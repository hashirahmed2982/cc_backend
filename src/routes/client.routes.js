// routes/client.routes.js
// Client portal routes — accessible to b2b_client and viewer roles only.
// All routes require authentication via protect middleware.
'use strict';

const express              = require('express');
const router               = express.Router();
const userProductService   = require('../services/userProduct.service');
const { protect }          = require('../middleware/auth');
const { query, param }     = require('express-validator');
const { validate }         = require('../middleware/validation');

// All client routes require authentication
router.use(protect);

// ─── GET /api/v1/client/products ──────────────────────────────────────────────
// Returns all products the authenticated user is allowed to see,
// with their specific price (custom if set, regular otherwise).
// Filters: search, category, page, limit
router.get(
  '/products',
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('search').optional().trim(),
    query('category').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { search, category, page = 1, limit = 50 } = req.query;
      const result = await userProductService.getClientProducts(
        req.user.user_id,
        { search, category, page: parseInt(page), limit: parseInt(limit) }
      );
      res.json({ success: true, ...result });
    } catch (err) { next(err); }
  }
);

// ─── GET /api/v1/client/products/:id ──────────────────────────────────────────
// Returns a single product if the user has access to it.
router.get(
  '/products/:id',
  [param('id').isInt().withMessage('Valid product ID required')],
  validate,
  async (req, res, next) => {
    try {
      const result = await userProductService.getClientProducts(req.user.user_id, { limit: 9999 });
      const product = result.data.find(p => p.id === req.params.id);
      if (!product) {
        return res.status(404).json({ success: false, message: 'Product not found or not accessible' });
      }
      res.json({ success: true, data: product });
    } catch (err) { next(err); }
  }
);

// ─── GET /api/v1/client/products/categories ───────────────────────────────────
// Returns distinct categories from products accessible to this user.
router.get('/product-categories', async (req, res, next) => {
  try {
    const result     = await userProductService.getClientProducts(req.user.user_id, { limit: 9999 });
    const categories = [...new Set(result.data.map(p => p.category).filter(Boolean))].sort();
    res.json({ success: true, data: categories });
  } catch (err) { next(err); }
});

module.exports = router;