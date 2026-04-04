// services/clientDashboard.service.js
'use strict';

const db     = require('../config/database');
const logger = require('../utils/logger');

class ClientDashboardService {

  // ══════════════════════════════════════════════════════════════════════════
  //  DASHBOARD SUMMARY  —  one call, all data
  // ══════════════════════════════════════════════════════════════════════════

  async getSummary(userId) {
    try {
      const uid = parseInt(userId);
      const [
        wallet,
        pendingTopups,
        recentTopups,
        pendingOrders,
        recentTransactions,
        recentTickets,
      ] = await Promise.all([
        this._getWallet(uid),
        this._getPendingTopupCount(uid),
        this._getRecentTopups(uid),
        this._getPendingOrders(uid),
        this._getRecentTransactions(uid),
        this._getRecentTickets(uid),
      ]);

      return {
        wallet,
        pendingTopups,
        recentTopups,
        pendingOrders,
        recentTransactions,
        recentTickets,
      };
    } catch (err) {
      logger.error('ClientDashboardService.getSummary:', err);
      throw err;
    }
  }

  // ─── Wallet balance ───────────────────────────────────────────────────────

  async _getWallet(userId) {
    const row = await db.queryOne(
      `SELECT balance, currency, status FROM wallets WHERE user_id = ? LIMIT 1`,
      [userId]
    );
    return row
      ? { balance: parseFloat(row.balance), currency: row.currency, status: row.status }
      : { balance: 0, currency: 'USD', status: 'active' };
  }

  // ─── Pending topup count ──────────────────────────────────────────────────

  async _getPendingTopupCount(userId) {
    const row = await db.queryOne(
      `SELECT COUNT(*) AS n FROM topup_requests WHERE user_id = ? AND status = 'pending'`,
      [userId]
    );
    return row?.n || 0;
  }

  // ─── Recent topup requests (last 5) ──────────────────────────────────────

  async _getRecentTopups(userId) {
    const rows = await db.query(
      `SELECT
         request_id   AS id,
         amount,
         currency,
         receipt_url  AS receiptUrl,
         status,
         rejection_reason AS rejectionReason,
         created_at   AS requestedAt,
         reviewed_at  AS reviewedAt
       FROM topup_requests
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 5`,
      [userId]
    );
    return rows.map(r => ({
      ...r,
      id:          String(r.id),
      amount:      parseFloat(r.amount),
    }));
  }

  // ─── Pending orders ───────────────────────────────────────────────────────

  async _getPendingOrders(userId) {
    const rows = await db.query(
      `SELECT
         o.order_id       AS id,
         o.order_number   AS orderNumber,
         o.order_status   AS status,
         o.total_amount   AS total,
         o.currency,
         o.created_at     AS createdAt,
         p.product_name   AS product,
         od.quantity
       FROM orders o
       JOIN order_details od ON od.order_id = o.order_id
       JOIN products p       ON p.product_id = od.product_id
       WHERE o.user_id = ?
         AND o.order_status IN ('pending', 'processing')
       ORDER BY o.created_at DESC
       LIMIT 10`,
      [userId]
    );
    return rows.map(r => ({
      ...r,
      id:    String(r.id),
      total: parseFloat(r.total),
    }));
  }

  // ─── Recent wallet transactions (last 5) ─────────────────────────────────

  async _getRecentTransactions(userId) {
    const wallet = await db.queryOne(
      'SELECT wallet_id FROM wallets WHERE user_id = ? LIMIT 1',
      [userId]
    );
    if (!wallet) return [];

    const rows = await db.query(
      `SELECT
         t.transaction_id   AS id,
         t.transaction_type AS type,
         t.amount,
         t.description,
         t.reference_type   AS referenceType,
         t.reference_id     AS referenceId,
         t.created_at       AS timestamp
       FROM wallet_transactions t
       WHERE t.wallet_id = ?
       ORDER BY t.created_at DESC
       LIMIT 5`,
      [wallet.wallet_id]
    );
    return rows.map(r => ({
      ...r,
      id:     String(r.id),
      amount: r.type === 'debit'
        ? -Math.abs(parseFloat(r.amount))
        :  Math.abs(parseFloat(r.amount)),
    }));
  }

