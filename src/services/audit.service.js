const db = require('../config/database');
const logger = require('../utils/logger');

class AuditService {
  /**
   * Log an action
   */
  async log(auditData) {
    try {
      const sql = `
        INSERT INTO audit_logs (
          user_id, action, entity_type, entity_id,
          old_values, new_values, ip_address, user_agent,
          result, error_message
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const params = [
        auditData.user_id || null,
        auditData.action,
        auditData.entity_type || null,
        auditData.entity_id || null,
        auditData.old_values ? JSON.stringify(auditData.old_values) : null,
        auditData.new_values ? JSON.stringify(auditData.new_values) : null,
        auditData.ip_address || null,
        auditData.user_agent || null,
        auditData.result || 'success',
        auditData.error_message || null
      ];

      await db.query(sql, params);
    } catch (error) {
      // Don't throw error for audit logging failures
      logger.error('Error logging audit:', error);
    }
  }

  /**
   * Get audit logs with filters
   */
  async getLogs(filters = {}) {
    try {
      const { 
        page = 1, 
        limit = 50, 
        userId, 
        action, 
        entityType,
        startDate,
        endDate 
      } = filters;
      
      const offset = (page - 1) * limit;

      let whereClauses = [];
      let params = [];

      if (userId) {
        whereClauses.push('user_id = ?');
        params.push(userId);
      }

      if (action) {
        whereClauses.push('action = ?');
        params.push(action);
      }

      if (entityType) {
        whereClauses.push('entity_type = ?');
        params.push(entityType);
      }

      if (startDate) {
        whereClauses.push('created_at >= ?');
        params.push(startDate);
      }

      if (endDate) {
        whereClauses.push('created_at <= ?');
        params.push(endDate);
      }

      const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

      const sql = `
        SELECT * FROM audit_logs
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `;

      const countSql = `
        SELECT COUNT(*) as total
        FROM audit_logs
        ${whereClause}
      `;

      const logs = await db.query(sql, [...params, limit, offset]);
      const countResult = await db.queryOne(countSql, params);

      return {
        data: logs,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: countResult.total,
          totalPages: Math.ceil(countResult.total / limit)
        }
      };
    } catch (error) {
      logger.error('Error getting audit logs:', error);
      throw error;
    }
  }
}

module.exports = new AuditService();