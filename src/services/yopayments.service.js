const axios = require("axios");
const paymentProviderService = require("./payment-provider.service");

/**
 * Yo Payments API URLs
 */
const YO_API_URLS = {
  test: "https://sandbox.yo.co.ug/services/yopaymentsdev/task.php",
  live: "https://paymentsapi1.yo.co.ug/ybs/task.php"
};

/**
 * Get Yo Payments credentials from DB or env
 * @returns {Promise<Object>} Credentials with API URL
 */
async function getCredentials() {
  const creds = await paymentProviderService.getYoPaymentsCredentials();
  const apiUrl = creds.environment === "live" ? YO_API_URLS.live : YO_API_URLS.test;
  return {
    ...creds,
    apiUrl
  };
}

/**
 * Build XML request for Yo Payments API
 * @param {string} method - API method name
 * @param {Object} params - Method parameters
 * @param {Object} creds - API credentials
 * @returns {string} XML request string
 */
function buildXmlRequest(method, params, creds) {
  const paramXml = Object.entries(params)
    .map(([key, value]) => `<${key}>${escapeXml(String(value))}</${key}>`)
    .join("\n      ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<AutoCreate>
  <Request>
    <APIUsername>${escapeXml(creds.api_username)}</APIUsername>
    <APIPassword>${escapeXml(creds.api_password)}</APIPassword>
    <Method>${escapeXml(method)}</Method>
    ${paramXml}
  </Request>
</AutoCreate>`;
}

/**
 * Escape special XML characters
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
function escapeXml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Parse XML response from Yo Payments
 * @param {string} xml - XML response string
 * @returns {Object} Parsed response object
 */
function parseXmlResponse(xml) {
  const result = {
    status: null,
    statusCode: null,
    statusMessage: null,
    transactionReference: null,
    transactionStatus: null,
    networkRef: null,
    mnoPRN: null,
    isError: false,
    rawXml: xml
  };

  try {
    // Extract Status
    const statusMatch = xml.match(/<Status>([^<]+)<\/Status>/);
    if (statusMatch) result.status = statusMatch[1];

    // Extract StatusCode
    const statusCodeMatch = xml.match(/<StatusCode>([^<]+)<\/StatusCode>/);
    if (statusCodeMatch) result.statusCode = statusCodeMatch[1];

    // Extract StatusMessage or ErrorMessage
    const statusMsgMatch = xml.match(/<StatusMessage>([^<]+)<\/StatusMessage>/);
    const errorMsgMatch = xml.match(/<ErrorMessage>([^<]+)<\/ErrorMessage>/);
    result.statusMessage = statusMsgMatch ? statusMsgMatch[1] : (errorMsgMatch ? errorMsgMatch[1] : null);

    // Extract TransactionReference
    const txRefMatch = xml.match(/<TransactionReference>([^<]+)<\/TransactionReference>/);
    if (txRefMatch) result.transactionReference = txRefMatch[1];

    // Extract TransactionStatus
    const txStatusMatch = xml.match(/<TransactionStatus>([^<]+)<\/TransactionStatus>/);
    if (txStatusMatch) result.transactionStatus = txStatusMatch[1];

    // Extract NetworkRef (MNO reference)
    const networkRefMatch = xml.match(/<NetworkRef>([^<]+)<\/NetworkRef>/);
    if (networkRefMatch) result.networkRef = networkRefMatch[1];

    // Extract MnoPRN (Mobile Network Operator PRN)
    const mnoPrnMatch = xml.match(/<MnoPRN>([^<]+)<\/MnoPRN>/);
    if (mnoPrnMatch) result.mnoPRN = mnoPrnMatch[1];

    // Determine if error
    result.isError = result.status === "ERROR" || result.statusCode === "ERROR";

  } catch (e) {
    console.error("Error parsing Yo Payments XML response:", e);
    result.isError = true;
    result.statusMessage = "Failed to parse response";
  }

  return result;
}

/**
 * Initiate a mobile money collection request
 * @param {Object} params - Payment parameters
 * @param {string} params.msisdn - Customer phone number (256XXXXXXXXX format)
 * @param {number} params.amount - Amount to collect
 * @param {string} params.narrative - Transaction description
 * @param {string} params.externalRef - External reference for tracking
 * @param {string} [params.providerRef] - Provider reference code
 * @returns {Promise<Object>} Collection response
 */
async function initiateCollection({ msisdn, amount, narrative, externalRef, providerRef }) {
  const creds = await getCredentials();

  if (!creds.api_username || !creds.api_password) {
    throw new Error("Yo Payments credentials not configured");
  }

  // Format phone number (ensure 256 prefix)
  const formattedMsisdn = formatMsisdn(msisdn);

  // Build params - ExternalReference can cause issues in sandbox, so only include narrative
  const params = {
    NonBlocking: "TRUE",
    Amount: amount,
    Account: formattedMsisdn,
    Narrative: narrative || "Bula WiFi Voucher"
  };

  // Only add optional parameters if provided and we're in live mode
  if (creds.environment === "live") {
    if (externalRef) {
      params.ExternalReference = externalRef;
    }
    if (providerRef) {
      params.ProviderReferenceText = providerRef;
    }
  }

  const xml = buildXmlRequest("acdepositfunds", params, creds);

  try {
    const response = await axios.post(creds.apiUrl, xml, {
      headers: {
        "Content-Type": "application/xml",
        "Accept": "application/xml"
      },
      timeout: 30000
    });

    const result = parseXmlResponse(response.data);

    return {
      success: !result.isError && result.status === "OK",
      transactionReference: result.transactionReference,
      status: result.status,
      statusCode: result.statusCode,
      statusMessage: result.statusMessage,
      rawResponse: result
    };
  } catch (e) {
    console.error("Yo Payments collection error:", e.message);
    throw new Error(`Yo Payments request failed: ${e.message}`);
  }
}

/**
 * Check the status of a transaction
 * @param {string} transactionRef - Yo Payments transaction reference
 * @returns {Promise<Object>} Transaction status
 */
async function checkTransactionStatus(transactionRef) {
  const creds = await getCredentials();

  if (!creds.api_username || !creds.api_password) {
    throw new Error("Yo Payments credentials not configured");
  }

  const params = {
    TransactionReference: transactionRef,
    PrivateTransactionReference: transactionRef
  };

  const xml = buildXmlRequest("actransactioncheckstatus", params, creds);

  try {
    const response = await axios.post(creds.apiUrl, xml, {
      headers: {
        "Content-Type": "application/xml",
        "Accept": "application/xml"
      },
      timeout: 30000
    });

    const result = parseXmlResponse(response.data);

    // Map Yo Payments status to our status
    let paymentStatus = "pending";
    if (result.transactionStatus === "SUCCEEDED") {
      paymentStatus = "success";
    } else if (result.transactionStatus === "FAILED") {
      paymentStatus = "failed";
    } else if (result.transactionStatus === "PENDING") {
      paymentStatus = "pending";
    } else if (result.transactionStatus === "INDETERMINATE") {
      paymentStatus = "processing";
    }

    return {
      success: !result.isError,
      transactionReference: result.transactionReference,
      transactionStatus: result.transactionStatus,
      paymentStatus,
      networkRef: result.networkRef,
      statusMessage: result.statusMessage,
      rawResponse: result
    };
  } catch (e) {
    console.error("Yo Payments status check error:", e.message);
    throw new Error(`Status check failed: ${e.message}`);
  }
}

/**
 * Format phone number to 256XXXXXXXXX format
 * @param {string} msisdn - Phone number in any format
 * @returns {string} Formatted phone number
 */
function formatMsisdn(msisdn) {
  // Remove all non-digit characters
  let cleaned = String(msisdn).replace(/\D/g, "");

  // Handle different formats
  if (cleaned.startsWith("256")) {
    // Already in correct format
    return cleaned;
  } else if (cleaned.startsWith("0")) {
    // Local format: 0XXXXXXXXX
    return "256" + cleaned.slice(1);
  } else if (cleaned.startsWith("7") || cleaned.startsWith("3")) {
    // Short format: 7XXXXXXXX or 3XXXXXXXX
    return "256" + cleaned;
  } else if (cleaned.startsWith("+256")) {
    return cleaned.replace("+", "");
  }

  // Default: assume it needs 256 prefix
  return "256" + cleaned;
}

/**
 * Determine the mobile network from phone number
 * @param {string} msisdn - Phone number
 * @returns {string} Network name (MTN, AIRTEL, unknown)
 */
function detectNetwork(msisdn) {
  const formatted = formatMsisdn(msisdn);
  const prefix = formatted.slice(3, 5); // Get digits after 256

  // MTN Uganda prefixes: 77, 78, 76, 39
  const mtnPrefixes = ["77", "78", "76", "39"];
  // Airtel Uganda prefixes: 70, 75, 74
  const airtelPrefixes = ["70", "75", "74"];

  if (mtnPrefixes.includes(prefix)) {
    return "MTN";
  } else if (airtelPrefixes.includes(prefix)) {
    return "AIRTEL";
  }

  return "unknown";
}

/**
 * Check if Yo Payments is enabled and configured
 * @returns {Promise<boolean>} Whether Yo Payments can be used
 */
async function isAvailable() {
  try {
    const creds = await paymentProviderService.getYoPaymentsCredentials();
    return !!(creds.api_username && creds.api_password);
  } catch (e) {
    return false;
  }
}

/**
 * Get credentials info (for checking configuration status)
 * @returns {Promise<Object>} Credentials info (without exposing secrets)
 */
async function getCredentialsInfo() {
  const creds = await paymentProviderService.getYoPaymentsCredentials();
  return {
    isConfigured: !!(creds.api_username && creds.api_password),
    source: creds.source,
    environment: creds.environment,
    hasAccountNumber: !!creds.account_number
  };
}

module.exports = {
  initiateCollection,
  checkTransactionStatus,
  formatMsisdn,
  detectNetwork,
  isAvailable,
  getCredentialsInfo,
  parseXmlResponse,
  YO_API_URLS
};
