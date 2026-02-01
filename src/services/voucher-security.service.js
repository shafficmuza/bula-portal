/**
 * Voucher Security Service
 *
 * Provides security features for voucher validation:
 * - Rate limiting per IP address
 * - Tracking validation attempts
 * - Detecting and flagging suspicious activity
 * - Preventing multiple voucher usage
 */

const portalDB = require("../config/db.portal");
const radiusDB = require("../config/db.radius");

// In-memory rate limiting (per IP)
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute window
const MAX_ATTEMPTS_PER_WINDOW = 10; // Max 10 attempts per minute
const LOCKOUT_THRESHOLD = 30; // Lock out after 30 failed attempts in 5 minutes
const LOCKOUT_WINDOW_MS = 5 * 60 * 1000; // 5 minute window for lockout tracking
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minute lockout

// Track failed attempts for lockout
const failedAttemptsStore = new Map();
const lockedOutIps = new Map();

/**
 * Ensure security tables exist
 */
async function ensureSecurityTables() {
  try {
    await portalDB.query(`
      CREATE TABLE IF NOT EXISTS voucher_security_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        event_type ENUM('validation_attempt', 'validation_success', 'validation_failed',
                        'voucher_used', 'suspicious_activity', 'rate_limit_exceeded',
                        'ip_locked', 'multiple_use_attempt') NOT NULL,
        voucher_code VARCHAR(50),
        ip_address VARCHAR(45),
        user_agent TEXT,
        details JSON,
        severity ENUM('info', 'warning', 'critical') DEFAULT 'info',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_event_type (event_type),
        INDEX idx_voucher_code (voucher_code),
        INDEX idx_ip_address (ip_address),
        INDEX idx_severity (severity),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Table to track voucher usage
    await portalDB.query(`
      CREATE TABLE IF NOT EXISTS voucher_usage (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        voucher_code VARCHAR(50) NOT NULL,
        voucher_source ENUM('vouchers', 'orders') NOT NULL,
        source_id BIGINT NOT NULL,
        used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        used_by_ip VARCHAR(45),
        used_by_mac VARCHAR(17),
        user_agent TEXT,
        session_id VARCHAR(100),
        UNIQUE KEY unique_voucher (voucher_code),
        INDEX idx_used_at (used_at),
        INDEX idx_used_by_ip (used_by_ip)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Flagged IPs table for persistent blocking
    await portalDB.query(`
      CREATE TABLE IF NOT EXISTS flagged_ips (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        ip_address VARCHAR(45) NOT NULL UNIQUE,
        reason VARCHAR(255),
        failed_attempts INT DEFAULT 0,
        flagged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        blocked_until TIMESTAMP NULL,
        is_permanent TINYINT(1) DEFAULT 0,
        INDEX idx_ip_address (ip_address),
        INDEX idx_blocked_until (blocked_until)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } catch (e) {
    console.error("Error creating security tables:", e);
  }
}

// Initialize tables on module load
ensureSecurityTables();

/**
 * Log a security event
 */
async function logSecurityEvent(eventType, data) {
  try {
    const { voucherCode, ipAddress, userAgent, details, severity = 'info' } = data;

    await portalDB.query(
      `INSERT INTO voucher_security_logs (event_type, voucher_code, ip_address, user_agent, details, severity)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [eventType, voucherCode || null, ipAddress || null, userAgent || null,
       details ? JSON.stringify(details) : null, severity]
    );
  } catch (e) {
    console.error("Error logging security event:", e);
  }
}

/**
 * Check if IP is rate limited
 * @returns {Object} { allowed: boolean, remaining: number, retryAfter: number }
 */
function checkRateLimit(ipAddress) {
  const now = Date.now();
  const key = `rate_${ipAddress}`;

  // Check if IP is locked out
  if (lockedOutIps.has(ipAddress)) {
    const lockoutEnd = lockedOutIps.get(ipAddress);
    if (now < lockoutEnd) {
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.ceil((lockoutEnd - now) / 1000),
        locked: true,
        reason: 'Too many failed attempts. IP temporarily blocked.'
      };
    } else {
      // Lockout expired
      lockedOutIps.delete(ipAddress);
    }
  }

  // Get or create rate limit entry
  let entry = rateLimitStore.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { windowStart: now, count: 0 };
  }

  entry.count++;
  rateLimitStore.set(key, entry);

  const remaining = Math.max(0, MAX_ATTEMPTS_PER_WINDOW - entry.count);
  const allowed = entry.count <= MAX_ATTEMPTS_PER_WINDOW;

  return {
    allowed,
    remaining,
    retryAfter: allowed ? 0 : Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000),
    locked: false
  };
}

