const nodemailer = require('nodemailer');
const logger = require('../utils/logger');
const templates = require('./emailTemplates');

class EmailService {
  constructor() {
    this.transporter = null;
    this.isConfigured = false;

    if (process.env.EMAIL_HOST && process.env.MAILTRAP_API_TOKEN) {
      try {
        this.transporter = nodemailer.createTransport({
          host: process.env.EMAIL_HOST,
          port: parseInt(process.env.EMAIL_PORT) || 587,
          secure: process.env.EMAIL_SECURE === 'true', 
          auth: {
            user: 'api',
            pass: process.env.MAILTRAP_API_TOKEN
          },
          debug: true,
          logger: true
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

  async sendEmail(to, subject, html, text, attachments = []) {
    if (!this.isConfigured) {
      logger.info(`📧 DEV LOG: Email to ${to} | Sub: ${subject} | Attachments: ${attachments.length}`);
      return { messageId: 'dev-mode' };
    }
    try {
      const mailOptions = {
        from: `"${process.env.EMAIL_FROM_NAME || 'Card Cove'}" <${process.env.EMAIL_FROM}>`,
        to, subject, html, text,
        attachments,
      };
      const info = await this.transporter.sendMail(mailOptions);
      logger.info(`Email sent: ${info.messageId}`);
      return info;
    } catch (error) {
      logger.error('Email send failure:', error.message);
      return { error: error.message };
    }
  }

  async sendTemplate(templateName, toEmail, vars) {
    const templateFn = templates[templateName];
    if (!templateFn) {
      logger.error(`Email template not found: ${templateName}`);
      throw new Error(`Unknown email template: ${templateName}`);
    }
    const { subject, html } = templateFn(vars);
    return this.sendEmail(toEmail, subject, html);
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

  async sendPasswordResetByAdmin(email, name, tempPassword) {
    const html = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#1d4ed8;padding:24px;border-radius:8px 8px 0 0;">
          <h2 style="color:#fff;margin:0;">Password Reset</h2>
          <p style="color:#bfdbfe;margin:4px 0 0;">CardCove B2B Portal</p>
        </div>
        <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
          <p>Hi ${name},</p>
          <p>Your password has been reset by an administrator. Your temporary password is:</p>
          <div style="background:#f3f4f6;border-radius:6px;padding:16px;text-align:center;font-family:monospace;font-size:20px;font-weight:bold;letter-spacing:2px;color:#111827;margin:16px 0;">
            ${tempPassword}
          </div>
          <p style="color:#dc2626;font-weight:600;">⚠️ You will be required to change this password on your next login.</p>
          <p style="color:#6b7280;font-size:13px;margin-top:24px;">
            If you did not expect this email, please contact your administrator immediately.
          </p>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
          <p style="color:#9ca3af;font-size:12px;margin:0;">CardCove B2B Portal</p>
        </div>
      </div>`;
    return this.sendEmail(
      email,
      'Your CardCove password has been reset',
      html,
      `Hi ${name}, your temporary password is: ${tempPassword}. You must change it on next login.`
    );
  }
}

module.exports = new EmailService();