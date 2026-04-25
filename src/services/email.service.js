const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

class EmailService {
  constructor() {
    this.transporter = null;
    this.isConfigured = false;

    if (process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASSWORD) {
      try {
        this.transporter = nodemailer.createTransport({
          host: process.env.EMAIL_HOST,
          port: parseInt(process.env.EMAIL_PORT) || 587,
          secure: process.env.EMAIL_SECURE === 'true', 
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASSWORD
          },
          debug: true, // Enable debug output
          logger: true // Log to console
        });
        
        this.transporter.verify((error) => {
          if (error) {
            logger.error('❌ Email Verification Error Details:', error);
            this.isConfigured = false;
          } else {
            this.isConfigured = true;
            logger.info('✅ Email service verified and ready');
          }
        });
      } catch (error) {
        logger.error('Email service initialization error:', error.message);
        this.isConfigured = false;
      }
    } else {
      logger.warn('Email service not configured');
    }
  }

  async sendEmail(to, subject, html, text) {
    if (!this.isConfigured) {
      logger.info(`📧 DEV LOG: Email to ${to} | Sub: ${subject}`);
      return { messageId: 'dev-mode' };
    }
    try {
      const mailOptions = {
        from: `"${process.env.EMAIL_FROM_NAME || 'Card Cove'}" <${process.env.EMAIL_FROM}>`,
        to, subject, html, text
      };
      const info = await this.transporter.sendMail(mailOptions);
      logger.info(`Email sent: ${info.messageId}`);
      return info;
    } catch (error) {
      logger.error('Email send failure:', error.message);
      return { error: error.message };
    }
  }

  async sendOTPEmail(email, otp) {
    const html = `<div style="font-family: sans-serif; border: 1px solid #ddd; padding: 20px; border-radius: 10px;">
      <h2>Verification Code</h2>
      <p>Your code is: <b style="font-size: 24px;">${otp}</b></p>
      <p>Valid for 10 minutes.</p>
    </div>`;
    return this.sendEmail(email, `${otp} is your verification code`, html, `Your code is ${otp}`);
  }

  async sendVerificationEmail(email, name, token) {
    const url = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;
    return this.sendEmail(email, 'Verify Email', `<a href="${url}">Verify Now</a>`, `Verify: ${url}`);
  }

  async sendPasswordResetEmail(email, name, token) {
    const url = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
    return this.sendEmail(email, 'Reset Password', `<a href="${url}">Reset Password</a>`, `Reset: ${url}`);
  }

  async sendWelcomeEmail(email, name) {
    return this.sendEmail(email, 'Welcome!', `Welcome to Card Cove, ${name}!`, `Welcome ${name}!`);
  }
}

module.exports = new EmailService();