/**
 * Track failed attempt for lockout calculation
 */
function trackFailedAttempt(ipAddress) {
  const now = Date.now();
  const key = `failed_${ipAddress}`;

  let entry = failedAttemptsStore.get(key);
  if (!entry || now - entry.windowStart > LOCKOUT_WINDOW_MS) {
    entry = { windowStart: now, count: 0 };
  }

  entry.count++;
  failedAttemptsStore.set(key, entry);

  // Check if should lock out
  if (entry.count >= LOCKOUT_THRESHOLD) {
    lockedOutIps.set(ipAddress, now + LOCKOUT_DURATION_MS);
    return { lockedOut: true, duration: LOCKOUT_DURATION_MS / 1000 };
  }

  return { lockedOut: false, failedCount: entry.count };
}

/**
 * Check if IP is blocked (persistent check from database)
 */
async function isIpBlocked(ipAddress) {
  try {
    const [[flagged]] = await portalDB.query(
      `SELECT * FROM flagged_ips WHERE ip_address = ?
       AND (is_permanent = 1 OR blocked_until > NOW())`,
      [ipAddress]
    );
    return flagged ? { blocked: true, reason: flagged.reason } : { blocked: false };
  } catch (e) {
    return { blocked: false };
  }
}

/**
 * Flag an IP address for suspicious activity
 */
async function flagIpAddress(ipAddress, reason, blockDurationMinutes = 60) {
  try {
    const blockedUntil = new Date(Date.now() + blockDurationMinutes * 60 * 1000);

    await portalDB.query(
      `INSERT INTO flagged_ips (ip_address, reason, failed_attempts, blocked_until)
       VALUES (?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE
         reason = VALUES(reason),
         failed_attempts = failed_attempts + 1,
         blocked_until = VALUES(blocked_until),
         flagged_at = NOW()`,
      [ipAddress, reason, blockedUntil]
    );

    await logSecurityEvent('ip_locked', {
      ipAddress,
      severity: 'critical',
      details: { reason, blockedUntil, blockDurationMinutes }
    });
  } catch (e) {
    console.error("Error flagging IP:", e);
  }
}

/**
 * Check if voucher has already been used (in RADIUS or in usage table)
 * @returns {Object} { used: boolean, usedAt: Date, sessions: number }
 */
async function checkVoucherUsed(voucherCode) {
  try {
    // Check voucher_usage table first
    const [[usage]] = await portalDB.query(
      `SELECT * FROM voucher_usage WHERE voucher_code = ?`,
      [voucherCode]
    );

    if (usage) {
      return {
        used: true,
        usedAt: usage.used_at,
        usedByIp: usage.used_by_ip,
        source: 'usage_table'
      };
    }

    // Check RADIUS accounting for any sessions with this username
    const [[acct]] = await radiusDB.query(
      `SELECT COUNT(*) as session_count,
              MIN(acctstarttime) as first_session,
              MAX(acctstarttime) as last_session
       FROM radacct WHERE username = ?`,
      [voucherCode]
    );

    if (acct && acct.session_count > 0) {
      return {
        used: true,
        usedAt: acct.first_session,
        lastSession: acct.last_session,
        sessionCount: acct.session_count,
        source: 'radius_accounting'
      };
    }

    return { used: false };
  } catch (e) {
    console.error("Error checking voucher usage:", e);
    return { used: false, error: e.message };
  }
}

/**
 * Check if voucher has an active session currently
 */
