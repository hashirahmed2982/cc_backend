#!/usr/bin/env node
/**
 * Diagnostic: calls wgcardsService.placeOrder() directly ONE time (no retry
 * wrapper, no order_details writes) and prints exactly what happens —
 * the real error message/code/stack if it throws, or the raw result if it
 * doesn't. Also decrypts and prints the last few /api/placeOrder entries
 * from api_logs so we can see WgCards' actual response body.
 *
 * Usage:
 *   node scripts/debug-place-order.js <wgcardsSkuId> [buyNum]
 *
 * Find a wgcards_sku_id via:
 *   mysql -u root -p cardcove_db -e "SELECT sku_id, wgcards_sku_id, is_custom_value FROM product_skus WHERE product_id = 11391;"
 */
'use strict';

require('dotenv').config();
const { randomUUID } = require('crypto');

const [, , skuIdArg, buyNumArg] = process.argv;
if (!skuIdArg) {
  console.error('Usage: node scripts/debug-place-order.js <wgcardsSkuId> [buyNum]');
  process.exit(1);
}

const wgcardsService = require('../src/services/wgcards.service');
const db = require('../src/config/database');
const { decrypt } = require('../src/utils/dataCrypto');

async function run() {
  console.log('='.repeat(70));
  console.log('1. Last 3 /api/placeOrder entries in api_logs (decrypted)');
  console.log('='.repeat(70));
  const logs = await db.query(
    `SELECT api_log_id, status_code, supplier_request, supplier_response, created_at
       FROM api_logs WHERE endpoint = '/api/placeOrder' ORDER BY created_at DESC LIMIT 3`
  );
  for (const row of logs) {
    console.log(`\n--- api_log_id=${row.api_log_id} status=${row.status_code} at=${row.created_at} ---`);
    console.log('request :', row.supplier_request ? decrypt(row.supplier_request) : '(none)');
    console.log('response:', row.supplier_response ? decrypt(row.supplier_response) : '(none)');
  }

  console.log('\n' + '='.repeat(70));
  console.log('2. Direct placeOrder call — no retry wrapper, no DB writes');
  console.log('='.repeat(70));
  const serviceOrder = randomUUID();
  console.log('serviceOrder:', serviceOrder);
  try {
    const result = await wgcardsService.placeOrder({
      skuId: skuIdArg,
      buyNum: parseInt(buyNumArg, 10) || 1,
      currency: 'USD',
      serviceOrder,
    });
    console.log('SUCCESS:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.log('THREW:');
    console.log('  name   :', err.name);
    console.log('  message:', err.message);
    console.log('  code   :', err.code);
    console.log('  wgcardsCode:', err.wgcardsCode);
    console.log('  stack  :', err.stack);
  }
}

run()
  .then(() => db.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Diagnostic script itself failed:', err);
    process.exit(1);
  });
