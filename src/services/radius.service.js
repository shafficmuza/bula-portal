const radiusDB = require("../config/db.radius");

/**
 * FreeRADIUS "Expiration" attribute expects:
 * "DD Mon YYYY HH:MM:SS"  (e.g. "21 Jan 2026 10:51:05")
 */
function radiusExpiration(d) {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const pad = (n) => String(n).padStart(2, "0");

  // Use SERVER LOCAL TIME (not UTC) to avoid timezone surprises
  const day = pad(d.getDate());
  const mon = months[d.getMonth()];
  const year = d.getFullYear();
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());

  return `${day} ${mon} ${year} ${hh}:${mm}:${ss}`;
}

/**
 * Helper to insert/update a radcheck attribute
 */
async function setRadcheck(username, attribute, op, value) {
  await radiusDB.query(
    `INSERT INTO radcheck (username, attribute, op, value)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE value=VALUES(value), op=VALUES(op)`,
    [username, attribute, op, String(value)]
  );
}

/**
 * Helper to insert/update a radreply attribute
 */
async function setRadreply(username, attribute, op, value) {
  await radiusDB.query(
    `INSERT INTO radreply (username, attribute, op, value)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE value=VALUES(value), op=VALUES(op)`,
    [username, attribute, op, String(value)]
  );
}

/**
 * Helper to delete a radreply attribute
 */
async function deleteRadreply(username, attribute) {
  await radiusDB.query(
    `DELETE FROM radreply WHERE username = ? AND attribute = ?`,
    [username, attribute]
  );
}

/**
 * Activate a voucher in FreeRADIUS SQL with full plan support:
 *
 * @param {Object} options
 * @param {string} options.username - Voucher username/code
 * @param {string} options.password - Voucher password
 * @param {number} options.minutes - Session duration in minutes
 * @param {number} [options.speedDownKbps] - Download speed limit in kbps
 * @param {number} [options.speedUpKbps] - Upload speed limit in kbps
 * @param {number} [options.dataMb] - Data limit in MB (optional)
 * @param {string} [options.rate] - Legacy rate format "XXXXk/XXXXk" (optional, overrides speed params)
 *
 * Sets the following RADIUS attributes:
 * - radcheck: Cleartext-Password (authentication)
 * - radreply: Expiration (absolute expiry time in FreeRADIUS format)
 * - radreply: Session-Timeout (max session time in seconds)
 * - radreply: Mikrotik-Rate-Limit (bandwidth limit for MikroTik)
 * - radreply: Mikrotik-Total-Limit (data cap for MikroTik, if dataMb provided)
 * - radreply: WISPr-Bandwidth-Max-Down (standard bandwidth attribute)
 * - radreply: WISPr-Bandwidth-Max-Up (standard bandwidth attribute)
 */
async function activateVoucher({ username, password, minutes, speedDownKbps, speedUpKbps, dataMb, rate }) {
  if (!username || !password || !minutes) {
    throw new Error("activateVoucher requires username, password, minutes");
  }

  const sessionSeconds = Number(minutes) * 60;
  const expiresAt = new Date(Date.now() + sessionSeconds * 1000);

  // 1. Authentication: Cleartext-Password in radcheck
  await setRadcheck(username, 'Cleartext-Password', ':=', password);

  // 2. Expiration: Absolute time when the voucher expires (FreeRADIUS format)
  await setRadreply(username, 'Expiration', ':=', radiusExpiration(expiresAt));

  // 3. Session-Timeout: Maximum session duration in seconds
  await setRadreply(username, 'Session-Timeout', ':=', sessionSeconds);

  // 4. Idle-Timeout: Disconnect after 5 minutes of inactivity
  await setRadreply(username, 'Idle-Timeout', ':=', 300);

  // 5. Bandwidth/Rate Limiting
  // Determine speeds - prefer explicit params, fallback to legacy rate string
  let downKbps = speedDownKbps;
  let upKbps = speedUpKbps;

  if (rate && !downKbps && !upKbps) {
    // Parse legacy rate format "XXXXk/XXXXk"
    const match = rate.match(/^(\d+)k\/(\d+)k$/);
    if (match) {
      downKbps = parseInt(match[1]);
      upKbps = parseInt(match[2]);
    }
  }

  if (downKbps && upKbps) {
    // MikroTik-Rate-Limit format: "rx-rate/tx-rate" (from client perspective: download/upload)
    // Format: "download/upload" where values are in bits or with k/M suffix
    const mikrotikRate = `${downKbps}k/${upKbps}k`;
    await setRadreply(username, 'Mikrotik-Rate-Limit', ':=', mikrotikRate);

    // WISPr bandwidth attributes (in bits per second)
    await setRadreply(username, 'WISPr-Bandwidth-Max-Down', ':=', downKbps * 1000);
    await setRadreply(username, 'WISPr-Bandwidth-Max-Up', ':=', upKbps * 1000);
  }

  // 6. Data Limit (if specified)
  if (dataMb && Number(dataMb) > 0) {
    const dataBytes = Number(dataMb) * 1024 * 1024; // Convert MB to bytes

    // MikroTik-Total-Limit: Total data limit in bytes
    await setRadreply(username, 'Mikrotik-Total-Limit', ':=', dataBytes);

    // Alternative: Mikrotik-Recv-Limit and Mikrotik-Xmit-Limit for separate down/up limits
    // For now we use total limit which is more common for hotspot vouchers
  }

  return {
    username,
    expiresAt,
    expirationValue: radiusExpiration(expiresAt),
    sessionSeconds,
    speedDownKbps: downKbps,
    speedUpKbps: upKbps,
    dataMb
  };
}

