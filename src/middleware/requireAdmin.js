module.exports = function requireAdmin(req, res, next) {
  if (req.session && req.session.admin && req.session.admin.id) return next();
  return res.redirect("/admin/login");
};
