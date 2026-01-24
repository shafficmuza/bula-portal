const mysql = require("mysql2/promise");
const env = require("./env");

module.exports = mysql.createPool({
  host: env.DB_HOST,
  user: env.DB_USER,
  password: env.DB_PASS,
  database: env.RADIUS_DB,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});
