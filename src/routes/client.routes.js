// routes/client.routes.js
// Client portal routes — accessible to b2b_client and viewer roles only.
'use strict';

const express                  = require('express');
const router                   = express.Router();
const multer                   = require('multer');
const userProductService       = require('../services/userProduct.service');
const clientDashboardService   = require('../services/clientDashboard.service');
const { protect }              = require('../middleware/auth');
const { query, param, body }   = require('express-validator');
const { validate }             = require('../middleware/validation');

const ticketUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg','image/png','image/webp','application/pdf',
                     'text/csv','application/vnd.ms-excel',
                     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                     'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                     'text/plain'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('File type not allowed'), false);
  },
});

router.use(protect);

// ─── Dashboard summary ─────────────────────────────────────────────────────
// GET /api/v1/client/dashboard
// Returns wallet, pending topup count, recent topups, pending orders,
// recent transactions, recent tickets in one call.
router.get('/dashboard', async (req, res, next) => {
  try {
    const data = await clientDashboardService.getSummary(req.user.user_id);
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─── Orders ───────────────────────────────────────────────────────────────
// GET /api/v1/client/orders
router.get('/orders',
  [
    query('status').optional().isIn(['pending','processing','completed','failed','cancelled']),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { status, page = 1, limit = 20 } = req.query;
      const result = await clientDashboardService.getOrders(req.user.user_id, {
        status, page: parseInt(page), limit: parseInt(limit),
      });
      res.json({ success: true, ...result });
    } catch (err) { next(err); }
  }
);

// ─── Support tickets ───────────────────────────────────────────────────────
// GET  /api/v1/client/tickets
// POST /api/v1/client/tickets
router.get('/tickets',
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { page = 1, limit = 20 } = req.query;
      const result = await clientDashboardService.getTickets(req.user.user_id, {
        page: parseInt(page), limit: parseInt(limit),
      });
      res.json({ success: true, ...result });
    } catch (err) { next(err); }
  }
);

router.post('/tickets',
  ticketUpload.single('attachment'),
  [
    body('title').trim().notEmpty().withMessage('Title is required'),
    body('description').trim().notEmpty().withMessage('Description is required'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { title, description } = req.body;
      const attachmentName = req.file?.originalname || null;
      const ticket = await clientDashboardService.createTicket(req.user.user_id, {
        title, description, attachmentName, attachmentUrl: null,
      });
      res.status(201).json({ success: true, data: ticket, message: 'Ticket created successfully' });
    } catch (err) { next(err); }
  }
);

// ─── Products ──────────────────────────────────────────────────────────────
router.get('/products',
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

router.get('/products/:id',
  [param('id').isInt().withMessage('Valid product ID required')],
  validate,
  async (req, res, next) => {
    try {
      const result = await userProductService.getClientProducts(req.user.user_id, { limit: 9999 });
      const product = result.data.find(p => p.id === req.params.id);
      if (!product) return res.status(404).json({ success: false, message: 'Product not found or not accessible' });
      res.json({ success: true, data: product });
    } catch (err) { next(err); }
  }
);

router.get('/product-categories', async (req, res, next) => {
  try {
    const result     = await userProductService.getClientProducts(req.user.user_id, { limit: 9999 });
    const categories = [...new Set(result.data.map(p => p.category).filter(Boolean))].sort();
    res.json({ success: true, data: categories });
  } catch (err) { next(err); }
});

module.exports = router;