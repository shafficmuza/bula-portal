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

module.exports = router;
