const db = require('../config/database');
const logger = require('../utils/logger');

class UserService {
  /**
   * Find user by email
   */
  async findByEmail(email) {
    try {
      const sql = `
        SELECT u.*, r.role_name, r.permissions
        FROM users u
        LEFT JOIN roles r ON u.role_id = r.role_id
        WHERE u.email = ?
        LIMIT 1
      `;
      return await db.queryOne(sql, [email]);
    } catch (error) {
      logger.error('Error finding user by email:', error);
      throw error;
    }
  }

  /**
   * Find user by ID
   */
  async findById(userId) {
    try {
      const sql = `
        SELECT u.*, r.role_name, r.permissions
        FROM users u
        LEFT JOIN roles r ON u.role_id = r.role_id
        WHERE u.user_id = ?
        LIMIT 1
      `;
      return await db.queryOne(sql, [userId]);
    } catch (error) {
      logger.error('Error finding user by ID:', error);
      throw error;
    }
  }

  /**
   * Create new user
   */
  async create(userData) {
    try {
      const sql = `
        INSERT INTO users (
          email, password_hash, full_name, company_name, 
          role_id, user_type, status, phone, 
          is_2fa_enabled, created_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      
      const params = [
        userData.email,
        userData.password_hash,
        userData.full_name,
        userData.company_name || null,
        userData.role_id || 3,
        userData.user_type || 'b2b_client',
        userData.status || 'active',
        userData.phone || null,
        userData.is_2fa_enabled || false,
        userData.created_by || null
      ];

      const result = await db.query(sql, params);
      return result.insertId;
    } catch (error) {
      logger.error('Error creating user:', error);
      throw error;
    }
  }

  /**
   * Update user
   */
  async update(userId, updates) {
    try {
      const allowedFields = [
        'full_name', 'phone', 'company_name', 'status', 'role_id',
        'is_2fa_enabled', '2fa_secret', 'failed_login_attempts',
        'locked_until', 'last_login', 'email_verified', 'password_hash',
        'updated_by', 'permanent_block_reason', 'permanent_block_date',
        'wallet_settled', 'settlement_method', 'settlement_reference',
        'settlement_date', 'settlement_notes'
      ];

      const updateFields = [];
      const values = [];

      Object.keys(updates).forEach(key => {
        if (allowedFields.includes(key)) {
          updateFields.push(`${key} = ?`);
          values.push(updates[key]);
        }
      });

      if (updateFields.length === 0) {
        return false;
      }

      values.push(userId);

      const sql = `
        UPDATE users 
        SET ${updateFields.join(', ')}, updated_at = NOW()
        WHERE user_id = ?
      `;

      const result = await db.query(sql, values);
      return result.affectedRows > 0;
    } catch (error) {
      logger.error('Error updating user:', error);
      throw error;
    }
  }

  /**
   * Get all users with pagination
   */
  async getAll(filters = {}) {
    try {
      const { page = 1, limit = 20, status, user_type, search } = filters;
      const offset = (page - 1) * limit;

      let whereClauses = ["u.user_type != 'viewer'"];
      let whereParams = [];

      if (status) {
        whereClauses.push('u.status = ?');
        whereParams.push(status);
      }

      if (user_type) {
        whereClauses.push('u.user_type = ?');
        whereParams.push(user_type);
      }

      if (search) {
        whereClauses.push('(u.full_name LIKE ? OR u.email LIKE ? OR u.company_name LIKE ?)');
        const searchTerm = `%${search}%`;
        whereParams.push(searchTerm, searchTerm, searchTerm);
      }

      const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

      const sql = `
        SELECT 
          u.user_id,
          u.email,
          u.full_name,
          u.company_name,
          u.phone,
          u.user_type,
          u.status,
          u.role_id,
          r.role_name,
          u.is_2fa_enabled,
          u.failed_login_attempts,
          u.locked_until,
          u.last_login,
          u.email_verified,
          u.created_at,
          u.updated_at,
          u.permanent_block_reason,
          u.permanent_block_date,
          u.wallet_settled,
          u.settlement_method,
          u.settlement_reference,
          u.settlement_date,
          u.settlement_notes,
          w.wallet_id,
          COALESCE(w.balance, 0) as wallet_balance,
          w.currency as wallet_currency,
          w.status as wallet_status
        FROM users u
        LEFT JOIN roles r ON u.role_id = r.role_id
        LEFT JOIN wallets w ON u.user_id = w.user_id
        ${whereClause}
        ORDER BY u.created_at DESC
        LIMIT ? OFFSET ?
      `;

      const countSql = `
        SELECT COUNT(*) as total
        FROM users u
        ${whereClause}
      `;

      // Separate parameter arrays for each query
      const queryParams = [...whereParams, parseInt(limit), parseInt(offset)];
      const countParams = [...whereParams];

      const users = await db.query(sql, queryParams);
      const countResult = await db.queryOne(countSql, countParams);

      return {
        data: users,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: countResult.total,
          totalPages: Math.ceil(countResult.total / limit)
        }
      };
    } catch (error) {
      logger.error('Error getting all users:', error);
      throw error;
    }
  }

  /**
   * Get all viewer accounts belonging to a b2b_client
   */
  async getViewersByParent(parentUserId) {
    try {
      const sql = `
        SELECT 
          u.user_id, u.email, u.full_name, u.status,
          u.last_login, u.created_at, u.email_verified
        FROM users u
        WHERE u.user_type = 'viewer'
          AND u.created_by = ?
        ORDER BY u.created_at DESC
      `;
      return await db.query(sql, [parentUserId]);
    } catch (error) {
      logger.error('Error getting viewer accounts:', error);
      throw error;
    }
  }

  /**
   * Delete user (soft delete)
   */
  async delete(userId) {
    try {
      const sql = 'UPDATE users SET status = ?, updated_at = NOW() WHERE user_id = ?';
      const result = await db.query(sql, ['deleted', userId]);
      return result.affectedRows > 0;
    } catch (error) {
      logger.error('Error deleting user:', error);
      throw error;
    }
  }

  /**
   * Create wallet for user
   */
  async createWallet(userId) {
    try {
      const sql = `
        INSERT INTO wallets (user_id, balance, currency, status)
        VALUES (?, 0.00, 'USD', 'active')
      `;
      
      const result = await db.query(sql, [userId]);
      return result.insertId;
    } catch (error) {
      logger.error('Error creating wallet:', error);
      throw error;
    }
  }

  /**
   * Get user wallet
   */
  async getWallet(userId) {
    try {
      const sql = 'SELECT * FROM wallets WHERE user_id = ? LIMIT 1';
      return await db.queryOne(sql, [userId]);
    } catch (error) {
      logger.error('Error getting wallet:', error);
      throw error;
    }
  }
  /**
 * Create viewer account link (viewer_user_id -> b2b_client_id)
 */
async createViewerLink(viewerUserId, b2bClientId, permissions, createdBy) {
  try {
    const sql = `
      INSERT INTO viewer_accounts (viewer_user_id, b2b_client_id, permissions, created_by)
      VALUES (?, ?, ?, ?)
    `;
    const result = await db.query(sql, [
      viewerUserId,
      b2bClientId,
      permissions ? JSON.stringify(permissions) : null,
      createdBy || null
    ]);
    return result.insertId;
  } catch (error) {
    logger.error('Error creating viewer link:', error);
    throw error;
  }
}

/**
 * Get all viewer accounts for a b2b_client
 */
async getViewerAccounts(b2bClientId) {
  try {
    const sql = `
      SELECT 
        u.user_id, u.email, u.full_name, u.status,
        u.last_login, u.created_at,
        va.permissions, va.id as viewer_account_id
      FROM viewer_accounts va
      JOIN users u ON va.viewer_user_id = u.user_id
      WHERE va.b2b_client_id = ?
      ORDER BY u.created_at DESC
    `;
    return await db.query(sql, [b2bClientId]);
  } catch (error) {
    logger.error('Error getting viewer accounts:', error);
    throw error;
  }
}
}


module.exports = new UserService();