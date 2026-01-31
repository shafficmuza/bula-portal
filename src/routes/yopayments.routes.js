const express = require("express");
const { nanoid } = require("nanoid");
const portalDB = require("../config/db.portal");
const env = require("../config/env");
const yoPaymentsService = require("../services/yopayments.service");
const paymentProviderService = require("../services/payment-provider.service");
const mikrotikService = require("../services/mikrotik.service");
const settingsService = require("../services/settings.service");
const { activateVoucher } = require("../services/radius.service");

const router = express.Router();

/**
 * Get or create customer by MSISDN
 */
async function getOrCreateCustomer(msisdn) {
  const formattedMsisdn = yoPaymentsService.formatMsisdn(msisdn);

  const [rows] = await portalDB.query(
    "SELECT id FROM customers WHERE msisdn=? LIMIT 1",
    [formattedMsisdn]
  );
  if (rows.length) return rows[0].id;

  const email = `${formattedMsisdn}@bula.local`;
  await portalDB.query(
    "INSERT INTO customers (msisdn, email) VALUES (?, ?)",
    [formattedMsisdn, email]
  );

  const [rows2] = await portalDB.query(
    "SELECT id FROM customers WHERE msisdn=? LIMIT 1",
    [formattedMsisdn]
  );
  return rows2[0].id;
}

/**
 * Log payment event
 */
