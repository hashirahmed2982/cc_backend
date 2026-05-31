'use strict';
// src/services/reports.service.js

const db     = require('../config/database');
const logger = require('../utils/logger');

class ReportsService {

  // ─── Helper: build a date range WHERE clause ────────────────────────────────
  _dateRange(col, from, to) {
    const parts = [];
    const params = [];
    if (from) { parts.push(`${col} >= ?`); params.push(from + ' 00:00:00'); }
    if (to)   { parts.push(`${col} <= ?`); params.push(to   + ' 23:59:59'); }
    return { clause: parts.length ? 'AND ' + parts.join(' AND ') : '', params };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 1. Channel Performance
  // ════════════════════════════════════════════════════════════════════════════
  async channelPerformance({ from, to } = {}) {
    const { clause, params } = this._dateRange('o.created_at', from, to);
    const rows = await db.query(`
      SELECT
        o.order_source                                                 AS channel,
        COUNT(DISTINCT o.order_id)                                     AS totalOrders,
        COALESCE(SUM(o.total_amount), 0)                               AS grossSales,
        COALESCE(SUM(CASE WHEN o.order_status='completed' THEN o.total_amount END), 0) AS netSales,
        ROUND(
          100.0 * SUM(CASE WHEN o.order_status='failed' THEN 1 ELSE 0 END)
          / NULLIF(COUNT(*),0), 2)                                     AS refundRate,
        SUM(od.margin_amount)                                          AS marginAmount
      FROM orders o
      JOIN order_details od ON od.order_id = o.order_id
      WHERE 1=1 ${clause}
      GROUP BY o.order_source
      ORDER BY grossSales DESC
    `, params);

    return {
      columns: ['Channel','Total Orders','Gross Sales','Net Sales','Refund Rate %','Margin'],
      rows: rows.map(r => [
        r.channel === 'portal' ? 'B2B Portal' : 'API',
        r.totalOrders,
        `$${parseFloat(r.grossSales).toFixed(2)}`,
        `$${parseFloat(r.netSales).toFixed(2)}`,
        `${r.refundRate ?? 0}%`,
        `$${parseFloat(r.marginAmount ?? 0).toFixed(2)}`,
      ]),
      chartData: rows.map(r => ({
        label: r.channel === 'portal' ? 'B2B Portal' : 'API',
        value: parseFloat(r.grossSales),
      })),
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 2. Transaction Detailed Report
  // ════════════════════════════════════════════════════════════════════════════
  async transactionDetailed({ from, to, page = 1, limit = 100 } = {}) {
    const { clause, params } = this._dateRange('o.created_at', from, to);
    const offset = (page - 1) * limit;

    const rows = await db.query(`
      SELECT
        o.order_number,
        DATE_FORMAT(o.created_at, '%Y-%m-%d')  AS orderDate,
        u.company_name,
        p.product_name,
        ps.face_value,
        od.unit_price,
        od.quantity,
        od.total_price,
        o.payment_method,
        o.order_status
      FROM orders o
      JOIN users u         ON u.user_id   = o.user_id
      JOIN order_details od ON od.order_id = o.order_id
      JOIN products p      ON p.product_id = od.product_id
      JOIN product_skus ps ON ps.sku_id    = od.sku_id
      WHERE 1=1 ${clause}
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    const [{ total }] = await db.query(`
      SELECT COUNT(*) AS total FROM orders o
      JOIN order_details od ON od.order_id = o.order_id
      WHERE 1=1 ${clause}
    `, params);

    return {
      columns: ['Order ID','Date','Client','Product','Face Value','Unit Price','Qty','Total','Payment','Status'],
      rows: rows.map(r => [
        r.order_number,
        r.orderDate,
        r.company_name || '—',
        r.product_name,
        `$${parseFloat(r.face_value ?? 0).toFixed(2)}`,
        `$${parseFloat(r.unit_price).toFixed(2)}`,
        r.quantity,
        `$${parseFloat(r.total_price).toFixed(2)}`,
        r.payment_method,
        r.order_status,
      ]),
      pagination: { page, limit, total: parseInt(total) },
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 3. Most Selling Products
  // ════════════════════════════════════════════════════════════════════════════
  async mostSelling({ from, to } = {}) {
    const { clause, params } = this._dateRange('o.created_at', from, to);
    const rows = await db.query(`
      SELECT
        p.product_name,
        p.brand_name,
        p.category,
        SUM(od.quantity)       AS totalQty,
        SUM(od.total_price)    AS totalRevenue,
        SUM(od.margin_amount)  AS totalMargin
      FROM order_details od
      JOIN orders o   ON o.order_id   = od.order_id
      JOIN products p ON p.product_id = od.product_id
      WHERE o.order_status = 'completed' ${clause}
      GROUP BY od.product_id
      ORDER BY totalQty DESC
      LIMIT 20
    `, params);

    return {
      columns: ['Product','Brand','Category','Units Sold','Revenue','Margin'],
      rows: rows.map(r => [
        r.product_name,
        r.brand_name || '—',
        r.category || '—',
        r.totalQty,
        `$${parseFloat(r.totalRevenue).toFixed(2)}`,
        `$${parseFloat(r.totalMargin ?? 0).toFixed(2)}`,
      ]),
      chartData: rows.slice(0, 8).map(r => ({
        label: r.product_name,
        value: parseFloat(r.totalRevenue),
      })),
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 4. Master Inventory Report
  // ════════════════════════════════════════════════════════════════════════════
  async masterInventory() {
    const rows = await db.query(`
      SELECT
        p.product_name,
        p.brand_name,
        p.category,
        ps.sku_id,
        ps.face_value,
        ps.selling_price,
        ps.cost_price,
        COALESCE(inv.stock_quantity, 0)  AS stockQty,
        COALESCE(inv.available_qty, 0)   AS availableQty,
        COALESCE(inv.reserved_qty, 0)    AS reservedQty,
        inv.unlimited_stock,
        p.source
      FROM products p
      JOIN product_skus ps ON ps.product_id = p.product_id AND ps.is_active = 1
      LEFT JOIN inventory inv ON inv.sku_id = ps.sku_id
      WHERE p.is_active = 1
      ORDER BY p.product_name ASC, ps.face_value ASC
    `);

    return {
      columns: ['Product','Brand','Category','Face Value','Sell Price','Cost','Available','Reserved','Source'],
      rows: rows.map(r => [
        r.product_name,
        r.brand_name || '—',
        r.category || '—',
        `$${parseFloat(r.face_value ?? 0).toFixed(2)}`,
        `$${parseFloat(r.selling_price ?? 0).toFixed(2)}`,
        `$${parseFloat(r.cost_price ?? 0).toFixed(2)}`,
        r.unlimited_stock ? '∞' : r.availableQty,
        r.reservedQty,
        r.source,
      ]),
      chartData: (() => {
        // Group available qty by category
        const map = {};
        rows.forEach(r => {
          const cat = r.category || 'Other';
          map[cat] = (map[cat] || 0) + (r.unlimited_stock ? 0 : parseInt(r.availableQty));
        });
        return Object.entries(map).map(([label, value]) => ({ label, value }));
      })(),
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 5. Code Lifecycle Report
  // ════════════════════════════════════════════════════════════════════════════
  async codeLifecycle({ from, to, page = 1, limit = 100 } = {}) {
    const { clause, params } = this._dateRange('dc.created_at', from, to);
    const offset = (page - 1) * limit;

    const rows = await db.query(`
      SELECT
        dc.code_id,
        dc.upload_batch,
        p.product_name,
        ps.face_value,
        dc.status,
        DATE_FORMAT(dc.sold_at, '%Y-%m-%d')    AS soldDate,
        u.company_name                          AS customer,
        dc.source
      FROM digital_codes dc
      JOIN product_skus ps ON ps.sku_id    = dc.sku_id
      JOIN products p      ON p.product_id = ps.product_id
      LEFT JOIN orders o   ON o.order_id   = dc.order_id
      LEFT JOIN users u    ON u.user_id    = o.user_id
      WHERE 1=1 ${clause}
      ORDER BY dc.code_id DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    const [{ total }] = await db.query(`
      SELECT COUNT(*) AS total FROM digital_codes dc WHERE 1=1 ${clause}
    `, params);

    return {
      columns: ['Code ID','Batch','Product','Face Value','Status','Sold Date','Customer','Source'],
      rows: rows.map(r => [
        `#${r.code_id}`,
        r.upload_batch || '—',
        r.product_name,
        `$${parseFloat(r.face_value ?? 0).toFixed(2)}`,
        r.status,
        r.soldDate || '—',
        r.customer || '—',
        r.source,
      ]),
      pagination: { page, limit, total: parseInt(total) },
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 6. Corporate Account Summary
  // ════════════════════════════════════════════════════════════════════════════
  async corporateAccountSummary() {
    const rows = await db.query(`
      SELECT
        u.user_id,
        u.full_name,
        u.company_name,
        u.email,
        u.status,
        u.created_at,
        w.balance                                                      AS walletBalance,
        COALESCE(SUM(CASE WHEN o.order_status='completed' THEN o.total_amount END), 0) AS lifetimePurchases,
        COUNT(DISTINCT o.order_id)                                     AS totalOrders,
        MAX(o.created_at)                                              AS lastOrderDate
      FROM users u
      LEFT JOIN wallets w ON w.user_id = u.user_id
      LEFT JOIN orders o  ON o.user_id = u.user_id
      WHERE u.user_type = 'b2b_client'
      GROUP BY u.user_id, u.full_name, u.company_name, u.email, u.status, u.created_at, w.balance
      ORDER BY lifetimePurchases DESC
    `);

    return {
      columns: ['Company','Client Name','Email','Status','Wallet Balance','Lifetime Purchases','Orders','Last Order'],
      rows: rows.map(r => [
        r.company_name || '—',
        r.full_name,
        r.email,
        r.status,
        `$${parseFloat(r.walletBalance ?? 0).toFixed(2)}`,
        `$${parseFloat(r.lifetimePurchases).toFixed(2)}`,
        r.totalOrders,
        r.lastOrderDate ? r.lastOrderDate.toISOString().split('T')[0] : '—',
      ]),
      chartData: rows.slice(0, 8).map(r => ({
        label: r.company_name || r.full_name,
        value: parseFloat(r.lifetimePurchases),
      })),
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 7. Bulk Order Report
  // ════════════════════════════════════════════════════════════════════════════
  async bulkOrders({ from, to } = {}) {
    const { clause, params } = this._dateRange('o.created_at', from, to);
    const rows = await db.query(`
      SELECT
        o.order_number,
        u.company_name,
        o.total_amount,
        COUNT(od.order_detail_id)             AS lineItems,
        SUM(od.quantity)                      AS totalQty,
        AVG(od.discount_percent)              AS avgDiscount,
        SUM(od.margin_amount)                 AS totalMargin,
        DATE_FORMAT(o.created_at, '%Y-%m-%d') AS orderDate,
        o.order_status
      FROM orders o
      JOIN users u         ON u.user_id   = o.user_id
      JOIN order_details od ON od.order_id = o.order_id
      WHERE 1=1 ${clause}
      GROUP BY o.order_id, o.order_number, u.company_name, o.total_amount, o.order_status, o.created_at
      HAVING totalQty >= 10
      ORDER BY totalQty DESC
    `, params);

    return {
      columns: ['Order ID','Client','Date','Total Qty','Line Items','Avg Discount%','Total Amount','Margin','Status'],
      rows: rows.map(r => [
        r.order_number,
        r.company_name || '—',
        r.orderDate,
        r.totalQty,
        r.lineItems,
        `${parseFloat(r.avgDiscount ?? 0).toFixed(1)}%`,
        `$${parseFloat(r.total_amount).toFixed(2)}`,
        `$${parseFloat(r.totalMargin ?? 0).toFixed(2)}`,
        r.order_status,
      ]),
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 8. Accounts Receivable Aging
  // ════════════════════════════════════════════════════════════════════════════
  async accountsReceivableAging() {
    const rows = await db.query(`
      SELECT
        u.company_name,
        u.full_name,
        COALESCE(w.balance, 0)  AS walletBalance,
        COALESCE(SUM(CASE WHEN o.order_status='pending'
          AND DATEDIFF(NOW(), o.created_at) BETWEEN 0  AND 30  THEN o.total_amount END), 0) AS d0_30,
        COALESCE(SUM(CASE WHEN o.order_status='pending'
          AND DATEDIFF(NOW(), o.created_at) BETWEEN 31 AND 60  THEN o.total_amount END), 0) AS d31_60,
        COALESCE(SUM(CASE WHEN o.order_status='pending'
          AND DATEDIFF(NOW(), o.created_at) BETWEEN 61 AND 90  THEN o.total_amount END), 0) AS d61_90,
        COALESCE(SUM(CASE WHEN o.order_status='pending'
          AND DATEDIFF(NOW(), o.created_at) > 90               THEN o.total_amount END), 0) AS d90plus
      FROM users u
      LEFT JOIN wallets w ON w.user_id = u.user_id
      LEFT JOIN orders o  ON o.user_id = u.user_id
      WHERE u.user_type = 'b2b_client'
      GROUP BY u.user_id, u.full_name, u.company_name, w.balance
      HAVING (d0_30 + d31_60 + d61_90 + d90plus) > 0
      ORDER BY d90plus DESC, d61_90 DESC
    `);

    return {
      columns: ['Client','Company','0–30 Days','31–60 Days','61–90 Days','90+ Days','Total Pending'],
      rows: rows.map(r => {
        const total = parseFloat(r.d0_30) + parseFloat(r.d31_60) + parseFloat(r.d61_90) + parseFloat(r.d90plus);
        return [
          r.full_name,
          r.company_name || '—',
          `$${parseFloat(r.d0_30).toFixed(2)}`,
          `$${parseFloat(r.d31_60).toFixed(2)}`,
          `$${parseFloat(r.d61_90).toFixed(2)}`,
          `$${parseFloat(r.d90plus).toFixed(2)}`,
          `$${total.toFixed(2)}`,
        ];
      }),
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 9. Real Margin Report
  // ════════════════════════════════════════════════════════════════════════════
  async realMargin({ from, to } = {}) {
    const { clause, params } = this._dateRange('o.created_at', from, to);
    const rows = await db.query(`
      SELECT
        MIN(p.product_name)                                                 AS product_name,
        MIN(ps.face_value)                                                  AS face_value,
        MIN(od.unit_price)                                                  AS sellingPrice,
        MIN(od.unit_cost)                                                   AS costPrice,
        SUM(od.quantity)                                                    AS totalUnits,
        SUM(od.total_price)                                                 AS totalRevenue,
        SUM(od.total_cost)                                                  AS totalCost,
        SUM(od.margin_amount)                                               AS totalMargin,
        ROUND(100.0 * SUM(od.margin_amount) / NULLIF(SUM(od.total_price),0), 2) AS marginPct
      FROM order_details od
      JOIN orders o   ON o.order_id   = od.order_id
      JOIN products p ON p.product_id = od.product_id
      JOIN product_skus ps ON ps.sku_id = od.sku_id
      WHERE o.order_status = 'completed' ${clause}
      GROUP BY od.product_id, od.sku_id
      ORDER BY totalMargin DESC
    `, params);

    return {
      columns: ['Product','Face Value','Sell Price','Cost Price','Units Sold','Revenue','Cost','Margin','Margin %'],
      rows: rows.map(r => [
        r.product_name,
        `$${parseFloat(r.face_value ?? 0).toFixed(2)}`,
        `$${parseFloat(r.sellingPrice).toFixed(2)}`,
        `$${parseFloat(r.costPrice).toFixed(2)}`,
        r.totalUnits,
        `$${parseFloat(r.totalRevenue).toFixed(2)}`,
        `$${parseFloat(r.totalCost).toFixed(2)}`,
        `$${parseFloat(r.totalMargin ?? 0).toFixed(2)}`,
        `${r.marginPct ?? 0}%`,
      ]),
      chartData: rows.slice(0, 8).map(r => ({
        label: r.product_name,
        value: parseFloat(r.totalMargin ?? 0),
      })),
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 10. Admin Activity Log — ALL admin/super_admin actions
  // ════════════════════════════════════════════════════════════════════════════
  async adminActivityLog({ from, to, page = 1, limit = 100, adminId } = {}) {
    const { clause, params } = this._dateRange('al.created_at', from, to);
    const offset = (page - 1) * limit;

    // Optional: filter to a specific admin
    const adminFilter = adminId ? 'AND al.user_id = ?' : '';
    if (adminId) params.push(adminId);

    // Human-readable action labels
    const actionLabel = `
      CASE al.action
        WHEN 'user_login'                  THEN 'Admin Login'
        WHEN 'user_logout'                 THEN 'Admin Logout'
        WHEN 'user_creation'               THEN 'User Created'
        WHEN 'user_update'                 THEN 'User Updated'
        WHEN 'user_delete'                 THEN 'User Deleted'
        WHEN 'user_lock'                   THEN 'User Locked'
        WHEN 'user_unlock'                 THEN 'User Unlocked'
        WHEN 'user_permanent_block'        THEN 'User Permanently Blocked'
        WHEN 'user_settings_update'        THEN 'Profile Updated'
        WHEN 'viewer_account_creation'     THEN 'Viewer Account Created'
        WHEN 'wallet_settlement'           THEN 'Wallet Settled'
        WHEN 'password_reset_admin'        THEN 'Password Reset (Admin)'
        WHEN 'password_reset_requested'    THEN 'Password Reset Requested'
        WHEN 'password_reset'              THEN 'Password Reset'
        WHEN 'password_changed'            THEN 'Password Changed'
        WHEN '2fa_enabled'                 THEN '2FA Enabled'
        WHEN '2fa_disabled'                THEN '2FA Disabled'
        WHEN 'topup_approved'              THEN 'Top-up Approved'
        WHEN 'topup_rejected'              THEN 'Top-up Rejected'
        WHEN 'topup_request_created'       THEN 'Top-up Requested'
        WHEN 'product_created'             THEN 'Product Created'
        WHEN 'product_updated'             THEN 'Product Updated'
        WHEN 'product_deleted'             THEN 'Product Deleted'
        WHEN 'product_status_toggled'      THEN 'Product Status Toggled'
        WHEN 'codes_uploaded'              THEN 'Codes Uploaded'
        WHEN 'user_product_config_saved'   THEN 'Product Access Config Saved'
        WHEN 'order_completed'             THEN 'Order Completed'
        WHEN 'account_locked'              THEN 'Account Auto-Locked'
        ELSE al.action
      END
    `;

    // Build a human-readable "Detail" column from entity + new_values
    const detailExpr = `
      CASE
        WHEN al.entity_type = 'user' AND target.email IS NOT NULL
          THEN CONCAT(COALESCE(target.full_name,''), ' (', target.email, ')')
        WHEN al.entity_type = 'product' AND al.new_values IS NOT NULL
          THEN JSON_UNQUOTE(JSON_EXTRACT(al.new_values, '$.name'))
        WHEN al.entity_type = 'topup_request'
          THEN CONCAT('Request #', al.entity_id)
        WHEN al.entity_id IS NOT NULL
          THEN CONCAT(COALESCE(al.entity_type,''), ' #', al.entity_id)
        ELSE '—'
      END
    `;

    const rows = await db.query(`
      SELECT
        al.log_id,
        COALESCE(u.full_name, 'System')               AS adminName,
        COALESCE(u.email, '—')                        AS adminEmail,
        u.user_type                                   AS adminType,
        (${actionLabel})                              AS actionLabel,
        al.action                                     AS actionRaw,
        al.entity_type,
        al.entity_id,
        (${detailExpr})                               AS detail,
        al.result,
        al.ip_address,
        DATE_FORMAT(al.created_at, '%Y-%m-%d %H:%i:%s') AS createdAt,
        al.old_values,
        al.new_values,
        al.error_message
      FROM audit_logs al
      LEFT JOIN users u      ON u.user_id      = al.user_id
      LEFT JOIN users target ON target.user_id = CAST(al.entity_id AS UNSIGNED)
      WHERE
        -- Only show logs from admin / super_admin users (or system = null user_id)
        (u.user_type IN ('admin', 'super_admin') OR al.user_id IS NULL)
        ${clause}
        ${adminFilter}
      ORDER BY al.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    const countParams = [...(this._dateRange('al.created_at', from, to).params)];
    if (adminId) countParams.push(adminId);

    const [{ total }] = await db.query(`
      SELECT COUNT(*) AS total
      FROM audit_logs al
      LEFT JOIN users u ON u.user_id = al.user_id
      WHERE
        (u.user_type IN ('admin', 'super_admin') OR al.user_id IS NULL)
        ${this._dateRange('al.created_at', from, to).clause}
        ${adminFilter}
    `, countParams);

    return {
      columns: ['Admin','Email','Role','Action','Detail','Result','IP Address','Date & Time'],
      rows: rows.map(r => [
        r.adminName,
        r.adminEmail,
        r.adminType || 'system',
        r.actionLabel,
        r.detail || '—',
        r.result,
        r.ip_address || '—',
        r.createdAt,
      ]),
      pagination: { page, limit, total: parseInt(total) },
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Router: dispatch to correct method by report ID
  // ════════════════════════════════════════════════════════════════════════════
  async getReport(reportId, params = {}) {
    const map = {
      'channel-performance':          () => this.channelPerformance(params),
      'transaction-detailed':         () => this.transactionDetailed(params),
      'most-selling':                 () => this.mostSelling(params),
      'master-inventory':             () => this.masterInventory(),
      'code-lifecycle':               () => this.codeLifecycle(params),
      'corporate-account-summary':    () => this.corporateAccountSummary(),
      'bulk-order':                   () => this.bulkOrders(params),
      'accounts-receivable-aging':    () => this.accountsReceivableAging(),
      'real-margin':                  () => this.realMargin(params),
      'admin-activity-log':           () => this.adminActivityLog(params),
    };

    const fn = map[reportId];
    if (!fn) throw new Error(`Unknown report: ${reportId}`);
    return fn();
  }
}

module.exports = new ReportsService();