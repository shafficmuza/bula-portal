const express = require("express");
const Joi = require("joi");
const { nanoid } = require("nanoid");

const portalDB = require("../config/db.portal");
const { activateVoucher } = require("../services/radius.service");
const paymentProviderService = require("../services/payment-provider.service");
const voucherSecurity = require("../services/voucher-security.service");

const router = express.Router();

/**
 * GET /api/portal/payment-providers
 * Returns list of enabled payment providers for the portal
 */
router.get("/payment-providers", async (req, res, next) => {
  try {
    const providers = await paymentProviderService.getEnabledProviders();
    res.json({
      ok: true,
      providers: providers.map(p => ({
        provider_code: p.provider_code,
        display_name: p.display_name
      }))
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/portal/plans
 */
router.get("/plans", async (req, res, next) => {
  try {
    const [rows] = await portalDB.query(
      "SELECT id, code, name, price_ugx, duration_minutes, speed_down_kbps, speed_up_kbps FROM plans WHERE is_active=1 ORDER BY price_ugx ASC"
    );
    res.json({ ok: true, plans: rows });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/portal/purchase/test-pay
 * For testing only: marks paid immediately and activates voucher in RADIUS.
 * Body: { "msisdn":"2567xxxxxxx", "planCode":"1H" }
 */
router.post("/purchase/test-pay", async (req, res, next) => {
  try {
    const schema = Joi.object({
      msisdn: Joi.string().min(8).max(20).required(),
      planCode: Joi.string().max(50).required(),
    });

    const { msisdn, planCode } = await schema.validateAsync(req.body);

    const [[plan]] = await portalDB.query(
      "SELECT * FROM plans WHERE code=? AND is_active=1",
      [planCode]
    );
    if (!plan) return res.status(404).json({ ok: false, message: "Plan not found" });

    // Upsert customer
    await portalDB.query(
      "INSERT INTO customers (msisdn) VALUES (?) ON DUPLICATE KEY UPDATE msisdn=VALUES(msisdn)",
      [msisdn]
    );
    const [[cust]] = await portalDB.query("SELECT id FROM customers WHERE msisdn=?", [msisdn]);

    // Generate numeric-only voucher code (5 digits, used as both username and password)
    const voucherCode = String(Math.floor(10000 + Math.random() * 90000));
    const orderRef = `ORD_${nanoid(14)}`;

    // Create order (PAID for test)
    await portalDB.query(
      `INSERT INTO orders (order_ref, customer_id, plan_id, username, password, amount_ugx, status, paid_at)
       VALUES (?,?,?,?,?,?, 'PAID', NOW())`,
      [orderRef, cust.id, plan.id, voucherCode, voucherCode, plan.price_ugx]
    );

    // Activate in RADIUS with full plan attributes
    // Voucher code is used as both username and password
    await activateVoucher({
      username: voucherCode,
      password: voucherCode,
      minutes: plan.duration_minutes,
      speedDownKbps: plan.speed_down_kbps,
      speedUpKbps: plan.speed_up_kbps,
      dataMb: plan.data_mb,
    });

    res.json({
      ok: true,
      orderRef,
      voucher: { code: voucherCode },
      plan: { code: plan.code, name: plan.name, duration_minutes: plan.duration_minutes, price_ugx: plan.price_ugx },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/portal/voucher/validate
 * Validates a voucher code with full security checks
 * Body: { "code": "12345678" }
 *
 * Security features:
 * - Rate limiting per IP
 * - Tracks failed attempts
 * - Blocks suspicious IPs
 * - Prevents multiple use
 * - Checks for active sessions
 */
router.post("/voucher/validate", async (req, res, next) => {
  try {
    const schema = Joi.object({
      code: Joi.string().min(5).max(20).pattern(/^\d+$/).required()
        .messages({ 'string.pattern.base': 'Voucher code must contain only numbers' }),
    });

    const { code } = await schema.validateAsync(req.body);

    // Get client info for security tracking
    const clientInfo = {
      ipAddress: req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0],
      userAgent: req.headers['user-agent'],
      macAddress: req.body.mac || req.query.mac || null
    };

    // Perform secure validation with all checks
    const result = await voucherSecurity.validateVoucherSecure(code, clientInfo);

    // Handle security blocks
    if (result.security.ipBlocked) {
      return res.status(403).json({
        ok: false,
        message: result.message,
        blocked: true
      });
    }

    if (result.security.rateLimited) {
      return res.status(429).json({
        ok: false,
        message: result.message,
        rateLimited: true,
        retryAfter: result.retryAfter
      });
    }

    if (result.security.alreadyUsed) {
      return res.status(400).json({
        ok: false,
        message: result.message,
        alreadyUsed: true
      });
    }

    if (result.security.hasActiveSession) {
      return res.status(400).json({
        ok: false,
        message: result.message,
        activeSession: true
      });
    }

    if (!result.valid) {
      return res.status(400).json({
        ok: false,
        message: result.message
      });
    }

    // Voucher is valid
    res.json({
      ok: true,
      message: result.message,
      voucher: result.voucher
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/portal/voucher/use
 * Marks a voucher as used when user successfully logs in
 * This should be called after RADIUS authentication succeeds
 * Body: { "code": "12345678", "mac": "AA:BB:CC:DD:EE:FF" }
 */
router.post("/voucher/use", async (req, res, next) => {
  try {
    const schema = Joi.object({
      code: Joi.string().min(5).max(20).pattern(/^\d+$/).required(),
      mac: Joi.string().max(17).optional(),
      sessionId: Joi.string().max(100).optional()
    });

    const { code, mac, sessionId } = await schema.validateAsync(req.body);

    const clientInfo = {
      ipAddress: req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0],
      userAgent: req.headers['user-agent'],
      macAddress: mac
    };

    // First validate the voucher is still valid
    const validation = await voucherSecurity.validateVoucherSecure(code, clientInfo);

    if (!validation.valid) {
      return res.status(400).json({
        ok: false,
        message: validation.message
      });
    }

    // Mark as used
    const markResult = await voucherSecurity.markVoucherUsed(
      code,
      validation.voucherSource,
      validation.voucherSourceId,
      {
        ipAddress: clientInfo.ipAddress,
        macAddress: mac,
        userAgent: clientInfo.userAgent,
        sessionId
      }
    );

    if (!markResult.success) {
      return res.status(500).json({
        ok: false,
        message: "Failed to mark voucher as used"
      });
    }

    res.json({
      ok: true,
      message: "Voucher marked as used",
      voucher: validation.voucher
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/portal/voucher/status/:code
 * Check the current status of a voucher (public, rate-limited)
 */
router.get("/voucher/status/:code", async (req, res, next) => {
  try {
    const code = req.params.code;

    if (!/^\d{5,20}$/.test(code)) {
      return res.status(400).json({ ok: false, message: "Invalid voucher code format" });
    }

    const clientInfo = {
      ipAddress: req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0],
      userAgent: req.headers['user-agent']
    };

    // Check rate limit first
    const rateCheck = voucherSecurity.checkRateLimit(clientInfo.ipAddress);
    if (!rateCheck.allowed) {
      return res.status(429).json({
        ok: false,
        message: `Rate limit exceeded. Try again in ${rateCheck.retryAfter} seconds.`,
        rateLimited: true
      });
    }

    // Check if already used
    const usageCheck = await voucherSecurity.checkVoucherUsed(code);

    // Check for active session
    const sessionCheck = await voucherSecurity.hasActiveSession(code);

    res.json({
      ok: true,
      status: {
        used: usageCheck.used,
        usedAt: usageCheck.usedAt || null,
        sessionCount: usageCheck.sessionCount || 0,
        hasActiveSession: sessionCheck.active,
        activeSessionStart: sessionCheck.active ? sessionCheck.startTime : null
      }
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
