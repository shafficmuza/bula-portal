const portalDB = require("../config/db.portal");

/**
 * Default provider configurations
 */
const DEFAULT_PROVIDERS = {
  flutterwave: {
    provider_code: "flutterwave",
    display_name: "Flutterwave",
    is_enabled: 0,
    environment: "test",
    credentials: {
      public_key: "",
      secret_key: "",
      webhook_hash: "",
    },
  },
  yopayments: {
    provider_code: "yopayments",
    display_name: "Yo Payments",
    is_enabled: 0,
    environment: "test",
    credentials: {
      api_username: "",
      api_password: "",
      account_number: "",
    },
  },
};

/**
 * Ensure payment_providers table exists
 */
async function ensureTable() {
  try {
    await portalDB.query(`
      CREATE TABLE IF NOT EXISTS payment_providers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        provider_code VARCHAR(50) NOT NULL UNIQUE,
        display_name VARCHAR(100) NOT NULL,
        is_enabled TINYINT(1) DEFAULT 0,
        environment ENUM('test', 'live') DEFAULT 'test',
        credentials JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_provider_code (provider_code),
        INDEX idx_is_enabled (is_enabled)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Insert default providers if they don't exist
    for (const [code, config] of Object.entries(DEFAULT_PROVIDERS)) {
      await portalDB.query(
        `INSERT IGNORE INTO payment_providers (provider_code, display_name, is_enabled, environment, credentials)
         VALUES (?, ?, ?, ?, ?)`,
        [
          config.provider_code,
          config.display_name,
          config.is_enabled,
          config.environment,
          JSON.stringify(config.credentials),
        ]
      );
    }
  } catch (e) {
    console.error("Error ensuring payment_providers table:", e);
  }
}

/**
 * Get all payment providers
 * @returns {Promise<Array>} List of payment providers
 */
async function getAllProviders() {
  try {
    await ensureTable();
    const [rows] = await portalDB.query(
      "SELECT * FROM payment_providers ORDER BY display_name"
    );
    return rows.map((row) => ({
      ...row,
      credentials: typeof row.credentials === "string"
        ? JSON.parse(row.credentials)
        : row.credentials || {},
    }));
  } catch (e) {
    console.error("Error getting providers:", e);
    return Object.values(DEFAULT_PROVIDERS);
  }
}

/**
 * Get a single payment provider by code
 * @param {string} providerCode - The provider code (e.g., 'flutterwave', 'yopayments')
 * @returns {Promise<Object|null>} Provider configuration or null
 */
async function getProvider(providerCode) {
  try {
    await ensureTable();
    const [[row]] = await portalDB.query(
      "SELECT * FROM payment_providers WHERE provider_code = ?",
      [providerCode]
    );
    if (!row) return DEFAULT_PROVIDERS[providerCode] || null;
    return {
      ...row,
      credentials: typeof row.credentials === "string"
        ? JSON.parse(row.credentials)
        : row.credentials || {},
    };
  } catch (e) {
    console.error("Error getting provider:", e);
    return DEFAULT_PROVIDERS[providerCode] || null;
  }
}

/**
 * Get enabled payment providers
 * @returns {Promise<Array>} List of enabled payment providers
 */
async function getEnabledProviders() {
  try {
    await ensureTable();
    const [rows] = await portalDB.query(
      "SELECT * FROM payment_providers WHERE is_enabled = 1 ORDER BY display_name"
    );
    return rows.map((row) => ({
      ...row,
      credentials: typeof row.credentials === "string"
        ? JSON.parse(row.credentials)
        : row.credentials || {},
    }));
  } catch (e) {
    console.error("Error getting enabled providers:", e);
    return [];
  }
}

/**
 * Update a payment provider's configuration
 * @param {string} providerCode - The provider code
 * @param {Object} data - Update data (is_enabled, environment, credentials)
 * @returns {Promise<Object>} Updated provider
 */
async function updateProvider(providerCode, data) {
  await ensureTable();

  const allowedFields = ["is_enabled", "environment", "credentials"];
  const updates = {};

  for (const field of allowedFields) {
    if (data.hasOwnProperty(field)) {
      if (field === "credentials") {
        updates[field] = JSON.stringify(data[field]);
      } else if (field === "is_enabled") {
        updates[field] = data[field] ? 1 : 0;
      } else {
        updates[field] = data[field];
      }
    }
  }

  if (Object.keys(updates).length === 0) {
    return await getProvider(providerCode);
  }

  const setClauses = Object.keys(updates).map((key) => `${key} = ?`);
  const values = [...Object.values(updates), providerCode];

  await portalDB.query(
    `UPDATE payment_providers SET ${setClauses.join(", ")} WHERE provider_code = ?`,
    values
  );

  return await getProvider(providerCode);
}

/**
 * Get Flutterwave credentials (with env fallback)
 * @returns {Promise<Object>} Flutterwave credentials
 */
async function getFlutterwaveCredentials() {
  const env = require("../config/env");
  const provider = await getProvider("flutterwave");

  // If provider is enabled and has credentials in DB, use those
  if (provider && provider.is_enabled && provider.credentials) {
    const creds = provider.credentials;
    if (creds.secret_key && creds.public_key) {
      return {
        secret_key: creds.secret_key,
        public_key: creds.public_key,
        webhook_hash: creds.webhook_hash || "",
        environment: provider.environment,
        source: "database",
      };
    }
  }

  // Fallback to environment variables
  return {
    secret_key: env.FLW_SECRET_KEY || "",
    public_key: env.FLW_PUBLIC_KEY || "",
    webhook_hash: env.FLW_WEBHOOK_HASH || "",
    environment: "live",
    source: "environment",
  };
}

/**
 * Get Yo Payments credentials
 * @returns {Promise<Object>} Yo Payments credentials
 */
async function getYoPaymentsCredentials() {
  const env = require("../config/env");
  const provider = await getProvider("yopayments");

  // If provider is enabled and has credentials in DB, use those
  if (provider && provider.is_enabled && provider.credentials) {
    const creds = provider.credentials;
    if (creds.api_username && creds.api_password) {
      return {
        api_username: creds.api_username,
        api_password: creds.api_password,
        account_number: creds.account_number || "",
        environment: provider.environment,
        source: "database",
      };
    }
  }

  // Fallback to environment variables
  return {
    api_username: env.YO_API_USERNAME || "",
    api_password: env.YO_API_PASSWORD || "",
    account_number: env.YO_ACCOUNT_NUMBER || "",
    environment: "live",
    source: "environment",
  };
}

/**
 * Check if a provider is enabled
 * @param {string} providerCode - The provider code
 * @returns {Promise<boolean>} Whether the provider is enabled
 */
async function isProviderEnabled(providerCode) {
  const provider = await getProvider(providerCode);
  return provider && provider.is_enabled === 1;
}

module.exports = {
  ensureTable,
  getAllProviders,
  getProvider,
  getEnabledProviders,
  updateProvider,
  getFlutterwaveCredentials,
  getYoPaymentsCredentials,
  isProviderEnabled,
  DEFAULT_PROVIDERS,
};
