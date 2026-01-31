const portalDB = require("../config/db.portal");

/**
 * Get financial summary statistics
 * @returns {Promise<Object>} Summary statistics
 */
async function getSummary() {
  const safeSum = async (sql, params = []) => {
    try {
      const [[row]] = await portalDB.query(sql, params);
      const val = row && (row.total ?? Object.values(row)[0]);
      return Number(val || 0);
    } catch (e) {
      return 0;
    }
  };

  const safeCount = async (sql, params = []) => {
    try {
      const [[row]] = await portalDB.query(sql, params);
      const val = row && (row.c ?? Object.values(row)[0]);
      return Number(val || 0);
    } catch (e) {
      return 0;
    }
  };

  const totalRevenue = await safeSum(
    "SELECT COALESCE(SUM(amount_ugx), 0) AS total FROM orders WHERE status IN ('PAID','SUCCESS','COMPLETED') OR paid_at IS NOT NULL"
  );

  const monthlyRevenue = await safeSum(
    "SELECT COALESCE(SUM(amount_ugx), 0) AS total FROM orders WHERE (status IN ('PAID','SUCCESS','COMPLETED') OR paid_at IS NOT NULL) AND MONTH(paid_at) = MONTH(CURDATE()) AND YEAR(paid_at) = YEAR(CURDATE())"
  );

  const dailyRevenue = await safeSum(
    "SELECT COALESCE(SUM(amount_ugx), 0) AS total FROM orders WHERE (status IN ('PAID','SUCCESS','COMPLETED') OR paid_at IS NOT NULL) AND DATE(paid_at) = CURDATE()"
  );

  const weeklyRevenue = await safeSum(
    "SELECT COALESCE(SUM(amount_ugx), 0) AS total FROM orders WHERE (status IN ('PAID','SUCCESS','COMPLETED') OR paid_at IS NOT NULL) AND YEARWEEK(paid_at) = YEARWEEK(CURDATE())"
  );

  const pendingPayments = await safeSum(
    "SELECT COALESCE(SUM(amount_ugx), 0) AS total FROM orders WHERE status = 'PENDING'"
  );

  const totalWithdrawn = await safeSum(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM withdrawals WHERE status = 'completed'"
  );

  const pendingWithdrawals = await safeSum(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM withdrawals WHERE status IN ('pending', 'processing')"
  );

  const totalTransactions = await safeCount(
    "SELECT COUNT(*) AS c FROM orders WHERE status IN ('PAID','SUCCESS','COMPLETED') OR paid_at IS NOT NULL"
  );

  const monthlyTransactions = await safeCount(
    "SELECT COUNT(*) AS c FROM orders WHERE (status IN ('PAID','SUCCESS','COMPLETED') OR paid_at IS NOT NULL) AND MONTH(paid_at) = MONTH(CURDATE()) AND YEAR(paid_at) = YEAR(CURDATE())"
  );

  const availableBalance = totalRevenue - totalWithdrawn - pendingWithdrawals;

  return {
    totalRevenue,
    monthlyRevenue,
    weeklyRevenue,
    dailyRevenue,
    pendingPayments,
    totalWithdrawn,
    pendingWithdrawals,
    availableBalance,
    totalTransactions,
    monthlyTransactions
  };
}

/**
 * Get payments/orders with filters
 * @param {Object} options - Filter options
 * @returns {Promise<Object>} Payments and pagination info
 */