async function hasActiveSession(voucherCode) {
  try {
    const [[session]] = await radiusDB.query(
      `SELECT radacctid, acctstarttime, nasipaddress, framedipaddress
       FROM radacct
       WHERE username = ? AND acctstoptime IS NULL
       ORDER BY acctstarttime DESC LIMIT 1`,
      [voucherCode]
    );

    return session ? {
      active: true,
      sessionId: session.radacctid,
      startTime: session.acctstarttime,
      nasIp: session.nasipaddress,
      clientIp: session.framedipaddress
    } : { active: false };
  } catch (e) {
    console.error("Error checking active session:", e);
    return { active: false, error: e.message };
  }
}

/**
 * Mark a voucher as used
 */
async function markVoucherUsed(voucherCode, source, sourceId, metadata = {}) {
  try {
    const { ipAddress, macAddress, userAgent, sessionId } = metadata;

    // Insert into voucher_usage table
    await portalDB.query(
      `INSERT INTO voucher_usage (voucher_code, voucher_source, source_id, used_by_ip, used_by_mac, user_agent, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         used_at = NOW(),
         used_by_ip = COALESCE(VALUES(used_by_ip), used_by_ip)`,
      [voucherCode, source, sourceId, ipAddress || null, macAddress || null, userAgent || null, sessionId || null]
    );

    // Update voucher status in source table
    if (source === 'vouchers') {
      await portalDB.query(
        `UPDATE vouchers SET status = 'USED', used_at = NOW() WHERE id = ?`,
        [sourceId]
      );
    } else if (source === 'orders') {
      await portalDB.query(
        `UPDATE orders SET status = 'COMPLETED' WHERE id = ? AND status = 'PAID'`,
        [sourceId]
      );
    }

    await logSecurityEvent('voucher_used', {
      voucherCode,
      ipAddress,
      severity: 'info',
      details: { source, sourceId, macAddress }
    });

    return { success: true };
  } catch (e) {
    console.error("Error marking voucher as used:", e);
    return { success: false, error: e.message };
  }
}

/**
 * Comprehensive voucher validation with all security checks
 * @returns {Object} Full validation result with security status
 */
