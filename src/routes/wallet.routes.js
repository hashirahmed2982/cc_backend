// routes/wallet.routes.js
const express    = require('express');
const router     = express.Router();
const walletCtrl = require('../controllers/wallet.controller');
const { protect, isAdmin } = require('../middleware/auth');
const { body, param, query } = require('express-validator');
const { validate } = require('../middleware/validation');
const logger = require('../utils/logger');

const multer = require('multer');
const path   = require('path');
const crypto = require('crypto');
const fs     = require('fs');

// Ensure upload directory exists
const uploadDir = path.join(__dirname, '../../uploads/receipts');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext      = path.extname(file.originalname).toLowerCase();
    const unique   = crypto.randomBytes(12).toString('hex');
    cb(null, `receipt_${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },  // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    allowed.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error('Only JPG, PNG, WebP and PDF allowed'));
  },
});
 
// All wallet routes require authentication
router.use(protect);
 
// ─────────────────────────────────────────────
// CLIENT ROUTES (any authenticated user)
// ─────────────────────────────────────────────
 
// Own wallet balance
router.get('/balance', walletCtrl.getMyBalance);
 
// Own transaction history
router.get('/transactions', walletCtrl.getMyTransactions);
 
// Own topup requests
router.get('/my-topup-requests', walletCtrl.getMyTopupRequests);
 
// Submit a topup request — multipart/form-data with optional receipt file
// Fields: amount (number), receiptUrl? (string fallback if no file)
router.post(
  '/topup', protect, upload.single('receipt'),
  walletCtrl.requestTopup
);
 
// ─────────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────────
// GET /api/v1/wallet/topup/:id/receipt
router.get('/topup/:id/receipt', protect, isAdmin, async (req, res, next) => {
  try {
    const db  = require('../config/database');
    const row = await db.queryOne(
      'SELECT receipt_url FROM topup_requests WHERE request_id = ?',
      [req.params.id]
    );

    if (!row?.receipt_url) {
      return res.status(404).json({ success: false, message: 'No receipt found' });
    }

    // Prefer explicit env var, then fall back to deriving from the request
    const baseUrl = process.env.API_BASE_URL
      || `${req.protocol}://${req.get('host')}`;

    // Ensure receipt_url starts with / before appending
    const path = row.receipt_url.startsWith('/')
      ? row.receipt_url
      : `/${row.receipt_url}`;

    const url = `${baseUrl}${path}`;

    res.json({ success: true, data: { url, expiresIn: null } });
  } catch (err) {
    logger.error(`[Receipt] Error for request_id ${req.params.id}:`, err.message);
    next(err);
  }
});
// All wallet balances overview
router.get('/balances', isAdmin, walletCtrl.getAllBalances);

// All topup requests
router.get('/topup-requests', isAdmin, walletCtrl.getTopupRequests);

// All transactions (admin history view)
router.get('/transactions/all', isAdmin, walletCtrl.getAllTransactions);

// Approve topup request (requires MFA)
router.post(
  '/topup/:requestId/approve',
  isAdmin,
  [
    param('requestId').isInt({ gt: 0 }).withMessage('Valid request ID required'),
    body('mfaCode').trim().notEmpty().withMessage('MFA code is required'),
  ],
  validate,
  walletCtrl.approveTopup
);

// Reject topup request (requires MFA)
router.post(
  '/topup/:requestId/reject',
  isAdmin,
  [
    param('requestId').isInt({ gt: 0 }).withMessage('Valid request ID required'),
    body('reason').trim().notEmpty().withMessage('Rejection reason is required'),
    body('mfaCode').trim().notEmpty().withMessage('MFA code is required'),
  ],
  validate,
  walletCtrl.rejectTopup
);

module.exports = router;
