// routes/topup.routes.js
// Client-facing Flow F (WgCards Direct Top-Up) endpoints. The inbound
// WgCards webhook itself lives outside this router — see
// routes/webhooks/wgcardsTopup.js, mounted directly on app.js with no auth.
//
// OUT OF SCOPE (2026-10-06): business decision — Direct Top-Up products/
// orders are not being catered to. Left wired up and working rather than
// removed, since Direct Top-Up products are already excluded from the
// customer catalog entirely (the spuType:5 filter in
// userProduct.service.js#getClientProducts), so nothing can reach these
// endpoints with a real product today regardless. Revisit before
// resurrecting this — wgcards.service.js's placeDirectOrder() has an
// unconfirmed gap around custom face values under the v4 API (see that
// method's comment) that was never resolved, just deprioritized.
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
