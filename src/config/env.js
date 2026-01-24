require("dotenv").config();

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

module.exports = {
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || "development",

  DB_HOST: process.env.DB_HOST || "localhost",
  DB_USER: req("DB_USER"),
  DB_PASS: req("DB_PASS"),

  RADIUS_DB: process.env.RADIUS_DB || "radius",
  PORTAL_DB: process.env.PORTAL_DB || "portal",

  ADMIN_API_KEY: process.env.ADMIN_API_KEY || "",

 FLW_ENV: process.env.FLW_ENV || "live",
 FLW_PUBLIC_KEY: process.env.FLW_PUBLIC_KEY || "",
 FLW_SECRET_KEY: process.env.FLW_SECRET_KEY || "",
 FLW_WEBHOOK_HASH: process.env.FLW_WEBHOOK_HASH || "",
 BASE_URL: process.env.BASE_URL || "http://localhost:3000",

};