/**
 * Deactivate/disable a voucher in FreeRADIUS
 * Sets Auth-Type to Reject to prevent authentication
 */
async function deactivateVoucher(username) {
  if (!username) {
    throw new Error("deactivateVoucher requires username");
  }

  // Option 1: Set Auth-Type to Reject (user can't authenticate)
  await setRadcheck(username, 'Auth-Type', ':=', 'Reject');

  // Option 2: Set expiration to past date
  const pastDate = new Date(Date.now() - 86400000); // 1 day ago
  await setRadreply(username, 'Expiration', ':=', radiusExpiration(pastDate));

  return { username, deactivated: true };
}

/**
 * Reactivate a previously deactivated voucher
 * Removes the Auth-Type Reject and updates expiration
 */
async function reactivateVoucher({ username, password, minutes, speedDownKbps, speedUpKbps, dataMb }) {
  if (!username) {
    throw new Error("reactivateVoucher requires username");
  }

  // Remove Auth-Type Reject
  await radiusDB.query(
    `DELETE FROM radcheck WHERE username = ? AND attribute = 'Auth-Type'`,
    [username]
  );

  // If password and minutes provided, do a full reactivation
  if (password && minutes) {
    return activateVoucher({ username, password, minutes, speedDownKbps, speedUpKbps, dataMb });
  }

  return { username, reactivated: true };
}

/**
 * Delete a voucher completely from RADIUS database
 */
async function deleteVoucher(username) {
  if (!username) {
    throw new Error("deleteVoucher requires username");
  }

  // Delete from radcheck (authentication)
  await radiusDB.query(`DELETE FROM radcheck WHERE username = ?`, [username]);

  // Delete from radreply (attributes)
  await radiusDB.query(`DELETE FROM radreply WHERE username = ?`, [username]);

  // Delete from radusergroup (group membership)
  await radiusDB.query(`DELETE FROM radusergroup WHERE username = ?`, [username]);

  return { username, deleted: true };
}

/**
 * Get voucher status from RADIUS database
 */
