// controllers/topup.controller.js
// Client-facing endpoints for Flow F (WgCards Direct Top-Up). Distinct from
// wallet.controller.js's topup* handlers, which are the unrelated "fund my
// CardCove wallet via bank transfer" flow.
'use strict';

const db = require('../config/database');
const wgcardsTopupService = require('../services/wgcardsTopup.service');
const auditService = require('../services/audit.service');
const logger = require('../utils/logger');

class TopupController {
  // GET /api/v1/topup/skus/:skuId/params — dynamic field list (player ID,
  // phone number, etc) the client must fill in before placing this SKU's
  // top-up order.
  async getParams(req, res, next) {
    try {
      const skuId = parseInt(req.params.skuId);
      if (!skuId) return res.status(400).json({ success: false, message: 'Valid skuId required' });
      const paramInfos = await wgcardsTopupService.getTopupParams(skuId);
      res.json({ success: true, data: { paramInfos } });
    } catch (err) {
      // Not-found / not-a-topup-sku are client errors, not server errors.
      if (/not found|not a Direct Top-Up|not a WgCards/.test(err.message)) {
        return res.status(400).json({ success: false, message: err.message });
      }
      next(err);
    }
  }

  // POST /api/v1/topup/orders
  // Body: { skuId, attributeValues: [{name, value, label?}], faceValue? }
  async placeTopup(req, res, next) {
    try {
      const { skuId, attributeValues, faceValue } = req.body;
      if (!skuId || !Array.isArray(attributeValues) || !attributeValues.length) {
        return res.status(400).json({ success: false, message: 'skuId and a non-empty attributeValues array are required' });
      }

      const result = await wgcardsTopupService.initiateTopup({
        userId: req.user.user_id,
        skuId: parseInt(skuId),
        attributeValues,
        faceValue,
      });

      await auditService.log({
        user_id: req.user.user_id,
        action: 'wgcards_topup_placed',
        entity_type: 'wgcards_topup_order',
        entity_id: String(result.topupOrderId),
        new_values: { orderReference: result.orderReference, success: result.success, reason: result.reason },
        ip_address: req.ip,
        user_agent: req.get('User-Agent'),
      });

      const status = result.success ? 200 : 422;
      res.status(status).json({ success: result.success, data: result });
    } catch (err) {
      // Validation-shaped failures (bad SKU, insufficient balance, wrong
      // faceValue range) came from initiateTopup's own checks before any
      // wallet debit happened — surface as 400, not 500.
      if (/not found|not active|not a Direct Top-Up|Not a WgCards|Insufficient wallet balance|faceValue|Wallet/.test(err.message)) {
        return res.status(400).json({ success: false, message: err.message });
      }
      next(err);
    }
  }

  // GET /api/v1/topup/orders — my top-up order history
  async getMyTopups(req, res, next) {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);
      const offset = (page - 1) * limit;

      const rows = await db.query(
        `SELECT tuo.topup_order_id, tuo.order_reference, tuo.wgcards_order_id, tuo.target_account,
                tuo.amount, tuo.currency, tuo.status, tuo.created_at, tuo.resolved_at,
                p.product_name
           FROM wgcards_topup_orders tuo
           JOIN product_skus ps ON ps.sku_id = tuo.sku_id
           JOIN products p ON p.product_id = ps.product_id
          WHERE tuo.user_id = ?
          ORDER BY tuo.created_at DESC
          LIMIT ? OFFSET ?`,
        [req.user.user_id, limit, offset]
      );
      const [{ total }] = await db.query('SELECT COUNT(*) AS total FROM wgcards_topup_orders WHERE user_id = ?', [req.user.user_id]);

      res.json({ success: true, data: rows, pagination: { page, limit, total } });
    } catch (err) {
      next(err);
    }
  }

  // GET /api/v1/topup/orders/:id — my single top-up order
  async getMyTopupById(req, res, next) {
    try {
      const row = await db.queryOne(
        `SELECT tuo.*, p.product_name
           FROM wgcards_topup_orders tuo
           JOIN product_skus ps ON ps.sku_id = tuo.sku_id
           JOIN products p ON p.product_id = ps.product_id
          WHERE tuo.topup_order_id = ? AND tuo.user_id = ?`,
        [req.params.id, req.user.user_id]
      );
      if (!row) return res.status(404).json({ success: false, message: 'Top-up order not found' });
      res.json({ success: true, data: row });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new TopupController();
