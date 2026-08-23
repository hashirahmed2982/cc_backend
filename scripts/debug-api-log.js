#!/usr/bin/env node
/**
 * Decrypts and prints the last N api_logs entries for a given WgCards
 * endpoint — the general-purpose version of debug-place-order.js's log
 * dump, for any endpoint.
 *
 * Usage:
 *   node scripts/debug-api-log.js /api/getOrderInfoAndDetail
 *   node scripts/debug-api-log.js /api/getOrderInfoAndDetail 5   # last 5 instead of 3
 */
'use strict';

require('dotenv').config();

const [, , endpointArg, limitArg] = process.argv;
if (!endpointArg) {
  console.error('Usage: node scripts/debug-api-log.js <endpoint> [limit]');
  process.exit(1);
}

const db = require('../src/config/database');
const { decrypt } = require('../src/utils/dataCrypto');

async function run() {
  const rows = await db.query(
    'SELECT api_log_id, status_code, supplier_request, supplier_response, error_message, created_at FROM api_logs WHERE endpoint = ? ORDER BY created_at DESC LIMIT ?',
    [endpointArg, parseInt(limitArg, 10) || 3]
  );

  if (!rows.length) {
    console.log(`No api_logs entries found for endpoint '${endpointArg}'`);
    return;
  }

  for (const row of rows) {
    console.log(`\n--- api_log_id=${row.api_log_id} status=${row.status_code} at=${row.created_at} ---`);
    console.log('request      :', row.supplier_request ? decrypt(row.supplier_request) : '(none)');
    console.log('response     :', row.supplier_response ? decrypt(row.supplier_response) : '(none)');
    console.log('error_message:', row.error_message || '(none)');
  }
}

run()
  .then(() => db.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Diagnostic script failed:', err);
    process.exit(1);
  });
