const jwt = require('jsonwebtoken');
const { AppError } = require('./errorHandler');
const userService = require('../services/user.service');
const sessionService = require('../services/session.service');
const logger = require('../utils/logger');

/**
 * Protect routes - verify JWT token
 */
const protect = async (req, res, next) => {
  try {
    // 1) Get token from header
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return next(new AppError('You are not logged in. Please log in to get access.', 401));
    }

    // 2) Verify token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return next(new AppError('Your token has expired. Please log in again.', 401));
      }
      return next(new AppError('Invalid token. Please log in again.', 401));
    }

    // 3) Check if session exists and is valid
    const session = await sessionService.findByToken(token);
    if (!session) {
      return next(new AppError('Session not found or expired. Please log in again.', 401));
    }

    // 4) Check session expiry
    if (new Date(session.expires_at) < new Date()) {
      await sessionService.delete(session.session_id);
      return next(new AppError('Session expired. Please log in again.', 401));
    }

    // 5) Check session timeout (5 minutes inactivity)
    const sessionTimeout = parseInt(process.env.SESSION_TIMEOUT) || 300000; // 5 minutes
    const lastActivity = new Date(session.last_activity);
    const now = new Date();
    
    if (now - lastActivity > sessionTimeout) {
      await sessionService.delete(session.session_id);
      return next(new AppError('Session timed out due to inactivity. Please log in again.', 401));
    }

    // 6) Update last activity
    await sessionService.updateLastActivity(session.session_id);

    // 7) Check if user still exists
    const user = await userService.findById(decoded.userId);
    if (!user) {
      return next(new AppError('The user belonging to this token no longer exists.', 401));
    }

    // 8) Check if user account is active
    if (user.status === 'locked') {
      return next(new AppError('Your account has been locked. Please contact support.', 403));
    }

    if (user.status === 'permanently_blocked') {
      return next(new AppError('Your account has been permanently blocked.', 403));
    }

    if (user.status !== 'active') {
      return next(new AppError('Your account is not active.', 403));
    }

    // 9) Grant access to protected route
    req.user = user;
    req.session = session;
    next();
  } catch (error) {
    logger.error('Auth middleware error:', error);
    return next(new AppError('Authentication failed', 401));
  }
};

/**
 * Restrict to specific roles
 */
const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.user_type)) {
      return next(new AppError('You do not have permission to perform this action', 403));
    }
    next();
  };
};

/**
 * Check if user is admin or super admin
 */
const isAdmin = (req, res, next) => {
  if (!['admin', 'super_admin'].includes(req.user.user_type)) {
    return next(new AppError('Access denied. Admin privileges required.', 403));
  }
  next();
};

/**
 * Check if user is super admin
 */
const isSuperAdmin = (req, res, next) => {
  if (req.user.user_type !== 'super_admin') {
    return next(new AppError('Access denied. Super admin privileges required.', 403));
  }
  next();
};

/**
 * Verify MFA for sensitive operations
 */
const verifyMFA = async (req, res, next) => {
  try {
    const { mfaCode } = req.body;

    if (!mfaCode) {
      return next(new AppError('MFA code is required for this operation', 400));
    }

    const mfaService = require('../services/mfa.service');
    const isValid = await mfaService.verifyToken(req.user.user_id, mfaCode);

    if (!isValid) {
      return next(new AppError('Invalid MFA code', 401));
    }

    next();
  } catch (error) {
    logger.error('MFA verification error:', error);
    return next(new AppError('MFA verification failed', 401));
  }
};

/**
 * Block access when the user has a pending forced password change
 */
const requirePasswordChange = (req, res, next) => {
  if (req.user.must_change_password) {
    return next(new AppError('You must change your password before accessing this resource.', 403));
  }
  next();
};

/**
 * Check IP whitelist for admin portal
 */
const checkIPWhitelist = (req, res, next) => {
  // Only apply IP whitelist in production for admin users
  if (process.env.NODE_ENV !== 'production' || !req.user || req.user.user_type === 'b2b_client') {
    return next();
  }

  const clientIP = req.ip || req.connection.remoteAddress;
  const whitelist = process.env.ADMIN_IP_WHITELIST?.split(',') || [];

  if (whitelist.length === 0) {
    // No whitelist configured, allow all
    return next();
  }

  if (!whitelist.includes(clientIP)) {
    logger.warn(`Unauthorized IP access attempt: ${clientIP} for user ${req.user.email}`);
    return next(new AppError('Access denied from this IP address', 403));
  }

  next();
};

module.exports = {
  protect,
  restrictTo,
  isAdmin,
  isSuperAdmin,
  verifyMFA,
  checkIPWhitelist,
  requirePasswordChange,
};