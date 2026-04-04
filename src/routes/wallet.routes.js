// routes/wallet.routes.js
const express    = require('express');
const router     = express.Router();
const multer     = require('multer');
const walletCtrl = require('../controllers/wallet.controller');
const { protect, isAdmin } = require('../middleware/auth');
const { body, param, query } = require('express-validator');
const { validate } = require('../middleware/validation');

const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    allowed.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error('Only images (jpg/png/webp) and PDF files are allowed'), false);
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
  '/topup',
  receiptUpload.single('receipt'),
  [
    body('amount')
      .isFloat({ gt: 0 })
      .withMessage('Amount must be a positive number'),
  ],
  validate,
  walletCtrl.requestTopup
);
 
// ─────────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────────

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
