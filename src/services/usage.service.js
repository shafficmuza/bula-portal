/**
 * Usage Tracking Service
 *
 * Provides comprehensive data usage tracking and session management
 * by querying RADIUS accounting records.
 */

const radiusDB = require("../config/db.radius");
const portalDB = require("../config/db.portal");

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Format duration in seconds to human readable string
 */
function formatDuration(seconds) {
  if (!seconds || seconds === 0) return '0s';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 && days === 0) parts.push(`${secs}s`);

  return parts.join(' ') || '0s';
}

/**
 * Get all active sessions across all devices
 */
async function getActiveSessions(options = {}) {
  const { limit = 100, offset = 0, search = null, nasIp = null } = options;

  let whereClause = "WHERE acctstoptime IS NULL";
  const params = [];

  if (nasIp) {
    whereClause += " AND nasipaddress = ?";
    params.push(nasIp);
  }

  if (search) {
    whereClause += " AND (username LIKE ? OR framedipaddress LIKE ? OR callingstationid LIKE ?)";
    const searchPattern = `%${search}%`;
    params.push(searchPattern, searchPattern, searchPattern);
  }

  // Get total count
  const [[countResult]] = await radiusDB.query(
    `SELECT COUNT(*) as total FROM radacct ${whereClause}`,
    params
  );

  // Get sessions
  const [sessions] = await radiusDB.query(
    `SELECT
       radacctid,
       username,
       nasipaddress,
       nasportid,
       nasporttype,
       acctstarttime,
       acctsessiontime,
       acctinputoctets as download_bytes,
       acctoutputoctets as upload_bytes,
       framedipaddress as client_ip,
       callingstationid as mac_address,
       servicetype,
       acctterminatecause
     FROM radacct
     ${whereClause}
     ORDER BY acctstarttime DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  // Enrich with device names
  const enrichedSessions = await Promise.all(sessions.map(async (session) => {
    let deviceName = session.nasipaddress;
    try {
      const [[device]] = await portalDB.query(
        "SELECT name FROM devices WHERE ip_address = ?",
        [session.nasipaddress]
      );
      if (device) deviceName = device.name;
    } catch (e) {}

    return {
      ...session,
      device_name: deviceName,
      download_formatted: formatBytes(session.download_bytes),
      upload_formatted: formatBytes(session.upload_bytes),
      total_bytes: (session.download_bytes || 0) + (session.upload_bytes || 0),
      total_formatted: formatBytes((session.download_bytes || 0) + (session.upload_bytes || 0)),
      duration_formatted: formatDuration(session.acctsessiontime),
      is_active: true
    };
  }));

  return {
    sessions: enrichedSessions,
    total: countResult.total,
    limit,
    offset
  };
}

/**
 * Get session history (completed sessions)
 */
async function getSessionHistory(options = {}) {
  const { limit = 100, offset = 0, search = null, username = null, dateFrom = null, dateTo = null } = options;

  let whereClause = "WHERE acctstoptime IS NOT NULL";
  const params = [];

  if (username) {
    whereClause += " AND username = ?";
    params.push(username);
  }

  if (search) {
    whereClause += " AND (username LIKE ? OR framedipaddress LIKE ? OR callingstationid LIKE ?)";
    const searchPattern = `%${search}%`;
    params.push(searchPattern, searchPattern, searchPattern);
  }

  if (dateFrom) {
    whereClause += " AND DATE(acctstarttime) >= ?";
    params.push(dateFrom);
  }

  if (dateTo) {
    whereClause += " AND DATE(acctstarttime) <= ?";
    params.push(dateTo);
  }

  // Get total count
  const [[countResult]] = await radiusDB.query(
    `SELECT COUNT(*) as total FROM radacct ${whereClause}`,
    params
  );

  // Get sessions
  const [sessions] = await radiusDB.query(
    `SELECT
       radacctid,
       username,
       nasipaddress,
       acctstarttime,
       acctstoptime,
       acctsessiontime,
       acctinputoctets as download_bytes,
       acctoutputoctets as upload_bytes,
       framedipaddress as client_ip,
       callingstationid as mac_address,
       acctterminatecause
     FROM radacct
     ${whereClause}
     ORDER BY acctstarttime DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  // Enrich sessions
  const enrichedSessions = sessions.map(session => ({
    ...session,
    download_formatted: formatBytes(session.download_bytes),
    upload_formatted: formatBytes(session.upload_bytes),
    total_bytes: (session.download_bytes || 0) + (session.upload_bytes || 0),
    total_formatted: formatBytes((session.download_bytes || 0) + (session.upload_bytes || 0)),
    duration_formatted: formatDuration(session.acctsessiontime),
    is_active: false
  }));

  return {
    sessions: enrichedSessions,
    total: countResult.total,
    limit,
    offset
  };
}

/**
 * Get usage statistics by user (top users by data usage)
 */
async function getTopUsers(options = {}) {
  const { limit = 50, period = 'all', sortBy = 'total' } = options;

  let dateFilter = "";
  if (period === 'today') {
    dateFilter = "AND DATE(acctstarttime) = CURDATE()";
  } else if (period === 'week') {
    dateFilter = "AND acctstarttime >= DATE_SUB(NOW(), INTERVAL 7 DAY)";
  } else if (period === 'month') {
    dateFilter = "AND acctstarttime >= DATE_SUB(NOW(), INTERVAL 30 DAY)";
  }

  const orderBy = sortBy === 'download' ? 'total_download DESC' :
                  sortBy === 'upload' ? 'total_upload DESC' :
                  sortBy === 'sessions' ? 'session_count DESC' :
                  sortBy === 'time' ? 'total_time DESC' :
                  '(total_download + total_upload) DESC';

  const [users] = await radiusDB.query(
    `SELECT
       username,
       COUNT(*) as session_count,
       SUM(acctinputoctets) as total_download,
       SUM(acctoutputoctets) as total_upload,
       SUM(acctsessiontime) as total_time,
       MAX(acctstarttime) as last_session,
       MIN(acctstarttime) as first_session,
       COUNT(CASE WHEN acctstoptime IS NULL THEN 1 END) as active_sessions
     FROM radacct
     WHERE 1=1 ${dateFilter}
     GROUP BY username
     ORDER BY ${orderBy}
     LIMIT ?`,
    [limit]
  );

  // Get voucher/order details for each user
  const enrichedUsers = await Promise.all(users.map(async (user) => {
    let planName = null;
    let source = null;

    try {
      // Check vouchers table
      const [[voucher]] = await portalDB.query(
        `SELECT v.id, v.status, p.name as plan_name
         FROM vouchers v
         LEFT JOIN plans p ON v.plan_id = p.id
         WHERE v.code = ?`,
        [user.username]
      );

      if (voucher) {
        planName = voucher.plan_name;
        source = 'voucher';
      } else {
        // Check orders table
        const [[order]] = await portalDB.query(
          `SELECT o.id, o.status, p.name as plan_name
           FROM orders o
           LEFT JOIN plans p ON o.plan_id = p.id
           WHERE o.username = ?`,
          [user.username]
        );

        if (order) {
          planName = order.plan_name;
          source = 'order';
        }
      }
    } catch (e) {}

    return {
      ...user,
      plan_name: planName,
      source,
      total_download_formatted: formatBytes(user.total_download),
      total_upload_formatted: formatBytes(user.total_upload),
      total_data: (user.total_download || 0) + (user.total_upload || 0),
      total_data_formatted: formatBytes((user.total_download || 0) + (user.total_upload || 0)),
      total_time_formatted: formatDuration(user.total_time),
      is_online: user.active_sessions > 0
    };
  }));

  return enrichedUsers;
}

/**
 * Get detailed usage for a specific user/voucher
 */
async function getUserUsageDetails(username) {
  // Get aggregate stats
  const [[stats]] = await radiusDB.query(
    `SELECT
       COUNT(*) as total_sessions,
       COUNT(CASE WHEN acctstoptime IS NULL THEN 1 END) as active_sessions,
       SUM(acctinputoctets) as total_download,
       SUM(acctoutputoctets) as total_upload,
       SUM(acctsessiontime) as total_time,
       MIN(acctstarttime) as first_session,
       MAX(acctstarttime) as last_session,
       AVG(acctsessiontime) as avg_session_time
     FROM radacct
     WHERE username = ?`,
    [username]
  );

  // Get recent sessions
  const [recentSessions] = await radiusDB.query(
    `SELECT
       radacctid,
       nasipaddress,
       acctstarttime,
       acctstoptime,
       acctsessiontime,
       acctinputoctets as download_bytes,
       acctoutputoctets as upload_bytes,
       framedipaddress as client_ip,
       callingstationid as mac_address,
       acctterminatecause
     FROM radacct
     WHERE username = ?
     ORDER BY acctstarttime DESC
     LIMIT 20`,
    [username]
  );

  // Get daily usage for the last 7 days
  const [dailyUsage] = await radiusDB.query(
    `SELECT
       DATE(acctstarttime) as date,
       COUNT(*) as sessions,
       SUM(acctinputoctets) as download,
       SUM(acctoutputoctets) as upload,
       SUM(acctsessiontime) as time
     FROM radacct
     WHERE username = ? AND acctstarttime >= DATE_SUB(NOW(), INTERVAL 7 DAY)
     GROUP BY DATE(acctstarttime)
     ORDER BY date DESC`,
    [username]
  );

  // Get unique devices/locations used
  const [devices] = await radiusDB.query(
    `SELECT DISTINCT nasipaddress, COUNT(*) as session_count
     FROM radacct WHERE username = ?
     GROUP BY nasipaddress
     ORDER BY session_count DESC`,
    [username]
  );

  // Get unique MACs used
  const [macs] = await radiusDB.query(
    `SELECT DISTINCT callingstationid as mac, COUNT(*) as session_count
     FROM radacct WHERE username = ? AND callingstationid IS NOT NULL
     GROUP BY callingstationid
     ORDER BY session_count DESC`,
    [username]
  );

  // Get voucher/order info
  let voucherInfo = null;
  try {
    const [[voucher]] = await portalDB.query(
      `SELECT v.*, p.name as plan_name, p.duration_minutes, p.data_mb, p.speed_down_kbps, p.speed_up_kbps
       FROM vouchers v
       LEFT JOIN plans p ON v.plan_id = p.id
       WHERE v.code = ?`,
      [username]
    );

    if (voucher) {
      voucherInfo = { ...voucher, source: 'voucher' };
    } else {
      const [[order]] = await portalDB.query(
        `SELECT o.*, p.name as plan_name, p.duration_minutes, p.data_mb, p.speed_down_kbps, p.speed_up_kbps
         FROM orders o
         LEFT JOIN plans p ON o.plan_id = p.id
         WHERE o.username = ?`,
        [username]
      );
      if (order) {
        voucherInfo = { ...order, source: 'order' };
      }
    }
  } catch (e) {}

  return {
    username,
    stats: {
      ...stats,
      total_download_formatted: formatBytes(stats.total_download),
      total_upload_formatted: formatBytes(stats.total_upload),
      total_data: (stats.total_download || 0) + (stats.total_upload || 0),
      total_data_formatted: formatBytes((stats.total_download || 0) + (stats.total_upload || 0)),
      total_time_formatted: formatDuration(stats.total_time),
      avg_session_time_formatted: formatDuration(Math.round(stats.avg_session_time || 0)),
      is_online: stats.active_sessions > 0
    },
    voucherInfo,
    recentSessions: recentSessions.map(s => ({
      ...s,
      download_formatted: formatBytes(s.download_bytes),
      upload_formatted: formatBytes(s.upload_bytes),
      duration_formatted: formatDuration(s.acctsessiontime),
      is_active: !s.acctstoptime
    })),
    dailyUsage: dailyUsage.map(d => ({
      ...d,
      download_formatted: formatBytes(d.download),
      upload_formatted: formatBytes(d.upload),
      time_formatted: formatDuration(d.time)
    })),
    devices,
    macs
  };
}

/**
 * Get overall usage statistics
 */
async function getUsageSummary(period = 'today') {
  let dateFilter = "";
  if (period === 'today') {
    dateFilter = "AND DATE(acctstarttime) = CURDATE()";
  } else if (period === 'week') {
    dateFilter = "AND acctstarttime >= DATE_SUB(NOW(), INTERVAL 7 DAY)";
  } else if (period === 'month') {
    dateFilter = "AND acctstarttime >= DATE_SUB(NOW(), INTERVAL 30 DAY)";
  }

  // Get summary stats
  const [[summary]] = await radiusDB.query(
    `SELECT
       COUNT(*) as total_sessions,
       COUNT(DISTINCT username) as unique_users,
       SUM(acctinputoctets) as total_download,
       SUM(acctoutputoctets) as total_upload,
       SUM(acctsessiontime) as total_time,
       AVG(acctsessiontime) as avg_session_time
     FROM radacct
     WHERE 1=1 ${dateFilter}`
  );

  // Get active sessions count
  const [[active]] = await radiusDB.query(
    `SELECT COUNT(*) as count FROM radacct WHERE acctstoptime IS NULL`
  );

  // Get hourly distribution for today
  const [hourlyDist] = await radiusDB.query(
    `SELECT
       HOUR(acctstarttime) as hour,
       COUNT(*) as sessions,
       SUM(acctinputoctets) as download,
       SUM(acctoutputoctets) as upload
     FROM radacct
     WHERE DATE(acctstarttime) = CURDATE()
     GROUP BY HOUR(acctstarttime)
     ORDER BY hour`
  );

  return {
    period,
    summary: {
      ...summary,
      active_sessions: active.count,
      total_download_formatted: formatBytes(summary.total_download),
      total_upload_formatted: formatBytes(summary.total_upload),
      total_data: (summary.total_download || 0) + (summary.total_upload || 0),
      total_data_formatted: formatBytes((summary.total_download || 0) + (summary.total_upload || 0)),
      total_time_formatted: formatDuration(summary.total_time),
      avg_session_time_formatted: formatDuration(Math.round(summary.avg_session_time || 0))
    },
    hourlyDistribution: hourlyDist.map(h => ({
      ...h,
      download_formatted: formatBytes(h.download),
      upload_formatted: formatBytes(h.upload)
    }))
  };
}

/**
 * Disconnect a user session (by setting expiration to past)
 */
async function disconnectUser(username) {
  try {
    // Set expiration to past time to force disconnection
    const pastDate = new Date(Date.now() - 1000);
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const pad = (n) => String(n).padStart(2, "0");
    const day = pad(pastDate.getDate());
    const mon = months[pastDate.getMonth()];
    const year = pastDate.getFullYear();
    const hh = pad(pastDate.getHours());
    const mm = pad(pastDate.getMinutes());
    const ss = pad(pastDate.getSeconds());
    const expValue = `${day} ${mon} ${year} ${hh}:${mm}:${ss}`;

    // Update radreply to expire the user
    await radiusDB.query(
      `INSERT INTO radreply (username, attribute, op, value)
       VALUES (?, 'Expiration', ':=', ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
      [username, expValue]
    );

    // Also set Session-Timeout to 0
    await radiusDB.query(
      `INSERT INTO radreply (username, attribute, op, value)
       VALUES (?, 'Session-Timeout', ':=', '0')
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
      [username]
    );

    return { success: true, message: `User ${username} will be disconnected on next re-auth` };
  } catch (e) {
    console.error("Error disconnecting user:", e);
    return { success: false, error: e.message };
  }
}

module.exports = {
  getActiveSessions,
  getSessionHistory,
  getTopUsers,
  getUserUsageDetails,
  getUsageSummary,
  disconnectUser,
  formatBytes,
  formatDuration
};
