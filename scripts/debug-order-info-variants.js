#!/usr/bin/env node
/**
 * getOrderInfoAndDetail returned {code:400, msg:"bad request", appId:null}
 * for the exact request shape shown in the doc's own example. The doc's
 * Params table says the orderId field accepts "orderId or serviceOrder
 * (what sent to us when placing the order)" — trying a few variants
 * directly against the sandbox to isolate which one it actually wants,
 * bypassing wgcards.service.js's fixed method signature.
 *
 * Usage:
 *   node scripts/debug-order-info-variants.js <wgcardsOrderId> <serviceOrder>
 */
'use strict';

require('dotenv').config();

const [, , orderIdArg, serviceOrderArg] = process.argv;
if (!orderIdArg || !serviceOrderArg) {
  console.error('Usage: node scripts/debug-order-info-variants.js <wgcardsOrderId> <serviceOrder>');
  console.error('Find both via: mysql ... -e "SELECT wgcards_order_id, wgcards_service_order FROM order_details WHERE order_id=24;"');
  process.exit(1);
}

// Reach into the private bits of wgcards.service.js's module so we can
// build arbitrary payloads through the same authed/encrypted call path,
// without being limited to the fixed public method signature.
const wgcardsService = require('../src/services/wgcards.service');
const db = require('../src/config/database');

async function tryPayload(label, payload) {
  console.log(`\n--- ${label} ---`);
  console.log('payload:', JSON.stringify(payload));
  try {
    // Piggyback on the public getOrderInfoAndDetail but override which
    // field carries which value by calling it with mismatched args.
    const result = await wgcardsService.getOrderInfoAndDetail(payload);
    console.log('SUCCESS:', JSON.stringify(result, null, 2).slice(0, 800));
  } catch (err) {
    console.log('THREW:', err.name, '-', err.message, err.wgcardsCode ? `(wgcardsCode=${err.wgcardsCode})` : '');
  }
}

async function run() {
  await tryPayload('A: orderId = wgcards_order_id (what we already tried)', { orderId: orderIdArg });
  await tryPayload('B: orderId = wgcards_service_order (the original idempotency key)', { orderId: serviceOrderArg });
}

run()
  .then(() => db.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Diagnostic script failed:', err);
    process.exit(1);
  });
