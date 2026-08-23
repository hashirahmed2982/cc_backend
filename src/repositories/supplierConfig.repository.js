// repositories/supplierConfig.repository.js
// All reads/writes of the supplier_config table go through here so the
// ENCRYPTED columns (app_id, account_id, app_key, token) are never handled
// raw anywhere else. Uses utils/dataCrypto (our own AES-256-CBC at-rest
// scheme) — not to be confused with utils/wgcardsCrypto (the WgCards wire
// protocol), which lives entirely inside services/wgcards.service.js.
'use strict';

const db = require('../config/database');
const { encrypt, decrypt } = require('../utils/dataCrypto');

function decryptRow(row) {
  if (!row) return row;
  return {
    ...row,
    app_id: decrypt(row.app_id),
    account_id: decrypt(row.account_id),
    app_key: decrypt(row.app_key),
    token: row.token ? decrypt(row.token) : null,
  };
}

/** Fetch one supplier's config, decrypted. Returns null if not configured. */
async function getBySupplierName(supplierName) {
  const row = await db.queryOne(
    'SELECT * FROM supplier_config WHERE supplier_name = ?',
    [supplierName]
  );
  return decryptRow(row);
}

/** Upsert a supplier's credentials (encrypted). Does not touch the cached token. */
async function upsertCredentials(supplierName, { appId, accountId, appKey, apiBaseUrl, rateLimits }) {
  await db.query(
    `INSERT INTO supplier_config
       (supplier_name, app_id, account_id, app_key, api_base_url, rate_limits, is_active)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE
       app_id = VALUES(app_id),
       account_id = VALUES(account_id),
       app_key = VALUES(app_key),
       api_base_url = VALUES(api_base_url),
       rate_limits = VALUES(rate_limits)`,
    [
      supplierName,
      encrypt(appId),
      encrypt(accountId),
      encrypt(appKey),
      apiBaseUrl,
      rateLimits ? JSON.stringify(rateLimits) : null,
    ]
  );
}

/** Cache a freshly-obtained token + its expiry. */
async function saveToken(supplierName, token, expiresAt) {
  await db.query(
    'UPDATE supplier_config SET token = ?, token_expires = ? WHERE supplier_name = ?',
    [encrypt(token), expiresAt, supplierName]
  );
}

/** Clear the cached token (forces a fresh getToken on next call). */
async function clearToken(supplierName) {
  await db.query(
    'UPDATE supplier_config SET token = NULL, token_expires = NULL WHERE supplier_name = ?',
    [supplierName]
  );
}

/** Flow A/G circuit breaker: record one failure; flips to 'down' at 3 consecutive. */
async function recordFailure(supplierName) {
  await db.query(
    `UPDATE supplier_config
       SET consecutive_failures = consecutive_failures + 1,
           integration_status = CASE WHEN consecutive_failures + 1 >= 3 THEN 'down' ELSE integration_status END,
           down_since = CASE WHEN consecutive_failures + 1 >= 3 AND down_since IS NULL THEN NOW() ELSE down_since END
     WHERE supplier_name = ?`,
    [supplierName]
  );
  const row = await db.queryOne(
    'SELECT integration_status, consecutive_failures FROM supplier_config WHERE supplier_name = ?',
    [supplierName]
  );
  return row;
}

/** Any successful call resets the circuit breaker. */
async function recordSuccess(supplierName) {
  await db.query(
    `UPDATE supplier_config
       SET consecutive_failures = 0, integration_status = 'healthy', down_since = NULL
     WHERE supplier_name = ?`,
    [supplierName]
  );
}

/** Flow G: store the latest balance snapshot. */
async function saveBalance(supplierName, balance, currency) {
  await db.query(
    `UPDATE supplier_config
       SET balance = ?, balance_currency = ?, balance_checked_at = NOW(), last_sync = NOW()
     WHERE supplier_name = ?`,
    [balance, currency, supplierName]
  );
}

module.exports = {
  getBySupplierName,
  upsertCredentials,
  saveToken,
  clearToken,
  recordFailure,
  recordSuccess,
  saveBalance,
};
