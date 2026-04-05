// routes/order.routes.js
'use strict';

const express         = require('express');
const router          = express.Router();
const orderController = require('../controllers/order.controller');
const { protect, isAdmin } = require('../middleware/auth');
const { body, param, query } = require('express-validator');
const { validate }    = require('../middleware/validation');

router.use(protect);

// ─── CLIENT ───────────────────────────────────────────────────────────────────

// POST /api/v1/orders — place an order
router.post('/',
  [
    body('items').isArray({ min: 1 }).withMessage('items must be a non-empty array'),
    body('items.*.productId').isInt({ gt: 0 }).withMessage('Each item must have a valid productId'),
    body('items.*.quantity').isInt({ gt: 0 }).withMessage('Each item must have quantity > 0'),
    body('notes').optional().trim(),
  ],
  validate,
  orderController.placeOrder
);

// GET /api/v1/orders — my order history
router.get('/',
  [
    query('status').optional().isIn(['pending','processing','completed','failed','cancelled']),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  orderController.getMyOrders
);

// GET /api/v1/orders/:id — my single order
router.get('/:id',
  [param('id').isInt().withMessage('Valid order ID required')],
  validate,
  orderController.getMyOrderById
);

// ─── ADMIN ────────────────────────────────────────────────────────────────────

// GET /api/v1/orders/admin/all — all orders with client info
router.get('/admin/all',
  isAdmin,
  [
    query('status').optional().isIn(['pending','processing','completed','failed','cancelled']),
    query('userId').optional().isInt(),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  orderController.getAllOrders
);

// GET /api/v1/orders/admin/:id — order detail with delivery breakdown
router.get('/admin/:id',
  isAdmin,
  [param('id').isInt().withMessage('Valid order ID required')],
  validate,
  orderController.getOrderById
);

// POST /api/v1/orders/admin/:id/complete — fulfill remaining + notify client
router.post('/admin/:id/complete',
  isAdmin,
  [param('id').isInt().withMessage('Valid order ID required')],
  validate,
  orderController.completeOrder
);

module.exports = router;
