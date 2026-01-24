const express = require("express");
const portalDB = require("../config/db.portal");
const env = require("../config/env");
const { createPaymentLink, verifyTransaction } = require("../services/flutterwave.service");
const { activateVoucher } = require("../services/radius.service");
const { nanoid } = require("nanoid");

const router = express.Router();

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
    const { msisdn, planCode } = req.body || {};
    if (!msisdn || !planCode) return res.status(400).json({ ok: false, message: "msisdn and planCode required" });

    if (!env.FLW_SECRET_KEY || !env.FLW_PUBLIC_KEY) {
      return res.status(500).json({ ok: false, message: "Flutterwave keys not configured" });
    }

    const [plans] = await portalDB.query(
      "SELECT id, code, name, price_ugx, duration_minutes, speed_down_kbps, speed_up_kbps FROM plans WHERE code=? AND is_active=1 LIMIT 1",
      [planCode]
    );
    const plan = plans[0];
    if (!plan) return res.status(404).json({ ok: false, message: "Plan not found" });

    // Generate numeric-only voucher code, but activate ONLY after webhook confirms payment
    // Voucher code is used as both username and password (voucher-based activation)
    const voucherCode = String(Math.floor(10000000 + Math.random() * 90000000));

    const orderRef = `ORD_${nanoid(14)}`;
	// customer_id: for now we can use 0 and later map it to a real customer record
    const customerId = await getOrCreateCustomer(msisdn);

	await portalDB.query(
  	`INSERT INTO orders (order_ref, customer_id, plan_id, username, password, amount_ugx, status, payment_provider)
   	VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 'FLUTTERWAVE')`,
  	[orderRef, customerId, plan.id, voucherCode, voucherCode, plan.price_ugx]
	);

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
    if (!link) return res.status(500).json({ ok: false, message: "Failed to create Flutterwave payment link" });

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
      "SELECT id, status, amount_ugx, plan_id, username, password FROM orders WHERE order_ref=? LIMIT 1",
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
        plan: plan ? formatPlanDisplay(plan) : { name: "WiFi Plan", duration_display: "", price_ugx: order.amount_ugx }
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

    // Render success page with voucher details
    return res.render("payment-success", {
      orderRef,
      voucher: {
        username: order.username,
        password: order.password
      },
      plan: formatPlanDisplay(plan)
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
      "SELECT id, status, amount_ugx, plan_id, username, password FROM orders WHERE order_ref=? LIMIT 1",
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

    return res.status(200).send("ok");
  } catch (e) {
    console.error("Flutterwave webhook error:", e.message);
    return res.status(200).send("ok");
  }
});

// Backward compatible alias
router.post("/flutterwave/webhook", (req, res) => router.handle(req, res));

module.exports = router;
