// controllers/wallet.controller.js
const walletService = require('../services/wallet.service');
const mfaService    = require('../services/mfa.service');
const auditService  = require('../services/audit.service');
const emailService  = require('../services/email.service');
const userService   = require('../services/user.service');
const logger        = require('../utils/logger');

class WalletController {
  // ─────────────────────────────────────────────
  // CLIENT: Own wallet balance
  // GET /api/v1/wallet/balance
  // ─────────────────────────────────────────────
  async getMyBalance(req, res, next) {
    try {
      const wallet = await walletService.getWalletByUserId(req.user.user_id);
      if (!wallet) {
        return res.status(404).json({ success: false, message: 'Wallet not found' });
      }
      res.json({ success: true, data: wallet });
    } catch (err) { next(err); }
  }
 
  // ─────────────────────────────────────────────
  // CLIENT: Own transactions
  // GET /api/v1/wallet/transactions
  // ─────────────────────────────────────────────
  async getMyTransactions(req, res, next) {
    try {
      const { page = 1, limit = 20 } = req.query;
      const wallet = await walletService.getWalletByUserId(req.user.user_id);
      if (!wallet) return res.status(404).json({ success: false, message: 'Wallet not found' });
 
      const result = await walletService.getTransactions({
        walletId: wallet.wallet_id,
        page: parseInt(page),
        limit: parseInt(limit),
      });
      res.json({ success: true, ...result });
    } catch (err) { next(err); }
  }
 
