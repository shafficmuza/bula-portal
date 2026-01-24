const env = require("../config/env");

function requireAdmin(req, res, next) {
  const key = req.header("x-admin-key");
  if (!key || key !== env.ADMIN_API_KEY) {
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  }
  next();
}

module.exports = { requireAdmin };
