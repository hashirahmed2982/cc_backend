#!/usr/bin/env node
/**
 * getOrderInfo now confirmed working with {userId, current, size} (the
 * doc's "uesrId" was a real documentation typo). getOrderInfoAndDetail
 * still fails with {userId, orderId, current, size} on both userId/uesrId
 * spellings. placeOrder is the only other endpoint whose payload includes
 * BOTH userId AND accountId (every read-only endpoint we've gotten working
 * so far — getAccount, getOrderInfo — only needed userId). Testing whether
 * getOrderInfoAndDetail is similarly asking for accountId too.
 *
 * Usage:
 *   node scripts/debug-order-detail-accountid.js <wgcardsOrderId>
 */
'use strict';

require('dotenv').config();

const [, , orderIdArg] = process.argv;
if (!orderIdArg) {
  console.error('Usage: node scripts/debug-order-detail-accountid.js <wgcardsOrderId>');
  process.exit(1);
}

const wgcardsService = require('../src/services/wgcards.service');
const supplierConfigRepo = require('../src/repositories/supplierConfig.repository');
const db = require('../src/config/database');

async function tryCall(label, payload) {
  console.log(`\n--- ${label} ---`);
  console.log('payload:', JSON.stringify(payload));
  try {
    const result = await wgcardsService._authedCall('/api/getOrderInfoAndDetail', payload);
    console.log('SUCCESS:', JSON.stringify(result, null, 2).slice(0, 1000));
  } catch (err) {
    console.log('THREW:', err.name, '-', err.message, err.wgcardsCode !== undefined ? `(wgcardsCode=${err.wgcardsCode})` : '');
  }
}

async function run() {
  const cfg = await supplierConfigRepo.getBySupplierName('wgcards');

  await tryCall('userId + accountId + orderId', {
    userId: cfg.app_id, accountId: cfg.account_id, orderId: orderIdArg, current: 1, size: 200,
  });
  await tryCall('userId + accountId + orderId, size omitted (maybe size:200 itself is rejected)', {
    userId: cfg.app_id, accountId: cfg.account_id, orderId: orderIdArg, current: 1,
  });
}

run()
  .then(() => db.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Diagnostic script failed:', err);
    process.exit(1);
  });
