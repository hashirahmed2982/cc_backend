// routes/supplier.routes.js
// Admin panel — Supplier Settings, Integration Activity/Error Log, and
// Cron Health. Balance and credentials are super-admin-only (per the
// client's own comment on the master plan doc — balance visibility scoped
// to super_admin); everything else here is admin+.
'use strict';

const express = require('express');
const router = express.Router();
const { protect, isAdmin, isSuperAdmin } = require('../middleware/auth');
const { body, param, query } = require('express-validator');
const { validate } = require('../middleware/validation');
const db = require('../config/database');
const supplierConfigRepo = require('../repositories/supplierConfig.repository');
const cronJobRunsRepo = require('../repositories/cronJobRuns.repository');
const supplierApiLog = require('../services/supplierApiLog.service');
const auditService = require('../services/audit.service');

router.use(protect, isAdmin);

// Mounted at ${API_PREFIX}/admin (alongside admin.routes.js's /dashboard) —
// paths below are relative to that, e.g. GET /api/v1/admin/suppliers.

// GET /api/v1/admin/suppliers — health + (super-admin only) balance/credentials
router.get('/suppliers', async (req, res, next) => {
  try {
    const rows = await db.query('SELECT * FROM supplier_config ORDER BY supplier_name ASC');
    const isSuper = req.user.user_type === 'super_admin';
    const data = rows.map((row) => ({
      supplierName: row.supplier_name,
      isActive: !!row.is_active,
      integrationStatus: row.integration_status,
      consecutiveFailures: row.consecutive_failures,
      downSince: row.down_since,
      lastSync: row.last_sync,
      apiBaseUrl: row.api_base_url,
      // Balance is the sensitive bit — never sent to a plain admin.
      balance: isSuper ? row.balance : null,
      balanceCurrency: isSuper ? row.balance_currency : null,
      balanceCheckedAt: isSuper ? row.balance_checked_at : null,
      lowBalanceThreshold: isSuper ? row.low_balance_threshold : null,
      // Credentials are never sent to the client at all, super-admin included
      // — this endpoint is read-only for them; use the PUT below to replace.
    }));
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// PUT /api/v1/admin/suppliers/:name/credentials — super-admin only
router.put('/suppliers/:name/credentials',
  isSuperAdmin,
  [
    param('name').isString().trim().notEmpty(),
    body('appId').isString().trim().notEmpty(),
    body('accountId').isString().trim().notEmpty(),
    body('appKey').isString().trim().notEmpty(),
    body('apiBaseUrl').isString().trim().notEmpty(),
    body('lowBalanceThreshold').optional().isFloat({ min: 0 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { name } = req.params;
      const { appId, accountId, appKey, apiBaseUrl, lowBalanceThreshold } = req.body;

      await supplierConfigRepo.upsertCredentials(name, { appId, accountId, appKey, apiBaseUrl });
      if (lowBalanceThreshold !== undefined) {
        await db.query('UPDATE supplier_config SET low_balance_threshold = ? WHERE supplier_name = ?', [lowBalanceThreshold, name]);
      }
      // Credentials just changed — the cached token is for the OLD ones.
      await supplierConfigRepo.clearToken(name);

      await auditService.log({
        user_id: req.user.user_id,
        action: 'supplier_credentials_updated',
        entity_type: 'supplier_config',
        entity_id: name,
        new_values: { apiBaseUrl, lowBalanceThreshold }, // never log secrets
        ip_address: req.ip,
        user_agent: req.get('User-Agent'),
      });

      res.json({ success: true, message: `${name} credentials updated` });
    } catch (err) { next(err); }
  }
);

// GET /api/v1/admin/suppliers/:name/logs — Integration Activity / Error Log
router.get('/suppliers/:name/logs',
  [
    param('name').isString().trim().notEmpty(),
    query('statusCode').optional().isInt(),
    query('errorsOnly').optional().isBoolean(),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 200 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { name } = req.params;
      const { statusCode, errorsOnly, page, limit } = req.query;
      const result = await supplierApiLog.list({
        supplierName: name,
        statusCode: statusCode !== undefined ? parseInt(statusCode) : undefined,
        errorsOnly: errorsOnly === 'true',
        page, limit,
      });
      res.json({ success: true, data: result.rows, pagination: result.pagination });
    } catch (err) { next(err); }
  }
);

// GET /api/v1/admin/suppliers/:name/topups — Flow F queue visibility
// (webhook-lost / still-pending Direct Top-Up orders)
router.get('/suppliers/:name/topups',
  [
    param('name').isString().trim().notEmpty(),
    query('status').optional().isIn(['pending', 'processing', 'confirmed', 'failed', 'cancelled']),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      // Only WgCards has Flow F today, but keeping this name-scoped rather
      // than hardcoded keeps the route honest about being supplier-specific
      // once a second supplier adds an equivalent flow.
      if (req.params.name !== 'wgcards') {
        return res.json({ success: true, data: [], pagination: { page: 1, limit: 20, total: 0 } });
      }
      const page = parseInt(req.query.page) || 1;
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);
      const offset = (page - 1) * limit;
      const conds = [];
      const params = [];
      if (req.query.status) { conds.push('tuo.status = ?'); params.push(req.query.status); }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

      const rows = await db.query(
        `SELECT tuo.topup_order_id, tuo.order_reference, tuo.wgcards_order_id, tuo.target_account,
                tuo.amount, tuo.currency, tuo.status, tuo.webhook_status, tuo.webhook_attempts,
                tuo.resolved_via, tuo.created_at, tuo.resolved_at, u.email AS userEmail, p.product_name
           FROM wgcards_topup_orders tuo
           JOIN users u ON u.user_id = tuo.user_id
           JOIN product_skus ps ON ps.sku_id = tuo.sku_id
           JOIN products p ON p.product_id = ps.product_id
           ${where}
          ORDER BY tuo.created_at DESC
          LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      const [{ total }] = await db.query(`SELECT COUNT(*) AS total FROM wgcards_topup_orders tuo ${where}`, params);

      res.json({ success: true, data: rows, pagination: { page, limit, total } });
    } catch (err) { next(err); }
  }
);

// GET /api/v1/admin/cron-status — Cron Health widget
router.get('/cron-status', async (req, res, next) => {
  try {
    const rows = await cronJobRunsRepo.getAll();
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

module.exports = router;
