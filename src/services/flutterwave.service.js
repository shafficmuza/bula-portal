const axios = require("axios");
const env = require("../config/env");
const paymentProviderService = require("./payment-provider.service");

const FLW_BASE = "https://api.flutterwave.com/v3";

/**
 * Get Flutterwave headers with credentials from DB or env
 * @returns {Promise<Object>} Headers object with Authorization
 */
async function getHeaders() {
  const creds = await paymentProviderService.getFlutterwaveCredentials();
  if (!creds.secret_key) {
    throw new Error("Missing Flutterwave secret key");
  }
  return {
    Authorization: `Bearer ${creds.secret_key}`,
    "Content-Type": "application/json",
  };
}

/**
 * Legacy sync headers function for backward compatibility
 * Uses environment variables directly
 */
function headers() {
  if (!env.FLW_SECRET_KEY) throw new Error("Missing FLW_SECRET_KEY");
  return {
    Authorization: `Bearer ${env.FLW_SECRET_KEY}`,
    "Content-Type": "application/json",
  };
}

/**
 * Create a Flutterwave payment link
 * @param {Object} params - Payment parameters
 * @param {string} params.tx_ref - Transaction reference
 * @param {number} params.amount - Payment amount
 * @param {string} params.currency - Currency code (e.g., 'UGX')
 * @param {Object} params.customer - Customer details
 * @param {string} params.redirect_url - Redirect URL after payment
 * @param {Object} params.meta - Additional metadata
 * @returns {Promise<Object>} Flutterwave response with payment link
 */
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

  const hdrs = await getHeaders();
  const res = await axios.post(`${FLW_BASE}/payments`, payload, { headers: hdrs });
  return res.data; // expects data.link
}

/**
 * Verify a Flutterwave transaction
 * @param {string} tx_id - Transaction ID from Flutterwave
 * @returns {Promise<Object>} Transaction verification result
 */
async function verifyTransaction(tx_id) {
  const hdrs = await getHeaders();
  const res = await axios.get(`${FLW_BASE}/transactions/${tx_id}/verify`, { headers: hdrs });
  return res.data; // expects data.status, data.tx_ref, data.amount, data.currency
}

/**
 * Get Flutterwave credentials (for checking configuration status)
 * @returns {Promise<Object>} Credentials info (without exposing secrets)
 */
async function getCredentialsInfo() {
  const creds = await paymentProviderService.getFlutterwaveCredentials();
  return {
    isConfigured: !!(creds.secret_key && creds.public_key),
    source: creds.source,
    environment: creds.environment,
    hasWebhookHash: !!creds.webhook_hash,
  };
}

/**
 * Check if Flutterwave is enabled and configured
 * @returns {Promise<boolean>} Whether Flutterwave can be used
 */
async function isAvailable() {
  try {
    const creds = await paymentProviderService.getFlutterwaveCredentials();
    return !!(creds.secret_key && creds.public_key);
  } catch (e) {
    return false;
  }
}

module.exports = {
  createPaymentLink,
  verifyTransaction,
  getCredentialsInfo,
  isAvailable,
  headers, // Keep for backward compatibility
};
