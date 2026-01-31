const express = require("express");
const portalDB = require("../config/db.portal");
const env = require("../config/env");
const { createPaymentLink, verifyTransaction } = require("../services/flutterwave.service");
const { activateVoucher } = require("../services/radius.service");
const mikrotikService = require("../services/mikrotik.service");
const paymentProviderService = require("../services/payment-provider.service");
const { nanoid } = require("nanoid");

const router = express.Router();

/**
 * Log payment event to payment_logs table
 */
async function logPayment(data) {
  try {
    await portalDB.query(`
      INSERT INTO payment_logs
      (order_id, provider_code, transaction_ref, provider_tx_id, amount, currency, status, status_message, request_payload, response_payload, customer_msisdn, payment_method, initiated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `, [
      data.order_id || null,
      'flutterwave',
      data.transaction_ref || null,
      data.provider_tx_id || null,
      data.amount || 0,
      data.currency || 'UGX',
      data.status || 'initiated',
      data.status_message || null,
      data.request_payload ? JSON.stringify(data.request_payload) : null,
      data.response_payload ? JSON.stringify(data.response_payload) : null,
      data.customer_msisdn || null,
      data.payment_method || 'card'
    ]);
  } catch (e) {
    console.error("Error logging payment:", e.message);
  }
}

/**
 * Update payment log status
 */
async function updatePaymentLog(transactionRef, status, responsePayload, completedAt = null) {
  try {
    let query = "UPDATE payment_logs SET status = ?, response_payload = ?";
    const params = [status, responsePayload ? JSON.stringify(responsePayload) : null];

    if (completedAt) {
      query += ", completed_at = NOW()";
    }

    query += " WHERE transaction_ref = ?";
    params.push(transactionRef);

    await portalDB.query(query, params);
  } catch (e) {
    console.error("Error updating payment log:", e.message);
  }
}

async function getOrCreateCustomer(msisdn) {
  // Try find existing
  const [rows] = await portalDB.query(
    "SELECT id FROM customers WHERE msisdn=? LIMIT 1",
    [msisdn]
  );
  if (rows.length) return rows[0].id;

  // Create new (msisdn is UNIQUE, so this is safe even with concurrency)
  const email = `${msisdn}@bula.local`;
  await portalDB.query(
    "INSERT INTO customers (msisdn, email) VALUES (?, ?)",
    [msisdn, email]
  );

  // Re-select to return id
  const [rows2] = await portalDB.query(
    "SELECT id FROM customers WHERE msisdn=? LIMIT 1",
    [msisdn]
  );
  return rows2[0].id;
}

/**
 * POST /api/payments/flutterwave/init
 * Body: { msisdn, planCode }
 *
 * Creates a PENDING order + returns Flutterwave hosted payment link.
 */
