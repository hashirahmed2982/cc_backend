// services/wallet.service.js
const db = require('../config/database');
const logger = require('../utils/logger');

class WalletService {
  // ─────────────────────────────────────────────
  // WALLET BALANCE
  // ─────────────────────────────────────────────

  /** Get wallet for a single user (their own) */
  async getWalletByUserId(userId) {
    const sql = `
      SELECT
        w.wallet_id,
        w.user_id,
        w.balance,
        w.currency,
        w.status,
        w.created_at,
        w.updated_at,
        COALESCE(SUM(CASE WHEN t.transaction_type = 'credit' THEN t.amount ELSE 0 END), 0) AS total_topups,
        COALESCE(SUM(CASE WHEN t.transaction_type = 'debit'  THEN t.amount ELSE 0 END), 0) AS total_spent
      FROM wallets w
      LEFT JOIN wallet_transactions t ON w.wallet_id = t.wallet_id
      WHERE w.user_id = ?
      GROUP BY w.wallet_id
      LIMIT 1
    `;
    return db.queryOne(sql, [userId]);
  }

  /** Get all wallet balances for admin (wallet balances table) */
  async getAllWalletBalances({ page = 1, limit = 50, search } = {}) {
    const offset = (page - 1) * limit;
    const searchClause = search
      ? 'WHERE (u.full_name LIKE ? OR u.email LIKE ? OR u.company_name LIKE ?)'
      : '';
    const searchParams = search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [];

    const sql = `
      SELECT
        w.wallet_id                               AS id,
        w.balance,
        w.currency,
        w.status                                  AS walletStatus,
        w.created_at                              AS createdAt,
        u.user_id,
        u.full_name                               AS userName,
        u.email                                   AS userEmail,
        u.company_name                            AS company,
        COALESCE(stats.total_topups, 0)           AS totalTopups,
        COALESCE(stats.total_spent,  0)           AS totalSpent,
        last_t.created_at                         AS lastTopup,
        last_t.amount                             AS lastTopupAmount
      FROM wallets w
      JOIN users u ON w.user_id = u.user_id
      LEFT JOIN (
        SELECT
          wallet_id,
          SUM(CASE WHEN transaction_type = 'credit' THEN amount ELSE 0 END) AS total_topups,
          SUM(CASE WHEN transaction_type = 'debit'  THEN amount ELSE 0 END) AS total_spent
        FROM wallet_transactions
        GROUP BY wallet_id
      ) stats ON w.wallet_id = stats.wallet_id
      LEFT JOIN (
        SELECT wallet_id, amount, created_at
        FROM wallet_transactions
        WHERE transaction_type = 'credit'
          AND (wallet_id, created_at) IN (
            SELECT wallet_id, MAX(created_at)
            FROM wallet_transactions
            WHERE transaction_type = 'credit'
            GROUP BY wallet_id
          )
      ) last_t ON w.wallet_id = last_t.wallet_id
      ${searchClause}
      ORDER BY w.balance DESC
      LIMIT ? OFFSET ?
    `;

    const countSql = `
      SELECT COUNT(*) AS total
      FROM wallets w
      JOIN users u ON w.user_id = u.user_id
      ${searchClause}
    `;

    const rows = await db.query(sql, [...searchParams, parseInt(limit), parseInt(offset)]);
    const countRow = await db.queryOne(countSql, searchParams);

    return {
      data: rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: countRow.total,
        totalPages: Math.ceil(countRow.total / limit),
      },
    };
  }

  // ─────────────────────────────────────────────
  // TRANSACTIONS
  // ─────────────────────────────────────────────

  async getTransactions({ walletId, userId, page = 1, limit = 20 } = {}) {
    const offset = (page - 1) * limit;

    let whereClauses = [];
    let params = [];

    if (walletId) { whereClauses.push('t.wallet_id = ?'); params.push(walletId); }
    if (userId)   { whereClauses.push('t.user_id = ?');   params.push(userId); }

    const whereClause = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const sql = `
      SELECT
        t.transaction_id   AS id,
        t.transaction_type AS type,
        t.amount,
        t.currency,
        t.balance_before,
        t.balance_after,
        t.description,
        t.reference_type,
        t.reference_id,
        t.payment_method,
        t.payment_ref,
        t.created_at,
        u.full_name        AS processedByName
      FROM wallet_transactions t
      LEFT JOIN users u ON t.processed_by = u.user_id
      ${whereClause}
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const countSql = `
      SELECT COUNT(*) AS total FROM wallet_transactions t ${whereClause}
    `;

    const rows = await db.query(sql, [...params, parseInt(limit), parseInt(offset)]);
    const countRow = await db.queryOne(countSql, params);

    return {
      data: rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: countRow.total,
        totalPages: Math.ceil(countRow.total / limit),
      },
    };
  }

  /** Credit wallet and record transaction (used after topup approval) */
  async creditWallet(walletId, userId, amount, description, referenceType, referenceId, processedBy) {
    const wallet = await db.queryOne('SELECT * FROM wallets WHERE wallet_id = ? FOR UPDATE', [walletId]);
    if (!wallet) throw new Error('Wallet not found');

    const balanceBefore = parseFloat(wallet.balance);
    const balanceAfter  = balanceBefore + parseFloat(amount);

    await db.query(
      'UPDATE wallets SET balance = ?, updated_at = NOW() WHERE wallet_id = ?',
      [balanceAfter, walletId]
    );

    const result = await db.query(
      `INSERT INTO wallet_transactions
         (wallet_id, user_id, transaction_type, amount, currency, balance_before, balance_after,
          description, reference_type, reference_id, processed_by)
       VALUES (?, ?, 'credit', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [walletId, userId, amount, wallet.currency, balanceBefore, balanceAfter,
       description, referenceType, referenceId, processedBy]
    );

    return { transactionId: result.insertId, balanceBefore, balanceAfter };
  }

  // ─────────────────────────────────────────────
  // TOPUP REQUESTS
  // ─────────────────────────────────────────────

  async createTopupRequest(userId, walletId, amount, receiptUrl = null) {
    const result = await db.query(
      `INSERT INTO topup_requests (user_id, wallet_id, amount, receipt_url, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [userId, walletId, amount, receiptUrl]
    );
    return result.insertId;
  }

  async getTopupRequests({ status, page = 1, limit = 20, userId } = {}) {
    const offset = (page - 1) * limit;
    let whereClauses = [];
    let params = [];

    if (status) { whereClauses.push('r.status = ?');  params.push(status); }
    if (userId) { whereClauses.push('r.user_id = ?'); params.push(userId); }

    const whereClause = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const sql = `
      SELECT
        r.request_id        AS id,
        r.amount,
        r.currency,
        r.receipt_url       AS receiptUrl,
        r.status,
        r.rejection_reason  AS rejectionReason,
        r.created_at        AS requestDate,
        r.reviewed_at       AS reviewedAt,
        u.full_name         AS userName,
        u.email             AS userEmail,
        u.company_name      AS company,
        rev.full_name       AS reviewedBy
      FROM topup_requests r
      JOIN  users u   ON r.user_id    = u.user_id
      LEFT JOIN users rev ON r.reviewed_by = rev.user_id
      ${whereClause}
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const countSql = `SELECT COUNT(*) AS total FROM topup_requests r ${whereClause}`;

    const rows     = await db.query(sql, [...params, parseInt(limit), parseInt(offset)]);
    const countRow = await db.queryOne(countSql, params);

    return {
      data: rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: countRow.total,
        totalPages: Math.ceil(countRow.total / limit),
      },
    };
  }

  async getTopupRequestById(requestId) {
    return db.queryOne(
      `SELECT r.*, u.full_name AS userName, u.email AS userEmail, u.company_name AS company
       FROM topup_requests r
       JOIN users u ON r.user_id = u.user_id
       WHERE r.request_id = ?`,
      [requestId]
    );
  }

  async approveTopupRequest(requestId, reviewedBy) {
    // Get the request
    const request = await this.getTopupRequestById(requestId);
    if (!request) throw new Error('Topup request not found');
    if (request.status !== 'pending') throw new Error('Request is no longer pending');

    // Mark approved
    await db.query(
      `UPDATE topup_requests
       SET status = 'approved', reviewed_by = ?, reviewed_at = NOW(), updated_at = NOW()
       WHERE request_id = ?`,
      [reviewedBy, requestId]
    );

    // Credit wallet
    const wallet = await db.queryOne('SELECT * FROM wallets WHERE user_id = ?', [request.user_id]);
    if (!wallet) throw new Error('Wallet not found for user');

    const { transactionId } = await this.creditWallet(
      wallet.wallet_id,
      request.user_id,
      request.amount,
      `Topup approved - Request #${requestId}`,
      'topup_request',
      String(requestId),
      reviewedBy
    );

    return { transactionId, amount: request.amount };
  }

  async rejectTopupRequest(requestId, rejectionReason, reviewedBy) {
    const request = await this.getTopupRequestById(requestId);
    if (!request) throw new Error('Topup request not found');
    if (request.status !== 'pending') throw new Error('Request is no longer pending');

    await db.query(
      `UPDATE topup_requests
       SET status = 'rejected', rejection_reason = ?, reviewed_by = ?, reviewed_at = NOW(), updated_at = NOW()
       WHERE request_id = ?`,
      [rejectionReason, reviewedBy, requestId]
    );
  }

  // ─────────────────────────────────────────────
  // ADMIN: All transactions across wallets
  // ─────────────────────────────────────────────

  async getAllTransactions({ page = 1, limit = 20, userId, type } = {}) {
    let whereClauses = [];
    let params = [];
    if (userId) { whereClauses.push('t.user_id = ?');           params.push(userId); }
    if (type)   { whereClauses.push('t.transaction_type = ?');  params.push(type); }

    const whereClause = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const sql = `
      SELECT
        t.transaction_id   AS id,
        t.transaction_type AS type,
        t.amount,
        t.currency,
        t.balance_before,
        t.balance_after,
        t.description,
        t.reference_type,
        t.reference_id,
        t.created_at,
        u.full_name        AS userName,
        u.email            AS userEmail,
        u.company_name     AS company,
        proc.full_name     AS processedByName
      FROM wallet_transactions t
      JOIN  users u    ON t.user_id      = u.user_id
      LEFT JOIN users proc ON t.processed_by = proc.user_id
      ${whereClause}
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?
    `;
    const countSql = `SELECT COUNT(*) AS total FROM wallet_transactions t ${whereClause}`;

    const rows     = await db.query(sql, [...params, parseInt(limit), parseInt(offset)]);
    const countRow = await db.queryOne(countSql, params);

    return {
      data: rows,
      pagination: { page: parseInt(page), limit: parseInt(limit), total: countRow.total,
        totalPages: Math.ceil(countRow.total / limit) },
    };
  }
}

module.exports = new WalletService();