async function getPayments(options = {}) {
  const {
    page = 1,
    limit = 50,
    provider = null,
    status = null,
    dateFrom = null,
    dateTo = null
  } = options;

  const offset = (page - 1) * limit;

  let whereClause = "WHERE 1=1";
  const params = [];

  if (provider) {
    whereClause += " AND o.payment_provider = ?";
    params.push(provider.toUpperCase());
  }
  if (status) {
    whereClause += " AND o.status = ?";
    params.push(status.toUpperCase());
  }
  if (dateFrom) {
    whereClause += " AND DATE(o.created_at) >= ?";
    params.push(dateFrom);
  }
  if (dateTo) {
    whereClause += " AND DATE(o.created_at) <= ?";
    params.push(dateTo);
  }

  // Get total count
  const [[countResult]] = await portalDB.query(
    `SELECT COUNT(*) as total FROM orders o ${whereClause}`,
    params
  );
  const total = countResult.total;

  // Get payments
  const [payments] = await portalDB.query(
    `SELECT o.id, o.order_ref as transaction_ref, o.payment_provider as provider_code,
            o.provider_tx_id, o.amount_ugx as amount, 'UGX' as currency,
            o.status, o.created_at as initiated_at, o.paid_at as completed_at,
            c.msisdn as customer_msisdn, p.name as plan_name
     FROM orders o
     LEFT JOIN customers c ON o.customer_id = c.id
     LEFT JOIN plans p ON o.plan_id = p.id
     ${whereClause}
     ORDER BY o.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return {
    payments,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  };
}

/**
 * Get withdrawals with filters
 * @param {Object} options - Filter options
 * @returns {Promise<Object>} Withdrawals and pagination info
 */
async function getWithdrawals(options = {}) {
  const {
    page = 1,
    limit = 50,
    status = null
  } = options;

  const offset = (page - 1) * limit;

  let whereClause = "WHERE 1=1";
  const params = [];

  if (status) {
    whereClause += " AND w.status = ?";
    params.push(status);
  }

  // Get total count
  const [[countResult]] = await portalDB.query(
    `SELECT COUNT(*) as total FROM withdrawals w ${whereClause}`,
    params
  );
  const total = countResult.total;

  // Get withdrawals
  const [withdrawals] = await portalDB.query(
    `SELECT w.*,
            req.full_name as requested_by_name, req.email as requested_by_email,
            apr.full_name as approved_by_name
     FROM withdrawals w
     LEFT JOIN admin_users req ON w.requested_by = req.id
     LEFT JOIN admin_users apr ON w.approved_by = apr.id
     ${whereClause}
     ORDER BY w.requested_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  // Parse JSON destination_details
  const parsedWithdrawals = withdrawals.map(w => ({
    ...w,
    destination_details: typeof w.destination_details === 'string'
      ? JSON.parse(w.destination_details)
      : w.destination_details || {}
  }));

  return {
    withdrawals: parsedWithdrawals,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  };
}

/**
 * Get revenue by provider
 * @returns {Promise<Array>} Revenue breakdown by provider
 */
async function getRevenueByProvider() {
  try {
    const [rows] = await portalDB.query(`
      SELECT payment_provider as provider,
             COUNT(*) as transaction_count,
             COALESCE(SUM(amount_ugx), 0) as total_amount
      FROM orders
      WHERE status IN ('PAID','SUCCESS','COMPLETED') OR paid_at IS NOT NULL
      GROUP BY payment_provider
      ORDER BY total_amount DESC
    `);
    return rows;
  } catch (e) {
    return [];
  }
}

/**
 * Get daily revenue for the last N days
 * @param {number} days - Number of days to include
 * @returns {Promise<Array>} Daily revenue data
 */
async function getDailyRevenue(days = 30) {
  try {
    const [rows] = await portalDB.query(`
      SELECT DATE(paid_at) as date,
             COUNT(*) as transaction_count,
             COALESCE(SUM(amount_ugx), 0) as total_amount
      FROM orders
      WHERE (status IN ('PAID','SUCCESS','COMPLETED') OR paid_at IS NOT NULL)
        AND paid_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY DATE(paid_at)
      ORDER BY date ASC
    `, [days]);
    return rows;
  } catch (e) {
    return [];
  }
}

/**
 * Get monthly revenue for the current year
 * @returns {Promise<Array>} Monthly revenue data
 */
async function getMonthlyRevenue() {
  try {
    const [rows] = await portalDB.query(`
      SELECT MONTH(paid_at) as month,
             YEAR(paid_at) as year,
             COUNT(*) as transaction_count,
             COALESCE(SUM(amount_ugx), 0) as total_amount
      FROM orders
      WHERE (status IN ('PAID','SUCCESS','COMPLETED') OR paid_at IS NOT NULL)
        AND YEAR(paid_at) = YEAR(CURDATE())
      GROUP BY YEAR(paid_at), MONTH(paid_at)
      ORDER BY year, month
    `);
    return rows;
  } catch (e) {
    return [];
  }
}

/**
 * Format amount with thousands separator
 * @param {number} amount - Amount to format
 * @returns {string} Formatted amount
 */
function formatAmount(amount) {
  return new Intl.NumberFormat('en-UG', {
    style: 'decimal',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(amount);
}

module.exports = {
  getSummary,
  getPayments,
  getWithdrawals,
  getRevenueByProvider,
  getDailyRevenue,
  getMonthlyRevenue,
  formatAmount
};