async function validateVoucherSecure(voucherCode, clientInfo = {}) {
  const { ipAddress, userAgent, macAddress } = clientInfo;
  const result = {
    valid: false,
    voucher: null,
    security: {
      rateLimited: false,
      ipBlocked: false,
      alreadyUsed: false,
      hasActiveSession: false,
      suspicious: false
    },
    message: ''
  };

  // 1. Check if IP is persistently blocked
  const blockCheck = await isIpBlocked(ipAddress);
  if (blockCheck.blocked) {
    result.security.ipBlocked = true;
    result.message = 'Access denied. Please contact support.';

    await logSecurityEvent('validation_attempt', {
      voucherCode,
      ipAddress,
      userAgent,
      severity: 'warning',
      details: { blocked: true, reason: blockCheck.reason }
    });

    return result;
  }

  // 2. Check rate limit
  const rateCheck = checkRateLimit(ipAddress);
  if (!rateCheck.allowed) {
    result.security.rateLimited = true;
    result.message = rateCheck.locked
      ? `Too many attempts. Try again in ${rateCheck.retryAfter} seconds.`
      : `Rate limit exceeded. Try again in ${rateCheck.retryAfter} seconds.`;

    await logSecurityEvent('rate_limit_exceeded', {
      voucherCode,
      ipAddress,
      userAgent,
      severity: 'warning',
      details: { retryAfter: rateCheck.retryAfter, locked: rateCheck.locked }
    });

    return result;
  }

  // 3. Look up voucher in vouchers table
  let voucher = null;
  let voucherSource = null;
  let voucherSourceId = null;

  const [[voucherRow]] = await portalDB.query(
    `SELECT v.id, v.code, v.status, v.expires_at, v.used_at,
            p.id as plan_id, p.name as plan_name, p.duration_minutes,
            p.speed_down_kbps, p.speed_up_kbps, p.data_mb
     FROM vouchers v
     LEFT JOIN plans p ON v.plan_id = p.id
     WHERE v.code = ? LIMIT 1`,
    [voucherCode]
  );

  if (voucherRow) {
    voucher = voucherRow;
    voucherSource = 'vouchers';
    voucherSourceId = voucherRow.id;
  } else {
    // Check orders table
    const [[orderRow]] = await portalDB.query(
      `SELECT o.id, o.username as code, o.status, o.paid_at,
              p.id as plan_id, p.name as plan_name, p.duration_minutes,
              p.speed_down_kbps, p.speed_up_kbps, p.data_mb
       FROM orders o
       LEFT JOIN plans p ON o.plan_id = p.id
       WHERE o.username = ? AND o.status IN ('PAID', 'COMPLETED') LIMIT 1`,
      [voucherCode]
    );

    if (orderRow) {
      voucher = orderRow;
      voucherSource = 'orders';
      voucherSourceId = orderRow.id;
    }
  }

  // 4. Voucher not found
  if (!voucher) {
    const failResult = trackFailedAttempt(ipAddress);

    await logSecurityEvent('validation_failed', {
      voucherCode,
      ipAddress,
      userAgent,
      severity: failResult.lockedOut ? 'critical' : 'warning',
      details: { reason: 'not_found', failedCount: failResult.failedCount }
    });

    // If locked out, flag the IP
    if (failResult.lockedOut) {
      await flagIpAddress(ipAddress, 'Too many failed voucher validation attempts', 60);
      result.security.ipBlocked = true;
      result.message = 'Too many failed attempts. Access temporarily blocked.';
    } else {
      result.message = 'Voucher code not found';
    }

    return result;
  }

  // 5. Check voucher status (for vouchers table)
  if (voucherSource === 'vouchers') {
    if (voucher.status === 'DISABLED') {
      await logSecurityEvent('validation_failed', {
        voucherCode,
        ipAddress,
        userAgent,
        severity: 'info',
        details: { reason: 'disabled' }
      });
      result.message = 'This voucher has been disabled';
      return result;
    }

    if (voucher.status === 'USED') {
      result.security.alreadyUsed = true;

      await logSecurityEvent('multiple_use_attempt', {
        voucherCode,
        ipAddress,
        userAgent,
        severity: 'warning',
        details: { usedAt: voucher.used_at }
      });

      result.message = 'This voucher has already been used';
      return result;
    }

    // Check expiration
    if (voucher.expires_at && new Date(voucher.expires_at) < new Date()) {
      await logSecurityEvent('validation_failed', {
        voucherCode,
        ipAddress,
        userAgent,
        severity: 'info',
        details: { reason: 'expired', expiresAt: voucher.expires_at }
      });
      result.message = 'This voucher has expired';
      return result;
    }
  }

  // 6. Check if already used (via usage table or RADIUS accounting)
  const usageCheck = await checkVoucherUsed(voucherCode);
  if (usageCheck.used) {
    result.security.alreadyUsed = true;

    await logSecurityEvent('multiple_use_attempt', {
      voucherCode,
      ipAddress,
      userAgent,
      severity: 'warning',
      details: {
        usedAt: usageCheck.usedAt,
        sessionCount: usageCheck.sessionCount,
        source: usageCheck.source
      }
    });

    result.message = 'This voucher has already been used';
    return result;
  }

  // 7. Check for active session
  const sessionCheck = await hasActiveSession(voucherCode);
  if (sessionCheck.active) {
    result.security.hasActiveSession = true;
    result.message = 'This voucher is currently in use';
    result.activeSession = sessionCheck;

    await logSecurityEvent('validation_failed', {
      voucherCode,
      ipAddress,
      userAgent,
      severity: 'info',
      details: { reason: 'active_session', session: sessionCheck }
    });

    return result;
  }

  // 8. All checks passed - voucher is valid
  result.valid = true;
  result.voucher = {
    code: voucher.code,
    plan_name: voucher.plan_name,
    plan_id: voucher.plan_id,
    duration_minutes: voucher.duration_minutes,
    speed_down_kbps: voucher.speed_down_kbps,
    speed_up_kbps: voucher.speed_up_kbps,
    data_mb: voucher.data_mb
  };
  result.voucherSource = voucherSource;
  result.voucherSourceId = voucherSourceId;
  result.message = 'Voucher is valid';

  await logSecurityEvent('validation_success', {
    voucherCode,
    ipAddress,
    userAgent,
    severity: 'info',
    details: { source: voucherSource, planName: voucher.plan_name }
  });

  return result;
}