  // ─── Recent support tickets (last 5) ─────────────────────────────────────

  async _getRecentTickets(userId) {
    const rows = await db.query(
      `SELECT
         ticket_id      AS id,
         ticket_number  AS ticketNumber,
         title,
         attachment_name AS attachmentName,
         status,
         created_at     AS createdAt
       FROM support_tickets
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 5`,
      [userId]
    );
    return rows.map(r => ({ ...r, id: String(r.id) }));
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  ORDERS — full list with pagination
  // ══════════════════════════════════════════════════════════════════════════

  async getOrders(userId, { status, page = 1, limit = 20 } = {}) {
    try {
      const uid    = parseInt(userId);
      const offset = (page - 1) * limit;
      const conds  = ['o.user_id = ?'];
      const params = [uid];

      if (status) { conds.push('o.order_status = ?'); params.push(status); }

      const where = `WHERE ${conds.join(' AND ')}`;

      const rows = await db.query(
        `SELECT
           o.order_id      AS id,
           o.order_number  AS orderNumber,
           o.order_status  AS status,
           o.total_amount  AS total,
           o.currency,
           o.created_at    AS createdAt,
           GROUP_CONCAT(p.product_name SEPARATOR ', ') AS products,
           SUM(od.quantity) AS totalQty
         FROM orders o
         JOIN order_details od ON od.order_id = o.order_id
         JOIN products p        ON p.product_id = od.product_id
         ${where}
         GROUP BY o.order_id
         ORDER BY o.created_at DESC
         LIMIT ? OFFSET ?`,
        [...params, parseInt(limit), offset]
      );

      const countRow = await db.queryOne(
        `SELECT COUNT(DISTINCT o.order_id) AS n FROM orders o ${where}`,
        params
      );

      return {
        data: rows.map(r => ({ ...r, id: String(r.id), total: parseFloat(r.total) })),
        pagination: { page: parseInt(page), limit: parseInt(limit), total: countRow.n, totalPages: Math.ceil(countRow.n / limit) },
      };
    } catch (err) {
      logger.error('ClientDashboardService.getOrders:', err);
      throw err;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SUPPORT TICKETS
  // ══════════════════════════════════════════════════════════════════════════

  async getTickets(userId, { page = 1, limit = 20 } = {}) {
    try {
      const uid    = parseInt(userId);
      const offset = (page - 1) * limit;

      const rows = await db.query(
        `SELECT
           ticket_id       AS id,
           ticket_number   AS ticketNumber,
           title,
           description,
           attachment_name AS attachmentName,
           status,
           created_at      AS createdAt
         FROM support_tickets
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
        [uid, parseInt(limit), offset]
      );

      const countRow = await db.queryOne(
        'SELECT COUNT(*) AS n FROM support_tickets WHERE user_id = ?',
        [uid]
      );

      return {
        data: rows.map(r => ({ ...r, id: String(r.id) })),
        pagination: { page: parseInt(page), limit: parseInt(limit), total: countRow.n, totalPages: Math.ceil(countRow.n / limit) },
      };
    } catch (err) {
      logger.error('ClientDashboardService.getTickets:', err);
      throw err;
    }
  }

  async createTicket(userId, { title, description, attachmentName, attachmentUrl }) {
    try {
      const ticketNumber = `TKT-${Date.now().toString().slice(-6)}`;
      const result = await db.query(
        `INSERT INTO support_tickets
           (user_id, ticket_number, title, description, attachment_name, attachment_url)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [parseInt(userId), ticketNumber, title, description, attachmentName || null, attachmentUrl || null]
      );
      return {
        id:            String(result.insertId),
        ticketNumber,
        title,
        description,
        attachmentName: attachmentName || null,
        status:        'pending',
        createdAt:     new Date().toISOString(),
      };
    } catch (err) {
      logger.error('ClientDashboardService.createTicket:', err);
      throw err;
    }
  }
}

module.exports = new ClientDashboardService();