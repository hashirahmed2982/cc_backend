// services/supplierApiLog.service.js
// Writes every outbound supplier API call to api_logs (supplier_request/
// supplier_response columns), regardless of success or failure. This is the
// Integration Activity / Error Log the client asked for (client comments
// #2 and #6 on the master plan doc) — the admin portal reads straight off
// this table, filterable by supplier_name/status_code/created_at.
'use strict';

const db = require('../config/database');
const logger = require('../utils/logger');
const { encrypt } = require('../utils/dataCrypto');

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
}

module.exports = new SupplierApiLogService();
