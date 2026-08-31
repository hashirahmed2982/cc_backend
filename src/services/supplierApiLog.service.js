// services/supplierApiLog.service.js
// Writes every outbound supplier API call to api_logs (supplier_request/
// supplier_response columns), regardless of success or failure. This is the
// Integration Activity / Error Log the client asked for (client comments
// #2 and #6 on the master plan doc) — the admin portal reads straight off
// this table, filterable by supplier_name/status_code/created_at.
'use strict';

const db = require('../config/database');
const logger = require('../utils/logger');
const { encrypt, decrypt } = require('../utils/dataCrypto');

class SupplierApiLogService {
  /**
   * @param {object} entry
   * @param {string} entry.supplierName  'wgcards' | 'gift2games'
   * @param {string} entry.endpoint      e.g. '/api/getToken'
   * @param {string} entry.method        'POST'
   * @param {object} [entry.requestBody] decrypted/plain request payload we sent
   * @param {object|string} [entry.responseBody] decrypted/plain response payload we got
   * @param {number} entry.statusCode    HTTP status code (0 if the call never got a response)
   * @param {number} entry.responseTimeMs
   * @param {string} [entry.errorMessage]
   * @param {number} [entry.userId]
   */
  async log(entry) {
    try {
      await db.query(
        `INSERT INTO api_logs
           (user_id, endpoint, method, request_body, response_body,
            status_code, response_time, supplier_request, supplier_response,
            supplier_name, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.userId || null,
          entry.endpoint,
          entry.method || 'POST',
          null, // request_body/response_body are for our own API's client-facing logs — unused here
          null,
          entry.statusCode || 0,
          entry.responseTimeMs || 0,
          entry.requestBody ? encrypt(JSON.stringify(entry.requestBody)) : null,
          entry.responseBody ? encrypt(JSON.stringify(entry.responseBody)) : null,
          entry.supplierName,
          entry.errorMessage || null,
        ]
      );
    } catch (err) {
      // Logging must never break the calling flow.
      logger.error('SupplierApiLogService.log failed:', err);
    }
  }

  /**
   * Paginated, decrypted read — the admin panel's Integration Activity /
   * Error Log page reads straight off this.
   * @param {object} filters
   * @param {string} [filters.supplierName]
   * @param {number} [filters.statusCode]  exact match; pass 0 to find transport failures
   * @param {boolean} [filters.errorsOnly] status_code != 200 OR error_message IS NOT NULL
   * @param {number} [filters.page]
   * @param {number} [filters.limit]
   */
  async list({ supplierName, statusCode, errorsOnly, page = 1, limit = 50 } = {}) {
    const conds = ['supplier_name IS NOT NULL'];
    const params = [];
    if (supplierName) { conds.push('supplier_name = ?'); params.push(supplierName); }
    if (statusCode !== undefined) { conds.push('status_code = ?'); params.push(statusCode); }
    if (errorsOnly) { conds.push("(status_code <> 200 OR error_message IS NOT NULL)"); }
    const where = `WHERE ${conds.join(' AND ')}`;

    const safeLimit = Math.min(parseInt(limit) || 50, 200);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * safeLimit;

    const rows = await db.query(
      `SELECT api_log_id, endpoint, method, status_code, response_time,
              supplier_request, supplier_response, supplier_name, error_message, created_at
         FROM api_logs ${where}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset]
    );
    const [{ total }] = await db.query(`SELECT COUNT(*) AS total FROM api_logs ${where}`, params);

    const decrypted = rows.map((row) => ({
      ...row,
      supplier_request: safeDecryptJson(row.supplier_request),
      supplier_response: safeDecryptJson(row.supplier_response),
    }));

    return { rows: decrypted, pagination: { page: Math.max(parseInt(page) || 1, 1), limit: safeLimit, total } };
  }
}

function safeDecryptJson(encrypted) {
  if (!encrypted) return null;
  try {
    return JSON.parse(decrypt(encrypted));
  } catch (err) {
    return null; // corrupted/undecryptable row — don't let one bad row break the whole page
  }
}

module.exports = new SupplierApiLogService();
