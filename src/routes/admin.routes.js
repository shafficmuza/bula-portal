const express = require("express");
const bcrypt = require("bcryptjs");
const { nanoid } = require("nanoid");
const path = require("path");
const fs = require("fs");
const portalDB = require("../config/db.portal");
const requireAdmin = require("../middleware/requireAdmin");
const { activateVoucher } = require("../services/radius.service");
const deviceService = require("../services/device.service");
const settingsService = require("../services/settings.service");
const paymentProviderService = require("../services/payment-provider.service");
const mikrotikService = require("../services/mikrotik.service");
const ubiquitiService = require("../services/ubiquiti.service");
const ciscoService = require("../services/cisco.service");
const voucherSecurity = require("../services/voucher-security.service");

const router = express.Router();
const ASSET_VERSION = Date.now();

// Login page
router.get("/login", (req, res) => {
  res.render("admin/login", { error: null });
});

// Login submit
router.post("/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!email || !password) {
      return res.status(200).render("admin/login", { error: "Email and password required" });
    }

    const [rows] = await portalDB.query(
      "SELECT id,email,password_hash,full_name,role,is_active FROM admin_users WHERE email=? LIMIT 1",
      [email]
    );
    const user = rows && rows[0];
    if (!user || Number(user.is_active) !== 1) {
      return res.status(200).render("admin/login", { error: "Invalid credentials" });
    }

    const ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) return res.status(200).render("admin/login", { error: "Invalid credentials" });

    req.session.admin = {
      id: user.id,
      email: user.email,
      name: user.full_name || "Admin",
      role: user.role,
    };

    // Update last login time
    await portalDB.query("UPDATE admin_users SET last_login = NOW() WHERE id = ?", [user.id]);

    return res.redirect("/admin");
  } catch (e) {
    console.error("Admin login error:", e);
    return res.status(200).render("admin/login", { error: "Server error" });
  }
});

// Logout
router.get("/logout", (req, res) => {
  if (!req.session) return res.redirect("/admin/login");
  req.session.destroy(() => res.redirect("/admin/login"));
});

// Dashboard
router.get("/", requireAdmin, async (req, res) => {
  const radiusDB = require("../config/db.radius");

  const safeCount = async (sql, params=[], db=portalDB) => {
    try {
      const [[row]] = await db.query(sql, params);
      const val = row && (row.c ?? Object.values(row)[0]);
      return Number(val || 0);
    } catch (e) {
      return 0;
    }
  };

  const safeSum = async (sql, params=[], db=portalDB) => {
    try {
      const [[row]] = await db.query(sql, params);
      const val = row && (row.total ?? Object.values(row)[0]);
      return Number(val || 0);
    } catch (e) {
      return 0;
    }
  };

  const counts = {
    orders: await safeCount("SELECT COUNT(*) AS c FROM orders"),
    paid: await safeCount(
      "SELECT COUNT(*) AS c FROM orders WHERE status IN ('PAID','SUCCESS','COMPLETED') OR paid_at IS NOT NULL"
    ),
    vouchers: await safeCount("SELECT COUNT(*) AS c FROM vouchers WHERE status='ACTIVE'"),
    plans: await safeCount("SELECT COUNT(*) AS c FROM plans WHERE is_active=1"),
    // New statistics
    totalUsers: await safeCount("SELECT COUNT(*) AS c FROM customers"),
    activeUsers: await safeCount(
      "SELECT COUNT(DISTINCT username) AS c FROM radacct WHERE acctstoptime IS NULL",
      [],
      radiusDB
    ),
    dailySales: await safeSum(
      "SELECT COALESCE(SUM(amount_ugx), 0) AS total FROM orders WHERE DATE(paid_at) = CURDATE() AND (status IN ('PAID','SUCCESS','COMPLETED') OR paid_at IS NOT NULL)"
    ),
    mtdSales: await safeSum(
      "SELECT COALESCE(SUM(amount_ugx), 0) AS total FROM orders WHERE MONTH(paid_at) = MONTH(CURDATE()) AND YEAR(paid_at) = YEAR(CURDATE()) AND (status IN ('PAID','SUCCESS','COMPLETED') OR paid_at IS NOT NULL)"
    ),
  };

  let recentOrders = [];
  try {
    const [rows] = await portalDB.query(`
      SELECT order_ref, status, amount_ugx, paid_at
      FROM orders
      ORDER BY id DESC
      LIMIT 10
    `);
    recentOrders = rows || [];
  } catch (e) {
    recentOrders = [];
  }

  res.render("admin/dashboard", {
    assetVersion: ASSET_VERSION,
    admin: req.session.admin,
    counts,
    recentOrders
  });
});

// Orders
router.get("/orders", requireAdmin, async (req, res) => {
  const [rows] = await portalDB.query(`
    SELECT id, order_ref, status, amount_ugx, payment_provider, provider_tx_id, paid_at, created_at,
           customer_id, plan_id, username
    FROM orders
    ORDER BY id DESC
    LIMIT 200
  `);
  res.render("admin/orders", { admin: req.session.admin, orders: rows || [], assetVersion: ASSET_VERSION });
});

// Plans page
router.get("/plans", requireAdmin, async (req, res) => {
  res.render("admin/plans", { admin: req.session.admin, assetVersion: ASSET_VERSION });
});

// Vouchers page
router.get("/vouchers", requireAdmin, async (req, res) => {
  res.render("admin/vouchers", { admin: req.session.admin, assetVersion: ASSET_VERSION });
});

// Settings page
router.get("/settings", requireAdmin, async (req, res) => {
  const settings = await settingsService.getSettings();
  res.render("admin/settings", { admin: req.session.admin, assetVersion: ASSET_VERSION, settings });
});

// Finance page
router.get("/finance", requireAdmin, async (req, res) => {
  res.render("admin/finance", { admin: req.session.admin, assetVersion: ASSET_VERSION });
});

// System Documentation page (software documentation)
router.get("/system-docs", requireAdmin, async (req, res) => {
  const env = require("../config/env");
  const baseUrl = env.BASE_URL || "https://bula.prosystemsug.com";

  res.render("admin/system-docs", {
    admin: req.session.admin,
    assetVersion: ASSET_VERSION,
    baseUrl
  });
});

// Configuration Guides page (MikroTik setup)
router.get("/docs", requireAdmin, async (req, res) => {
  const env = require("../config/env");
  const baseUrl = env.BASE_URL || "https://bula.prosystemsug.com";
  const portalDomain = baseUrl.replace(/^https?:\/\//, "").split("/")[0];

  // Get server IP (try to extract from BASE_URL or use a default)
  let serverIp = "YOUR-SERVER-IP";
  try {
    const os = require("os");
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === "IPv4" && !iface.internal) {
          serverIp = iface.address;
          break;
        }
      }
    }
  } catch (e) {}

  res.render("admin/docs", {
    admin: req.session.admin,
    assetVersion: ASSET_VERSION,
    baseUrl,
    portalDomain,
    serverIp
  });
});

// Devices page
router.get("/devices", requireAdmin, async (req, res) => {
  res.render("admin/devices", { admin: req.session.admin, assetVersion: ASSET_VERSION });
});

// ============ DEVICE API ENDPOINTS ============