  // ─────────────────────────────────────────────
  // CLIENT: Submit topup request
  // POST /api/v1/wallet/topup
  // Body: multipart/form-data — amount (required), receipt (file, optional)
  // ─────────────────────────────────────────────
  async requestTopup(req, res, next) {
    try {
      const { amount } = req.body;
 
      if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
        return res.status(400).json({ success: false, message: 'Valid amount is required' });
      }
 
      const wallet = await walletService.getWalletByUserId(req.user.user_id);
      if (!wallet) return res.status(404).json({ success: false, message: 'Wallet not found' });
 
      if (wallet.status !== 'active') {
        return res.status(400).json({ success: false, message: 'Wallet is not active' });
      }
 
      // Store the original filename as the receipt reference.
      // In production replace this with an S3/storage upload that returns a URL.
      const receiptRef = req.file ? req.file.originalname : (req.body.receiptUrl || null);
 
      const requestId = await walletService.createTopupRequest(
        req.user.user_id,
        wallet.wallet_id,
        parseFloat(amount),
        receiptRef
      );
 
      await auditService.log({
        user_id: req.user.user_id,
        action: 'topup_request_created',
        entity_type: 'topup_request',
        entity_id: String(requestId),
        new_values: { amount, receiptRef },
        ip_address: req.ip,
        user_agent: req.get('user-agent'),
      });

      try {
        await emailService.sendTemplate('topUpReceived', req.user.email, {
          Client_Name: req.user.full_name,
          Reference_ID: requestId,
          Amount: amount,
          Currency: 'USD',
          Date: new Date().toLocaleDateString('en-GB')
        });
      } catch (emailErr) {
        logger.warn('Top-up received email failed:', emailErr.message);
      }

      res.status(201).json({
        success: true,
        message: 'Topup request submitted successfully. Awaiting admin approval.',
        data: { requestId },
      });
    } catch (err) { next(err); }
  }
 
  // ─────────────────────────────────────────────
  // CLIENT: Own topup requests
  // GET /api/v1/wallet/my-topup-requests
  // ─────────────────────────────────────────────
  async getMyTopupRequests(req, res, next) {
    try {
      const { status, page = 1, limit = 20 } = req.query;
      const result = await walletService.getTopupRequests({
        status,
        userId: req.user.user_id,
        page: parseInt(page),
        limit: parseInt(limit),
      });
      res.json({ success: true, ...result });
    } catch (err) { next(err); }
  }

  // ─────────────────────────────────────────────
  // ADMIN: All wallet balances
  // GET /api/v1/wallet/balances
  // ─────────────────────────────────────────────
  async getAllBalances(req, res, next) {
    try {
      const { page = 1, limit = 50, search } = req.query;
      const result = await walletService.getAllWalletBalances({
        page: parseInt(page),
        limit: parseInt(limit),
        search,
      });
      res.json({ success: true, ...result });
    } catch (err) { next(err); }
  }

  // ─────────────────────────────────────────────
  // ADMIN: All topup requests
  // GET /api/v1/wallet/topup-requests
  // ─────────────────────────────────────────────
  async getTopupRequests(req, res, next) {
    try {
      const { status, page = 1, limit = 20 } = req.query;
      const result = await walletService.getTopupRequests({
        status,
        page: parseInt(page),
        limit: parseInt(limit),
      });
      res.json({ success: true, ...result });
    } catch (err) { next(err); }
  }

  // ─────────────────────────────────────────────
  // ADMIN: Approve topup (requires MFA)
  // POST /api/v1/wallet/topup/:requestId/approve
  // Body: { mfaCode }
  // ─────────────────────────────────────────────
  async approveTopup(req, res, next) {
    try {
      const { requestId } = req.params;
      const { mfaCode } = req.body;

      if (!mfaCode) {
        return res.status(400).json({ success: false, message: 'MFA code is required' });
      }

      // Verify MFA
      // const isValidMFA = await mfaService.verifyToken(req.user.user_id, mfaCode);
      // if (!isValidMFA) {
      //   return res.status(400).json({ success: false, message: 'Invalid MFA code' });
      // }

      const result = await walletService.approveTopupRequest(
        parseInt(requestId),
        req.user.user_id
      );

      await auditService.log({
        user_id: req.user.user_id,
        action: 'topup_approved',
        entity_type: 'topup_request',
        entity_id: requestId,
        new_values: { amount: result.amount, transactionId: result.transactionId },
        ip_address: req.ip,
        user_agent: req.get('user-agent'),
      });

      try {
        const topupRequest = await walletService.getTopupRequestById(parseInt(requestId));
        if (topupRequest) {
          const approvedWallet = await walletService.getWalletByUserId(topupRequest.user_id);
          await emailService.sendTemplate('topUpSuccessful', topupRequest.userEmail, {
            Client_Name: topupRequest.userName,
            Reference_ID: requestId,
            Amount: topupRequest.amount,
            Currency: 'USD',
            Wallet_Balance: approvedWallet ? approvedWallet.balance : 'N/A',
            Date: new Date().toLocaleDateString('en-GB')
          });
        }
      } catch (emailErr) {
        logger.warn('Top-up approved email failed:', emailErr.message);
      }

      res.json({
        success: true,
        message: `Topup of $${result.amount} approved. Wallet credited.`,
        data: result,
      });
    } catch (err) {
      if (err.message.includes('no longer pending') || err.message.includes('not found')) {
        return res.status(400).json({ success: false, message: err.message });
      }
      next(err);
    }
  }

  // ─────────────────────────────────────────────
  // ADMIN: Reject topup (requires MFA)
  // POST /api/v1/wallet/topup/:requestId/reject
  // Body: { reason, mfaCode }
  // ─────────────────────────────────────────────
  async rejectTopup(req, res, next) {
    try {
      const { requestId } = req.params;
      const { reason, mfaCode } = req.body;

      if (!mfaCode) {
        return res.status(400).json({ success: false, message: 'MFA code is required' });
      }
      if (!reason || !reason.trim()) {
        return res.status(400).json({ success: false, message: 'Rejection reason is required' });
      }

      const isValidMFA = await mfaService.verifyToken(req.user.user_id, mfaCode);
      if (!isValidMFA) {
        return res.status(400).json({ success: false, message: 'Invalid MFA code' });
      }

       await walletService.rejectTopupRequest(parseInt(requestId), reason, req.user.user_id);

      await auditService.log({
        user_id: req.user.user_id,
        action: 'topup_rejected',
        entity_type: 'topup_request',
        entity_id: requestId,
        new_values: { reason },
        ip_address: req.ip,
        user_agent: req.get('user-agent'),
      });

      try {
        // Fetch topup request details to get user and amount
        const topupRequest = await walletService.getTopupRequestById(parseInt(requestId));
        if (topupRequest) {
          const topupUser = await userService.findById(topupRequest.user_id);
          await emailService.sendTemplate('topUpCanceled', topupUser.email, {
            Client_Name: topupUser.full_name,
            Reference_ID: requestId,
            Amount: topupRequest.amount,
            Currency: 'USD',
            Date: new Date().toLocaleDateString('en-GB')
          });
        }
      } catch (emailErr) {
        logger.warn('Top-up rejected email failed:', emailErr.message);
      }

      res.json({ success: true, message: 'Topup request rejected.' });
    } catch (err) {
      if (err.message.includes('no longer pending') || err.message.includes('not found')) {
        return res.status(400).json({ success: false, message: err.message });
      }
      next(err);
    }
  }

  // ─────────────────────────────────────────────
  // ADMIN: All transactions (history view)
  // GET /api/v1/wallet/transactions/all
  // ─────────────────────────────────────────────
  async getAllTransactions(req, res, next) {
    try {
      const { page = 1, limit = 20, userId, type } = req.query;
      const result = await walletService.getAllTransactions({
        page: parseInt(page),
        limit: parseInt(limit),
        userId: userId ? parseInt(userId) : undefined,
        type,
      });
      res.json({ success: true, ...result });
    } catch (err) { next(err); }
  }
}

module.exports = new WalletController();
