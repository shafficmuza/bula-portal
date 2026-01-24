const portalDB = require("../config/db.portal");

/**
 * Get all business settings
 * @returns {Promise<Object>} Business settings object
 */
async function getSettings() {
  try {
    const [[settings]] = await portalDB.query(
      "SELECT * FROM business_settings WHERE id = 1"
    );

    if (!settings) {
      // Create default settings if not exists
      await portalDB.query("INSERT IGNORE INTO business_settings (id) VALUES (1)");
      const [[newSettings]] = await portalDB.query(
        "SELECT * FROM business_settings WHERE id = 1"
      );
      return newSettings || getDefaultSettings();
    }

    return settings;
  } catch (e) {
    console.error("Error getting settings:", e);
    // Return default settings if table doesn't exist
    return getDefaultSettings();
  }
}

/**
 * Get default settings when database is not available
 * @returns {Object} Default settings object
 */
function getDefaultSettings() {
  return {
    id: 1,
    business_name: "BUULAS INVESTMENTS",
    tagline: "WiFi Hotspot Service",
    address: null,
    phone: null,
    email: null,
    website: null,
    logo_url: null,
    favicon_url: null,
    portal_title: "Welcome to WiFi",
    portal_welcome_text: "Connect to high-speed internet",
    portal_custom_css: null,
    portal_background_url: null,
    portal_background_color: "#f7f8fa",
    primary_color: "#0ea56b",
    primary_light: "#e6f6ef",
    primary_dark: "#0b8a59",
    theme_mode: "light",
    facebook_url: null,
    twitter_url: null,
    instagram_url: null,
    terms_url: null,
    privacy_url: null,
    terms_text: null,
    support_phone: null,
    support_email: null,
    support_hours: null,
  };
}

/**
 * Update business settings
 * @param {Object} data - Settings data to update
 * @returns {Promise<Object>} Updated settings
 */
async function updateSettings(data) {
  const allowedFields = [
    "business_name",
    "tagline",
    "address",
    "phone",
    "email",
    "website",
    "logo_url",
    "favicon_url",
    "portal_title",
    "portal_welcome_text",
    "portal_custom_css",
    "portal_background_url",
    "portal_background_color",
    "primary_color",
    "primary_light",
    "primary_dark",
    "theme_mode",
    "facebook_url",
    "twitter_url",
    "instagram_url",
    "terms_url",
    "privacy_url",
    "terms_text",
    "support_phone",
    "support_email",
    "support_hours",
  ];

  // Filter only allowed fields
  const updates = {};
  for (const field of allowedFields) {
    if (data.hasOwnProperty(field)) {
      updates[field] = data[field] || null;
    }
  }

  if (Object.keys(updates).length === 0) {
    return await getSettings();
  }

  // Build update query
  const setClauses = Object.keys(updates).map((key) => `${key} = ?`);
  const values = Object.values(updates);

  await portalDB.query(
    `UPDATE business_settings SET ${setClauses.join(", ")} WHERE id = 1`,
    values
  );

  return await getSettings();
}

/**
 * Update a specific field
 * @param {string} field - Field name
 * @param {any} value - Field value
 * @returns {Promise<Object>} Updated settings
 */
async function updateField(field, value) {
  return await updateSettings({ [field]: value });
}

/**
 * Clear a specific image field (logo, background, etc.)
 * @param {string} field - Field name to clear
 * @returns {Promise<Object>} Updated settings
 */
async function clearImageField(field) {
  const imageFields = ["logo_url", "favicon_url", "portal_background_url"];
  if (!imageFields.includes(field)) {
    throw new Error("Invalid image field");
  }

  await portalDB.query(
    `UPDATE business_settings SET ${field} = NULL WHERE id = 1`
  );

  return await getSettings();
}

/**
 * Get CSS variables from settings for dynamic theming
 * @param {Object} settings - Settings object
 * @returns {string} CSS variables string
 */
function getCssVariables(settings) {
  return `
    :root {
      --primary: ${settings.primary_color || "#0ea56b"};
      --primary-light: ${settings.primary_light || "#e6f6ef"};
      --primary-dark: ${settings.primary_dark || "#0b8a59"};
    }
  `;
}

/**
 * Ensure settings table exists
 */
async function ensureSettingsTable() {
  try {
    await portalDB.query(`
      CREATE TABLE IF NOT EXISTS business_settings (
        id INT PRIMARY KEY DEFAULT 1,
        business_name VARCHAR(255) DEFAULT 'BUULAS INVESTMENTS',
        tagline VARCHAR(255) DEFAULT 'WiFi Hotspot Service',
        address TEXT,
        phone VARCHAR(50),
        email VARCHAR(255),
        website VARCHAR(255),
        logo_url VARCHAR(500),
        favicon_url VARCHAR(500),
        portal_title VARCHAR(255) DEFAULT 'Welcome to WiFi',
        portal_welcome_text TEXT DEFAULT 'Connect to high-speed internet',
        portal_custom_css TEXT,
        portal_background_url VARCHAR(500),
        portal_background_color VARCHAR(20) DEFAULT '#f7f8fa',
        primary_color VARCHAR(20) DEFAULT '#0ea56b',
        primary_light VARCHAR(20) DEFAULT '#e6f6ef',
        primary_dark VARCHAR(20) DEFAULT '#0b8a59',
        theme_mode ENUM('light', 'dark', 'auto') DEFAULT 'light',
        facebook_url VARCHAR(500),
        twitter_url VARCHAR(500),
        instagram_url VARCHAR(500),
        terms_url VARCHAR(500),
        privacy_url VARCHAR(500),
        terms_text TEXT,
        support_phone VARCHAR(50),
        support_email VARCHAR(255),
        support_hours VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Insert default row if not exists
    await portalDB.query("INSERT IGNORE INTO business_settings (id) VALUES (1)");

    return true;
  } catch (e) {
    console.error("Error ensuring settings table:", e);
    return false;
  }
}

module.exports = {
  getSettings,
  getDefaultSettings,
  updateSettings,
  updateField,
  clearImageField,
  getCssVariables,
  ensureSettingsTable,
};
