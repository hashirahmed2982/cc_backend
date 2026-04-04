const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

class EmailService {
  constructor() {
    this.transporter = null;
    this.isConfigured = false;

    // Only initialize transporter if email is configured
    if (process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASSWORD) {
      try {
        this.transporter = nodemailer.createTransport({
          host: process.env.EMAIL_HOST,
          port: parseInt(process.env.EMAIL_PORT) || 587,
          secure: process.env.EMAIL_SECURE === 'true',
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASSWORD
          }
        });
        this.isConfigured = true;
        logger.info('Email service configured successfully');
      } catch (error) {
        logger.warn('Email service configuration failed:', error.message);
        this.isConfigured = false;
      }
    } else {
      logger.warn('Email service not configured - emails will be logged to console only');
    }
  }

  /**
   * Send email
   */
  async sendEmail(to, subject, html, text) {
    // If email not configured, just log to console (development mode)
    if (!this.isConfigured) {
      logger.info('📧 EMAIL (not sent - email not configured):');
      logger.info(`   To: ${to}`);
      logger.info(`   Subject: ${subject}`);
      logger.info(`   Content: ${text || html.substring(0, 200)}...`);
      return { messageId: 'dev-mode-no-email' };
    }

    try {
      const mailOptions = {
        from: `"${process.env.EMAIL_FROM_NAME || 'Card Cove'}" <${process.env.EMAIL_FROM}>`,
        to,
        subject,
        html,
        text
      };

      const info = await this.transporter.sendMail(mailOptions);
      logger.info(`Email sent: ${info.messageId}`);
      return info;
    } catch (error) {
      logger.error('Error sending email:', error.message);
      // Don't throw error - just log it
      // In development, we don't want email failures to break registration
      logger.warn('Email sending failed, but continuing...');
      return { messageId: 'email-failed', error: error.message };
    }
  }

  /**
   * Send verification email
   */
  async sendVerificationEmail(email, name, token) {
    const verificationUrl = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;
    
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Welcome to Card Cove!</h2>
        <p>Hi ${name},</p>
        <p>Thank you for registering with Card Cove. Please verify your email address by clicking the button below:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${verificationUrl}" style="background-color: #4F46E5; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
            Verify Email Address
          </a>
        </div>
        <p>Or copy and paste this link in your browser:</p>
        <p style="word-break: break-all; color: #666;">${verificationUrl}</p>
        <p>This link will expire in 24 hours.</p>
        <p>If you didn't create an account, please ignore this email.</p>
        <hr style="border: 1px solid #eee; margin: 30px 0;">
        <p style="color: #999; font-size: 12px;">© 2024 Card Cove. All rights reserved.</p>
      </div>
    `;

    const text = `
      Welcome to Card Cove!
      
      Hi ${name},
      
      Thank you for registering. Please verify your email by visiting:
      ${verificationUrl}
      
      Verification Token: ${token}
      
      This link will expire in 24 hours.
      
      If you didn't create an account, please ignore this email.
    `;

    // Log token to console for development
    if (!this.isConfigured) {
      logger.info('📧 ========================================');
      logger.info('📧 EMAIL VERIFICATION TOKEN (Development Mode)');
      logger.info('📧 ========================================');
      logger.info(`📧 Email: ${email}`);
      logger.info(`📧 Token: ${token}`);
      logger.info(`📧 Verification URL: ${verificationUrl}`);
      logger.info('📧 ========================================');
      logger.info('📧 Copy the token above to verify via API:');
      logger.info(`📧 POST /api/v1/auth/verify-email`);
      logger.info(`📧 Body: { "token": "${token}" }`);
      logger.info('📧 ========================================\n');
    }

    return this.sendEmail(email, 'Verify Your Email - Card Cove', html, text);
  }

  /**
   * Send password reset email
   */
  async sendPasswordResetEmail(email, name, token) {
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
    
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Password Reset Request</h2>
        <p>Hi ${name},</p>
        <p>We received a request to reset your password. Click the button below to create a new password:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetUrl}" style="background-color: #4F46E5; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
            Reset Password
          </a>
        </div>
        <p>Or copy and paste this link in your browser:</p>
        <p style="word-break: break-all; color: #666;">${resetUrl}</p>
        <p>This link will expire in 1 hour.</p>
        <p>If you didn't request a password reset, please ignore this email or contact support if you're concerned.</p>
        <hr style="border: 1px solid #eee; margin: 30px 0;">
        <p style="color: #999; font-size: 12px;">© 2024 Card Cove. All rights reserved.</p>
      </div>
    `;

    const text = `
      Password Reset Request
      
      Hi ${name},
      
      We received a request to reset your password. Visit this link to create a new password:
      ${resetUrl}
      
      Reset Token: ${token}
      
      This link will expire in 1 hour.
      
      If you didn't request this, please ignore this email.
    `;

    // Log token to console for development
    if (!this.isConfigured) {
      logger.info('📧 ========================================');
      logger.info('📧 PASSWORD RESET TOKEN (Development Mode)');
      logger.info('📧 ========================================');
      logger.info(`📧 Email: ${email}`);
      logger.info(`📧 Token: ${token}`);
      logger.info(`📧 Reset URL: ${resetUrl}`);
      logger.info('📧 ========================================');
      logger.info('📧 Copy the token above to reset password:');
      logger.info(`📧 POST /api/v1/auth/reset-password`);
      logger.info(`📧 Body: { "token": "${token}", "newPassword": "YourNewPass123!" }`);
      logger.info('📧 ========================================\n');
    }

    return this.sendEmail(email, 'Reset Your Password - Card Cove', html, text);
  }

  /**
   * Send welcome email (after verification)
   */
  async sendWelcomeEmail(email, name) {
    const loginUrl = `${process.env.FRONTEND_URL}/login`;
    
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Welcome to Card Cove!</h2>
        <p>Hi ${name},</p>
        <p>Your email has been verified successfully. You can now log in to your account and start purchasing digital cards.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${loginUrl}" style="background-color: #4F46E5; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
            Log In Now
          </a>
        </div>
        <p>Thank you for choosing Card Cove!</p>
        <hr style="border: 1px solid #eee; margin: 30px 0;">
        <p style="color: #999; font-size: 12px;">© 2024 Card Cove. All rights reserved.</p>
      </div>
    `;

    const text = `
      Welcome to Card Cove!
      
      Hi ${name},
      
      Your email has been verified. You can now log in at:
      ${loginUrl}
      
      Thank you for choosing Card Cove!
    `;

    return this.sendEmail(email, 'Welcome to Card Cove!', html, text);
  }
}

module.exports = new EmailService();