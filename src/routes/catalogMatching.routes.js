// routes/catalogMatching.routes.js
// Admin panel — "Link Products" (Master Plan §9.2). admin+ gated, same
// tier as regular product management (not super-admin-only — this is
// catalog curation, not credentials/balance).
'use strict';

const express = require('express');
const router = express.Router();
const { protect, isAdmin } = require('../middleware/auth');
const { body, param, query } = require('express-validator');
const { validate } = require('../middleware/validation');
const catalogMatching = require('../services/catalogMatching.service');
const auditService = require('../services/audit.service');

router.use(protect, isAdmin);

// Mounted at ${API_PREFIX}/admin — paths below are relative to that, e.g.
// GET /api/v1/admin/catalog-matching/pending.

// GET /api/v1/admin/catalog-matching/pending
router.get('/catalog-matching/pending',
  [
    query('supplier').optional().isString().trim(),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 200 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { supplier, page, limit } = req.query;
      const result = await catalogMatching.getPendingReview({ supplier, page, limit });
      res.json({ success: true, data: result.rows, pagination: result.pagination });
    } catch (err) { next(err); }
  }
);

// GET /api/v1/admin/catalog-matching/:stagingId — one staged item + suggested matches
router.get('/catalog-matching/:stagingId',
  [param('stagingId').isInt({ gt: 0 })],
  validate,
  async (req, res, next) => {
    try {
      const item = await catalogMatching.getStagingItemWithSuggestions(req.params.stagingId);
      if (!item) return res.status(404).json({ success: false, message: 'Staging item not found' });
      res.json({ success: true, data: item });
    } catch (err) { next(err); }
  }
);

// POST /api/v1/admin/catalog-matching/:stagingId/link — confirm a match to an EXISTING canonical SKU
router.post('/catalog-matching/:stagingId/link',
  [
    param('stagingId').isInt({ gt: 0 }),
    body('skuId').isInt({ gt: 0 }).withMessage('Valid skuId required'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const result = await catalogMatching.confirmLink({
        stagingId: req.params.stagingId, skuId: req.body.skuId, reviewedBy: req.user.user_id,
      });
      await auditService.log({
        user_id: req.user.user_id, action: 'catalog_item_linked', entity_type: 'supplier_catalog_items',
        entity_id: String(req.params.stagingId), new_values: { skuId: result.skuId },
        ip_address: req.ip, user_agent: req.get('User-Agent'),
      });
      res.json({ success: true, data: result });
    } catch (err) {
      if (/not found|already/.test(err.message)) return res.status(400).json({ success: false, message: err.message });
      next(err);
    }
  }
);

// POST /api/v1/admin/catalog-matching/:stagingId/create-new — no match, create a new canonical product+SKU
router.post('/catalog-matching/:stagingId/create-new',
  [
    param('stagingId').isInt({ gt: 0 }),
    body('sellingPrice').optional().isFloat({ gt: 0 }),
    body('category').optional().isString().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const result = await catalogMatching.createNewFromStaging({
        stagingId: req.params.stagingId, reviewedBy: req.user.user_id,
        sellingPrice: req.body.sellingPrice, category: req.body.category,
      });
      await auditService.log({
        user_id: req.user.user_id, action: 'catalog_item_created_new', entity_type: 'supplier_catalog_items',
        entity_id: String(req.params.stagingId), new_values: result,
        ip_address: req.ip, user_agent: req.get('User-Agent'),
      });
      res.json({ success: true, data: result });
    } catch (err) {
      if (/not found|already/.test(err.message)) return res.status(400).json({ success: false, message: err.message });
      next(err);
    }
  }
);

// POST /api/v1/admin/catalog-matching/:stagingId/ignore — skip this item, no product created
router.post('/catalog-matching/:stagingId/ignore',
  [param('stagingId').isInt({ gt: 0 })],
  validate,
  async (req, res, next) => {
    try {
      await catalogMatching.ignoreStaging({ stagingId: req.params.stagingId, reviewedBy: req.user.user_id });
      await auditService.log({
        user_id: req.user.user_id, action: 'catalog_item_ignored', entity_type: 'supplier_catalog_items',
        entity_id: String(req.params.stagingId), new_values: {},
        ip_address: req.ip, user_agent: req.get('User-Agent'),
      });
      res.json({ success: true, message: 'Staging item ignored' });
    } catch (err) {
      if (/not found/.test(err.message)) return res.status(404).json({ success: false, message: err.message });
      next(err);
    }
  }
);

module.exports = router;
