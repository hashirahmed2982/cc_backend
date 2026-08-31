#!/usr/bin/env node
/**
 * Flow F live smoke test — places a REAL Direct Top-Up order through the
 * actual wgcardsTopupService.initiateTopup() (same code path the API
 * uses): apiTopUpParamCheck -> placeDirectOrder. This debits real wallet
 * balance on the WgCards SANDBOX — do not run against production
 * credentials/data without knowing what you're doing.
 *
 * Run scripts/discover-topup-skus.js first to find a skuId and see what
 * attributeValues (name/value pairs) it actually needs.
 *
 * Usage:
 *   node scripts/test-topup-placement.js <userId> <skuId> <attrName> <attrValue> [faceValue]
 *
 * Example (fixed-denomination SKU):
 *   node scripts/test-topup-placement.js 3 12 "player ID" 1234
 * Example (custom-value SKU, faceValue required):
 *   node scripts/test-topup-placement.js 3 12 "player ID" 1234 25
 *
 * After running, watch for the webhook (up to 5x within 30 min) or the
 * reconciler (10 min after the 35-min mark) to resolve it:
 *   mysql -u root -p cardcove_db -e "SELECT * FROM wgcards_topup_orders WHERE topup_order_id = <id>\G"
 * To force-check it immediately instead of waiting on the schedule:
 *   node src/jobs/wgcardsTopupReconciler.js
 */
'use strict';

require('dotenv').config();

const [, , userIdArg, skuIdArg, attrName, attrValue, faceValueArg] = process.argv;

if (!userIdArg || !skuIdArg || !attrName || !attrValue) {
  console.error('Usage: node scripts/test-topup-placement.js <userId> <skuId> <attrName> <attrValue> [faceValue]');
  process.exit(1);
}

const wgcardsTopupService = require('../src/services/wgcardsTopup.service');
const db = require('../src/config/database');

async function run() {
  const userId = parseInt(userIdArg, 10);
  const skuId = parseInt(skuIdArg, 10);
  const faceValue = faceValueArg ? parseFloat(faceValueArg) : undefined;
  const attributeValues = [{ name: attrName, value: attrValue }];

  console.log('='.repeat(70));
  console.log(`Placing a REAL Direct Top-Up order: userId=${userId}, skuId=${skuId}, attributeValues=${JSON.stringify(attributeValues)}${faceValue !== undefined ? `, faceValue=${faceValue}` : ''}`);
  console.log('='.repeat(70));

  if (!process.env.WGCARDS_TOPUP_WEBHOOK_URL) {
    console.log('\n⚠ WGCARDS_TOPUP_WEBHOOK_URL is not set — WgCards will have nowhere to POST the result.');
    console.log('  The order will still be placed; you\'ll rely entirely on the reconciler to resolve it.\n');
  }

  const result = await wgcardsTopupService.initiateTopup({ userId, skuId, attributeValues, faceValue });

  console.log('\nResult:');
  console.log(JSON.stringify(result, null, 2));

  if (result.topupOrderId) {
    console.log('\nCheck its status:');
    console.log(`  mysql -u root -p cardcove_db -e "SELECT * FROM wgcards_topup_orders WHERE topup_order_id = ${result.topupOrderId}\\G"`);
  }
}

run()
  .then(() => db.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Top-up placement failed:', err);
    process.exit(1);
  });
