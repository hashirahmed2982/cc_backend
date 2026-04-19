'use strict';

const db = require('../config/database');
const logger = require('../utils/logger');

class AdminDashboardService {

  async getSummary() {
    try {
      const [
        revenueStats,
        userStats,
        orderStats,
        walletStats,
        inventoryStats,
        recentActivity,
      ] = await Promise.all([
        this._getRevenueStats(),
        this._getUserStats(),
        this._getOrderStats(),
        this._getWalletStats(),
        this._getInventoryStats(),
        this._getRecentActivity(),
      ]);

      return {
        revenue:   revenueStats,
        users:     userStats,
        orders:    orderStats,
        wallet:    walletStats,
        inventory: inventoryStats,
        recentActivity,
      };
    } catch (err) {
      logger.error('AdminDashboardService.getSummary:', err);
      throw err;
    }
  }

  // ─── Revenue ──────────────────────────────────────────────────────────────

  async _getRevenueStats() {
    const row = await db.queryOne(`
      SELECT
        COALESCE(SUM(CASE WHEN order_status = 'completed' THEN total_amount ELSE 0 END), 0) AS totalRevenue,
        COALESCE(SUM(CASE
          WHEN order_status = 'completed'
           AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')
          THEN total_amount ELSE 0 END), 0) AS thisMonth,
        COALESCE(SUM(CASE
          WHEN order_status = 'completed'
           AND created_at >= DATE_FORMAT(NOW() - INTERVAL 1 MONTH, '%Y-%m-01')
           AND created_at <  DATE_FORMAT(NOW(), '%Y-%m-01')
          THEN total_amount ELSE 0 END), 0) AS lastMonth
      FROM orders
    `);

    const thisMonth  = parseFloat(row.thisMonth);
    const lastMonth  = parseFloat(row.lastMonth);
    const changePercent = lastMonth > 0
      ? Math.round(((thisMonth - lastMonth) / lastMonth) * 100 * 10) / 10
      : null;

    return {
      total:         parseFloat(row.totalRevenue),
      thisMonth,
      lastMonth,
      changePercent,
    };
  }

  // ─── Users ────────────────────────────────────────────────────────────────

  async _getUserStats() {
    const row = await db.queryOne(`
      SELECT
        COUNT(*)                                                          AS total,
        SUM(status = 'active')                                            AS active,
        SUM(status = 'pending')                                           AS pendingVerification,
        SUM(status = 'locked')                                            AS locked,
        SUM(user_type = 'b2b_client' AND status = 'active')              AS activeClients,
        SUM(created_at >= DATE_FORMAT(NOW(), '%Y-%m-01'))                 AS newThisMonth,
        SUM(created_at >= DATE_FORMAT(NOW() - INTERVAL 1 MONTH, '%Y-%m-01')
          AND created_at < DATE_FORMAT(NOW(), '%Y-%m-01'))                AS newLastMonth
      FROM users
      WHERE user_type IN ('b2b_client', 'viewer')
    `);

    const newThisMonth  = parseInt(row.newThisMonth);
    const newLastMonth  = parseInt(row.newLastMonth);
    const changePercent = newLastMonth > 0
      ? Math.round(((newThisMonth - newLastMonth) / newLastMonth) * 100 * 10) / 10
      : null;

    return {
      total:               parseInt(row.total),
      active:              parseInt(row.active),
      pendingVerification: parseInt(row.pendingVerification),
      locked:              parseInt(row.locked),
      activeClients:       parseInt(row.activeClients),
      newThisMonth,
      newLastMonth,
      changePercent,
    };
  }

  // ─── Orders ───────────────────────────────────────────────────────────────

