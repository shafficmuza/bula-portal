/**
 * MikroTik RouterOS API Service
 *
 * Provides integration with MikroTik routers for automatic WiFi login
 * after successful payment by creating IP bindings.
 */

const portalDB = require("../config/db.portal");

/**
 * Normalize MAC address to XX:XX:XX:XX:XX:XX format (uppercase)
 * @param {string} mac - MAC address in any format
 * @returns {string|null} Normalized MAC or null if invalid
 */
function normalizeMacAddress(mac) {
  if (!mac) return null;

  // Remove all non-hex characters
  const cleaned = mac.replace(/[^a-fA-F0-9]/g, "");

  // Must be exactly 12 hex characters
  if (cleaned.length !== 12) return null;

  // Format as XX:XX:XX:XX:XX:XX (uppercase)
  const formatted = cleaned
    .toUpperCase()
    .match(/.{2}/g)
    .join(":");

  return formatted;
}

/**
 * Get MikroTik configuration from database
 * @returns {Promise<Object|null>} MikroTik config or null
 */
async function getConfig() {
  try {
    const [[settings]] = await portalDB.query(
      `SELECT mikrotik_enabled, mikrotik_host, mikrotik_port,
              mikrotik_username, mikrotik_password, mikrotik_hotspot_server
       FROM business_settings WHERE id = 1`
    );

    if (!settings) return null;

    return {
      enabled: Boolean(settings.mikrotik_enabled),
      host: settings.mikrotik_host,
      port: settings.mikrotik_port || 8728,
      username: settings.mikrotik_username,
      password: settings.mikrotik_password,
      hotspotServer: settings.mikrotik_hotspot_server || "hotspot1",
    };
  } catch (e) {
    console.error("Error getting MikroTik config:", e.message);
    return null;
  }
}

/**
 * Check if MikroTik integration is available and configured
 * @returns {Promise<boolean>}
 */
async function isAvailable() {
  const config = await getConfig();
  return !!(
    config &&
    config.enabled &&
    config.host &&
    config.username &&
    config.password
  );
}

/**
 * Execute MikroTik API command using RouterOS API
 * @param {Object} config - MikroTik configuration
 * @param {string} command - API command path (e.g., '/ip/hotspot/ip-binding/add')
 * @param {Object} params - Command parameters
 * @returns {Promise<Object>} API response
 */
async function executeCommand(config, command, params = {}) {
  const RosApi = require("node-routeros").RouterOSAPI;

  const conn = new RosApi({
    host: config.host,
    port: config.port || 8728,
    user: config.username,
    password: config.password,
    timeout: 10,
  });

  try {
    await conn.connect();

    // Build command with parameters
    const result = await conn.write(command, Object.entries(params).map(
      ([key, value]) => `=${key}=${value}`
    ));

    await conn.close();
    return { success: true, data: result };
  } catch (error) {
    try {
      await conn.close();
    } catch (e) {
      // Ignore close errors
    }
    throw error;
  }
}

/**
 * Test connection to MikroTik router
 * @returns {Promise<Object>} Connection test result
 */
async function testConnection() {
  try {
    const config = await getConfig();

    if (!config || !config.host || !config.username) {
      return {
        success: false,
        message: "MikroTik not configured",
      };
    }

    // Try to get system identity
    const result = await executeCommand(config, "/system/identity/print");

    const identity = result.data?.[0]?.name || "Unknown";

    // Also try to get RouterOS version
    let version = "Unknown";
    try {
      const resourceResult = await executeCommand(config, "/system/resource/print");
      version = resourceResult.data?.[0]?.version || "Unknown";
    } catch (e) {
      // Version fetch failed, continue with identity only
    }

    return {
      success: true,
      message: `Connected to ${identity}`,
      identity,
      version,
    };
  } catch (error) {
    console.error("MikroTik connection test failed:", error.message);
    return {
      success: false,
      message: error.message || "Connection failed",
    };
  }
}

/**
 * Authorize MAC address by creating an IP binding (bypassed)
 * This allows the device to access internet without hotspot login
 *
 * @param {Object} options
 * @param {string} options.mac - MAC address to authorize
 * @param {string} options.ip - IP address (optional)
 * @param {number} options.durationMinutes - Binding duration in minutes
 * @param {string} options.comment - Comment for the binding
 * @param {number} options.orderId - Order ID for tracking
 * @returns {Promise<Object>} Result of the operation
 */
