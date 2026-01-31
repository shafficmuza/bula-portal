const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const session = require("express-session");
const MySQLStore = require("express-mysql-session")(session);
const portalDB = require("./config/db.portal");

const portalRoutes = require("./routes/portal.routes");
const loadSettings = require("./middleware/loadSettings");
const settingsService = require("./services/settings.service");
const paymentProviderService = require("./services/payment-provider.service");

const app = express();

app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://api.flutterwave.com"],
      fontSrc: ["'self'", "https:", "data:"],
    },
  },
}));
app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("combined"));

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

const path = require("path");
app.use(express.static(path.join(__dirname, "..", "public")));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));

/** Admin sessions (stored in portal DB) */
const sessionStore = new MySQLStore({}, portalDB.promise ? portalDB.promise() : portalDB);
app.use(session({
  key: "bula_admin_sid",
  secret: process.env.SESSION_SECRET || "change_this_now",
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax" }
}));

app.use(express.urlencoded({ extended: true }));

// Ensure settings table exists on startup
settingsService.ensureSettingsTable().catch(console.error);

// Ensure payment providers table exists on startup
paymentProviderService.ensureTable().catch(console.error);

// Load business settings into all views
app.use(loadSettings);

app.get("/health", (req, res) => res.json({ ok: true }));

// Captive Portal Page
app.get("/portal", async (req, res) => {
  const settings = await settingsService.getSettings();

  // Capture MikroTik hotspot redirect parameters
  const customerMac = req.query.mac || req.query["chap-id"] || null;
  const customerIp = req.query.ip || null;
  const linkLogin = req.query["link-login"] || req.query["link-login-only"] || null;
  const linkOrig = req.query["link-orig"] || null;

  // Store in session for payment flow
  if (customerMac) {
    req.session.customerMac = customerMac;
    req.session.customerIp = customerIp;
    req.session.mikrotikLoginUrl = linkLogin;
    req.session.mikrotikOrigUrl = linkOrig;
  }

  res.render("portal/index", {
    settings,
    customerMac,
    customerIp,
    linkLogin,
    linkOrig,
  });
});

// Payment Pending Page (for Yo Payments polling)
app.get("/payment-pending", async (req, res) => {
  const { orderRef } = req.query;
  if (!orderRef) {
    return res.redirect("/portal");
  }

  const settings = await settingsService.getSettings();
  res.render("payment-pending", {
    settings,
    orderRef,
    message: "Please check your phone and approve the payment to continue.",
    checkUrl: `/api/payments/yopayments/status/${orderRef}`
  });
});

app.use("/api/portal", portalRoutes);
app.use("/api/payments/flutterwave", require("./routes/flutterwave.routes"));
app.use("/api/payments/yopayments", require("./routes/yopayments.routes"));

app.use("/admin", require("./routes/admin.routes"));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, message: "Server error", detail: err.message });
});

module.exports = app;
