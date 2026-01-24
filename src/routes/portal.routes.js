const express = require("express");
const Joi = require("joi");
const { nanoid } = require("nanoid");

const portalDB = require("../config/db.portal");
const { activateVoucher } = require("../services/radius.service");

const router = express.Router();

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

    // Generate numeric-only voucher code (used as both username and password for voucher-based activation)
    const voucherCode = String(Math.floor(10000000 + Math.random() * 90000000));
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
 * Validates a voucher code and returns its status
 * Body: { "code": "12345678" }
 */
router.post("/voucher/validate", async (req, res, next) => {
  try {
    const schema = Joi.object({
      code: Joi.string().min(6).max(20).pattern(/^\d+$/).required()
        .messages({ 'string.pattern.base': 'Voucher code must contain only numbers' }),
    });

    const { code } = await schema.validateAsync(req.body);

    // Check if voucher exists and is active in vouchers table
    const [[voucher]] = await portalDB.query(
      `SELECT v.id, v.code, v.status, v.expires_at, p.name as plan_name, p.duration_minutes
       FROM vouchers v
       LEFT JOIN plans p ON v.plan_id = p.id
       WHERE v.code = ? LIMIT 1`,
      [code]
    );

    // Also check in orders table (for vouchers generated via payment)
    if (!voucher) {
      const [[order]] = await portalDB.query(
        `SELECT o.id, o.username as code, o.status, p.name as plan_name, p.duration_minutes
         FROM orders o
         LEFT JOIN plans p ON o.plan_id = p.id
         WHERE o.username = ? AND o.status = 'PAID' LIMIT 1`,
        [code]
      );

      if (order) {
        return res.json({
          ok: true,
          message: "Voucher is valid",
          voucher: {
            code: order.code,
            plan_name: order.plan_name,
            duration_minutes: order.duration_minutes
          }
        });
      }
    }

    if (!voucher) {
      return res.status(404).json({ ok: false, message: "Voucher code not found" });
    }

    if (voucher.status === 'DISABLED') {
      return res.status(400).json({ ok: false, message: "This voucher has been disabled" });
    }

    if (voucher.status === 'USED') {
      return res.status(400).json({ ok: false, message: "This voucher has already been used" });
    }

    if (voucher.expires_at && new Date(voucher.expires_at) < new Date()) {
      return res.status(400).json({ ok: false, message: "This voucher has expired" });
    }

    res.json({
      ok: true,
      message: "Voucher is valid",
      voucher: {
        code: voucher.code,
        plan_name: voucher.plan_name,
        duration_minutes: voucher.duration_minutes
      }
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