  async _getOrderStats() {
    const row = await db.queryOne(`
      SELECT
        COUNT(*)                                              AS total,
        SUM(order_status = 'pending')                         AS pending,
        SUM(order_status = 'processing')                      AS processing,
        SUM(order_status = 'completed')                       AS completed,
        SUM(order_status = 'failed')                          AS failed,
        SUM(created_at >= DATE_FORMAT(NOW(), '%Y-%m-01'))     AS thisMonth,
        SUM(created_at >= DATE_FORMAT(NOW() - INTERVAL 1 MONTH, '%Y-%m-01')
          AND created_at < DATE_FORMAT(NOW(), '%Y-%m-01'))    AS lastMonth
      FROM orders
    `);

    const thisMonth  = parseInt(row.thisMonth);
    const lastMonth  = parseInt(row.lastMonth);
    const changePercent = lastMonth > 0
      ? Math.round(((thisMonth - lastMonth) / lastMonth) * 100 * 10) / 10
      : null;

    return {
      total:      parseInt(row.total),
      pending:    parseInt(row.pending),
      processing: parseInt(row.processing),
      completed:  parseInt(row.completed),
      failed:     parseInt(row.failed),
      thisMonth,
      changePercent,
    };
  }

  // ─── Wallet ───────────────────────────────────────────────────────────────

  async _getWalletStats() {
    const [walletRow, topupRow] = await Promise.all([
      db.queryOne(`
        SELECT
          COALESCE(SUM(balance), 0)       AS totalBalance,
          COUNT(*)                         AS totalWallets,
          SUM(status = 'frozen')           AS frozen
        FROM wallets
      `),
      db.queryOne(`
        SELECT
          SUM(status = 'pending')          AS pendingCount,
          COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) AS pendingAmount
        FROM topup_requests
      `),
    ]);

    return {
      totalBalance:  parseFloat(walletRow.totalBalance),
      totalWallets:  parseInt(walletRow.totalWallets),
      frozen:        parseInt(walletRow.frozen),
      pendingTopups: parseInt(topupRow.pendingCount),
      pendingAmount: parseFloat(topupRow.pendingAmount),
    };
  }

  // ─── Inventory ────────────────────────────────────────────────────────────

  async _getInventoryStats() {
    const row = await db.queryOne(`
      SELECT
        COUNT(DISTINCT p.product_id)                            AS totalProducts,
        SUM(p.is_active = 1)                                    AS activeProducts,
        SUM(p.is_active = 0)                                    AS inactiveProducts,
        SUM(i.available_qty = 0 AND p.source = 'internal'
            AND p.is_active = 1)                                AS outOfStock,
        SUM(i.available_qty > 0 AND i.available_qty <= 10
            AND p.source = 'internal' AND p.is_active = 1)     AS lowStock
      FROM products p
      LEFT JOIN product_skus ps ON ps.product_id = p.product_id AND ps.is_active = 1
      LEFT JOIN inventory i     ON i.sku_id = ps.sku_id
    `);

    return {
      totalProducts:    parseInt(row.totalProducts),
      activeProducts:   parseInt(row.activeProducts),
      inactiveProducts: parseInt(row.inactiveProducts),
      outOfStock:       parseInt(row.outOfStock) || 0,
      lowStock:         parseInt(row.lowStock)   || 0,
    };
  }

  // ─── Recent activity (last 10 events across orders + topups + users) ──────

  
  async _getRecentActivity() {
    const rows = await db.query(`
      SELECT * FROM (
        SELECT
          'user_registered'  AS type,
          u.full_name        AS actor,
          u.email            AS detail,
          u.created_at       AS timestamp
        FROM users u
        WHERE u.user_type = 'b2b_client'

        UNION ALL

        SELECT
          CASE tr.status
            WHEN 'approved' THEN 'topup_approved'
            WHEN 'rejected' THEN 'topup_rejected'
            ELSE 'topup_requested'
          END                AS type,
          u.full_name        AS actor,
          u.email            AS detail,
          tr.created_at      AS timestamp
        FROM topup_requests tr
        JOIN users u ON u.user_id = tr.user_id

        UNION ALL

        SELECT
          'order_placed'     AS type,
          u.full_name        AS actor,
          o.order_number     AS detail,
          o.created_at       AS timestamp
        FROM orders o
        JOIN users u ON u.user_id = o.user_id

      ) combined
      ORDER BY timestamp DESC
      LIMIT 10
    `);

    return rows.map(r => ({
      type:      r.type,
      actor:     r.actor,
      detail:    r.detail,
      timestamp: r.timestamp,
    }));
  }
}

module.exports = new AdminDashboardService();