const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const userService = require('./user.service');
const logger = require('../utils/logger');

class MFAService {
  /**
   * Generate 2FA secret and QR code
   */
  async generateSecret(userId) {
    try {
      const user = await userService.findById(userId);
      
      const secret = speakeasy.generateSecret({
        name: `${process.env.MFA_ISSUER || 'Card Cove'} (${user.email})`,
        issuer: process.env.MFA_ISSUER || 'Card Cove'
      });

      // Generate QR code
      const qrCode = await QRCode.toDataURL(secret.otpauth_url);

      // Save secret to user (but don't enable 2FA yet)
      await userService.update(userId, {
        '2fa_secret': secret.base32
      });

      return {
        secret: secret.base32,
        qrCode
      };
    } catch (error) {
      logger.error('Error generating 2FA secret:', error);
      throw error;
    }
  }

  /**
   * Verify token
   */
  async verifyToken(userId, token) {
    try {
      const user = await userService.findById(userId);
      
      if (!user || !user['2fa_secret']) {
        return false;
      }

      const verified = speakeasy.totp.verify({
        secret: user['2fa_secret'],
        encoding: 'base32',
        token: token,
        window: parseInt(process.env.MFA_WINDOW) || 2
      });

      return verified;
    } catch (error) {
      logger.error('Error verifying 2FA token:', error);
      return false;
    }
  }

  /**
   * Verify and enable 2FA
   */
  async verifyAndEnable(userId, token) {
    try {
      const isValid = await this.verifyToken(userId, token);
      
      if (!isValid) {
        return false;
      }

      // Enable 2FA for user
      await userService.update(userId, {
        is_2fa_enabled: true
      });

      return true;
    } catch (error) {
      logger.error('Error enabling 2FA:', error);
      return false;
    }
  }

  /**
   * Disable 2FA
   */
  async disable(userId) {
    try {
      await userService.update(userId, {
        is_2fa_enabled: false,
        '2fa_secret': null
      });

      return true;
    } catch (error) {
      logger.error('Error disabling 2FA:', error);
      throw error;
    }
  }
}

module.exports = new MFAService();