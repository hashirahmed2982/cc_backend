const db = require('../config/database');
const logger = require('../utils/logger');

class SessionService {
  /**
   * Create new session
   */
  async create(sessionData) {
    try {
      const sql = `
        INSERT INTO sessions (
          user_id, token, refresh_token, ip_address, 
          user_agent, expires_at, last_activity
        )
        VALUES (?, ?, ?, ?, ?, ?, NOW())
      `;
      
      const params = [
        sessionData.user_id,
        sessionData.token,
        sessionData.refresh_token,
        sessionData.ip_address,
        sessionData.user_agent,
        sessionData.expires_at
      ];

      const result = await db.query(sql, params);
      return result.insertId;
    } catch (error) {
      logger.error('Error creating session:', error);
      throw error;
    }
  }

  /**
   * Find session by token
   */
  async findByToken(token) {
    try {
      const sql = 'SELECT * FROM sessions WHERE token = ? LIMIT 1';
      return await db.queryOne(sql, [token]);
    } catch (error) {
      logger.error('Error finding session by token:', error);
      throw error;
    }
  }

  /**
   * Find session by refresh token
   */
  async findByRefreshToken(refreshToken) {
    try {
      const sql = 'SELECT * FROM sessions WHERE refresh_token = ? LIMIT 1';
      return await db.queryOne(sql, [refreshToken]);
    } catch (error) {
      logger.error('Error finding session by refresh token:', error);
      throw error;
    }
  }

  /**
   * Update session
   */
  async update(sessionId, updates) {
    try {
      const allowedFields = ['token', 'refresh_token', 'last_activity', 'expires_at'];
      
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

      values.push(sessionId);

      const sql = `UPDATE sessions SET ${updateFields.join(', ')} WHERE session_id = ?`;
      const result = await db.query(sql, values);
      return result.affectedRows > 0;
    } catch (error) {
      logger.error('Error updating session:', error);
      throw error;
    }
  }

  /**
   * Update last activity
   */
  async updateLastActivity(sessionId) {
    try {
      const sql = 'UPDATE sessions SET last_activity = NOW() WHERE session_id = ?';
      const result = await db.query(sql, [sessionId]);
      return result.affectedRows > 0;
    } catch (error) {
      logger.error('Error updating last activity:', error);
      throw error;
    }
  }

  /**
   * Delete session
   */
  async delete(sessionId) {
    try {
      const sql = 'DELETE FROM sessions WHERE session_id = ?';
      const result = await db.query(sql, [sessionId]);
      return result.affectedRows > 0;
    } catch (error) {
      logger.error('Error deleting session:', error);
      throw error;
    }
  }

  /**
   * Delete session by token
   */
  async deleteByToken(token) {
    try {
      const sql = 'DELETE FROM sessions WHERE token = ?';
      const result = await db.query(sql, [token]);
      return result.affectedRows > 0;
    } catch (error) {
      logger.error('Error deleting session by token:', error);
      throw error;
    }
  }

  /**
   * Delete all sessions for a user
   */
  async deleteAllByUserId(userId) {
    try {
      const sql = 'DELETE FROM sessions WHERE user_id = ?';
      const result = await db.query(sql, [userId]);
      return result.affectedRows;
    } catch (error) {
      logger.error('Error deleting all user sessions:', error);
      throw error;
    }
  }

  /**
   * Clean up expired sessions
   */
  async cleanupExpired() {
    try {
      const sql = 'DELETE FROM sessions WHERE expires_at < NOW()';
      const result = await db.query(sql);
      
      if (result.affectedRows > 0) {
        logger.info(`Cleaned up ${result.affectedRows} expired sessions`);
      }
      
      return result.affectedRows;
    } catch (error) {
      logger.error('Error cleaning up expired sessions:', error);
      throw error;
    }
  }
}

module.exports = new SessionService();