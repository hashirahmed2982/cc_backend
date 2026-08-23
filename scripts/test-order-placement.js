#!/usr/bin/env node
/**
 * Phase 4 live smoke test — places a REAL order through the actual
 * orderService.placeOrder() (same code path the API uses), against a real
 * WgCards-sourced product. This debits real wallet balance and places a
 * real order on the WgCards SANDBOX — do not run against production
 * credentials/data without knowing what you're doing.
 *
 * Usage:
 *   node scripts/test-order-placement.js <userId> <productId> [quantity]
 *
 * Find a userId with wallet balance and a wgcards productId via:
 *   mysql -u root -p cardcove_db -e "SELECT user_id FROM wallets WHERE balance > 0 LIMIT 5;"
 *   mysql -u root -p cardcove_db -e "SELECT product_id, product_name FROM products WHERE source='wgcards' LIMIT 10;"
 */
'use strict';

require('dotenv').config();

const [, , userIdArg, productIdArg, quantityArg] = process.argv;

if (!userIdArg || !productIdArg) {
  console.error('Usage: node scripts/test-order-placement.js <userId> <productId> [quantity]');
  process.exit(1);
}

const orderService = require('../src/services/order.service');
const db = require('../src/config/database');

async function run() {
  const userId = parseInt(userIdArg, 10);
  const productId = parseInt(productIdArg, 10);
  const quantity = parseInt(quantityArg, 10) || 1;

  console.log('='.repeat(70));
  console.log(`Placing a REAL test order: userId=${userId}, productId=${productId}, quantity=${quantity}`);
  console.log('='.repeat(70));

  const result = await orderService.placeOrder(userId, [{ productId, quantity }], 'Phase 4 live smoke test');

  console.log('\nOrder placed:');
  console.log(JSON.stringify(result, null, 2));

  console.log('\nCheck order_details for the wgcards_order_id / pending_reason:');
  console.log(`  mysql -u root -p cardcove_db -e "SELECT * FROM order_details WHERE order_id = ${result.orderId}\\G"`);
}

run()
  .then(() => db.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Order placement failed:', err);
    process.exit(1);
  });
