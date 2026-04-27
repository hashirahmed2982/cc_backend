const db = require('../config/database');
const crypto = require('crypto');
const logger = require('../utils/logger');

class AuthService {
  /**
   * Generate and save OTP
   */
  async generateOTP(email) {
    try {
      // Generate 6 digit OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      const sql = `
        INSERT INTO otp_verifications (email, otp, expires_at)
        VALUES (?, ?, ?)
      `;
      
      await db.query(sql, [email, otp, expiresAt]);
      return otp;
    } catch (error) {
      logger.error('Error generating OTP:', error);
      throw error;
    }
  }

  /**
   * Verify OTP
   */
  async verifyOTP(email, otp) {
    try {
      const sql = `
        SELECT *
        FROM otp_verifications
        WHERE email = ?
          AND otp = ?
          AND expires_at > NOW()
          AND used = false
        ORDER BY created_at DESC LIMIT 1
      `;
      const record = await db.queryOne(sql, [email, otp]);
      
      if (record) {
        // Mark as used
        await db.query('UPDATE otp_verifications SET used = true WHERE id = ?', [record.id]);
        return true;
      }
      return false;
    } catch (error) {
      logger.error('Error verifying OTP:', error);
      throw error;
    }
  }

  /**
   * Generate email verification token
   */
  async generateEmailVerificationToken(userId) {
    try {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      const sql = `
        INSERT INTO email_verification_tokens (user_id, token, expires_at)
        VALUES (?, ?, ?)
      `;
      
      await db.query(sql, [userId, token, expiresAt]);
      return token;
    } catch (error) {
      logger.error('Error generating email verification token:', error);
      throw error;
    }
  }

  /**
   * Verify email token
   */
  async verifyEmailToken(token) {
    try {
      const sql = `
        SELECT * FROM email_verification_tokens
        WHERE token = ? AND expires_at > NOW()
        LIMIT 1
      `;
      
      return await db.queryOne(sql, [token]);
    } catch (error) {
      logger.error('Error verifying email token:', error);
      throw error;
    }
  }

  /**
   * Delete email verification token
   */
  async deleteEmailToken(token) {
    try {
      const sql = 'DELETE FROM email_verification_tokens WHERE token = ?';
      const result = await db.query(sql, [token]);
      return result.affectedRows > 0;
    } catch (error) {
      logger.error('Error deleting email token:', error);
      throw error;
    }
  }

  /**
   * Generate password reset token
   */
  async generatePasswordResetToken(userId) {
    try {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      const sql = `
        INSERT INTO password_reset_tokens (user_id, token, expires_at, used)
        VALUES (?, ?, ?, false)
      `;
      
      await db.query(sql, [userId, token, expiresAt]);
      return token;
    } catch (error) {
      logger.error('Error generating password reset token:', error);
      throw error;
    }
  }

  /**
   * Verify password reset token
   */
  async verifyPasswordResetToken(token) {
    try {
      const sql = `
        SELECT * FROM password_reset_tokens
        WHERE token = ? AND expires_at > NOW() AND used = false
        LIMIT 1
      `;
      
      return await db.queryOne(sql, [token]);
    } catch (error) {
      logger.error('Error verifying password reset token:', error);
      throw error;
    }
  }

  /**
   * Delete password reset token
   */
  async deletePasswordResetToken(token) {
    try {
      const sql = 'UPDATE password_reset_tokens SET used = true WHERE token = ?';
      const result = await db.query(sql, [token]);
      return result.affectedRows > 0;
    } catch (error) {
      logger.error('Error deleting password reset token:', error);
      throw error;
    }
  }
}

module.exports = new AuthService();