// List all devices
router.get("/api/devices", requireAdmin, async (req, res) => {
  try {
    const [devices] = await portalDB.query(
      `SELECT d.*, l.name as location_name
       FROM devices d
       LEFT JOIN locations l ON d.location_id = l.id
       ORDER BY d.created_at DESC`
    );

    // Check status for all devices in parallel
    const statusMap = await deviceService.checkDevicesStatus(devices);

    // Enrich devices with status
    const enrichedDevices = devices.map(d => ({
      ...d,
      online: statusMap.get(d.id)?.online || false,
      latency: statusMap.get(d.id)?.latency || null,
    }));

    res.json({ ok: true, devices: enrichedDevices });
  } catch (e) {
    console.error("List devices error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Get device stats (connected users, bandwidth)
router.get("/api/devices/:id/stats", requireAdmin, async (req, res) => {
  try {
    const [[device]] = await portalDB.query(
      "SELECT * FROM devices WHERE id = ?",
      [req.params.id]
    );

    if (!device) {
      return res.status(404).json({ ok: false, message: "Device not found" });
    }

    const [connectedUsers, bandwidthToday, bandwidthMonth, activeSessions] = await Promise.all([
      deviceService.getConnectedUsersCount(device.ip_address),
      deviceService.getNasBandwidthUsage(device.ip_address, "today"),
      deviceService.getNasBandwidthUsage(device.ip_address, "month"),
      deviceService.getNasActiveSessions(device.ip_address),
    ]);

    res.json({
      ok: true,
      stats: {
        connectedUsers,
        bandwidthToday: {
          download: bandwidthToday.download,
          upload: bandwidthToday.upload,
          downloadFormatted: deviceService.formatBytes(bandwidthToday.download),
          uploadFormatted: deviceService.formatBytes(bandwidthToday.upload),
        },
        bandwidthMonth: {
          download: bandwidthMonth.download,
          upload: bandwidthMonth.upload,
          downloadFormatted: deviceService.formatBytes(bandwidthMonth.download),
          uploadFormatted: deviceService.formatBytes(bandwidthMonth.upload),
        },
        activeSessions: activeSessions.map(s => ({
          ...s,
          downloadFormatted: deviceService.formatBytes(s.download || 0),
          uploadFormatted: deviceService.formatBytes(s.upload || 0),
        })),
      },
    });
  } catch (e) {
    console.error("Get device stats error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Check device status (ping)
router.get("/api/devices/:id/status", requireAdmin, async (req, res) => {
  try {
    const [[device]] = await portalDB.query(
      "SELECT ip_address FROM devices WHERE id = ?",
      [req.params.id]
    );

    if (!device) {
      return res.status(404).json({ ok: false, message: "Device not found" });
    }

    const status = await deviceService.pingDevice(device.ip_address);
    res.json({ ok: true, ...status });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Create new device
router.post("/api/devices", requireAdmin, async (req, res) => {
  try {
    const { name, ip_address, shortname, secret, vendor, location_id, description } = req.body;

    // Validation
    if (!name || !ip_address || !shortname || !secret) {
      return res.status(400).json({
        ok: false,
        message: "Name, IP address, short name, and RADIUS secret are required"
      });
    }

    // Validate IP address format
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipRegex.test(ip_address)) {
      return res.status(400).json({ ok: false, message: "Invalid IP address format" });
    }

    // Check if IP already exists
    const [[existing]] = await portalDB.query(
      "SELECT id FROM devices WHERE ip_address = ?",
      [ip_address]
    );
    if (existing) {
      return res.status(400).json({ ok: false, message: "Device with this IP already exists" });
    }

    // Insert device
    const [result] = await portalDB.query(
      `INSERT INTO devices (name, ip_address, shortname, secret, vendor, location_id, description, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [name, ip_address, shortname, secret, vendor || "other", location_id || null, description || null]
    );

    // Sync to RADIUS NAS table
    await deviceService.syncToRadiusNas({
      ip_address,
      shortname,
      secret,
      vendor: vendor || "other",
      description: description || "",
    });

    res.json({ ok: true, message: "Device created", id: result.insertId });
  } catch (e) {
    console.error("Create device error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Get single device
router.get("/api/devices/:id", requireAdmin, async (req, res) => {
  try {
    const [[device]] = await portalDB.query(
      "SELECT * FROM devices WHERE id = ?",
      [req.params.id]
    );

    if (!device) {
      return res.status(404).json({ ok: false, message: "Device not found" });
    }

    // Check status
    const status = await deviceService.pingDevice(device.ip_address);
    device.online = status.online;
    device.latency = status.latency;

    res.json({ ok: true, device });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Update device
router.put("/api/devices/:id", requireAdmin, async (req, res) => {
  try {
    const { name, ip_address, shortname, secret, vendor, location_id, description, is_active } = req.body;

    // Check device exists
    const [[existing]] = await portalDB.query(
      "SELECT * FROM devices WHERE id = ?",
      [req.params.id]
    );
    if (!existing) {
      return res.status(404).json({ ok: false, message: "Device not found" });
    }

    // Validation
    if (!name || !ip_address || !shortname || !secret) {
      return res.status(400).json({
        ok: false,
        message: "Name, IP address, short name, and RADIUS secret are required"
      });
    }

    // Check if IP exists for another device
    const [[ipExists]] = await portalDB.query(
      "SELECT id FROM devices WHERE ip_address = ? AND id != ?",
      [ip_address, req.params.id]
    );
    if (ipExists) {
      return res.status(400).json({ ok: false, message: "Another device with this IP already exists" });
    }

    // If IP changed, remove old NAS entry
    if (existing.ip_address !== ip_address) {
      await deviceService.removeFromRadiusNas(existing.ip_address);
    }

    // Update device
    await portalDB.query(
      `UPDATE devices SET
        name = ?, ip_address = ?, shortname = ?, secret = ?,
        vendor = ?, location_id = ?, description = ?, is_active = ?
       WHERE id = ?`,
      [name, ip_address, shortname, secret, vendor || "other", location_id || null, description || null, is_active ? 1 : 0, req.params.id]
    );

    // Sync to RADIUS NAS table
    await deviceService.syncToRadiusNas({
      ip_address,
      shortname,
      secret,
      vendor: vendor || "other",
      description: description || "",
    });

    res.json({ ok: true, message: "Device updated" });
  } catch (e) {
    console.error("Update device error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Toggle device active status
router.patch("/api/devices/:id/toggle", requireAdmin, async (req, res) => {
  try {
    const [[device]] = await portalDB.query(
      "SELECT id, is_active, ip_address FROM devices WHERE id = ?",
      [req.params.id]
    );
    if (!device) {
      return res.status(404).json({ ok: false, message: "Device not found" });
    }

    const newStatus = device.is_active ? 0 : 1;
    await portalDB.query(
      "UPDATE devices SET is_active = ? WHERE id = ?",
      [newStatus, req.params.id]
    );

    res.json({ ok: true, message: `Device ${newStatus ? 'activated' : 'deactivated'}`, is_active: newStatus });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Delete device
router.delete("/api/devices/:id", requireAdmin, async (req, res) => {
  try {
    const [[device]] = await portalDB.query(
      "SELECT id, ip_address FROM devices WHERE id = ?",
      [req.params.id]
    );

    if (!device) {
      return res.status(404).json({ ok: false, message: "Device not found" });
    }

    // Remove from RADIUS NAS table
    await deviceService.removeFromRadiusNas(device.ip_address);

    // Delete device
    await portalDB.query("DELETE FROM devices WHERE id = ?", [req.params.id]);

    res.json({ ok: true, message: "Device deleted" });
  } catch (e) {
    console.error("Delete device error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Get vendor types
router.get("/api/devices/meta/vendors", requireAdmin, async (req, res) => {
  res.json({ ok: true, vendors: deviceService.VENDOR_TYPES });
});

// Get Ubiquiti models
router.get("/api/devices/meta/ubiquiti-models", requireAdmin, async (req, res) => {
  res.json({ ok: true, models: ubiquitiService.UBIQUITI_MODELS });
});

// Test Ubiquiti device connection
router.post("/api/devices/ubiquiti/test-device", requireAdmin, async (req, res) => {
  try {
    const { ip_address } = req.body;
    if (!ip_address) {
      return res.status(400).json({ ok: false, message: "IP address required" });
    }

    const result = await ubiquitiService.testDeviceConnection(ip_address);
    res.json({ ok: true, result });
  } catch (e) {
    console.error("Ubiquiti device test error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Test UniFi Controller connection
router.post("/api/devices/ubiquiti/test-controller", requireAdmin, async (req, res) => {
  try {
    const { controllerUrl, username, password, site } = req.body;
    if (!controllerUrl || !username || !password) {
      return res.status(400).json({ ok: false, message: "Controller URL, username, and password required" });
    }

    const result = await ubiquitiService.testControllerConnection({
      controllerUrl,
      username,
      password,
      site: site || "default",
    });
    res.json({ ok: true, result });
  } catch (e) {
    console.error("UniFi controller test error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Get RADIUS configuration instructions for Ubiquiti
router.post("/api/devices/ubiquiti/radius-config", requireAdmin, async (req, res) => {
  try {
    const { model, radiusServer, radiusPort, radiusSecret, acctPort } = req.body;
    if (!model || !radiusServer || !radiusSecret) {
      return res.status(400).json({ ok: false, message: "Model, RADIUS server, and secret required" });
    }

    const instructions = ubiquitiService.getRadiusConfigInstructions(model, {
      radiusServer,
      radiusPort: radiusPort || 1812,
      radiusSecret,
      acctPort: acctPort || 1813,
    });
    res.json({ ok: true, instructions });
  } catch (e) {
    console.error("RADIUS config instructions error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Get Hotspot configuration instructions for Ubiquiti
router.post("/api/devices/ubiquiti/hotspot-config", requireAdmin, async (req, res) => {
  try {
    const { model, portalUrl, redirectUrl, radiusServer, radiusSecret } = req.body;
    if (!model || !portalUrl || !radiusServer) {
      return res.status(400).json({ ok: false, message: "Model, portal URL, and RADIUS server required" });
    }

    const instructions = ubiquitiService.getHotspotConfigInstructions(model, {
      portalUrl,
      redirectUrl,
      radiusServer,
      radiusSecret,
    });
    res.json({ ok: true, instructions });
  } catch (e) {
    console.error("Hotspot config instructions error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Validate Ubiquiti device configuration
router.post("/api/devices/ubiquiti/validate", requireAdmin, async (req, res) => {
  try {
    const result = ubiquitiService.validateConfig(req.body);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error("Ubiquiti validate error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ============ CISCO DEVICE API ENDPOINTS ============

// Get Cisco models
router.get("/api/devices/meta/cisco-models", requireAdmin, async (req, res) => {
  res.json({ ok: true, models: ciscoService.CISCO_MODELS, categories: ciscoService.CISCO_CATEGORIES });
});

// Test Cisco device connection
router.post("/api/devices/cisco/test-device", requireAdmin, async (req, res) => {
  try {
    const { ip_address } = req.body;
    if (!ip_address) {
      return res.status(400).json({ ok: false, message: "IP address required" });
    }

    const result = await ciscoService.testDeviceConnection(ip_address);
    res.json({ ok: true, result });
  } catch (e) {
    console.error("Cisco device test error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Get RADIUS configuration instructions for Cisco
router.post("/api/devices/cisco/radius-config", requireAdmin, async (req, res) => {
  try {
    const { model, radiusServer, radiusPort, radiusSecret, acctPort } = req.body;
    if (!model || !radiusServer || !radiusSecret) {
      return res.status(400).json({ ok: false, message: "Model, RADIUS server, and secret required" });
    }

    const instructions = ciscoService.getRadiusConfigInstructions(model, {
      radiusServer,
      radiusPort: radiusPort || 1812,
      radiusSecret,
      acctPort: acctPort || 1813,
    });
    res.json({ ok: true, instructions });
  } catch (e) {
    console.error("Cisco RADIUS config instructions error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Get Hotspot configuration instructions for Cisco
router.post("/api/devices/cisco/hotspot-config", requireAdmin, async (req, res) => {
  try {
    const { model, portalUrl, redirectUrl, radiusServer, radiusSecret } = req.body;
    if (!model || !portalUrl || !radiusServer) {
      return res.status(400).json({ ok: false, message: "Model, portal URL, and RADIUS server required" });
    }

    const instructions = ciscoService.getHotspotConfigInstructions(model, {
      portalUrl,
      redirectUrl,
      radiusServer,
      radiusSecret,
    });
    res.json({ ok: true, instructions });
  } catch (e) {
    console.error("Cisco hotspot config instructions error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Validate Cisco device configuration
router.post("/api/devices/cisco/validate", requireAdmin, async (req, res) => {
  try {
    const result = ciscoService.validateConfig(req.body);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error("Cisco validate error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ============ LOCATION API ENDPOINTS ============

// Locations page
router.get("/locations", requireAdmin, async (req, res) => {
  res.render("admin/locations", { admin: req.session.admin, assetVersion: ASSET_VERSION });
});

// List all locations
router.get("/api/locations", requireAdmin, async (req, res) => {
  try {
    const [locations] = await portalDB.query(
      `SELECT l.*,
              (SELECT COUNT(*) FROM devices d WHERE d.location_id = l.id) as device_count
       FROM locations l
       ORDER BY l.name ASC`
    );
    res.json({ ok: true, locations });
  } catch (e) {
    console.error("List locations error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Get active locations (for dropdowns)
router.get("/api/locations/active", requireAdmin, async (req, res) => {
  try {
    const [locations] = await portalDB.query(
      "SELECT id, name, address FROM locations WHERE is_active = 1 ORDER BY name ASC"
    );
    res.json({ ok: true, locations });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Create new location
router.post("/api/locations", requireAdmin, async (req, res) => {
  try {
    const { name, address, description } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ ok: false, message: "Location name is required" });
    }

    // Check if name already exists
    const [[existing]] = await portalDB.query(
      "SELECT id FROM locations WHERE name = ?",
      [name.trim()]
    );
    if (existing) {
      return res.status(400).json({ ok: false, message: "Location with this name already exists" });
    }

    const [result] = await portalDB.query(
      `INSERT INTO locations (name, address, description, is_active)
       VALUES (?, ?, ?, 1)`,
      [name.trim(), address?.trim() || null, description?.trim() || null]
    );

    res.json({ ok: true, message: "Location created", id: result.insertId });
  } catch (e) {
    console.error("Create location error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Get single location
router.get("/api/locations/:id", requireAdmin, async (req, res) => {
  try {
    const [[location]] = await portalDB.query(
      `SELECT l.*,
              (SELECT COUNT(*) FROM devices d WHERE d.location_id = l.id) as device_count
       FROM locations l
       WHERE l.id = ?`,
      [req.params.id]
    );

    if (!location) {
      return res.status(404).json({ ok: false, message: "Location not found" });
    }

    res.json({ ok: true, location });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Update location
router.put("/api/locations/:id", requireAdmin, async (req, res) => {
  try {
    const { name, address, description, is_active } = req.body;

    const [[existing]] = await portalDB.query(
      "SELECT id FROM locations WHERE id = ?",
      [req.params.id]
    );
    if (!existing) {
      return res.status(404).json({ ok: false, message: "Location not found" });
    }

    if (!name || !name.trim()) {
      return res.status(400).json({ ok: false, message: "Location name is required" });
    }

    // Check if name exists for another location
    const [[nameExists]] = await portalDB.query(
      "SELECT id FROM locations WHERE name = ? AND id != ?",
      [name.trim(), req.params.id]
    );
    if (nameExists) {
      return res.status(400).json({ ok: false, message: "Another location with this name already exists" });
    }

    await portalDB.query(
      `UPDATE locations SET name = ?, address = ?, description = ?, is_active = ?
       WHERE id = ?`,
      [name.trim(), address?.trim() || null, description?.trim() || null, is_active ? 1 : 0, req.params.id]
    );

    res.json({ ok: true, message: "Location updated" });
  } catch (e) {
    console.error("Update location error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Toggle location active status
router.patch("/api/locations/:id/toggle", requireAdmin, async (req, res) => {
  try {
    const [[location]] = await portalDB.query(
      "SELECT id, is_active FROM locations WHERE id = ?",
      [req.params.id]
    );
    if (!location) {
      return res.status(404).json({ ok: false, message: "Location not found" });
    }

    const newStatus = location.is_active ? 0 : 1;
    await portalDB.query(
      "UPDATE locations SET is_active = ? WHERE id = ?",
      [newStatus, req.params.id]
    );

    res.json({ ok: true, message: `Location ${newStatus ? 'activated' : 'deactivated'}`, is_active: newStatus });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Delete location
router.delete("/api/locations/:id", requireAdmin, async (req, res) => {
  try {
    const [[location]] = await portalDB.query(
      `SELECT l.id,
              (SELECT COUNT(*) FROM devices d WHERE d.location_id = l.id) as device_count
       FROM locations l WHERE l.id = ?`,
      [req.params.id]
    );

    if (!location) {
      return res.status(404).json({ ok: false, message: "Location not found" });
    }

    if (location.device_count > 0) {
      return res.status(400).json({
        ok: false,
        message: `Cannot delete location. It has ${location.device_count} device(s) assigned.`
      });
    }

    await portalDB.query("DELETE FROM locations WHERE id = ?", [req.params.id]);
    res.json({ ok: true, message: "Location deleted" });
  } catch (e) {
    console.error("Delete location error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ============ USER MANAGEMENT API ENDPOINTS ============

// Middleware to check for SUPER_ADMIN role
const requireSuperAdmin = (req, res, next) => {
  if (!req.session?.admin?.role || req.session.admin.role !== "SUPER_ADMIN") {
    return res.status(403).json({ ok: false, message: "Access denied. Super Admin privileges required." });
  }
  next();
};

// Users management page
router.get("/users", requireAdmin, requireSuperAdmin, async (req, res) => {
  res.render("admin/users", { admin: req.session.admin, assetVersion: ASSET_VERSION });
});

// Profile/Settings page (for logged-in user)
router.get("/profile", requireAdmin, async (req, res) => {
  res.render("admin/profile", { admin: req.session.admin, assetVersion: ASSET_VERSION });
});

// List all admin users (SUPER_ADMIN only)
router.get("/api/users", requireAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const [users] = await portalDB.query(
      `SELECT id, email, full_name, role, is_active, created_at, last_login
       FROM admin_users
       ORDER BY created_at DESC`
    );
    res.json({ ok: true, users });
  } catch (e) {
    console.error("List users error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Create new admin user (SUPER_ADMIN only)
router.post("/api/users", requireAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const { email, password, full_name, role } = req.body;

    if (!email || !password) {
      return res.status(400).json({ ok: false, message: "Email and password are required" });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ ok: false, message: "Invalid email format" });
    }

    // Validate password length
    if (password.length < 6) {
      return res.status(400).json({ ok: false, message: "Password must be at least 6 characters" });
    }

    // Validate role
    const validRoles = ["SUPER_ADMIN", "ADMIN", "STAFF"];
    const userRole = role && validRoles.includes(role) ? role : "STAFF";

    // Check if email already exists
    const [[existing]] = await portalDB.query(
      "SELECT id FROM admin_users WHERE email = ?",
      [email.toLowerCase().trim()]
    );
    if (existing) {
      return res.status(400).json({ ok: false, message: "Email already exists" });
    }

    // Hash password
    const passwordHash = bcrypt.hashSync(password, 10);

    // Insert user
    const [result] = await portalDB.query(
      `INSERT INTO admin_users (email, password_hash, full_name, role, is_active, created_by)
       VALUES (?, ?, ?, ?, 1, ?)`,
      [email.toLowerCase().trim(), passwordHash, full_name?.trim() || null, userRole, req.session.admin.id]
    );

    res.json({ ok: true, message: "User created", id: result.insertId });
  } catch (e) {
    console.error("Create user error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Get single user (SUPER_ADMIN only)
router.get("/api/users/:id", requireAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const [[user]] = await portalDB.query(
      `SELECT id, email, full_name, role, is_active, created_at, last_login
       FROM admin_users WHERE id = ?`,
      [req.params.id]
    );

    if (!user) {
      return res.status(404).json({ ok: false, message: "User not found" });
    }

    res.json({ ok: true, user });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Update user (SUPER_ADMIN only)
router.put("/api/users/:id", requireAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const { email, password, full_name, role } = req.body;
    const userId = parseInt(req.params.id);

    // Check user exists
    const [[existing]] = await portalDB.query(
      "SELECT id, email FROM admin_users WHERE id = ?",
      [userId]
    );
    if (!existing) {
      return res.status(404).json({ ok: false, message: "User not found" });
    }

    // Prevent editing own account via this endpoint (use profile instead)
    if (userId === req.session.admin.id) {
      return res.status(400).json({ ok: false, message: "Use profile settings to edit your own account" });
    }

    if (!email) {
      return res.status(400).json({ ok: false, message: "Email is required" });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ ok: false, message: "Invalid email format" });
    }

    // Check if email exists for another user
    const [[emailExists]] = await portalDB.query(
      "SELECT id FROM admin_users WHERE email = ? AND id != ?",
      [email.toLowerCase().trim(), userId]
    );
    if (emailExists) {
      return res.status(400).json({ ok: false, message: "Email already used by another user" });
    }

    // Validate role
    const validRoles = ["SUPER_ADMIN", "ADMIN", "STAFF"];
    const userRole = role && validRoles.includes(role) ? role : "STAFF";

    // Build update query
    let updateQuery = "UPDATE admin_users SET email = ?, full_name = ?, role = ?";
    let params = [email.toLowerCase().trim(), full_name?.trim() || null, userRole];

    // If password provided, update it too
    if (password && password.length >= 6) {
      const passwordHash = bcrypt.hashSync(password, 10);
      updateQuery += ", password_hash = ?";
      params.push(passwordHash);
    }

    updateQuery += " WHERE id = ?";
    params.push(userId);

    await portalDB.query(updateQuery, params);

    res.json({ ok: true, message: "User updated" });
  } catch (e) {
    console.error("Update user error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Toggle user active status (SUPER_ADMIN only)
router.patch("/api/users/:id/toggle", requireAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    // Prevent toggling own account
    if (userId === req.session.admin.id) {
      return res.status(400).json({ ok: false, message: "Cannot deactivate your own account" });
    }

    const [[user]] = await portalDB.query(
      "SELECT id, is_active FROM admin_users WHERE id = ?",
      [userId]
    );
    if (!user) {
      return res.status(404).json({ ok: false, message: "User not found" });
    }

    const newStatus = user.is_active ? 0 : 1;
    await portalDB.query(
      "UPDATE admin_users SET is_active = ? WHERE id = ?",
      [newStatus, userId]
    );

    res.json({ ok: true, message: `User ${newStatus ? 'activated' : 'deactivated'}`, is_active: newStatus });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Delete user (SUPER_ADMIN only)
router.delete("/api/users/:id", requireAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    // Prevent deleting own account
    if (userId === req.session.admin.id) {
      return res.status(400).json({ ok: false, message: "Cannot delete your own account" });
    }

    const [[user]] = await portalDB.query(
      "SELECT id FROM admin_users WHERE id = ?",
      [userId]
    );
    if (!user) {
      return res.status(404).json({ ok: false, message: "User not found" });
    }

    await portalDB.query("DELETE FROM admin_users WHERE id = ?", [userId]);
    res.json({ ok: true, message: "User deleted" });
  } catch (e) {
    console.error("Delete user error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ============ PROFILE API ENDPOINTS ============

// Get current user profile
router.get("/api/profile", requireAdmin, async (req, res) => {
  try {
    const [[user]] = await portalDB.query(
      `SELECT id, email, full_name, role, created_at, last_login
       FROM admin_users WHERE id = ?`,
      [req.session.admin.id]
    );

    if (!user) {
      return res.status(404).json({ ok: false, message: "User not found" });
    }

    res.json({ ok: true, user });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Update current user profile
router.put("/api/profile", requireAdmin, async (req, res) => {
  try {
    const { email, full_name } = req.body;

    if (!email) {
      return res.status(400).json({ ok: false, message: "Email is required" });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ ok: false, message: "Invalid email format" });
    }

    // Check if email exists for another user
    const [[emailExists]] = await portalDB.query(
      "SELECT id FROM admin_users WHERE email = ? AND id != ?",
      [email.toLowerCase().trim(), req.session.admin.id]
    );
    if (emailExists) {
      return res.status(400).json({ ok: false, message: "Email already used by another user" });
    }

    await portalDB.query(
      "UPDATE admin_users SET email = ?, full_name = ? WHERE id = ?",
      [email.toLowerCase().trim(), full_name?.trim() || null, req.session.admin.id]
    );

    // Update session
    req.session.admin.email = email.toLowerCase().trim();
    req.session.admin.name = full_name?.trim() || req.session.admin.name;

    res.json({ ok: true, message: "Profile updated" });
  } catch (e) {
    console.error("Update profile error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Change password
router.put("/api/profile/password", requireAdmin, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ ok: false, message: "Current and new passwords are required" });
    }

    if (new_password.length < 6) {
      return res.status(400).json({ ok: false, message: "New password must be at least 6 characters" });
    }

    // Get current password hash
    const [[user]] = await portalDB.query(
      "SELECT password_hash FROM admin_users WHERE id = ?",
      [req.session.admin.id]
    );

    if (!user) {
      return res.status(404).json({ ok: false, message: "User not found" });
    }

    // Verify current password
    const isValid = bcrypt.compareSync(current_password, user.password_hash);
    if (!isValid) {
      return res.status(400).json({ ok: false, message: "Current password is incorrect" });
    }

    // Hash and update new password
    const newPasswordHash = bcrypt.hashSync(new_password, 10);
    await portalDB.query(
      "UPDATE admin_users SET password_hash = ? WHERE id = ?",
      [newPasswordHash, req.session.admin.id]
    );

    res.json({ ok: true, message: "Password changed successfully" });
  } catch (e) {
    console.error("Change password error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ============ VOUCHER API ENDPOINTS ============

// List vouchers with pagination
router.get("/api/vouchers", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const status = req.query.status || null;
    const planId = req.query.plan_id || null;

    let whereClause = "WHERE 1=1";
    const params = [];

    if (status) {
      whereClause += " AND v.status = ?";
      params.push(status);
    }
    if (planId) {
      whereClause += " AND v.plan_id = ?";
      params.push(planId);
    }

    // Get total count
    const [[countResult]] = await portalDB.query(
      `SELECT COUNT(*) as total FROM vouchers v ${whereClause}`,
      params
    );
    const total = countResult.total;

    // Get vouchers with plan info
    const [vouchers] = await portalDB.query(
      `SELECT v.*, p.name as plan_name, p.price_ugx, p.duration_minutes
       FROM vouchers v
       LEFT JOIN plans p ON v.plan_id = p.id
       ${whereClause}
       ORDER BY v.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      ok: true,
      vouchers,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (e) {
    console.error("List vouchers error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Get plans for dropdown
router.get("/api/plans", requireAdmin, async (req, res) => {
  try {
    const [plans] = await portalDB.query(
      "SELECT id, code, name, price_ugx, duration_minutes FROM plans WHERE is_active = 1 ORDER BY price_ugx ASC"
    );
    res.json({ ok: true, plans });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Generate vouchers (bulk)
router.post("/api/vouchers/generate", requireAdmin, async (req, res) => {
  try {
    const { plan_id, count = 1, expires_days = null, activate_radius = false } = req.body;

    if (!plan_id) {
      return res.status(400).json({ ok: false, message: "plan_id is required" });
    }

    const quantity = Math.min(100, Math.max(1, parseInt(count) || 1));

    // Get plan info (including data_mb for RADIUS data limits)
    const [[plan]] = await portalDB.query(
      "SELECT id, code, name, price_ugx, duration_minutes, speed_down_kbps, speed_up_kbps, data_mb FROM plans WHERE id = ? AND is_active = 1",
      [plan_id]
    );
    if (!plan) {
      return res.status(404).json({ ok: false, message: "Plan not found" });
    }

    const vouchers = [];
    const adminId = req.session.admin?.id || null;

    // Calculate expiration date if specified
    let expiresAt = null;
    if (expires_days && parseInt(expires_days) > 0) {
      const expDate = new Date();
      expDate.setDate(expDate.getDate() + parseInt(expires_days));
      expiresAt = expDate.toISOString().slice(0, 19).replace('T', ' ');
    }

    for (let i = 0; i < quantity; i++) {
      // Generate numeric-only voucher code (5 digits)
      const code = String(Math.floor(10000 + Math.random() * 90000));

      await portalDB.query(
        `INSERT INTO vouchers (code, password, plan_id, status, created_by, expires_at)
         VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
        [code, code, plan_id, adminId, expiresAt]
      );

      // Optionally activate in RADIUS immediately with full plan attributes
      // Voucher code is used as both username and password
      if (activate_radius) {
        try {
          await activateVoucher({
            username: code,
            password: code,
            minutes: plan.duration_minutes,
            speedDownKbps: plan.speed_down_kbps,
            speedUpKbps: plan.speed_up_kbps,
            dataMb: plan.data_mb,
          });
        } catch (radErr) {
          console.error("RADIUS activation error for voucher:", code, radErr.message);
        }
      }

      vouchers.push({
        code,
        plan_name: plan.name,
        price_ugx: plan.price_ugx,
        duration_minutes: plan.duration_minutes,
        expires_at: expiresAt
      });
    }

    res.json({
      ok: true,
      message: `Generated ${vouchers.length} voucher(s)`,
      vouchers
    });
  } catch (e) {
    console.error("Generate vouchers error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Get single voucher
router.get("/api/vouchers/:id", requireAdmin, async (req, res) => {
  try {
    const [[voucher]] = await portalDB.query(
      `SELECT v.*, p.name as plan_name, p.price_ugx, p.duration_minutes
       FROM vouchers v
       LEFT JOIN plans p ON v.plan_id = p.id
       WHERE v.id = ?`,
      [req.params.id]
    );
    if (!voucher) {
      return res.status(404).json({ ok: false, message: "Voucher not found" });
    }
    res.json({ ok: true, voucher });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Update voucher status (disable/enable)
router.patch("/api/vouchers/:id", requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['ACTIVE', 'DISABLED'];

    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ ok: false, message: "Invalid status. Use ACTIVE or DISABLED" });
    }

    const [[voucher]] = await portalDB.query(
      "SELECT id, status FROM vouchers WHERE id = ?",
      [req.params.id]
    );
    if (!voucher) {
      return res.status(404).json({ ok: false, message: "Voucher not found" });
    }

    // Don't allow changing status of USED vouchers
    if (voucher.status === 'USED') {
      return res.status(400).json({ ok: false, message: "Cannot change status of used vouchers" });
    }

    await portalDB.query(
      "UPDATE vouchers SET status = ? WHERE id = ?",
      [status, req.params.id]
    );

    res.json({ ok: true, message: `Voucher ${status === 'DISABLED' ? 'disabled' : 'enabled'}` });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Delete voucher (only if not used)
router.delete("/api/vouchers/:id", requireAdmin, async (req, res) => {
  try {
    const [[voucher]] = await portalDB.query(
      "SELECT id, status FROM vouchers WHERE id = ?",
      [req.params.id]
    );
    if (!voucher) {
      return res.status(404).json({ ok: false, message: "Voucher not found" });
    }

    if (voucher.status === 'USED') {
      return res.status(400).json({ ok: false, message: "Cannot delete used vouchers" });
    }

    await portalDB.query("DELETE FROM vouchers WHERE id = ?", [req.params.id]);
    res.json({ ok: true, message: "Voucher deleted" });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Bulk delete vouchers
router.post("/api/vouchers/bulk-delete", requireAdmin, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ ok: false, message: "No voucher IDs provided" });
    }

    // Only delete non-used vouchers
    const placeholders = ids.map(() => '?').join(',');
    const [result] = await portalDB.query(
      `DELETE FROM vouchers WHERE id IN (${placeholders}) AND status != 'USED'`,
      ids
    );

    res.json({ ok: true, message: `Deleted ${result.affectedRows} voucher(s)` });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Export vouchers as CSV
router.get("/api/vouchers/export/csv", requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || null;
    const planId = req.query.plan_id || null;

    let whereClause = "WHERE 1=1";
    const params = [];

    if (status) {
      whereClause += " AND v.status = ?";
      params.push(status);
    }
    if (planId) {
      whereClause += " AND v.plan_id = ?";
      params.push(planId);
    }

    const [vouchers] = await portalDB.query(
      `SELECT v.code, v.password, v.status, p.name as plan_name, p.price_ugx,
              v.created_at, v.expires_at, v.used_at
       FROM vouchers v
       LEFT JOIN plans p ON v.plan_id = p.id
       ${whereClause}
       ORDER BY v.id DESC`,
      params
    );

    // Generate CSV (voucher code only, no separate password)
    const headers = ['Voucher Code', 'Plan', 'Price (UGX)', 'Status', 'Created', 'Expires', 'Used'];
    const rows = vouchers.map(v => [
      v.code,
      v.plan_name,
      v.price_ugx,
      v.status,
      v.created_at ? new Date(v.created_at).toISOString() : '',
      v.expires_at ? new Date(v.expires_at).toISOString() : '',
      v.used_at ? new Date(v.used_at).toISOString() : ''
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=vouchers-${Date.now()}.csv`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ============ VOUCHER SECURITY API ENDPOINTS ============

// Get suspicious activity report
router.get("/api/vouchers/security/suspicious", requireAdmin, async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const report = await voucherSecurity.getSuspiciousActivity(hours);
    res.json({ ok: true, report });
  } catch (e) {
    console.error("Get suspicious activity error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Get security logs with pagination
router.get("/api/vouchers/security/logs", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const severity = req.query.severity || null;
    const eventType = req.query.event_type || null;

    let whereClause = "WHERE 1=1";
    const params = [];

    if (severity) {
      whereClause += " AND severity = ?";
      params.push(severity);
    }
    if (eventType) {
      whereClause += " AND event_type = ?";
      params.push(eventType);
    }

    const [[countResult]] = await portalDB.query(
      `SELECT COUNT(*) as total FROM voucher_security_logs ${whereClause}`,
      params
    );

    const [logs] = await portalDB.query(
      `SELECT * FROM voucher_security_logs ${whereClause}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    // Parse JSON details
    const parsedLogs = logs.map(log => ({
      ...log,
      details: log.details ? JSON.parse(log.details) : null
    }));

    res.json({
      ok: true,
      logs: parsedLogs,
      pagination: {
        page,
        limit,
        total: countResult.total,
        pages: Math.ceil(countResult.total / limit)
      }
    });
  } catch (e) {
    console.error("Get security logs error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Get flagged/blocked IPs
router.get("/api/vouchers/security/blocked-ips", requireAdmin, async (req, res) => {
  try {
    const [flaggedIps] = await portalDB.query(
      `SELECT * FROM flagged_ips ORDER BY flagged_at DESC`
    );
    res.json({ ok: true, flaggedIps });
  } catch (e) {
    console.error("Get blocked IPs error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Unblock an IP address
router.delete("/api/vouchers/security/blocked-ips/:ip", requireAdmin, async (req, res) => {
  try {
    const ip = req.params.ip;
    const result = await voucherSecurity.unblockIp(ip);
    res.json(result);
  } catch (e) {
    console.error("Unblock IP error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Manually block an IP
router.post("/api/vouchers/security/block-ip", requireAdmin, async (req, res) => {
  try {
    const { ip, reason, duration } = req.body;
    if (!ip) {
      return res.status(400).json({ ok: false, message: "IP address required" });
    }
    await voucherSecurity.flagIpAddress(ip, reason || "Manually blocked by admin", duration || 60);
    res.json({ ok: true, message: `IP ${ip} has been blocked` });
  } catch (e) {
    console.error("Block IP error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Get voucher usage history
router.get("/api/vouchers/security/usage", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const [[countResult]] = await portalDB.query(
      `SELECT COUNT(*) as total FROM voucher_usage`
    );

    const [usage] = await portalDB.query(
      `SELECT vu.*, p.name as plan_name
       FROM voucher_usage vu
       LEFT JOIN vouchers v ON vu.voucher_code = v.code
       LEFT JOIN plans p ON v.plan_id = p.id
       ORDER BY vu.used_at DESC
       LIMIT ? OFFSET ?`,
      [limit, offset]
    );

    res.json({
      ok: true,
      usage,
      pagination: {
        page,
        limit,
        total: countResult.total,
        pages: Math.ceil(countResult.total / limit)
      }
    });
  } catch (e) {
    console.error("Get voucher usage error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Check specific voucher security status
router.get("/api/vouchers/:id/security", requireAdmin, async (req, res) => {
  try {
    const [[voucher]] = await portalDB.query(
      `SELECT code FROM vouchers WHERE id = ?`,
      [req.params.id]
    );

    if (!voucher) {
      return res.status(404).json({ ok: false, message: "Voucher not found" });
    }

    const usageCheck = await voucherSecurity.checkVoucherUsed(voucher.code);
    const sessionCheck = await voucherSecurity.hasActiveSession(voucher.code);

    // Get security logs for this voucher
    const [logs] = await portalDB.query(
      `SELECT event_type, ip_address, severity, details, created_at
       FROM voucher_security_logs
       WHERE voucher_code = ?
       ORDER BY created_at DESC
       LIMIT 20`,
      [voucher.code]
    );

    res.json({
      ok: true,
      security: {
        used: usageCheck.used,
        usedAt: usageCheck.usedAt,
        sessionCount: usageCheck.sessionCount || 0,
        hasActiveSession: sessionCheck.active,
        activeSession: sessionCheck.active ? sessionCheck : null,
        recentLogs: logs.map(l => ({
          ...l,
          details: l.details ? JSON.parse(l.details) : null
        }))
      }
    });
  } catch (e) {
    console.error("Get voucher security error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Clean up old security logs (SUPER_ADMIN only)
router.post("/api/vouchers/security/cleanup", requireAdmin, async (req, res) => {
  try {
    if (req.session.admin.role !== "SUPER_ADMIN") {
      return res.status(403).json({ ok: false, message: "Super Admin required" });
    }

    const daysToKeep = parseInt(req.body.days) || 30;
    const result = await voucherSecurity.cleanupOldLogs(daysToKeep);
    res.json({ ok: true, message: `Cleaned up ${result.deletedCount} old log entries` });
  } catch (e) {
    console.error("Cleanup logs error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ============ PLANS API ENDPOINTS ============

// List all plans (including inactive)
router.get("/api/plans/all", requireAdmin, async (req, res) => {
  try {
    const [plans] = await portalDB.query(
      `SELECT p.*,
              (SELECT COUNT(*) FROM vouchers v WHERE v.plan_id = p.id) as voucher_count,
              (SELECT COUNT(*) FROM orders o WHERE o.plan_id = p.id) as order_count
       FROM plans p
       ORDER BY p.is_active DESC, p.price_ugx ASC`
    );
    res.json({ ok: true, plans });
  } catch (e) {
    console.error("List plans error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Create new plan
router.post("/api/plans", requireAdmin, async (req, res) => {
  try {
    const { code, name, price_ugx, duration_minutes, speed_down_kbps, speed_up_kbps, data_mb } = req.body;

    // Validation
    if (!code || !name || !price_ugx || !duration_minutes) {
      return res.status(400).json({ ok: false, message: "Code, name, price, and duration are required" });
    }

    // Check if code already exists
    const [[existing]] = await portalDB.query("SELECT id FROM plans WHERE code = ?", [code]);
    if (existing) {
      return res.status(400).json({ ok: false, message: "Plan code already exists" });
    }

    const [result] = await portalDB.query(
      `INSERT INTO plans (code, name, price_ugx, duration_minutes, speed_down_kbps, speed_up_kbps, data_mb, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        code.toUpperCase(),
        name,
        parseInt(price_ugx),
        parseInt(duration_minutes),
        speed_down_kbps ? parseInt(speed_down_kbps) : null,
        speed_up_kbps ? parseInt(speed_up_kbps) : null,
        data_mb ? parseInt(data_mb) : null
      ]
    );

    res.json({ ok: true, message: "Plan created", id: result.insertId });
  } catch (e) {
    console.error("Create plan error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Get single plan
router.get("/api/plans/:id", requireAdmin, async (req, res) => {
  try {
    const [[plan]] = await portalDB.query(
      `SELECT p.*,
              (SELECT COUNT(*) FROM vouchers v WHERE v.plan_id = p.id) as voucher_count,
              (SELECT COUNT(*) FROM orders o WHERE o.plan_id = p.id) as order_count
       FROM plans p
       WHERE p.id = ?`,
      [req.params.id]
    );
    if (!plan) {
      return res.status(404).json({ ok: false, message: "Plan not found" });
    }
    res.json({ ok: true, plan });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Update plan
router.put("/api/plans/:id", requireAdmin, async (req, res) => {
  try {
    const { code, name, price_ugx, duration_minutes, speed_down_kbps, speed_up_kbps, data_mb } = req.body;

    // Check plan exists
    const [[existing]] = await portalDB.query("SELECT id FROM plans WHERE id = ?", [req.params.id]);
    if (!existing) {
      return res.status(404).json({ ok: false, message: "Plan not found" });
    }

    // Validation
    if (!code || !name || !price_ugx || !duration_minutes) {
      return res.status(400).json({ ok: false, message: "Code, name, price, and duration are required" });
    }

    // Check if code exists for another plan
    const [[codeExists]] = await portalDB.query(
      "SELECT id FROM plans WHERE code = ? AND id != ?",
      [code, req.params.id]
    );
    if (codeExists) {
      return res.status(400).json({ ok: false, message: "Plan code already exists" });
    }

    await portalDB.query(
      `UPDATE plans SET
        code = ?, name = ?, price_ugx = ?, duration_minutes = ?,
        speed_down_kbps = ?, speed_up_kbps = ?, data_mb = ?
       WHERE id = ?`,
      [
        code.toUpperCase(),
        name,
        parseInt(price_ugx),
        parseInt(duration_minutes),
        speed_down_kbps ? parseInt(speed_down_kbps) : null,
        speed_up_kbps ? parseInt(speed_up_kbps) : null,
        data_mb ? parseInt(data_mb) : null,
        req.params.id
      ]
    );

    res.json({ ok: true, message: "Plan updated" });
  } catch (e) {
    console.error("Update plan error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Toggle plan active status
router.patch("/api/plans/:id/toggle", requireAdmin, async (req, res) => {
  try {
    const [[plan]] = await portalDB.query("SELECT id, is_active FROM plans WHERE id = ?", [req.params.id]);
    if (!plan) {
      return res.status(404).json({ ok: false, message: "Plan not found" });
    }

    const newStatus = plan.is_active ? 0 : 1;
    await portalDB.query("UPDATE plans SET is_active = ? WHERE id = ?", [newStatus, req.params.id]);

    res.json({ ok: true, message: `Plan ${newStatus ? 'activated' : 'deactivated'}`, is_active: newStatus });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Delete plan (only if no vouchers or orders reference it)
router.delete("/api/plans/:id", requireAdmin, async (req, res) => {
  try {
    const [[plan]] = await portalDB.query(
      `SELECT p.id,
              (SELECT COUNT(*) FROM vouchers v WHERE v.plan_id = p.id) as voucher_count,
              (SELECT COUNT(*) FROM orders o WHERE o.plan_id = p.id) as order_count
       FROM plans p WHERE p.id = ?`,
      [req.params.id]
    );

    if (!plan) {
      return res.status(404).json({ ok: false, message: "Plan not found" });
    }

    if (plan.voucher_count > 0 || plan.order_count > 0) {
      return res.status(400).json({
        ok: false,
        message: `Cannot delete plan. It has ${plan.voucher_count} voucher(s) and ${plan.order_count} order(s).`
      });
    }

    await portalDB.query("DELETE FROM plans WHERE id = ?", [req.params.id]);
    res.json({ ok: true, message: "Plan deleted" });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ============ SETTINGS API ENDPOINTS ============

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, "..", "..", "public", "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Get current settings
router.get("/api/settings", requireAdmin, async (req, res) => {
  try {
    const settings = await settingsService.getSettings();
    res.json({ ok: true, settings });
  } catch (e) {
    console.error("Get settings error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Update settings
router.put("/api/settings", requireAdmin, async (req, res) => {
  try {
    const settings = await settingsService.updateSettings(req.body);
    res.json({ ok: true, message: "Settings updated", settings });
  } catch (e) {
    console.error("Update settings error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Handle file upload for logo and background images
router.post("/api/settings/upload/:field", requireAdmin, async (req, res) => {
  try {
    const { field } = req.params;
    const validFields = ["logo_url", "favicon_url", "portal_background_url"];

    if (!validFields.includes(field)) {
      return res.status(400).json({ ok: false, message: "Invalid upload field" });
    }

    // Check if content-type is base64 data
    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ ok: false, message: "No image data provided" });
    }

    // Parse base64 image
    const matches = image.match(/^data:image\/([a-zA-Z+]+);base64,(.+)$/);
    if (!matches) {
      return res.status(400).json({ ok: false, message: "Invalid image format" });
    }

    const ext = matches[1] === "jpeg" ? "jpg" : matches[1];
    const data = matches[2];
    const buffer = Buffer.from(data, "base64");

    // Validate file size (max 5MB)
    if (buffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({ ok: false, message: "Image must be less than 5MB" });
    }

    // Generate unique filename
    const filename = `${field.replace("_url", "")}_${Date.now()}.${ext}`;
    const filepath = path.join(uploadsDir, filename);

    // Save file
    fs.writeFileSync(filepath, buffer);

    // Update settings with new URL
    const imageUrl = `/uploads/${filename}`;
    await settingsService.updateField(field, imageUrl);

    // Delete old file if exists
    const currentSettings = await settingsService.getSettings();
    const oldUrl = currentSettings[field];
    if (oldUrl && oldUrl !== imageUrl && oldUrl.startsWith("/uploads/")) {
      const oldPath = path.join(__dirname, "..", "..", "public", oldUrl);
      if (fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
      }
    }

    res.json({ ok: true, message: "Image uploaded", url: imageUrl });
  } catch (e) {
    console.error("Upload error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Delete uploaded image
router.delete("/api/settings/upload/:field", requireAdmin, async (req, res) => {
  try {
    const { field } = req.params;
    const validFields = ["logo_url", "favicon_url", "portal_background_url"];

    if (!validFields.includes(field)) {
      return res.status(400).json({ ok: false, message: "Invalid field" });
    }

    // Get current URL
    const settings = await settingsService.getSettings();
    const currentUrl = settings[field];

    // Delete file if it exists
    if (currentUrl && currentUrl.startsWith("/uploads/")) {
      const filepath = path.join(__dirname, "..", "..", "public", currentUrl);
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
      }
    }

    // Clear the field in settings
    await settingsService.clearImageField(field);

    res.json({ ok: true, message: "Image deleted" });
  } catch (e) {
    console.error("Delete image error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Reset settings to defaults
router.post("/api/settings/reset", requireAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const defaults = settingsService.getDefaultSettings();
    const settings = await settingsService.updateSettings(defaults);
    res.json({ ok: true, message: "Settings reset to defaults", settings });
  } catch (e) {
    console.error("Reset settings error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ============ PAYMENT PROVIDER API ENDPOINTS ============

// Get all payment providers
router.get("/api/payment-providers", requireAdmin, async (req, res) => {
  try {
    const providers = await paymentProviderService.getAllProviders();
    // Mask sensitive credentials in response
    const maskedProviders = providers.map(p => ({
      ...p,
      credentials: maskCredentials(p.credentials, p.provider_code)
    }));
    res.json({ ok: true, providers: maskedProviders });
  } catch (e) {
    console.error("Get payment providers error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Get single payment provider
router.get("/api/payment-providers/:code", requireAdmin, async (req, res) => {
  try {
    const provider = await paymentProviderService.getProvider(req.params.code);
    if (!provider) {
      return res.status(404).json({ ok: false, message: "Provider not found" });
    }
    // Mask sensitive credentials
    const masked = {
      ...provider,
      credentials: maskCredentials(provider.credentials, provider.provider_code)
    };
    res.json({ ok: true, provider: masked });
  } catch (e) {
    console.error("Get payment provider error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Update payment provider
router.put("/api/payment-providers/:code", requireAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const { is_enabled, environment, credentials } = req.body;

    // Validate environment
    if (environment && !["test", "live"].includes(environment)) {
      return res.status(400).json({ ok: false, message: "Invalid environment. Use 'test' or 'live'" });
    }

    // Get current provider to merge credentials
    const currentProvider = await paymentProviderService.getProvider(req.params.code);
    if (!currentProvider) {
      return res.status(404).json({ ok: false, message: "Provider not found" });
    }

    // Merge credentials (only update fields that are provided and not masked)
    let updatedCredentials = currentProvider.credentials || {};
    if (credentials) {
      for (const [key, value] of Object.entries(credentials)) {
        // Only update if value is provided and not a masked placeholder
        if (value !== undefined && value !== null && !String(value).includes("••••")) {
          updatedCredentials[key] = value;
        }
      }
    }

    const updated = await paymentProviderService.updateProvider(req.params.code, {
      is_enabled: is_enabled !== undefined ? is_enabled : currentProvider.is_enabled,
      environment: environment || currentProvider.environment,
      credentials: updatedCredentials
    });

    res.json({
      ok: true,
      message: "Payment provider updated",
      provider: {
        ...updated,
        credentials: maskCredentials(updated.credentials, updated.provider_code)
      }
    });
  } catch (e) {
    console.error("Update payment provider error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Get enabled payment providers (for portal)
router.get("/api/payment-providers/enabled/list", requireAdmin, async (req, res) => {
  try {
    const providers = await paymentProviderService.getEnabledProviders();
    res.json({
      ok: true,
      providers: providers.map(p => ({
        provider_code: p.provider_code,
        display_name: p.display_name,
        environment: p.environment
      }))
    });
  } catch (e) {
    console.error("Get enabled providers error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ============ MIKROTIK API ENDPOINTS ============

// Test MikroTik connection
router.get("/api/mikrotik/test", requireAdmin, async (req, res) => {
  try {
    const result = await mikrotikService.testConnection();
    res.json({ ok: true, result });
  } catch (e) {
    console.error("MikroTik test error:", e);
    res.json({
      ok: false,
      result: {
        success: false,
        message: e.message || "Connection test failed"
      }
    });
  }
});

// Get MikroTik status
router.get("/api/mikrotik/status", requireAdmin, async (req, res) => {
  try {
    const isAvailable = await mikrotikService.isAvailable();
    const config = await mikrotikService.getConfig();

    res.json({
      ok: true,
      available: isAvailable,
      enabled: config?.enabled || false,
      configured: !!(config?.host && config?.username)
    });
  } catch (e) {
    console.error("MikroTik status error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Get active MAC bindings from MikroTik
router.get("/api/mikrotik/bindings", requireAdmin, async (req, res) => {
  try {
    const result = await mikrotikService.getActiveBindings();
    res.json(result);
  } catch (e) {
    console.error("MikroTik bindings error:", e);
    res.status(500).json({ ok: false, message: e.message, bindings: [] });
  }
});

// Remove a MAC binding
router.delete("/api/mikrotik/bindings/:mac", requireAdmin, async (req, res) => {
  try {
    const result = await mikrotikService.removeMacBinding(req.params.mac);
    res.json(result);
  } catch (e) {
    console.error("MikroTik remove binding error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

/**
 * Mask sensitive credential values for display
 */
function maskCredentials(credentials, providerCode) {
  if (!credentials) return {};

  const masked = { ...credentials };
  const sensitiveFields = {
    flutterwave: ["secret_key", "webhook_hash"],
    yopayments: ["api_password"]
  };

  const fieldsToMask = sensitiveFields[providerCode] || [];
  for (const field of fieldsToMask) {
    if (masked[field]) {
      // Show first 4 and last 4 characters with masking in between
      const val = String(masked[field]);
      if (val.length > 8) {
        masked[field] = val.slice(0, 4) + "••••••••" + val.slice(-4);
      } else if (val.length > 0) {
        masked[field] = "••••••••";
      }
    }
  }
  return masked;
}

// ============ FINANCE API ENDPOINTS ============

// Ensure payment_logs table exists
async function ensurePaymentLogsTable() {
  try {
    await portalDB.query(`
      CREATE TABLE IF NOT EXISTS payment_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT,
        provider_code VARCHAR(50) NOT NULL,
        transaction_ref VARCHAR(100),
        provider_tx_id VARCHAR(100),
        amount DECIMAL(15, 2) NOT NULL,
        currency VARCHAR(10) DEFAULT 'UGX',
        status ENUM('initiated', 'pending', 'processing', 'success', 'failed', 'cancelled') DEFAULT 'initiated',
        status_message TEXT,
        request_payload JSON,
        response_payload JSON,
        customer_msisdn VARCHAR(20),
        payment_method VARCHAR(50),
        initiated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP NULL,
        INDEX idx_order_id (order_id),
        INDEX idx_provider_code (provider_code),
        INDEX idx_transaction_ref (transaction_ref),
        INDEX idx_status (status),
        INDEX idx_initiated_at (initiated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } catch (e) {
    console.error("Error ensuring payment_logs table:", e);
  }
}

// Ensure withdrawals table exists
async function ensureWithdrawalsTable() {
  try {
    await portalDB.query(`
      CREATE TABLE IF NOT EXISTS withdrawals (
        id INT AUTO_INCREMENT PRIMARY KEY,
        withdrawal_ref VARCHAR(50) NOT NULL UNIQUE,
        amount DECIMAL(15, 2) NOT NULL,
        currency VARCHAR(10) DEFAULT 'UGX',
        destination_type ENUM('bank_account', 'mobile_money') NOT NULL,
        destination_details JSON,
        status ENUM('pending', 'processing', 'completed', 'failed', 'cancelled') DEFAULT 'pending',
        requested_by INT,
        approved_by INT,
        requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMP NULL,
        completed_at TIMESTAMP NULL,
        notes TEXT,
        INDEX idx_withdrawal_ref (withdrawal_ref),
        INDEX idx_status (status),
        INDEX idx_requested_at (requested_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } catch (e) {
    console.error("Error ensuring withdrawals table:", e);
  }
}

// Initialize tables
ensurePaymentLogsTable();
ensureWithdrawalsTable();

// Get finance dashboard summary
router.get("/api/finance/summary", requireAdmin, async (req, res) => {
  try {
    const safeSum = async (sql, params = []) => {
      try {
        const [[row]] = await portalDB.query(sql, params);
        const val = row && (row.total ?? Object.values(row)[0]);
        return Number(val || 0);
      } catch (e) {
        return 0;
      }
    };

    const safeCount = async (sql, params = []) => {
      try {
        const [[row]] = await portalDB.query(sql, params);
        const val = row && (row.c ?? Object.values(row)[0]);
        return Number(val || 0);
      } catch (e) {
        return 0;
      }
    };

    // Calculate totals from orders table
    const totalRevenue = await safeSum(
      "SELECT COALESCE(SUM(amount_ugx), 0) AS total FROM orders WHERE status IN ('PAID','SUCCESS','COMPLETED') OR paid_at IS NOT NULL"
    );

    const monthlyRevenue = await safeSum(
      "SELECT COALESCE(SUM(amount_ugx), 0) AS total FROM orders WHERE (status IN ('PAID','SUCCESS','COMPLETED') OR paid_at IS NOT NULL) AND MONTH(paid_at) = MONTH(CURDATE()) AND YEAR(paid_at) = YEAR(CURDATE())"
    );

    const dailyRevenue = await safeSum(
      "SELECT COALESCE(SUM(amount_ugx), 0) AS total FROM orders WHERE (status IN ('PAID','SUCCESS','COMPLETED') OR paid_at IS NOT NULL) AND DATE(paid_at) = CURDATE()"
    );

    const pendingPayments = await safeSum(
      "SELECT COALESCE(SUM(amount_ugx), 0) AS total FROM orders WHERE status = 'PENDING'"
    );

    // Calculate withdrawals
    const totalWithdrawn = await safeSum(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM withdrawals WHERE status = 'completed'"
    );

    const pendingWithdrawals = await safeSum(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM withdrawals WHERE status IN ('pending', 'processing')"
    );

    // Count transactions
    const totalTransactions = await safeCount(
      "SELECT COUNT(*) AS c FROM orders WHERE status IN ('PAID','SUCCESS','COMPLETED') OR paid_at IS NOT NULL"
    );

    const monthlyTransactions = await safeCount(
      "SELECT COUNT(*) AS c FROM orders WHERE (status IN ('PAID','SUCCESS','COMPLETED') OR paid_at IS NOT NULL) AND MONTH(paid_at) = MONTH(CURDATE()) AND YEAR(paid_at) = YEAR(CURDATE())"
    );

    // Available balance = Total Revenue - Total Withdrawn - Pending Withdrawals
    const availableBalance = totalRevenue - totalWithdrawn - pendingWithdrawals;

    res.json({
      ok: true,
      summary: {
        totalRevenue,
        monthlyRevenue,
        dailyRevenue,
        pendingPayments,
        totalWithdrawn,
        pendingWithdrawals,
        availableBalance,
        totalTransactions,
        monthlyTransactions
      }
    });
  } catch (e) {
    console.error("Get finance summary error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Get payment logs with filters
router.get("/api/finance/payments", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const provider = req.query.provider || null;
    const status = req.query.status || null;
    const dateFrom = req.query.date_from || null;
    const dateTo = req.query.date_to || null;

    // Build query from orders table (primary source of payments)
    let whereClause = "WHERE 1=1";
    const params = [];

    if (provider) {
      whereClause += " AND o.payment_provider = ?";
      params.push(provider.toUpperCase());
    }
    if (status) {
      whereClause += " AND o.status = ?";
      params.push(status.toUpperCase());
    }
    if (dateFrom) {
      whereClause += " AND DATE(o.created_at) >= ?";
      params.push(dateFrom);
    }
    if (dateTo) {
      whereClause += " AND DATE(o.created_at) <= ?";
      params.push(dateTo);
    }

    // Get total count
    const [[countResult]] = await portalDB.query(
      `SELECT COUNT(*) as total FROM orders o ${whereClause}`,
      params
    );
    const total = countResult.total;

    // Get payment records
    const [payments] = await portalDB.query(
      `SELECT o.id, o.order_ref as transaction_ref, o.payment_provider as provider_code,
              o.provider_tx_id, o.amount_ugx as amount, 'UGX' as currency,
              o.status, o.created_at as initiated_at, o.paid_at as completed_at,
              c.msisdn as customer_msisdn, p.name as plan_name
       FROM orders o
       LEFT JOIN customers c ON o.customer_id = c.id
       LEFT JOIN plans p ON o.plan_id = p.id
       ${whereClause}
       ORDER BY o.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      ok: true,
      payments,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (e) {
    console.error("Get payment logs error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Get withdrawals
router.get("/api/finance/withdrawals", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const status = req.query.status || null;

    let whereClause = "WHERE 1=1";
    const params = [];

    if (status) {
      whereClause += " AND w.status = ?";
      params.push(status);
    }

    // Get total count
    const [[countResult]] = await portalDB.query(
      `SELECT COUNT(*) as total FROM withdrawals w ${whereClause}`,
      params
    );
    const total = countResult.total;

    // Get withdrawals with user info
    const [withdrawals] = await portalDB.query(
      `SELECT w.*,
              req.full_name as requested_by_name, req.email as requested_by_email,
              apr.full_name as approved_by_name
       FROM withdrawals w
       LEFT JOIN admin_users req ON w.requested_by = req.id
       LEFT JOIN admin_users apr ON w.approved_by = apr.id
       ${whereClause}
       ORDER BY w.requested_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    // Parse JSON destination_details
    const parsedWithdrawals = withdrawals.map(w => ({
      ...w,
      destination_details: typeof w.destination_details === 'string'
        ? JSON.parse(w.destination_details)
        : w.destination_details || {}
    }));

    res.json({
      ok: true,
      withdrawals: parsedWithdrawals,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (e) {
    console.error("Get withdrawals error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Create withdrawal request
router.post("/api/finance/withdrawals", requireAdmin, async (req, res) => {
  try {
    const { amount, destination_type, destination_details, notes } = req.body;

    // Validation
    if (!amount || amount <= 0) {
      return res.status(400).json({ ok: false, message: "Valid amount is required" });
    }
    if (!destination_type || !["bank_account", "mobile_money"].includes(destination_type)) {
      return res.status(400).json({ ok: false, message: "Invalid destination type" });
    }
    if (!destination_details) {
      return res.status(400).json({ ok: false, message: "Destination details are required" });
    }

    // Generate withdrawal reference
    const withdrawalRef = `WD_${nanoid(12)}`;

    await portalDB.query(
      `INSERT INTO withdrawals (withdrawal_ref, amount, destination_type, destination_details, status, requested_by, notes)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      [
        withdrawalRef,
        amount,
        destination_type,
        JSON.stringify(destination_details),
        req.session.admin.id,
        notes || null
      ]
    );

    res.json({ ok: true, message: "Withdrawal request created", withdrawal_ref: withdrawalRef });
  } catch (e) {
    console.error("Create withdrawal error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Update withdrawal status (SUPER_ADMIN only)
router.patch("/api/finance/withdrawals/:id", requireAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const { status, notes } = req.body;
    const validStatuses = ["pending", "processing", "completed", "failed", "cancelled"];

    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ ok: false, message: "Invalid status" });
    }

    const [[withdrawal]] = await portalDB.query(
      "SELECT id, status FROM withdrawals WHERE id = ?",
      [req.params.id]
    );

    if (!withdrawal) {
      return res.status(404).json({ ok: false, message: "Withdrawal not found" });
    }

    // Don't allow changing completed/failed withdrawals
    if (["completed", "failed"].includes(withdrawal.status)) {
      return res.status(400).json({ ok: false, message: "Cannot modify completed or failed withdrawals" });
    }

    let updateQuery = "UPDATE withdrawals SET status = ?";
    let params = [status];

    // Set timestamps based on status
    if (status === "processing") {
      updateQuery += ", processed_at = NOW(), approved_by = ?";
      params.push(req.session.admin.id);
    } else if (status === "completed" || status === "failed") {
      updateQuery += ", completed_at = NOW()";
    }

    if (notes) {
      updateQuery += ", notes = ?";
      params.push(notes);
    }

    updateQuery += " WHERE id = ?";
    params.push(req.params.id);

    await portalDB.query(updateQuery, params);

    res.json({ ok: true, message: `Withdrawal ${status}` });
  } catch (e) {
    console.error("Update withdrawal error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Export payments as CSV
router.get("/api/finance/payments/export", requireAdmin, async (req, res) => {
  try {
    const provider = req.query.provider || null;
    const status = req.query.status || null;
    const dateFrom = req.query.date_from || null;
    const dateTo = req.query.date_to || null;

    let whereClause = "WHERE 1=1";
    const params = [];

    if (provider) {
      whereClause += " AND o.payment_provider = ?";
      params.push(provider.toUpperCase());
    }
    if (status) {
      whereClause += " AND o.status = ?";
      params.push(status.toUpperCase());
    }
    if (dateFrom) {
      whereClause += " AND DATE(o.created_at) >= ?";
      params.push(dateFrom);
    }
    if (dateTo) {
      whereClause += " AND DATE(o.created_at) <= ?";
      params.push(dateTo);
    }

    const [payments] = await portalDB.query(
      `SELECT o.order_ref, o.payment_provider, o.provider_tx_id, o.amount_ugx,
              o.status, o.created_at, o.paid_at, c.msisdn, p.name as plan_name
       FROM orders o
       LEFT JOIN customers c ON o.customer_id = c.id
       LEFT JOIN plans p ON o.plan_id = p.id
       ${whereClause}
       ORDER BY o.created_at DESC`,
      params
    );

    // Generate CSV
    const headers = ['Reference', 'Provider', 'Provider TX ID', 'Amount (UGX)', 'Status', 'Customer', 'Plan', 'Created', 'Paid'];
    const rows = payments.map(p => [
      p.order_ref,
      p.payment_provider || '',
      p.provider_tx_id || '',
      p.amount_ugx,
      p.status,
      p.msisdn || '',
      p.plan_name || '',
      p.created_at ? new Date(p.created_at).toISOString() : '',
      p.paid_at ? new Date(p.paid_at).toISOString() : ''
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.map(v => `"${v}"`).join(','))].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=payments-${Date.now()}.csv`);
    res.send(csv);
  } catch (e) {
    console.error("Export payments error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

module.exports = router;
