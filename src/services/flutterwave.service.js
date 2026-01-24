const axios = require("axios");
const env = require("../config/env");

const FLW_BASE = "https://api.flutterwave.com/v3";

function headers() {
  if (!env.FLW_SECRET_KEY) throw new Error("Missing FLW_SECRET_KEY");
  return {
    Authorization: `Bearer ${env.FLW_SECRET_KEY}`,
    "Content-Type": "application/json",
  };
}

async function createPaymentLink({ tx_ref, amount, currency, customer, redirect_url, meta }) {
  const payload = {
    tx_ref,
    amount,
    currency,
    redirect_url,
    customer,
    meta,
    customizations: {
      title: "Bula WiFi Hotspot",
      description: "Internet voucher purchase",
    },
  };

  const res = await axios.post(`${FLW_BASE}/payments`, payload, { headers: headers() });
  return res.data; // expects data.link
}

async function verifyTransaction(tx_id) {
  const res = await axios.get(`${FLW_BASE}/transactions/${tx_id}/verify`, { headers: headers() });
  return res.data; // expects data.status, data.tx_ref, data.amount, data.currency
}

module.exports = { createPaymentLink, verifyTransaction };
