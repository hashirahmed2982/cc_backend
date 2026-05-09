const userService = require('../services/user.service');
const userProductService = require('../services/userProduct.service');

const auditService = require('../services/audit.service');
const emailService = require('../services/email.service');
const logger = require('../utils/logger');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

class UserController {
  /**
   * Get all users
   * GET /api/v1/users
   */
  async getAll(req, res, next) {
    try {
      const { page = 1, limit = 20, status, user_type, search } = req.query;

      const filters = {
        page: parseInt(page),
        limit: parseInt(limit),
        status,
        user_type,
        search
      };

      const result = await userService.getAll(filters);

      res.json({
        success: true,
        data: result.data,
        pagination: result.pagination
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get user by ID
   * GET /api/v1/users/:id
   */
  async getById(req, res, next) {
    try {
      const { id } = req.params;

      const user = await userService.findById(parseInt(id));

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      // Remove sensitive data
      delete user.password_hash;
      delete user['2fa_secret'];

      res.json({
        success: true,
        data: user
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Create user (Admin only)
   * POST /api/v1/users
   * - super_admin can create: admin, b2b_client
   * - admin can create: b2b_client
   * - viewer accounts are created under a b2b_client via POST /users/:id/viewer-accounts
   */
  async create(req, res, next) {
    try {
      const { email, password, name, company, user_type } = req.body;
      const requestingUser = req.user;

      // Determine what user_type is being created
      const targetType = user_type || 'b2b_client';

      // Enforce role hierarchy
      if (targetType === 'super_admin') {
        return res.status(403).json({
          success: false,
          message: 'Cannot create super_admin accounts.'
        });
      }

      if (targetType === 'viewer') {
        return res.status(400).json({
          success: false,
          message: 'Viewer accounts must be created under a specific b2b_client. Use POST /users/:id/viewer-accounts'
        });
      }

      if (targetType === 'admin' && requestingUser.user_type !== 'super_admin') {
        return res.status(403).json({
          success: false,
          message: 'Only super_admin can create admin accounts.'
        });
      }

      if (!['admin', 'b2b_client'].includes(targetType)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid user_type. Must be admin or b2b_client.'
        });
      }

      // Map user_type to role_id
      const roleMap = { admin: 2, b2b_client: 3 };
      const role_id = roleMap[targetType];

      // Check if user exists
      const existingUser = await userService.findByEmail(email);
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: 'User with this email already exists'
        });
      }

      // Hash password
      const passwordHash = await bcrypt.hash(
        password,
        parseInt(process.env.BCRYPT_ROUNDS) || 12
      );

      // Create user — active immediately (admin-created accounts skip email verification)
      const userId = await userService.create({
        email,
        password_hash: passwordHash,
        full_name: name,
        company_name: company,
        role_id,
        user_type: targetType,
        status: 'active',
        email_verified: true,
        must_change_password: true,
        created_by: requestingUser.user_id
      });

      // Create wallet for b2b_client accounts
      if (targetType === 'b2b_client') {
        await userService.createWallet(userId);
      }

      // Log action
            await auditService.log({
        user_id: requestingUser.user_id,
        action: 'user_creation',
        entity_type: 'user',
        entity_id: userId,
        new_values: { email, name, company, user_type: targetType },
        ip_address: req.ip,
        user_agent: req.get('user-agent')
        });

      res.status(201).json({
        success: true,
        message: `${targetType} account created successfully.`,
        data: { userId }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update user
   * PUT /api/v1/users/:id
   */
  async update(req, res, next) {
    try {
      const { id } = req.params;
      const { name, company, phone, role } = req.body;

      const user = await userService.findById(parseInt(id));
      
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      // Save old values for audit
      const oldValues = {
        full_name: user.full_name,
        company_name: user.company_name,
        phone: user.phone,
        role_id: user.role_id
      };

      const updates = {};
      if (name) updates.full_name = name;
      if (company) updates.company_name = company;
      if (phone) updates.phone = phone;
      if (role) updates.role_id = role;
      updates.updated_by = req.user.user_id;

      await userService.update(parseInt(id), updates);

      // Log action
      await auditService.log({
        user_id: req.user.user_id,
        action: 'user_update',
        entity_type: 'user',
        entity_id: req.user.user_id,
        oldValues:oldValues,
        new_values: updates,
        ip_address: req.ip,
        user_agent: req.get('user-agent')
        });

      res.json({
        success: true,
        message: 'User updated successfully'
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Delete user
   * DELETE /api/v1/users/:id
   */
  async delete(req, res, next) {
    try {
      const { id } = req.params;

      const user = await userService.findById(parseInt(id));
      
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      await userService.delete(parseInt(id));

      // Log action
      await auditService.log({
        user_id: req.user.user_id,
        action: 'user_delete',
        entity_type: 'user',
        entity_id: id,
        old_values: { email: user.email, name: user.full_name },
        ip_address: req.ip,
        user_agent: req.get('user-agent')
      });

      res.json({
        success: true,
        message: 'User deleted successfully'
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Lock user account
   * POST /api/v1/users/:id/lock
   */
  async lockUser(req, res, next) {
    try {
      const { id } = req.params;
      const { reason } = req.body;

      const user = await userService.findById(parseInt(id));
      
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      if (user.status === 'permanently_blocked') {
        return res.status(400).json({
          success: false,
          message: 'Cannot lock permanently blocked user'
        });
      }

      await userService.update(parseInt(id), {
        status: 'locked',
        updated_by: req.user.user_id
      });

       // Log action
       await auditService.log({
         user_id: req.user.user_id,
         action: 'user_lock',
         entity_type: 'user',
         entity_id: id,
         new_values: { reason },
         ip_address: req.ip,
         user_agent: req.get('user-agent')
       });

       try {
         await emailService.sendTemplate('accountBlocked', user.email, {
           Client_Name: user.full_name,
           Date: new Date().toLocaleDateString('en-GB')
         });
       } catch (emailErr) {
         logger.warn('Account blocked email failed:', emailErr.message);
       }

       res.json({
         success: true,
         message: 'User locked successfully'
       });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Unlock user account
   * POST /api/v1/users/:id/unlock
   */
  async unlockUser(req, res, next) {
    try {
      const { id } = req.params;

      const user = await userService.findById(parseInt(id));
      
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      if (user.status === 'permanently_blocked') {
        return res.status(400).json({
          success: false,
          message: 'Cannot unlock permanently blocked user'
        });
      }

      await userService.update(parseInt(id), {
        status: 'active',
        failed_login_attempts: 0,
        locked_until: null,
        updated_by: req.user.user_id
      });

       // Log action
       await auditService.log({
         user_id: req.user.user_id,
         action: 'user_unlock',
         entity_type: 'user',
         entity_id: id,
         ip_address: req.ip,
         user_agent: req.get('user-agent')
       });

       try {
         await emailService.sendTemplate('accountReactivated', user.email, {
           Client_Name: user.full_name,
           Date: new Date().toLocaleDateString('en-GB')
         });
       } catch (emailErr) {
         logger.warn('Account reactivated email failed:', emailErr.message);
       }

       res.json({
         success: true,
         message: 'User unlocked successfully'
       });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Reset user password (Admin)
   * POST /api/v1/users/:id/reset-password
   */
  async resetPassword(req, res, next) {
    try {
      const { id } = req.params;

      const user = await userService.findById(parseInt(id));
      
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      // Generate temporary password
      const tempPassword = crypto.randomBytes(8).toString('hex');

      // Hash password
      const passwordHash = await bcrypt.hash(
        tempPassword,
        parseInt(process.env.BCRYPT_ROUNDS) || 12
      );

      await userService.update(parseInt(id), {
        password_hash: passwordHash,
        must_change_password: true,
        updated_by: req.user.user_id
      });

      // Log action
      await auditService.log({
        user_id: req.user.user_id,
        action: 'password_reset_admin',
        entity_type: 'user',
        entity_id: id,
        ip_address: req.ip,
        user_agent: req.get('user-agent')
      });

      res.json({
        success: true,
        message: 'Password reset successfully',
        data: {
          temporaryPassword: tempPassword
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Permanently block user
   * POST /api/v1/users/:id/permanent-block
   */
  async permanentBlock(req, res, next) {
    try {
      const { id } = req.params;
      const { reason, walletSettled, settlementMethod, transactionReference, settlementNotes, settlementDate } = req.body;

      const user = await userService.findById(parseInt(id));
      
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      if (user.status === 'permanently_blocked') {
        return res.status(400).json({
          success: false,
          message: 'User is already permanently blocked'
        });
      }

      const updatePayload = {
        status: 'permanently_blocked',
        permanent_block_reason: reason,
        permanent_block_date: new Date(),
        updated_by: req.user.user_id
      };

      // If admin marked wallet as already settled, save settlement details inline
      if (walletSettled) {
        updatePayload.wallet_settled = true;
        updatePayload.settlement_method = settlementMethod || null;
        updatePayload.settlement_reference = transactionReference || null;
        updatePayload.settlement_date = settlementDate || new Date().toISOString().split('T')[0];
        updatePayload.settlement_notes = settlementNotes || null;
      }

      await userService.update(parseInt(id), updatePayload);

      // Log block action
      await auditService.log({
        user_id: req.user.user_id,
        action: 'user_permanent_block',
        entity_type: 'user',
        entity_id: id,
        new_values: { reason, walletSettled },
        ip_address: req.ip,
        user_agent: req.get('user-agent')
      });

       // Log settlement if done inline
       if (walletSettled) {
         await auditService.log({
           user_id: req.user.user_id,
           action: 'wallet_settlement',
           entity_type: 'user',
           entity_id: parseInt(id),
           new_values: { settlementMethod, transactionReference, settlementNotes, settlementDate },
           ip_address: req.ip,
           user_agent: req.get('user-agent')
         });
       }

       try {
         await emailService.sendTemplate('accountBlocked', user.email, {
           Client_Name: user.full_name,
           Date: new Date().toLocaleDateString('en-GB')
         });
       } catch (emailErr) {
         logger.warn('Permanent block email failed:', emailErr.message);
       }

       res.json({
         success: true,
         message: 'User permanently blocked'
       });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Settle wallet for blocked user
   * POST /api/v1/users/:id/settle-wallet
   */
  async settleWallet(req, res, next) {
    try {
      const { id } = req.params;
      const { settlementMethod, transactionReference, settlementNotes, settlementDate } = req.body;

      const user = await userService.findById(parseInt(id));
      
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      if (user.status !== 'permanently_blocked') {
        return res.status(400).json({
          success: false,
          message: 'Can only settle wallet for permanently blocked users'
        });
      }

      await userService.update(parseInt(id), {
        wallet_settled: true,
        settlement_method: settlementMethod,
        settlement_reference: transactionReference,
        settlement_date: settlementDate,
        settlement_notes: settlementNotes,
        updated_by: req.user.user_id
      });

       // Log action
       await auditService.log({
   user_id: req.user.user_id,
   action: 'wallet_settlement',
   entity_type: 'user',
   entity_id: parseInt(id),
   new_values: { settlementMethod, transactionReference, settlementNotes, settlementDate },
   ip_address: req.ip,
   user_agent: req.get('user-agent')
});

       try {
         await emailService.sendTemplate('walletBalanceSettled', user.email, {
           Client_Name: user.full_name,
           Amount: user.wallet_balance || 0,
           Currency: 'USD',
           Wallet_Balance: 0,
           Date: settlementDate || new Date().toLocaleDateString('en-GB')
         });
       } catch (emailErr) {
         logger.warn('Wallet settled email failed:', emailErr.message);
       }

       res.json({
         success: true,
         message: 'Wallet settled successfully'
       });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get viewer accounts for a b2b_client
   * GET /api/v1/users/:id/viewer-accounts
   */
//   async getViewerAccounts(req, res, next) {
//     try {
//       const { id } = req.params;

//       const parentUser = await userService.findById(parseInt(id));
//       if (!parentUser) {
//         return res.status(404).json({ success: false, message: 'User not found' });
//       }
//       if (parentUser.user_type !== 'b2b_client') {
//         return res.status(400).json({ success: false, message: 'This user is not a b2b_client' });
//       }

//       const viewers = await userService.getViewersByParent(parseInt(id));

//       res.json({ success: true, data: viewers });
//     } catch (error) {
//       next(error);
//     }
//   }

  /**
   * Create viewer account under a b2b_client
   * POST /api/v1/users/:id/viewer-accounts
   */
  async getViewerAccounts(req, res, next) {
  try {
    const { id } = req.params;

    const b2bClient = await userService.findById(parseInt(id));
    if (!b2bClient) {
      return res.status(404).json({ success: false, message: 'B2B client not found' });
    }

    const viewers = await userService.getViewerAccounts(parseInt(id));

    res.json({ success: true, data: viewers });
  } catch (error) {
    next(error);
  }
}

async createViewerAccount(req, res, next) {
  try {
    const { id } = req.params;          // b2b_client_id
    const { name, email, permissions } = req.body;
    const requestingUser = req.user;

    // Validate the b2b client exists
    const b2bClient = await userService.findById(parseInt(id));
    if (!b2bClient || b2bClient.user_type !== 'b2b_client') {
      return res.status(404).json({ success: false, message: 'B2B client not found' });
    }

    // Check email not already taken
    const existing = await userService.findByEmail(email);
    if (existing) {
      return res.status(400).json({ success: false, message: 'Email already in use' });
    }

    // Generate a temporary password
    const tempPassword = crypto.randomBytes(8).toString('hex');
    const passwordHash = await bcrypt.hash(
      tempPassword,
      parseInt(process.env.BCRYPT_ROUNDS) || 12
    );

    // Create the user with viewer type
    const viewerUserId = await userService.create({
      email,
      password_hash: passwordHash,
      full_name: name,
      company_name: b2bClient.company_name,  // inherit parent company
      role_id: 4,       // viewer role
      user_type: 'viewer',
      status: 'active',
      must_change_password: true,
      created_by: requestingUser.user_id
    });

    // Link viewer to b2b client  <-- THIS is the missing piece
    await userService.createViewerLink(
      viewerUserId,
      parseInt(id),
      permissions || null,
      requestingUser.user_id
    );

    // Audit log
    await auditService.log({
      user_id: requestingUser.user_id,
      action: 'viewer_account_creation',
      entity_type: 'user',
      entity_id: viewerUserId,
      new_values: { email, name, b2b_client_id: parseInt(id), permissions },
      ip_address: req.ip,
      user_agent: req.get('user-agent')
    });

    res.status(201).json({
      success: true,
      message: 'Viewer account created successfully',
      data: { userId: viewerUserId, temporaryPassword: tempPassword }
    });
  } catch (error) {
    next(error);
  }
}

  /**
   * Get user product access
   * GET /api/v1/users/:id/products
   */
  /**
   * GET /api/v1/users/:id/products
   * Admin: all active products with this user's visibility + custom pricing overlaid
   */
  async getUserProductConfig(req, res, next) {
    try {
      const userId = parseInt(req.params.id);
      const data   = await userProductService.getUserProductConfig(userId);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  }
 
  /**
   * PUT /api/v1/users/:id/products
   * Admin: save visibility + custom pricing config for a user
   * Body: { configs: [{ id, visible, customPrice, useCustomPrice }] }
   */
  async saveUserProductConfig(req, res, next) {
    try {
      const userId      = parseInt(req.params.id);
      const { configs } = req.body;
 
      await userProductService.saveUserProductConfig(userId, configs, req.user.user_id);
 
      await auditService.log({
        user_id:     req.user.user_id,
        action:      'user_product_config_saved',
        entity_type: 'user',
        entity_id:   String(userId),
        new_values:  { configCount: configs.length },
        ip_address:  req.ip,
        user_agent:  req.get('User-Agent'),
      });
 
      res.json({ success: true, message: 'Product configuration saved successfully' });
    } catch (err) { next(err); }
  }
}

module.exports = new UserController();