router.post("/init", async (req, res) => {
  try {
    const { msisdn, planCode, customerMac, customerIp, linkLogin } = req.body || {};
    if (!msisdn || !planCode) return res.status(400).json({ ok: false, message: "msisdn and planCode required" });

    // Check if Flutterwave is available (from DB or env)
    const flwService = require("../services/flutterwave.service");
    const isAvailable = await flwService.isAvailable();
    if (!isAvailable) {
      return res.status(500).json({ ok: false, message: "Flutterwave is not configured" });
    }

    const [plans] = await portalDB.query(
      "SELECT id, code, name, price_ugx, duration_minutes, speed_down_kbps, speed_up_kbps FROM plans WHERE code=? AND is_active=1 LIMIT 1",
      [planCode]
    );
    const plan = plans[0];
    if (!plan) return res.status(404).json({ ok: false, message: "Plan not found" });

    // Generate numeric-only voucher code (5 digits), but activate ONLY after webhook confirms payment
    // Voucher code is used as both username and password (voucher-based activation)
    const voucherCode = String(Math.floor(10000 + Math.random() * 90000));

    const orderRef = `ORD_${nanoid(14)}`;
    // customer_id: for now we can use 0 and later map it to a real customer record
    const customerId = await getOrCreateCustomer(msisdn);

    // Normalize MAC address if provided
    const normalizedMac = customerMac ? mikrotikService.normalizeMacAddress(customerMac) : null;

    await portalDB.query(
      `INSERT INTO orders (order_ref, customer_id, plan_id, username, password, amount_ugx, status, payment_provider, customer_mac, customer_ip, mikrotik_login_url)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 'FLUTTERWAVE', ?, ?, ?)`,
      [orderRef, customerId, plan.id, voucherCode, voucherCode, plan.price_ugx, normalizedMac, customerIp || null, linkLogin || null]
    );

    // Get order ID for logging
    const [[orderRow]] = await portalDB.query(
      "SELECT id FROM orders WHERE order_ref = ?",
      [orderRef]
    );

    // Log payment initiation
    await logPayment({
      order_id: orderRow?.id,
      transaction_ref: orderRef,
      amount: plan.price_ugx,
      customer_msisdn: msisdn,
      payment_method: 'flutterwave',
      status: 'initiated',
      request_payload: { msisdn, planCode }
    });

    const redirect_url = `${env.BASE_URL}/api/payments/flutterwave/redirect?orderRef=${encodeURIComponent(orderRef)}`;

    const flw = await createPaymentLink({
      tx_ref: orderRef,
      amount: plan.price_ugx,
      currency: "UGX",
      redirect_url,
      customer: {
        phonenumber: msisdn,
        email: `${msisdn}@bula.local`,
        name: msisdn,
      },
      meta: { planCode: plan.code, msisdn },
    });

    const link = flw?.data?.link;
    if (!link) {
      await updatePaymentLog(orderRef, 'failed', flw);
      return res.status(500).json({ ok: false, message: "Failed to create Flutterwave payment link" });
    }

    // Update log with pending status
    await updatePaymentLog(orderRef, 'pending', { link });

    return res.json({
      ok: true,
      orderRef,
      paymentLink: link,
      plan,
      voucher: { code: voucherCode }, // voucher code only (used as both username and password)
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Server error", detail: e.message });
  }
});

/**
 * Helper to format plan display values
 */
function formatPlanDisplay(plan) {
  // Duration display
  let duration_display = "";
  if (plan.duration_minutes >= 1440) {
    const days = Math.floor(plan.duration_minutes / 1440);
    duration_display = days === 1 ? "1 Day" : `${days} Days`;
  } else if (plan.duration_minutes >= 60) {
    const hours = Math.floor(plan.duration_minutes / 60);
    duration_display = hours === 1 ? "1 Hour" : `${hours} Hours`;
  } else {
    duration_display = `${plan.duration_minutes} Minutes`;
  }

  // Speed display
  let speed_display = "";
  if (plan.speed_down_kbps && plan.speed_up_kbps) {
    const down = plan.speed_down_kbps >= 1000 ? `${plan.speed_down_kbps / 1000}Mbps` : `${plan.speed_down_kbps}Kbps`;
    speed_display = `${down} Speed`;
  }

  // Data display
  let data_display = "";
  if (plan.data_mb) {
    data_display = plan.data_mb >= 1024 ? `${(plan.data_mb / 1024).toFixed(1)}GB Data` : `${plan.data_mb}MB Data`;
  }

  return { ...plan, duration_display, speed_display, data_display };
}

/**
 * GET /api/payments/flutterwave/redirect
 * User comes back in browser. We MUST verify transaction server-to-server
 * before marking PAID / activating voucher.
 */
router.get("/redirect", async (req, res) => {
  try {
    const orderRef = String(req.query.orderRef || "");
    const status = String(req.query.status || "");
    const txRef = String(req.query.tx_ref || "");
    const txId = String(req.query.transaction_id || "");

    if (!orderRef || !txId) {
      return res.render("payment-failed", {
        message: "Missing payment information. Please try again.",
        orderRef: orderRef || null
      });
    }

    // Load order
    const [rows] = await portalDB.query(
      "SELECT id, status, amount_ugx, plan_id, username, password, customer_mac, customer_ip, mikrotik_login_url, autologin_status FROM orders WHERE order_ref=? LIMIT 1",
      [orderRef]
    );
    const order = rows && rows[0];
    if (!order) {
      return res.render("payment-failed", {
        message: "Order not found. Please contact support.",
        orderRef
      });
    }

    // Load plan info (needed for display in all cases)
    const [plans] = await portalDB.query(
      "SELECT name, duration_minutes, speed_down_kbps, speed_up_kbps, data_mb, price_ugx FROM plans WHERE id=? LIMIT 1",
      [order.plan_id]
    );
    const plan = plans && plans[0];

    // Idempotency - already paid, show success page with voucher details
    if (order.status === "PAID") {
      return res.render("payment-success", {
        orderRef,
        voucher: {
          username: order.username,
          password: order.password
        },
        plan: plan ? formatPlanDisplay(plan) : { name: "WiFi Plan", duration_display: "", price_ugx: order.amount_ugx },
        autoLogin: {
          attempted: !!order.autologin_status,
          success: order.autologin_status === 'success',
          status: order.autologin_status,
          mac: order.customer_mac,
        },
        linkLogin: order.mikrotik_login_url,
      });
    }

    // Quick sanity (do NOT trust redirect, but use it as a hint)
    if (status && status !== "successful") {
      return res.render("payment-failed", {
        message: "Payment was not successful. Please try again.",
        orderRef
      });
    }

    // Verify with Flutterwave
    const verifyUrl = "https://api.flutterwave.com/v3/transactions/" + encodeURIComponent(txId) + "/verify";
    const vResp = await fetch(verifyUrl, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + env.FLW_SECRET_KEY,
        "Content-Type": "application/json",
      },
    });

    const vJson = await vResp.json().catch(() => ({}));
    const vData = vJson && vJson.data ? vJson.data : null;

    if (!vResp.ok || !vData) {
      console.error("Flutterwave redirect verify failed:", vJson);
      return res.render("payment-failed", {
        message: "Could not verify payment with Flutterwave. Please contact support.",
        orderRef
      });
    }

    const vStatus = String(vData.status || "");
    const vRef = String(vData.tx_ref || "");
    const vCurrency = String(vData.currency || "");
    const vAmount = Number(vData.amount || 0);

    // Must match order
    if (vStatus !== "successful" || vRef !== orderRef || vCurrency !== "UGX" || vAmount !== Number(order.amount_ugx)) {
      console.error("Payment verification mismatch:", { vStatus, vRef, vCurrency, vAmount, expected: order.amount_ugx });
      return res.render("payment-failed", {
        message: "Payment verification failed. Amount or reference mismatch.",
        orderRef
      });
    }

    if (!plan) {
      return res.render("payment-failed", {
        message: "Plan not found. Please contact support.",
        orderRef
      });
    }

    // Activate voucher in FreeRADIUS with full plan attributes
    await activateVoucher({
      username: order.username,
      password: order.password,
      minutes: plan.duration_minutes,
      speedDownKbps: plan.speed_down_kbps,
      speedUpKbps: plan.speed_up_kbps,
      dataMb: plan.data_mb,
    });

    // Mark order paid
    await portalDB.query(
      "UPDATE orders SET status=\"PAID\", provider=\"FLUTTERWAVE\", provider_tx_id=?, provider_ref=?, paid_at=NOW() WHERE order_ref=?",
      [txId, orderRef, orderRef]
    );

    // Attempt MikroTik auto-login if MAC address is available
    let autoLoginResult = { attempted: false, success: false, status: 'skipped', message: null };

    if (order.customer_mac) {
      try {
        const mikrotikResult = await mikrotikService.authorizeMacBinding({
          mac: order.customer_mac,
          ip: order.customer_ip,
          durationMinutes: plan.duration_minutes,
          comment: `Bula WiFi - Order ${orderRef} - ${plan.name}`,
          orderId: order.id,
        });

        autoLoginResult = {
          attempted: true,
          success: mikrotikResult.success,
          status: mikrotikResult.status,
          message: mikrotikResult.message,
          mac: order.customer_mac,
        };

        // Update order with auto-login status
        await portalDB.query(
          "UPDATE orders SET autologin_status = ?, autologin_message = ? WHERE order_ref = ?",
          [mikrotikResult.status, mikrotikResult.message, orderRef]
        );
      } catch (mikrotikError) {
        console.error("MikroTik auto-login error:", mikrotikError.message);
        autoLoginResult = {
          attempted: true,
          success: false,
          status: 'failed',
          message: mikrotikError.message,
        };
        await portalDB.query(
          "UPDATE orders SET autologin_status = 'failed', autologin_message = ? WHERE order_ref = ?",
          [mikrotikError.message, orderRef]
        );
      }
    }

    // Render success page with voucher details and auto-login result
    return res.render("payment-success", {
      orderRef,
      voucher: {
        username: order.username,
        password: order.password
      },
      plan: formatPlanDisplay(plan),
      autoLogin: autoLoginResult,
      linkLogin: order.mikrotik_login_url,
    });
  } catch (e) {
    console.error("Flutterwave redirect error:", e);
    return res.render("payment-failed", {
      message: "An error occurred while processing your payment. Please contact support.",
      orderRef: req.query.orderRef || null
    });
  }
});


