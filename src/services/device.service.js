const radiusDB = require("../config/db.radius");
const portalDB = require("../config/db.portal");
const { exec } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);

/**
 * Device/NAS vendor types
 */
const VENDOR_TYPES = {
  mikrotik: { name: "MikroTik", ports: 1812 },
  ubiquiti: { name: "Ubiquiti", ports: 1812 },
  cisco: { name: "Cisco", ports: 1812 },
  other: { name: "Other", ports: 1812 },
};

/**
 * Ping a device to check if it's online
 * @param {string} ipAddress - IP address to ping
 * @returns {Promise<{online: boolean, latency: number|null}>}
 */
async function pingDevice(ipAddress) {
  try {
    // Use fping for faster results, fallback to ping
    const { stdout } = await execAsync(
      `ping -c 1 -W 2 ${ipAddress} 2>/dev/null | grep -oP 'time=\\K[0-9.]+'`,
      { timeout: 5000 }
    );
    const latency = parseFloat(stdout.trim());
    return { online: true, latency: isNaN(latency) ? null : latency };
  } catch (e) {
    return { online: false, latency: null };
  }
}

/**
 * Check status of multiple devices in parallel
 * @param {Array<{id: number, ip_address: string}>} devices
 * @returns {Promise<Map<number, {online: boolean, latency: number|null}>>}
 */
async function checkDevicesStatus(devices) {
  const results = new Map();
  const promises = devices.map(async (device) => {
    const status = await pingDevice(device.ip_address);
    results.set(device.id, status);
  });
  await Promise.all(promises);
  return results;
}

/**
 * Get connected users count for a NAS from radacct
 * @param {string} nasIpAddress - NAS IP address
 * @returns {Promise<number>}
 */
async function getConnectedUsersCount(nasIpAddress) {
  try {
    const [[row]] = await radiusDB.query(
      `SELECT COUNT(DISTINCT username) as count
       FROM radacct
       WHERE nasipaddress = ?
       AND acctstoptime IS NULL`,
      [nasIpAddress]
    );
    return row?.count || 0;
  } catch (e) {
    console.error("Error getting connected users:", e.message);
    return 0;
  }
}

/**
 * Get bandwidth usage for a NAS from radacct
 * @param {string} nasIpAddress - NAS IP address
 * @param {string} period - 'today', 'week', 'month', 'all'
 * @returns {Promise<{download: number, upload: number}>}
 */
async function getNasBandwidthUsage(nasIpAddress, period = "today") {
  try {
    let dateFilter = "";
    switch (period) {
      case "today":
        dateFilter = "AND DATE(acctstarttime) = CURDATE()";
        break;
      case "week":
        dateFilter = "AND acctstarttime >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)";
        break;
      case "month":
        dateFilter = "AND acctstarttime >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)";
        break;
      default:
        dateFilter = "";
    }

    const [[row]] = await radiusDB.query(
      `SELECT
        COALESCE(SUM(acctinputoctets), 0) as download,
        COALESCE(SUM(acctoutputoctets), 0) as upload
       FROM radacct
       WHERE nasipaddress = ? ${dateFilter}`,
      [nasIpAddress]
    );

    return {
      download: row?.download || 0,
      upload: row?.upload || 0,
    };
  } catch (e) {
    console.error("Error getting bandwidth usage:", e.message);
    return { download: 0, upload: 0 };
  }
}

/**
 * Get stats for a single device
 * @param {string} nasIpAddress
 * @returns {Promise<Object>}
 */
async function getDeviceStats(nasIpAddress) {
  const [connectedUsers, bandwidthToday] = await Promise.all([
    getConnectedUsersCount(nasIpAddress),
    getNasBandwidthUsage(nasIpAddress, "today"),
  ]);

  return {
    connectedUsers,
    bandwidthToday,
  };
}

/**
 * Sync device to FreeRADIUS NAS table
 * @param {Object} device
 */
async function syncToRadiusNas(device) {
  const { ip_address, shortname, secret, vendor, description } = device;

  // Check if NAS already exists
  const [[existing]] = await radiusDB.query(
    "SELECT id FROM nas WHERE nasname = ?",
    [ip_address]
  );

  if (existing) {
    // Update existing NAS
    await radiusDB.query(
      `UPDATE nas SET
        shortname = ?,
        type = ?,
        secret = ?,
        description = ?
       WHERE nasname = ?`,
      [shortname, vendor || "other", secret, description || "", ip_address]
    );
  } else {
    // Insert new NAS
    await radiusDB.query(
      `INSERT INTO nas (nasname, shortname, type, ports, secret, server, community, description)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
      [ip_address, shortname, vendor || "other", 1812, secret, description || ""]
    );
  }
}

/**
 * Remove device from FreeRADIUS NAS table
 * @param {string} ipAddress
 */
async function removeFromRadiusNas(ipAddress) {
  await radiusDB.query("DELETE FROM nas WHERE nasname = ?", [ipAddress]);
}

/**
 * Get all active sessions for a NAS
 * @param {string} nasIpAddress
 * @returns {Promise<Array>}
 */
async function getNasActiveSessions(nasIpAddress) {
  const [rows] = await radiusDB.query(
    `SELECT
      username,
      nasportid,
      acctstarttime,
      acctinputoctets as download,
      acctoutputoctets as upload,
      acctsessiontime,
      framedipaddress,
      callingstationid as mac_address
     FROM radacct
     WHERE nasipaddress = ?
     AND acctstoptime IS NULL
     ORDER BY acctstarttime DESC`,
    [nasIpAddress]
  );
  return rows || [];
}

/**
 * Format bytes to human readable
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

module.exports = {
  VENDOR_TYPES,
  pingDevice,
  checkDevicesStatus,
  getConnectedUsersCount,
  getNasBandwidthUsage,
  getDeviceStats,
  syncToRadiusNas,
  removeFromRadiusNas,
  getNasActiveSessions,
  formatBytes,
};
