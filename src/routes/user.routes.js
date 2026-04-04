const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const { protect, isAdmin, isSuperAdmin } = require('../middleware/auth');
const { validate } = require('../middleware/validation');
const { body, param } = require('express-validator');

// All user routes require authentication + admin role
router.use(protect);
router.use(isAdmin);

// Validation rules
const createUserValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain uppercase, lowercase, and number'),
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('company').optional().trim(),
  body('user_type')
    .isIn(['admin', 'b2b_client'])
    .withMessage('user_type must be admin or b2b_client')
];

const createViewerValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain uppercase, lowercase, and number'),
  body('name').trim().notEmpty().withMessage('Name is required')
];

const updateUserValidation = [
  param('id').isInt().withMessage('Valid user ID required'),
  body('name').optional().trim().notEmpty(),
  body('company').optional().trim(),
  body('phone').optional().trim()
];

const lockUserValidation = [
  param('id').isInt().withMessage('Valid user ID required'),
  body('reason').trim().notEmpty().withMessage('Reason is required')
];

const permanentBlockValidation = [
  param('id').isInt().withMessage('Valid user ID required'),
  body('reason').trim().notEmpty().withMessage('Reason is required')
];

const settleWalletValidation = [
  param('id').isInt().withMessage('Valid user ID required'),
  body('settlementMethod').trim().notEmpty().withMessage('Settlement method is required'),
  body('transactionReference').trim().notEmpty().withMessage('Transaction reference is required'),
  body('settlementDate').isDate().withMessage('Valid settlement date is required'),
  body('settlementNotes').optional().trim()
];

// User listing and lookup (admin + super_admin)
router.get('/', userController.getAll);
router.get('/:id', param('id').isInt(), validate, userController.getById);

// Create user:
//   - super_admin only for creating admin accounts (enforced in controller)
//   - admin or super_admin for b2b_client accounts
router.post('/', createUserValidation, validate, userController.create);

// Update / delete (admin + super_admin)
router.put('/:id', updateUserValidation, validate, userController.update);
router.delete('/:id', param('id').isInt(), validate, userController.delete);

// Account management (admin + super_admin)
router.post('/:id/lock', lockUserValidation, validate, userController.lockUser);
router.post('/:id/unlock', param('id').isInt(), validate, userController.unlockUser);
router.post('/:id/reset-password', param('id').isInt(), validate, userController.resetPassword);
router.post('/:id/permanent-block', permanentBlockValidation, validate, userController.permanentBlock);
router.post('/:id/settle-wallet', settleWalletValidation, validate, userController.settleWallet);

// Viewer accounts — belong to a b2b_client parent
router.get('/:id/viewer-accounts', param('id').isInt(), validate, userController.getViewerAccounts);
router.post('/:id/viewer-accounts', param('id').isInt(), createViewerValidation, validate, userController.createViewerAccount);

// Product access
router.get('/:id/products', isAdmin, param('id').isInt(), validate, userController.getUserProductConfig);
router.put('/:id/products', isAdmin,
  [
    param('id').isInt().withMessage('Valid user ID required'),
    body('configs').isArray({ min: 1 }).withMessage('configs must be a non-empty array'),
  ],
  validate,
  userController.saveUserProductConfig
);

module.exports = router;