// --- Flutterwave Webhook (must be reachable at POST /api/payments/flutterwave/webhook) ---
// NOTE: Flutterwave sends header "verif-hash". We validate it against env.FLW_WEBHOOK_HASH.

// Backward-compatible alias (in case someone configured /flutterwave/webhook somewhere)
router.post("/flutterwave/webhook", async (req, res) => {
  try {
    const hash = String(req.headers["verif-hash"] || "");
    if (!env.FLW_WEBHOOK_HASH || hash !== String(env.FLW_WEBHOOK_HASH)) {
      return res.status(200).send("ok");
    }
    return res.status(200).send("ok");
  } catch (e) {
    return res.status(200).send("ok");
  }
});


// --- Flutterwave Webhook (PROCESS PAYMENT HERE) ---

router.post("/webhook", async (req, res) => {
    
  console.log("Flutterwave webhook hit", {
    ip: req.ip,
    hasHash: !!req.headers["verif-hash"],
    hashPrefix: (req.headers["verif-hash"] || "").toString().slice(0, 6),
    event: req.body?.event,
    tx_ref: req.body?.data?.tx_ref,
    id: req.body?.data?.id,
    status: req.body?.data?.status,
  });
// --- Flutterwave webhook debug log (safe fields only) ---
    try {
      const d = req.body && req.body.data ? req.body.data : {};
      console.log("Flutterwave webhook received:", {
        event: req.body?.event,
        tx_ref: d.tx_ref,
        id: d.id,
        status: d.status,
        amount: d.amount,
        currency: d.currency,
      });
    } catch (e) {
      console.warn("Flutterwave webhook log error", e.message);
    }

  try {
    const hash = String(req.headers["verif-hash"] || "");
    if (!env.FLW_WEBHOOK_HASH || hash !== String(env.FLW_WEBHOOK_HASH)) {
      return res.status(200).send("ok");
    }

    const body = req.body || {};
    const data = body.data || {};

    // Flutterwave usually sends tx_ref and id in data
    const orderRef = String(data.tx_ref || "");
    const txId = String(data.id || "");

    if (!orderRef || !txId) {
      return res.status(200).send("ok");
    }

    // 1) Load order
    const [rows] = await portalDB.query(
      "SELECT id, status, amount_ugx, plan_id, username, password, customer_mac, customer_ip FROM orders WHERE order_ref=? LIMIT 1",
      [orderRef]
    );
    const order = rows && rows[0];
    if (!order) return res.status(200).send("ok");

    // Idempotency
    if (order.status === "PAID") return res.status(200).send("ok");

    // 2) Verify transaction server-to-server
    const verifyUrl = "https://api.flutterwave.com/v3/transactions/" + encodeURIComponent(txId) + "/verify";
    const vResp = await fetch(verifyUrl, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + env.FLW_SECRET_KEY,
        "Content-Type": "application/json",
      },
    });

    const vJson = await vResp.json().catch(() => ({}));
    const vData = vJson && vJson.data ? vJson.data : null;
    if (!vResp.ok || !vData) {
      console.error("Flutterwave webhook verify failed:", vJson);
      return res.status(200).send("ok");
    }

    const vStatus = String(vData.status || "");
    const vRef = String(vData.tx_ref || "");
    const vCurrency = String(vData.currency || "");
    const vAmount = Number(vData.amount || 0);

    if (vStatus !== "successful" || vRef !== orderRef || vCurrency !== "UGX" || vAmount !== Number(order.amount_ugx)) {
      console.error("Flutterwave webhook mismatch:", { vStatus, vRef, vCurrency, vAmount, expected: order.amount_ugx });
      return res.status(200).send("ok");
    }

    // 3) Load plan
    const [plans] = await portalDB.query(
      "SELECT duration_minutes, speed_down_kbps, speed_up_kbps, data_mb FROM plans WHERE id=? LIMIT 1",
      [order.plan_id]
    );
    const plan = plans && plans[0];
    if (!plan) return res.status(200).send("ok");

    // 4) Activate voucher with full plan attributes
    await activateVoucher({
      username: order.username,
      password: order.password,
      minutes: plan.duration_minutes,
      speedDownKbps: plan.speed_down_kbps,
      speedUpKbps: plan.speed_up_kbps,
      dataMb: plan.data_mb,
    });

    // 5) Mark paid
    await portalDB.query(
      "UPDATE orders SET status=\"PAID\", provider=\"FLUTTERWAVE\", provider_tx_id=?, provider_ref=?, paid_at=NOW() WHERE order_ref=?",
      [txId, orderRef, orderRef]
    );

    // 6) Attempt MikroTik auto-login if MAC address is available
    if (order.customer_mac) {
      try {
        const mikrotikResult = await mikrotikService.authorizeMacBinding({
          mac: order.customer_mac,
          ip: order.customer_ip,
          durationMinutes: plan.duration_minutes,
          comment: `Bula WiFi - Order ${orderRef} - Webhook`,
          orderId: order.id,
        });

        await portalDB.query(
          "UPDATE orders SET autologin_status = ?, autologin_message = ? WHERE order_ref = ?",
          [mikrotikResult.status, mikrotikResult.message, orderRef]
        );
      } catch (mikrotikError) {
        console.error("MikroTik auto-login error (webhook):", mikrotikError.message);
        await portalDB.query(
          "UPDATE orders SET autologin_status = 'failed', autologin_message = ? WHERE order_ref = ?",
          [mikrotikError.message, orderRef]
        );
      }
    }

    // 7) Update payment log
    await updatePaymentLog(orderRef, 'success', vJson, true);

    return res.status(200).send("ok");
  } catch (e) {
    console.error("Flutterwave webhook error:", e.message);
    return res.status(200).send("ok");
  }
});

// Backward compatible alias
router.post("/flutterwave/webhook", (req, res) => router.handle(req, res));

module.exports = router;
