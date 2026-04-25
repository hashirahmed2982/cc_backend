const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const authService = require('../services/auth.service');
const userService = require('../services/user.service');
const sessionService = require('../services/session.service');
const emailService = require('../services/email.service');
const auditService = require('../services/audit.service');
const mfaService = require('../services/mfa.service');
const logger = require('../utils/logger');
const { generateTokens, verifyRefreshToken } = require('../utils/tokens');

// ─── Shared login logic extracted to avoid duplication ───────────────────────
async function performLogin(req, res, next, { allowedUserTypes, portalName }) {
  try {
    const { email, password, mfaCode } = req.body;

    const user = await userService.findByEmail(email);

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // ── Portal separation: reject wrong user type immediately ──────────────
    if (!allowedUserTypes.includes(user.user_type)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. This login is for the ${portalName} portal only.`,
      });
    }

    // ── Account status checks ──────────────────────────────────────────────
    if (user.status === 'permanently_blocked') {
      return res.status(403).json({
        success: false,
        message: 'Your account has been permanently blocked. Please contact support.',
      });
    }

    if (user.status === 'pending') {
      return res.status(403).json({
        success: false,
        message: 'Please verify your email before logging in',
      });
    }

    if (user.status === 'locked' && user.locked_until && new Date() < new Date(user.locked_until)) {
      const remainingTime = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(403).json({
        success: false,
        message: `Account is locked. Try again in ${remainingTime} minutes.`,
      });
    }

    // Auto-unlock if lock period has passed
    if (user.status === 'locked' && user.locked_until && new Date() >= new Date(user.locked_until)) {
      await userService.update(user.user_id, {
        status: 'active',
        failed_login_attempts: 0,
        locked_until: null,
      });
      user.status = 'active';
    }

    // ── Password verification ──────────────────────────────────────────────
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);

    if (!isPasswordValid) {
      const failedAttempts = (user.failed_login_attempts || 0) + 1;
      const maxAttempts = parseInt(process.env.MAX_LOGIN_ATTEMPTS) || 10;

      if (failedAttempts >= maxAttempts) {
        const lockTime = parseInt(process.env.ACCOUNT_LOCK_TIME) || 30;
        const lockedUntil = new Date(Date.now() + lockTime * 60000);

        await userService.update(user.user_id, {
          status: 'locked',
          failed_login_attempts: failedAttempts,
          locked_until: lockedUntil,
        });

        await auditService.log({
          user_id: user.user_id,
          action: 'account_locked',
          entity_type: 'user',
          entity_id: user.user_id,
          details: { reason: 'Too many failed login attempts' },
          ip_address: req.ip,
        });

        return res.status(403).json({
          success: false,
          message: `Account locked due to too many failed attempts. Try again in ${lockTime} minutes.`,
        });
      }

      await userService.update(user.user_id, { failed_login_attempts: failedAttempts });

      return res.status(401).json({
        success: false,
        message: `Invalid credentials. ${maxAttempts - failedAttempts} attempts remaining.`,
      });
    }

    // ── MFA check ─────────────────────────────────────────────────────────
    if (user.is_2fa_enabled) {
      if (!mfaCode) {
        return res.status(200).json({
          success: true,
          requiresMFA: true,
          message: 'Please provide MFA code',
        });
      }

      const isValidMFA = await mfaService.verifyToken(user.user_id, mfaCode);
      if (!isValidMFA) {
        return res.status(401).json({ success: false, message: 'Invalid MFA code' });
      }
    }

    // ── Success ───────────────────────────────────────────────────────────
    await userService.update(user.user_id, {
      failed_login_attempts: 0,
      last_login: new Date(),
    });

    const { accessToken, refreshToken } = generateTokens(user);

    await sessionService.create({
      user_id: user.user_id,
      token: accessToken,
      refresh_token: refreshToken,
      ip_address: req.ip,
      user_agent: req.get('user-agent'),
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    await auditService.log({
      user_id: user.user_id,
      action: 'user_login',
      entity_type: 'user',
      entity_id: user.user_id,
      ip_address: req.ip,
      user_agent: req.get('user-agent'),
      result: 'success',
    });

    const userData = await userService.findById(user.user_id);
    delete userData.password_hash;
    delete userData['2fa_secret'];

    return res.json({
      success: true,
      message: 'Login successful',
      data: { user: userData, accessToken, refreshToken },
    });
  } catch (error) {
    await auditService.log({
      user_id: null,
      action: 'user_login',
      details: { email: req.body.email },
      ip_address: req.ip,
      user_agent: req.get('user-agent'),
      result: 'failed',
      error_message: error.message,
    });
    next(error);
  }
}

class AuthController {
  /**
   * Request OTP
   * POST /api/v1/auth/request-otp
   */
  async requestOTP(req, res, next) {
    try {
      const { email } = req.body;
      
      // Optionally check if user exists
      const user = await userService.findByEmail(email);
      if (!user) {
        return res.status(404).json({ success: false, message: 'No account found with this email' });
      }

      const otp = await authService.generateOTP(email);
      await emailService.sendOTPEmail(email, otp);

      res.json({
        success: true,
        message: 'A 6-digit verification code has been sent to your email.'
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Verify OTP
   * POST /api/v1/auth/verify-otp
   */
  async verifyOTP(req, res, next) {
    try {
      const { email, otp } = req.body;

      const isValid = await authService.verifyOTP(email, otp);

      if (!isValid) {
        return res.status(400).json({
          success: false,
          message: 'Invalid or expired verification code'
        });
      }

      res.json({
        success: true,
        message: 'OTP verified successfully'
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Login user - Admin portal only (super_admin and admin)
   * POST /api/v1/auth/login
   */
  async login(req, res, next) {
    try {
      const { email, password, mfaCode } = req.body;

      // Find user
      const user = await userService.findByEmail(email);
      
      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'Invalid credentials'
        });
      }

      // Admin portal only - block b2b_client and viewer accounts
      if (user.user_type === 'b2b_client' || user.user_type === 'viewer') {
        await auditService.log({
          user_id: user.user_id,
          action: 'user_login',
          entity_type: 'user',
          entity_id: user.user_id,
          details: { reason: 'Portal access denied for user type: ' + user.user_type },
          ip_address: req.ip,
          result: 'failed'
        });
        return res.status(403).json({
          success: false,
          message: 'Access denied. This portal is for administrators only.'
        });
      }

      // Check account status
      if (user.status === 'permanently_blocked') {
        return res.status(403).json({
          success: false,
          message: 'Your account has been permanently blocked. Please contact support.'
        });
      }

      if (user.status === 'pending') {
        return res.status(403).json({
          success: false,
          message: 'Please verify your email before logging in'
        });
      }

      // Check if account is locked
      if (user.status === 'locked' && user.locked_until && new Date() < new Date(user.locked_until)) {
        const remainingTime = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
        return res.status(403).json({
          success: false,
          message: `Account is locked. Try again in ${remainingTime} minutes.`
        });
      }

      // Unlock account if lock time has passed
      if (user.status === 'locked' && user.locked_until && new Date() >= new Date(user.locked_until)) {
        await userService.update(user.user_id, {
          status: 'active',
          failed_login_attempts: 0,
          locked_until: null
        });
        user.status = 'active';
      }

      // Verify password
      const isPasswordValid = await bcrypt.compare(password, user.password_hash);
      
      if (!isPasswordValid) {
        // Increment failed attempts
        const failedAttempts = (user.failed_login_attempts || 0) + 1;
        const maxAttempts = parseInt(process.env.MAX_LOGIN_ATTEMPTS) || 10;

        if (failedAttempts >= maxAttempts) {
          // Lock account
          const lockTime = parseInt(process.env.ACCOUNT_LOCK_TIME) || 30;
          const lockedUntil = new Date(Date.now() + lockTime * 60000);

          await userService.update(user.user_id, {
            status: 'locked',
            failed_login_attempts: failedAttempts,
            locked_until: lockedUntil
          });

          await auditService.log({
            user_id: user.user_id,
            action: 'account_locked',
            entity_type: 'user',
            entity_id: user.user_id,
            details: { reason: 'Too many failed login attempts' },
            ip_address: req.ip
          });

          return res.status(403).json({
            success: false,
            message: `Account locked due to too many failed attempts. Try again in ${lockTime} minutes.`
          });
        }

        await userService.update(user.user_id, {
          failed_login_attempts: failedAttempts
        });

        return res.status(401).json({
          success: false,
          message: `Invalid credentials. ${maxAttempts - failedAttempts} attempts remaining.`
        });
      }

      // Check MFA if enabled
      if (user.is_2fa_enabled) {
        if (!mfaCode) {
          return res.status(200).json({
            success: true,
            requiresMFA: true,
            message: 'Please provide MFA code'
          });
        }

        const isValidMFA = await mfaService.verifyToken(user.user_id, mfaCode);
        if (!isValidMFA) {
          return res.status(401).json({
            success: false,
            message: 'Invalid MFA code'
          });
        }
      }

      // Reset failed attempts on successful login
      await userService.update(user.user_id, {
        failed_login_attempts: 0,
        last_login: new Date()
      });

      // Generate tokens
      const { accessToken, refreshToken } = generateTokens(user);

      // Create session
      await sessionService.create({
        user_id: user.user_id,
        token: accessToken,
        refresh_token: refreshToken,
        ip_address: req.ip,
        user_agent: req.get('user-agent'),
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
      });

      // Log successful login
      await auditService.log({
        user_id: user.user_id,
        action: 'user_login',
        entity_type: 'user',
        entity_id: user.user_id,
        ip_address: req.ip,
        user_agent: req.get('user-agent'),
        result: 'success'
      });

      // Get user data without password
      const userData = await userService.findById(user.user_id);
      delete userData.password_hash;
      delete userData['2fa_secret'];

      res.json({
        success: true,
        message: 'Login successful',
        data: {
          user: userData,
          accessToken,
          refreshToken
        }
      });
    } catch (error) {
      // Log failed login attempt
      await auditService.log({
        user_id: null,
        action: 'user_login',
        details: { email: req.body.email },
        ip_address: req.ip,
        user_agent: req.get('user-agent'),
        result: 'failed',
        error_message: error.message
      });
      
      next(error);
    }
  }

  // ─── ADMIN PORTAL login ────────────────────────────────────────────────────
  async adminLogin(req, res, next) {
    return performLogin(req, res, next, {
      allowedUserTypes: ['admin', 'super_admin'],
      portalName: 'admin',
    });
  }

  // ─── CLIENT PORTAL login ───────────────────────────────────────────────────
  /**
   * Client portal login — only b2b_client & viewer allowed
   * POST /api/v1/auth/client/login
   */
  async clientLogin(req, res, next) {
    return performLogin(req, res, next, {
      allowedUserTypes: ['b2b_client', 'viewer'],
      portalName: 'client',
    });
  }

  /**
   * Refresh access token
   * POST /api/v1/auth/refresh
   */
  async refreshToken(req, res, next) {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        return res.status(400).json({
          success: false,
          message: 'Refresh token is required'
        });
      }

      const decoded = verifyRefreshToken(refreshToken);
      if (!decoded) {
        return res.status(401).json({
          success: false,
          message: 'Invalid refresh token'
        });
      }

      const session = await sessionService.findByRefreshToken(refreshToken);
      if (!session) {
        return res.status(401).json({
          success: false,
          message: 'Session not found or expired'
        });
      }

      // Get user
      const user = await userService.findById(decoded.userId);

      if (!user || user.status !== 'active') {
        return res.status(401).json({
          success: false,
          message: 'User not found or inactive'
        });
      }

      // Generate new access token
      const { accessToken } = generateTokens(user);

      // Update session
      await sessionService.update(session.session_id, {
        token: accessToken,
        last_activity: new Date()
      });

      res.json({
        success: true,
        data: { accessToken }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Logout user
   * POST /api/v1/auth/logout
   */
  async logout(req, res, next) {
    try {
      const token = req.headers.authorization?.split(' ')[1];

      if (token) {
        // Delete session
        await sessionService.deleteByToken(token);
      }

      // Log logout
      await auditService.log({
        user_id: req.user?.user_id,
        action: 'user_logout',
        entity_type: 'user',
        entity_id: req.user?.user_id,
        ip_address: req.ip
      });

      res.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Request password reset
   * POST /api/v1/auth/forgot-password
   */
  async forgotPassword(req, res, next) {
    try {
      const { email } = req.body;
      const user = await userService.findByEmail(email);
      
      if (!user) {
        // Don't reveal if user exists
        return res.json({
          success: true,
          message: 'If an account exists with this email, you will receive a password reset link.'
        });
      }

      // Generate reset token
      const resetToken = await authService.generatePasswordResetToken(user.user_id);

      // Send reset email
      await emailService.sendPasswordResetEmail(email, user.full_name, resetToken);

      // Log action
      await auditService.log({
        user_id: user.user_id,
        action: 'password_reset_requested',
        entity_type: 'user',
        entity_id: user.user_id,
        ip_address: req.ip
      });

      res.json({
        success: true,
        message: 'If an account exists with this email, you will receive a password reset link.'
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Reset password with token
   * POST /api/v1/auth/reset-password
   */
  async resetPassword(req, res, next) {
    try {
      const { token, newPassword } = req.body;
      const tokenData = await authService.verifyPasswordResetToken(token);
      
      if (!tokenData) {
        return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });
      }

      const passwordHash = await bcrypt.hash(newPassword, parseInt(process.env.BCRYPT_ROUNDS) || 12);
      
      await userService.update(tokenData.user_id, { password_hash: passwordHash });
      await sessionService.deleteAllByUserId(tokenData.user_id);
      await authService.deletePasswordResetToken(token);

      await auditService.log({
        user_id: tokenData.user_id,
        action: 'password_reset',
        entity_type: 'user',
        entity_id: tokenData.user_id,
        ip_address: req.ip
      });

      res.json({ success: true, message: 'Password reset successfully. Please login.' });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Enable 2FA
   */
  async enable2FA(req, res, next) {
    try {
      const userId = req.user.user_id;
      const { secret, qrCode } = await mfaService.generateSecret(userId);
      res.json({ success: true, data: { secret, qrCode } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Verify and activate 2FA
   */
  async verify2FA(req, res, next) {
    try {
      const { token } = req.body;
      const userId = req.user.user_id;
      const isValid = await mfaService.verifyAndEnable(userId, token);

      if (!isValid) {
        return res.status(400).json({ success: false, message: 'Invalid verification code' });
      }

      await auditService.log({
        user_id: userId,
        action: '2fa_enabled',
        entity_type: 'user',
        entity_id: userId,
        ip_address: req.ip
      });

      res.json({ success: true, message: '2FA enabled successfully' });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Disable 2FA
   */
  async disable2FA(req, res, next) {
    try {
      const { token, password } = req.body;
      const userId = req.user.user_id;

      const user = await userService.findById(userId);
      const isPasswordValid = await bcrypt.compare(password, user.password_hash);

      if (!isPasswordValid) {
        return res.status(401).json({ success: false, message: 'Invalid password' });
      }

      const isValid = await mfaService.verifyToken(userId, token);
      if (!isValid) {
        return res.status(400).json({ success: false, message: 'Invalid MFA code' });
      }

      await mfaService.disable(userId);
      await auditService.log({
        user_id: userId,
        action: '2fa_disabled',
        entity_type: 'user',
        entity_id: userId,
        ip_address: req.ip
      });

      res.json({ success: true, message: '2FA disabled successfully' });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new AuthController();