async function logPayment(data) {
  try {
    await portalDB.query(`
      INSERT INTO payment_logs
      (order_id, provider_code, transaction_ref, provider_tx_id, amount, currency, status, status_message, request_payload, response_payload, customer_msisdn, payment_method, initiated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `, [
      data.order_id || null,
      'yopayments',
      data.transaction_ref || null,
      data.provider_tx_id || null,
      data.amount || 0,
      data.currency || 'UGX',
      data.status || 'initiated',
      data.status_message || null,
      data.request_payload ? JSON.stringify(data.request_payload) : null,
      data.response_payload ? JSON.stringify(data.response_payload) : null,
      data.customer_msisdn || null,
      data.payment_method || 'mobile_money'
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

/**
 * POST /api/payments/yopayments/init
 * Body: { msisdn, planCode }
 *
 * Initiates a Yo Payments mobile money collection request.
 */
router.post("/init", async (req, res) => {
  try {
    const { msisdn, planCode, customerMac, customerIp, linkLogin } = req.body || {};

    if (!msisdn || !planCode) {
      return res.status(400).json({ ok: false, message: "msisdn and planCode required" });
    }

    // Check if Yo Payments is enabled
    const isEnabled = await paymentProviderService.isProviderEnabled("yopayments");
    if (!isEnabled) {
      return res.status(400).json({ ok: false, message: "Yo Payments is not enabled" });
    }

    // Check if Yo Payments is configured
    const isAvailable = await yoPaymentsService.isAvailable();
    if (!isAvailable) {
      return res.status(500).json({ ok: false, message: "Yo Payments is not configured" });
    }

    // Get plan
    const [plans] = await portalDB.query(
      "SELECT id, code, name, price_ugx, duration_minutes, speed_down_kbps, speed_up_kbps, data_mb FROM plans WHERE code=? AND is_active=1 LIMIT 1",
      [planCode]
    );
    const plan = plans[0];
    if (!plan) {
      return res.status(404).json({ ok: false, message: "Plan not found" });
    }

    // Generate voucher code (5 digits)
    const voucherCode = String(Math.floor(10000 + Math.random() * 90000));
    const orderRef = `YO_${nanoid(14)}`;

    // Create customer
    const customerId = await getOrCreateCustomer(msisdn);

    // Normalize MAC address if provided
    const normalizedMac = customerMac ? mikrotikService.normalizeMacAddress(customerMac) : null;

    // Create order
    await portalDB.query(
      `INSERT INTO orders (order_ref, customer_id, plan_id, username, password, amount_ugx, status, payment_provider, customer_mac, customer_ip, mikrotik_login_url)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 'YO', ?, ?, ?)`,
      [orderRef, customerId, plan.id, voucherCode, voucherCode, plan.price_ugx, normalizedMac, customerIp || null, linkLogin || null]
    );

    // Get the order ID
    const [[orderRow]] = await portalDB.query(
      "SELECT id FROM orders WHERE order_ref = ?",
      [orderRef]
    );

    // Detect network
    const network = yoPaymentsService.detectNetwork(msisdn);

    // Log payment initiation
    await logPayment({
      order_id: orderRow?.id,
      transaction_ref: orderRef,
      amount: plan.price_ugx,
      customer_msisdn: yoPaymentsService.formatMsisdn(msisdn),
      payment_method: `mobile_money_${network.toLowerCase()}`,
      status: 'initiated',
      request_payload: { msisdn, planCode, network }
    });

    // Get business settings for narrative
    const settings = await settingsService.getSettings();
    const businessName = settings.business_name || "Bula";
    // Extract first word of business name
    const bizPrefix = businessName.split(/\s+/)[0];

    // Build descriptive narrative: "BUULAS WiFi 4 Hours @500UGX"
    const narrative = `${bizPrefix} WiFi ${plan.name} @${plan.price_ugx}UGX`;

    const yoResult = await yoPaymentsService.initiateCollection({
      msisdn,
      amount: plan.price_ugx,
      narrative,
      externalRef: orderRef,
      providerRef: bizPrefix.toUpperCase()
    });

    // Update order with Yo Payments reference
    if (yoResult.transactionReference) {
      await portalDB.query(
        "UPDATE orders SET provider_ref = ? WHERE order_ref = ?",
        [yoResult.transactionReference, orderRef]
      );
    }

    // Update payment log
    await updatePaymentLog(orderRef, yoResult.success ? 'pending' : 'failed', yoResult.rawResponse);

    if (!yoResult.success) {
      return res.status(400).json({
        ok: false,
        message: yoResult.statusMessage || "Failed to initiate payment",
        orderRef
      });
    }

    return res.json({
      ok: true,
      orderRef,
      transactionReference: yoResult.transactionReference,
      message: "Payment request sent. Please check your phone to approve the payment.",
      plan,
      voucher: { code: voucherCode },
      network
    });

  } catch (e) {
    console.error("Yo Payments init error:", e);
    return res.status(500).json({ ok: false, message: "Server error", detail: e.message });
  }
});

/**
 * GET /api/payments/yopayments/status/:orderRef
 *
 * Check the status of a Yo Payments transaction.
 */
router.get("/status/:orderRef", async (req, res) => {
  try {
    const { orderRef } = req.params;

    // Get order
    const [[order]] = await portalDB.query(
      "SELECT id, status, amount_ugx, plan_id, username, password, provider_ref, customer_mac, customer_ip FROM orders WHERE order_ref = ?",
      [orderRef]
    );

    if (!order) {
      return res.status(404).json({ ok: false, message: "Order not found" });
    }

    // If already paid, return success
    if (order.status === "PAID") {
      return res.json({
        ok: true,
        status: "PAID",
        message: "Payment completed",
        voucher: { code: order.username }
      });
    }

    // If no provider reference, payment wasn't initiated properly
    if (!order.provider_ref) {
      return res.json({
        ok: true,
        status: order.status,
        message: "Payment not yet processed"
      });
    }

    // Check status with Yo Payments
    const statusResult = await yoPaymentsService.checkTransactionStatus(order.provider_ref);

    if (statusResult.paymentStatus === "success") {
      // Payment succeeded - activate voucher
      const [[plan]] = await portalDB.query(
        "SELECT duration_minutes, speed_down_kbps, speed_up_kbps, data_mb, name FROM plans WHERE id = ?",
        [order.plan_id]
      );

      if (plan) {
        await activateVoucher({
          username: order.username,
          password: order.password,
          minutes: plan.duration_minutes,
          speedDownKbps: plan.speed_down_kbps,
          speedUpKbps: plan.speed_up_kbps,
          dataMb: plan.data_mb,
        });
      }

      // Update order status
      await portalDB.query(
        "UPDATE orders SET status = 'PAID', provider_tx_id = ?, paid_at = NOW() WHERE order_ref = ?",
        [statusResult.networkRef || order.provider_ref, orderRef]
      );

      // Attempt MikroTik auto-login if MAC address is available
      let autoLoginResult = { success: false, status: 'skipped' };
      if (order.customer_mac && plan) {
        try {
          autoLoginResult = await mikrotikService.authorizeMacBinding({
            mac: order.customer_mac,
            ip: order.customer_ip,
            durationMinutes: plan.duration_minutes,
            comment: `Bula WiFi - Order ${orderRef} - ${plan.name}`,
            orderId: order.id,
          });

          await portalDB.query(
            "UPDATE orders SET autologin_status = ?, autologin_message = ? WHERE order_ref = ?",
            [autoLoginResult.status, autoLoginResult.message, orderRef]
          );
        } catch (mikrotikError) {
          console.error("MikroTik auto-login error (status check):", mikrotikError.message);
          await portalDB.query(
            "UPDATE orders SET autologin_status = 'failed', autologin_message = ? WHERE order_ref = ?",
            [mikrotikError.message, orderRef]
          );
        }
      }

      // Update payment log
      await updatePaymentLog(orderRef, 'success', statusResult.rawResponse, true);

      return res.json({
        ok: true,
        status: "PAID",
        message: "Payment completed successfully",
        voucher: { code: order.username },
        autoLogin: autoLoginResult,
      });
    } else if (statusResult.paymentStatus === "failed") {
      // Payment failed
      await portalDB.query(
        "UPDATE orders SET status = 'FAILED' WHERE order_ref = ?",
        [orderRef]
      );
      await updatePaymentLog(orderRef, 'failed', statusResult.rawResponse, true);

      return res.json({
        ok: true,
        status: "FAILED",
        message: statusResult.statusMessage || "Payment failed"
      });
    }

    // Still pending
    return res.json({
      ok: true,
      status: "PENDING",
      message: "Payment is still being processed"
    });

  } catch (e) {
    console.error("Yo Payments status error:", e);
    return res.status(500).json({ ok: false, message: "Server error", detail: e.message });
  }
});

/**
 * POST /api/payments/yopayments/webhook
 *
 * Yo Payments IPN (Instant Payment Notification) callback.
 * This is called by Yo Payments when a transaction status changes.
 */
router.post("/webhook", async (req, res) => {
  try {
    console.log("Yo Payments webhook received:", {
      body: req.body,
      headers: {
        'content-type': req.headers['content-type']
      }
    });

    // Yo Payments sends data as form-urlencoded or XML
    // Extract relevant fields
    let transactionRef = null;
    let transactionStatus = null;
    let amount = null;
    let networkRef = null;
    let msisdn = null;

    // Check if body is XML
    if (typeof req.body === 'string' && req.body.includes('<?xml')) {
      const parsed = yoPaymentsService.parseXmlResponse(req.body);
      transactionRef = parsed.transactionReference;
      transactionStatus = parsed.transactionStatus;
      networkRef = parsed.networkRef;
    } else {
      // Form data
      transactionRef = req.body.transaction_reference || req.body.external_reference || req.body.TransactionReference;
      transactionStatus = req.body.transaction_status || req.body.TransactionStatus || req.body.status;
      amount = req.body.amount || req.body.Amount;
      networkRef = req.body.network_ref || req.body.NetworkRef;
      msisdn = req.body.msisdn || req.body.Msisdn;
    }

    if (!transactionRef) {
      console.log("Yo Payments webhook: No transaction reference");
      return res.status(200).send("OK");
    }

    // Find order by provider_ref or order_ref
    let order = null;
    let [[orderByRef]] = await portalDB.query(
      "SELECT id, order_ref, status, amount_ugx, plan_id, username, password, customer_mac, customer_ip FROM orders WHERE provider_ref = ? OR order_ref = ?",
      [transactionRef, transactionRef]
    );
    order = orderByRef;

    if (!order) {
      console.log("Yo Payments webhook: Order not found for ref:", transactionRef);
      return res.status(200).send("OK");
    }

    // If already paid, skip
    if (order.status === "PAID") {
      return res.status(200).send("OK");
    }

    // Check transaction status
    const isSuccess = transactionStatus &&
      (transactionStatus.toUpperCase() === "SUCCEEDED" ||
       transactionStatus.toUpperCase() === "SUCCESSFUL" ||
       transactionStatus.toUpperCase() === "SUCCESS");

    if (isSuccess) {
      // Get plan for voucher activation
      const [[plan]] = await portalDB.query(
        "SELECT duration_minutes, speed_down_kbps, speed_up_kbps, data_mb, name FROM plans WHERE id = ?",
        [order.plan_id]
      );

      if (plan) {
        // Activate voucher in RADIUS
        await activateVoucher({
          username: order.username,
          password: order.password,
          minutes: plan.duration_minutes,
          speedDownKbps: plan.speed_down_kbps,
          speedUpKbps: plan.speed_up_kbps,
          dataMb: plan.data_mb,
        });
      }

      // Update order to PAID
      await portalDB.query(
        "UPDATE orders SET status = 'PAID', provider_tx_id = ?, paid_at = NOW() WHERE id = ?",
        [networkRef || transactionRef, order.id]
      );

      // Attempt MikroTik auto-login if MAC address is available
      if (order.customer_mac && plan) {
        try {
          const mikrotikResult = await mikrotikService.authorizeMacBinding({
            mac: order.customer_mac,
            ip: order.customer_ip,
            durationMinutes: plan.duration_minutes,
            comment: `Bula WiFi - Order ${order.order_ref} - ${plan.name} (Webhook)`,
            orderId: order.id,
          });

          await portalDB.query(
            "UPDATE orders SET autologin_status = ?, autologin_message = ? WHERE id = ?",
            [mikrotikResult.status, mikrotikResult.message, order.id]
          );
        } catch (mikrotikError) {
          console.error("MikroTik auto-login error (YoPay webhook):", mikrotikError.message);
          await portalDB.query(
            "UPDATE orders SET autologin_status = 'failed', autologin_message = ? WHERE id = ?",
            [mikrotikError.message, order.id]
          );
        }
      }

      // Update payment log
      await updatePaymentLog(order.order_ref, 'success', req.body, true);

      console.log("Yo Payments webhook: Payment successful for order:", order.order_ref);
    } else if (transactionStatus && transactionStatus.toUpperCase() === "FAILED") {
      // Update order to FAILED
      await portalDB.query(
        "UPDATE orders SET status = 'FAILED' WHERE id = ?",
        [order.id]
      );
      await updatePaymentLog(order.order_ref, 'failed', req.body, true);

      console.log("Yo Payments webhook: Payment failed for order:", order.order_ref);
    }

    return res.status(200).send("OK");
  } catch (e) {
    console.error("Yo Payments webhook error:", e);
    return res.status(200).send("OK");
  }
});

/**
 * Helper to format plan display values
 */
function formatPlanDisplay(plan) {
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

  let speed_display = "";
  if (plan.speed_down_kbps && plan.speed_up_kbps) {
    const down = plan.speed_down_kbps >= 1000 ? `${plan.speed_down_kbps / 1000}Mbps` : `${plan.speed_down_kbps}Kbps`;
    speed_display = `${down} Speed`;
  }

  let data_display = "";
  if (plan.data_mb) {
    data_display = plan.data_mb >= 1024 ? `${(plan.data_mb / 1024).toFixed(1)}GB Data` : `${plan.data_mb}MB Data`;
  }

  return { ...plan, duration_display, speed_display, data_display };
}

/**
 * GET /api/payments/yopayments/redirect
 *
 * Redirect page after mobile money payment (manual check).
 */
router.get("/redirect", async (req, res) => {
  try {
    const orderRef = String(req.query.orderRef || "");

    if (!orderRef) {
      return res.render("payment-failed", {
        message: "Missing order reference",
        orderRef: null
      });
    }

    // Get order
    const [[order]] = await portalDB.query(
      "SELECT id, status, amount_ugx, plan_id, username, password, provider_ref, customer_mac, customer_ip, mikrotik_login_url, autologin_status FROM orders WHERE order_ref = ?",
      [orderRef]
    );

    if (!order) {
      return res.render("payment-failed", {
        message: "Order not found",
        orderRef
      });
    }

    // Get plan
    const [[plan]] = await portalDB.query(
      "SELECT name, duration_minutes, speed_down_kbps, speed_up_kbps, data_mb, price_ugx FROM plans WHERE id = ?",
      [order.plan_id]
    );

    // If already paid
    if (order.status === "PAID") {
      return res.render("payment-success", {
        orderRef,
        voucher: { username: order.username, password: order.password },
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

    // If we have a provider ref, check status
    if (order.provider_ref) {
      try {
        const statusResult = await yoPaymentsService.checkTransactionStatus(order.provider_ref);

        if (statusResult.paymentStatus === "success") {
          // Activate voucher
          if (plan) {
            await activateVoucher({
              username: order.username,
              password: order.password,
              minutes: plan.duration_minutes,
              speedDownKbps: plan.speed_down_kbps,
              speedUpKbps: plan.speed_up_kbps,
              dataMb: plan.data_mb,
            });
          }

          await portalDB.query(
            "UPDATE orders SET status = 'PAID', provider_tx_id = ?, paid_at = NOW() WHERE order_ref = ?",
            [statusResult.networkRef || order.provider_ref, orderRef]
          );

          // Attempt MikroTik auto-login if MAC address is available
          let autoLoginResult = { attempted: false, success: false, status: 'skipped' };
          if (order.customer_mac && plan) {
            try {
              autoLoginResult = await mikrotikService.authorizeMacBinding({
                mac: order.customer_mac,
                ip: order.customer_ip,
                durationMinutes: plan.duration_minutes,
                comment: `Bula WiFi - Order ${orderRef} - ${plan.name}`,
                orderId: order.id,
              });
              autoLoginResult.attempted = true;

              await portalDB.query(
                "UPDATE orders SET autologin_status = ?, autologin_message = ? WHERE order_ref = ?",
                [autoLoginResult.status, autoLoginResult.message, orderRef]
              );
            } catch (mikrotikError) {
              console.error("MikroTik auto-login error (YoPay redirect):", mikrotikError.message);
              autoLoginResult = { attempted: true, success: false, status: 'failed', message: mikrotikError.message };
              await portalDB.query(
                "UPDATE orders SET autologin_status = 'failed', autologin_message = ? WHERE order_ref = ?",
                [mikrotikError.message, orderRef]
              );
            }
          }

          return res.render("payment-success", {
            orderRef,
            voucher: { username: order.username, password: order.password },
            plan: plan ? formatPlanDisplay(plan) : { name: "WiFi Plan", duration_display: "", price_ugx: order.amount_ugx },
            autoLogin: autoLoginResult,
            linkLogin: order.mikrotik_login_url,
          });
        } else if (statusResult.paymentStatus === "failed") {
          await portalDB.query(
            "UPDATE orders SET status = 'FAILED' WHERE order_ref = ?",
            [orderRef]
          );

          return res.render("payment-failed", {
            message: statusResult.statusMessage || "Payment failed",
            orderRef
          });
        }
      } catch (e) {
        console.error("Error checking Yo Payments status on redirect:", e);
      }
    }

    // Payment still pending - show waiting page
    return res.render("payment-pending", {
      orderRef,
      message: "Your payment is being processed. Please check your phone to approve the payment.",
      checkUrl: `/api/payments/yopayments/status/${orderRef}`
    });

  } catch (e) {
    console.error("Yo Payments redirect error:", e);
    return res.render("payment-failed", {
      message: "An error occurred",
      orderRef: req.query.orderRef || null
    });
  }
});

module.exports = router;
