// routes/topup.routes.js
// Client-facing Flow F (WgCards Direct Top-Up) endpoints. The inbound
// WgCards webhook itself lives outside this router — see
// routes/webhooks/wgcardsTopup.js, mounted directly on app.js with no auth.
'use strict';

const express = require('express');
const router = express.Router();
const topupController = require('../controllers/topup.controller');
const { protect } = require('../middleware/auth');
const { body, param } = require('express-validator');
const { validate } = require('../middleware/validation');

router.use(protect);

// GET /api/v1/topup/skus/:skuId/params
router.get('/skus/:skuId/params',
  [param('skuId').isInt({ gt: 0 }).withMessage('Valid skuId required')],
  validate,
  topupController.getParams
);

// POST /api/v1/topup/orders
router.post('/orders',
  [
    body('skuId').isInt({ gt: 0 }).withMessage('Valid skuId required'),
    body('attributeValues').isArray({ min: 1 }).withMessage('attributeValues must be a non-empty array'),
    body('attributeValues.*.name').notEmpty().withMessage('Each attributeValues entry needs a name'),
    body('attributeValues.*.value').notEmpty().withMessage('Each attributeValues entry needs a value'),
    body('faceValue').optional().isFloat({ gt: 0 }),
  ],
  validate,
  topupController.placeTopup
);

// GET /api/v1/topup/orders
router.get('/orders', topupController.getMyTopups);

// GET /api/v1/topup/orders/:id
router.get('/orders/:id',
  [param('id').isInt({ gt: 0 }).withMessage('Valid order ID required')],
  validate,
  topupController.getMyTopupById
);

module.exports = router;
