const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { protect } = require('../middleware/auth');
const { validate } = require('../middleware/validation');
const { body } = require('express-validator');

// Validation rules
const loginValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').notEmpty().withMessage('Password is required')
];

const otpRequestValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required')
];

const otpVerifyValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('otp').isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits')
];

const forgotPasswordValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required')
];

const resetPasswordValidation = [
  body('token').notEmpty().withMessage('Reset token is required'),
  body('newPassword')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain uppercase, lowercase, and number')
];

const refreshTokenValidation = [
  body('refreshToken').notEmpty().withMessage('Refresh token is required')
];

const verify2FAValidation = [
  body('token').notEmpty().isLength({ min: 6, max: 6 }).withMessage('Valid 6-digit code is required')
];

const disable2FAValidation = [
  body('token').notEmpty().isLength({ min: 6, max: 6 }).withMessage('Valid 6-digit MFA code is required'),
  body('password').notEmpty().withMessage('Password is required')
];

// Public routes
router.post('/login', loginValidation, validate, authController.login);
router.post('/request-otp', otpRequestValidation, validate, authController.requestOTP);
router.post('/verify-otp', otpVerifyValidation, validate, authController.verifyOTP);
router.post('/refresh', refreshTokenValidation, validate, authController.refreshToken);
router.post('/forgot-password', forgotPasswordValidation, validate, authController.forgotPassword);
router.post('/reset-password', resetPasswordValidation, validate, authController.resetPassword);

// Portal-specific logins
router.post('/admin/login', loginValidation, validate, authController.adminLogin);
router.post('/client/login', loginValidation, validate, authController.clientLogin);

// Protected routes
router.use(protect);
router.post('/logout', authController.logout);
router.post('/enable-2fa', validate, authController.enable2FA);
router.post('/verify-2fa', verify2FAValidation, validate, authController.verify2FA);
router.post('/disable-2fa', disable2FAValidation, validate, authController.disable2FA);

module.exports = router;