async function authorizeMacBinding(options) {
  const { mac, ip, durationMinutes, comment, orderId } = options;

  try {
    const config = await getConfig();

    if (!config || !config.enabled) {
      return {
        success: false,
        status: "skipped",
        message: "MikroTik not enabled",
      };
    }

    const normalizedMac = normalizeMacAddress(mac);
    if (!normalizedMac) {
      return {
        success: false,
        status: "failed",
        message: "Invalid MAC address",
      };
    }

    // Build binding parameters
    const bindingParams = {
      "mac-address": normalizedMac,
      type: "bypassed",
      comment: comment || `Bula WiFi - Order ${orderId || "N/A"}`,
    };

    // Add IP if provided
    if (ip) {
      bindingParams.address = ip;
    }

    // Add hotspot server if configured
    if (config.hotspotServer) {
      bindingParams.server = config.hotspotServer;
    }

    // First, check if binding already exists and remove it
    try {
      const existingResult = await executeCommand(config, "/ip/hotspot/ip-binding/print", {
        "?mac-address": normalizedMac,
      });

      if (existingResult.data && existingResult.data.length > 0) {
        // Remove existing binding
        for (const binding of existingResult.data) {
          if (binding[".id"]) {
            await executeCommand(config, "/ip/hotspot/ip-binding/remove", {
              ".id": binding[".id"],
            });
          }
        }
      }
    } catch (e) {
      // Ignore errors when checking/removing existing bindings
      console.log("Note: Could not check existing bindings:", e.message);
    }

    // Create the IP binding
    const result = await executeCommand(config, "/ip/hotspot/ip-binding/add", bindingParams);

    // Get the binding ID from result
    const bindingId = result.data?.ret || result.data?.[0]?.[".id"] || null;

    // Log to mac_bindings table
    try {
      const expiresAt = durationMinutes
        ? new Date(Date.now() + durationMinutes * 60 * 1000)
        : null;

      await portalDB.query(
        `INSERT INTO mac_bindings
         (order_id, mac_address, ip_address, mikrotik_host, binding_type, status, mikrotik_id, expires_at)
         VALUES (?, ?, ?, ?, 'ip-binding', 'active', ?, ?)`,
        [orderId || 0, normalizedMac, ip || null, config.host, bindingId, expiresAt]
      );
    } catch (dbError) {
      console.error("Error logging MAC binding:", dbError.message);
    }

    return {
      success: true,
      status: "success",
      message: "Device authorized for WiFi access",
      bindingId,
      mac: normalizedMac,
    };
  } catch (error) {
    console.error("MikroTik authorizeMacBinding error:", error.message);

    // Log failed attempt
    try {
      await portalDB.query(
        `INSERT INTO mac_bindings
         (order_id, mac_address, ip_address, binding_type, status)
         VALUES (?, ?, ?, 'ip-binding', 'pending')`,
        [orderId || 0, normalizeMacAddress(mac) || mac, ip || null]
      );
    } catch (dbError) {
      // Ignore logging errors
    }

    return {
      success: false,
      status: "failed",
      message: error.message || "Failed to authorize device",
    };
  }
}

/**
 * Remove MAC binding from MikroTik
 * @param {string} mac - MAC address to remove
 * @returns {Promise<Object>} Result of the operation
 */
async function removeMacBinding(mac) {
  try {
    const config = await getConfig();

    if (!config || !config.enabled) {
      return { success: false, message: "MikroTik not enabled" };
    }

    const normalizedMac = normalizeMacAddress(mac);
    if (!normalizedMac) {
      return { success: false, message: "Invalid MAC address" };
    }

    // Find and remove bindings with this MAC
    const existingResult = await executeCommand(config, "/ip/hotspot/ip-binding/print", {
      "?mac-address": normalizedMac,
    });

    if (!existingResult.data || existingResult.data.length === 0) {
      return { success: true, message: "No binding found" };
    }

    // Remove all bindings for this MAC
    for (const binding of existingResult.data) {
      if (binding[".id"]) {
        await executeCommand(config, "/ip/hotspot/ip-binding/remove", {
          ".id": binding[".id"],
        });
      }
    }

    // Update database
    await portalDB.query(
      "UPDATE mac_bindings SET status = 'removed' WHERE mac_address = ? AND status = 'active'",
      [normalizedMac]
    );

    return {
      success: true,
      message: `Removed ${existingResult.data.length} binding(s)`,
    };
  } catch (error) {
    console.error("MikroTik removeMacBinding error:", error.message);
    return {
      success: false,
      message: error.message || "Failed to remove binding",
    };
  }
}

/**
 * Get active bindings from MikroTik
 * @returns {Promise<Object>} List of bindings
 */
async function getActiveBindings() {
  try {
    const config = await getConfig();

    if (!config || !config.enabled) {
      return { success: false, message: "MikroTik not enabled", bindings: [] };
    }

    const result = await executeCommand(config, "/ip/hotspot/ip-binding/print");

    return {
      success: true,
      bindings: result.data || [],
    };
  } catch (error) {
    console.error("MikroTik getActiveBindings error:", error.message);
    return {
      success: false,
      message: error.message,
      bindings: [],
    };
  }
}

module.exports = {
  normalizeMacAddress,
  getConfig,
  isAvailable,
  testConnection,
  authorizeMacBinding,
  removeMacBinding,
  getActiveBindings,
};