async function getVoucherStatus(username) {
  if (!username) {
    throw new Error("getVoucherStatus requires username");
  }

  // Get radcheck entries
  const [checkRows] = await radiusDB.query(
    `SELECT attribute, op, value FROM radcheck WHERE username = ?`,
    [username]
  );

  // Get radreply entries
  const [replyRows] = await radiusDB.query(
    `SELECT attribute, op, value FROM radreply WHERE username = ?`,
    [username]
  );

  // Get accounting info (last session)
  const [acctRows] = await radiusDB.query(
    `SELECT acctstarttime, acctstoptime, acctinputoctets, acctoutputoctets, acctsessiontime
     FROM radacct WHERE username = ? ORDER BY acctstarttime DESC LIMIT 1`,
    [username]
  );

  // Parse attributes into useful format
  const check = {};
  checkRows.forEach(r => { check[r.attribute] = r.value; });

  const reply = {};
  replyRows.forEach(r => { reply[r.attribute] = r.value; });

  const lastSession = acctRows[0] || null;

  // Determine status
  let status = 'UNKNOWN';
  if (check['Auth-Type'] === 'Reject') {
    status = 'DISABLED';
  } else if (reply['Expiration']) {
    const expDate = parseRadiusExpiration(reply['Expiration']);
    if (expDate && expDate < new Date()) {
      status = 'EXPIRED';
    } else if (check['Cleartext-Password']) {
      status = 'ACTIVE';
    }
  } else if (check['Cleartext-Password']) {
    status = 'ACTIVE';
  }

  return {
    username,
    status,
    hasPassword: !!check['Cleartext-Password'],
    expiration: reply['Expiration'] || null,
    sessionTimeout: reply['Session-Timeout'] ? parseInt(reply['Session-Timeout']) : null,
    rateLimit: reply['Mikrotik-Rate-Limit'] || null,
    dataLimit: reply['Mikrotik-Total-Limit'] ? parseInt(reply['Mikrotik-Total-Limit']) : null,
    lastSession: lastSession ? {
      startTime: lastSession.acctstarttime,
      stopTime: lastSession.acctstoptime,
      inputBytes: lastSession.acctinputoctets,
      outputBytes: lastSession.acctoutputoctets,
      sessionTime: lastSession.acctsessiontime
    } : null,
    radcheck: check,
    radreply: reply
  };
}

/**
 * Parse FreeRADIUS expiration format back to Date
 */
function parseRadiusExpiration(str) {
  if (!str) return null;

  const months = {
    'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3, 'May': 4, 'Jun': 5,
    'Jul': 6, 'Aug': 7, 'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11
  };

  // Try FreeRADIUS format: "DD Mon YYYY HH:MM:SS"
  const match = str.match(/^(\d{2}) (\w{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
  if (match) {
    const [, day, mon, year, hh, mm, ss] = match;
    const month = months[mon];
    if (month !== undefined) {
      return new Date(parseInt(year), month, parseInt(day), parseInt(hh), parseInt(mm), parseInt(ss));
    }
  }

  // Fallback: try ISO format
  const date = new Date(str);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Get usage statistics for a voucher from accounting
 */
async function getVoucherUsage(username) {
  if (!username) {
    throw new Error("getVoucherUsage requires username");
  }

  // Get all accounting records for this user
  const [rows] = await radiusDB.query(
    `SELECT
       COUNT(*) as total_sessions,
       SUM(acctinputoctets) as total_download_bytes,
       SUM(acctoutputoctets) as total_upload_bytes,
       SUM(acctsessiontime) as total_session_seconds,
       MAX(acctstarttime) as last_session_start,
       MAX(acctstoptime) as last_session_stop
     FROM radacct WHERE username = ?`,
    [username]
  );

  const stats = rows[0];

  return {
    username,
    totalSessions: stats.total_sessions || 0,
    totalDownloadMb: stats.total_download_bytes ? Math.round(stats.total_download_bytes / 1024 / 1024 * 100) / 100 : 0,
    totalUploadMb: stats.total_upload_bytes ? Math.round(stats.total_upload_bytes / 1024 / 1024 * 100) / 100 : 0,
    totalSessionMinutes: stats.total_session_seconds ? Math.round(stats.total_session_seconds / 60) : 0,
    lastSessionStart: stats.last_session_start,
    lastSessionStop: stats.last_session_stop
  };
}

/**
 * Disconnect active session (requires COA/POD support in NAS)
 * Note: This sends a signal but actual disconnection depends on NAS configuration
 */
async function disconnectSession(username) {
  // This would typically require RADIUS COA (Change of Authorization) or POD (Packet of Disconnect)
  // For now, we just set the expiration to past which will prevent re-authentication
  const pastDate = new Date(Date.now() - 1000);
  await setRadreply(username, 'Expiration', ':=', radiusExpiration(pastDate));

  return { username, signalSent: true, note: 'Expiration set to past. User will be disconnected on next reauthentication.' };
}

module.exports = {
  activateVoucher,
  deactivateVoucher,
  reactivateVoucher,
  deleteVoucher,
  getVoucherStatus,
  getVoucherUsage,
  disconnectSession,
  radiusExpiration,
  parseRadiusExpiration
};