/**
 * Get suspicious activity report
 */
async function getSuspiciousActivity(hours = 24) {
  try {
    const [events] = await portalDB.query(
      `SELECT event_type, voucher_code, ip_address, details, severity, created_at
       FROM voucher_security_logs
       WHERE severity IN ('warning', 'critical')
         AND created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
       ORDER BY created_at DESC
       LIMIT 100`,
      [hours]
    );

    // Get IPs with most failed attempts
    const [topFailedIps] = await portalDB.query(
      `SELECT ip_address, COUNT(*) as attempt_count
       FROM voucher_security_logs
       WHERE event_type = 'validation_failed'
         AND created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
       GROUP BY ip_address
       HAVING attempt_count >= 5
       ORDER BY attempt_count DESC
       LIMIT 20`,
      [hours]
    );

    // Get flagged IPs
    const [flaggedIps] = await portalDB.query(
      `SELECT ip_address, reason, failed_attempts, flagged_at, blocked_until, is_permanent
       FROM flagged_ips
       WHERE is_permanent = 1 OR blocked_until > NOW()
       ORDER BY flagged_at DESC`
    );

    // Get multiple use attempts
    const [multipleUseAttempts] = await portalDB.query(
      `SELECT voucher_code, COUNT(*) as attempt_count,
              GROUP_CONCAT(DISTINCT ip_address) as ips
       FROM voucher_security_logs
       WHERE event_type = 'multiple_use_attempt'
         AND created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
       GROUP BY voucher_code
       ORDER BY attempt_count DESC
       LIMIT 20`,
      [hours]
    );

    return {
      events,
      topFailedIps,
      flaggedIps,
      multipleUseAttempts,
      summary: {
        totalWarnings: events.filter(e => e.severity === 'warning').length,
        totalCritical: events.filter(e => e.severity === 'critical').length,
        flaggedIpCount: flaggedIps.length,
        multipleUseAttemptsCount: multipleUseAttempts.length
      }
    };
  } catch (e) {
    console.error("Error getting suspicious activity:", e);
    return { events: [], topFailedIps: [], flaggedIps: [], multipleUseAttempts: [], summary: {} };
  }
}

/**
 * Unblock an IP address
 */
async function unblockIp(ipAddress) {
  try {
    // Remove from in-memory stores
    lockedOutIps.delete(ipAddress);
    failedAttemptsStore.delete(`failed_${ipAddress}`);
    rateLimitStore.delete(`rate_${ipAddress}`);

    // Remove from database
    await portalDB.query(
      `DELETE FROM flagged_ips WHERE ip_address = ?`,
      [ipAddress]
    );

    return { success: true, message: `IP ${ipAddress} has been unblocked` };
  } catch (e) {
    console.error("Error unblocking IP:", e);
    return { success: false, error: e.message };
  }
}

/**
 * Clean up old security logs (run periodically)
 */
async function cleanupOldLogs(daysToKeep = 30) {
  try {
    const [result] = await portalDB.query(
      `DELETE FROM voucher_security_logs
       WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
         AND severity = 'info'`,
      [daysToKeep]
    );

    return { deletedCount: result.affectedRows };
  } catch (e) {
    console.error("Error cleaning up logs:", e);
    return { deletedCount: 0, error: e.message };
  }
}

module.exports = {
  validateVoucherSecure,
  checkVoucherUsed,
  hasActiveSession,
  markVoucherUsed,
  checkRateLimit,
  isIpBlocked,
  flagIpAddress,
  unblockIp,
  logSecurityEvent,
  getSuspiciousActivity,
  cleanupOldLogs,
  ensureSecurityTables
};
