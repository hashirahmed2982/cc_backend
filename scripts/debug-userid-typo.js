#!/usr/bin/env node
/**
 * Both order-query endpoints (getOrderInfo, getOrderInfoAndDetail) return
 * {code:400, msg:"bad request"} while every other endpoint works — and
 * they're the only two whose doc examples disagree on the user-id field's
 * spelling: getOrderInfo's example literally says "uesrId" (typo),
 * getOrderInfoAndDetail's says "userId" (correct). Cross-testing both
 * spellings on both endpoints to see if the doc has it backwards.
 */
'use strict';

require('dotenv').config();

const wgcardsService = require('../src/services/wgcards.service');
const supplierConfigRepo = require('../src/repositories/supplierConfig.repository');
const db = require('../src/config/database');

const [, , orderIdArg] = process.argv;

async function tryCall(label, endpoint, payload) {
  console.log(`\n--- ${label} ---`);
  console.log('payload:', JSON.stringify(payload));
  try {
    const result = await wgcardsService._authedCall(endpoint, payload);
    console.log('SUCCESS:', JSON.stringify(result, null, 2).slice(0, 600));
  } catch (err) {
    console.log('THREW:', err.name, '-', err.message, err.wgcardsCode !== undefined ? `(wgcardsCode=${err.wgcardsCode})` : '');
  }
}

async function run() {
  const cfg = await supplierConfigRepo.getBySupplierName('wgcards');

  await tryCall('getOrderInfo + userId (correct spelling)', '/api/getOrderInfo', { userId: cfg.app_id, current: 1, size: 10 });
  await tryCall('getOrderInfo + uesrId (doc\'s literal typo)', '/api/getOrderInfo', { uesrId: cfg.app_id, current: 1, size: 10 });

  if (orderIdArg) {
    await tryCall('getOrderInfoAndDetail + userId (correct spelling)', '/api/getOrderInfoAndDetail', { userId: cfg.app_id, orderId: orderIdArg, current: 1, size: 200 });
    await tryCall('getOrderInfoAndDetail + uesrId (typo, cross-tested)', '/api/getOrderInfoAndDetail', { uesrId: cfg.app_id, orderId: orderIdArg, current: 1, size: 200 });
  } else {
    console.log('\n(no orderId arg passed — skipping getOrderInfoAndDetail variants; pass it as arg 1 to include them)');
  }
}

run()
  .then(() => db.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Diagnostic script failed:', err);
    process.exit(1);
  });
