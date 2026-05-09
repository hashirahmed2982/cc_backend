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
      // Increase expiry to 1 hour to account for server/db time drift
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); 

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
      logger.info(`Attempting to verify OTP: ${otp} for email: ${email}`);

      // First, retrieve the OTP record based on email and OTP, regardless of 'used' or 'expires_at' for detailed checks
      const findOtpSql = `
        SELECT id, expires_at, used
        FROM otp_verifications
        WHERE email = ? AND otp = ?
        ORDER BY created_at DESC LIMIT 1
      `;
      const record = await db.queryOne(findOtpSql, [email, otp]);

      if (!record) {
        logger.warn(`❌ OTP Verification failed for ${email}. No matching OTP record found for OTP: ${otp}`);
        return false; // No record found
      }

      if (record.used) {
        logger.warn(`❌ OTP Verification failed for ${email}. OTP ID ${record.id} has already been used.`);
        return false; // OTP already used
      }

      // Now, explicitly check for expiration using the database's current timestamp (NOW())
      // The database connection is configured to use UTC, so NOW() will be UTC.
      const isExpired = new Date(record.expires_at) < new Date(); // Compare with current server time

      if (isExpired) {
        logger.warn(`❌ OTP Verification failed for ${email}. OTP ID ${record.id} has expired. Expires at: ${record.expires_at}`);
        return false; // OTP expired
      }

      // If all checks pass (record found, not used, not expired), mark as used
      await db.query('UPDATE otp_verifications SET used = true WHERE id = ?', [record.id]);
      logger.info(`✅ OTP Verified successfully for ${email}. OTP ID: ${record.id}`);
      return true;
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
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

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
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

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
        WHERE token = ? AND used = false
        LIMIT 1
      `;
      
      const row = await db.queryOne(sql, [token]);
      if (row) {
        logger.info('Token found and verified:', { token, userId: row.user_id });
      } else {
        logger.warn('Token not found or already used:', token);
      }
      return row;
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