const settingsService = require("../services/settings.service");

/**
 * Middleware to load business settings into res.locals for all views
 * This makes settings available in all EJS templates as `settings`
 */
async function loadSettings(req, res, next) {
  try {
    const settings = await settingsService.getSettings();
    res.locals.settings = settings;
    res.locals.businessName = settings.business_name || "BUULAS INVESTMENTS";
    res.locals.tagline = settings.tagline || "WiFi Hotspot Service";
  } catch (e) {
    // Use defaults if settings can't be loaded
    res.locals.settings = settingsService.getDefaultSettings();
    res.locals.businessName = "BUULAS INVESTMENTS";
    res.locals.tagline = "WiFi Hotspot Service";
  }
  next();
}

module.exports = loadSettings;
