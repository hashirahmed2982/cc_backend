#!/usr/bin/env node
/**
 * Live test of createOrder() + getOrderDetails() — the two Gift2Games
 * endpoints that have NEVER been confirmed against the real API (only
 * checkBalance() and getProducts() have, per gift2games.service.js's own
 * header). This is what utils/gift2gamesDelivery.js's field-name guesses
 * (code/cardCode/redeemCode/etc.) need real data to validate or correct.
 *
 * IMPORTANT: createOrder() is a REAL purchase against your live Gift2Games
 * balance — there is no known sandbox/test mode for this API. This script
 * is deliberately two-step to prevent an accidental real spend:
 *
 *   node scripts/test-gift2games-order.js
 *     — DRY RUN. Shows your balance and the cheapest in-stock catalog item
 *       it would buy. Places NO order.
 *
 *   node scripts/test-gift2games-order.js --confirm
 *     — Actually calls createOrder() for that item, then calls
 *       getOrderDetails() on the same referenceNumber and prints both raw
 *       responses in full. Send that full output back — that's what's
 *       needed to confirm or fix the delivered-code extractor.
 *
 * Usage:
 *   node scripts/test-gift2games-order.js [--confirm]
 */
'use strict';

require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const gift2gamesService = require('../src/services/gift2games.service');
const db = require('../src/config/database');

const CONFIRM = process.argv.includes('--confirm');

function pickCheapest(products) {
  const inStock = products.filter((p) => p.inStock);
  const pool = inStock.length ? inStock : products;
  return pool.reduce((cheapest, p) => {
    const price = Number(p.sellPrice ?? p.price ?? Infinity);
    const cheapestPrice = Number(cheapest.sellPrice ?? cheapest.price ?? Infinity);
    return price < cheapestPrice ? p : cheapest;
  }, pool[0]);
}

async function run() {
  console.log('='.repeat(70));
  console.log('Gift2Games createOrder/getOrderDetails live test');
  console.log('='.repeat(70));

  const balance = await gift2gamesService.checkBalance();
  console.log('\nCurrent balance:');
  console.log(JSON.stringify(balance, null, 2));

  console.log('\nFetching catalog...');
  const products = await gift2gamesService.getProducts();
  console.log(`Got ${products.length} products.`);

  const target = pickCheapest(products);
  console.log('\nCheapest in-stock item (this is what would be purchased):');
  console.log(JSON.stringify(target, null, 2));

  if (!CONFIRM) {
    console.log('\n' + '='.repeat(70));
    console.log('DRY RUN — no order placed. This item costs '
      + `${target.sellPrice ?? target.price} ${target.currency || ''} from your real balance.`);
    console.log('Re-run with --confirm to actually place it and see the real response shape:');
    console.log('  node scripts/test-gift2games-order.js --confirm');
    console.log('='.repeat(70));
    return db.end();
  }

  const referenceNumber = uuidv4();
  console.log('\n' + '='.repeat(70));
  console.log(`Placing a REAL order — productId: ${target.id}, referenceNumber: ${referenceNumber}`);
  console.log('='.repeat(70));

  let orderResult;
  try {
    orderResult = await gift2gamesService.createOrder({ productId: target.id, referenceNumber });
    console.log('\n✓ createOrder succeeded — RAW RESPONSE (send this in full):');
    console.log(JSON.stringify(orderResult, null, 2));
  } catch (err) {
    console.log('\n✗ createOrder threw — RAW ERROR (send this in full):');
    console.log('  message:', err.message);
    console.log('  code:', err.code);
    console.log('  full error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
  }

  console.log('\nCalling getOrderDetails on the same referenceNumber...');
  try {
    const details = await gift2gamesService.getOrderDetails({ referenceNumber });
    console.log('\n✓ getOrderDetails succeeded — RAW RESPONSE (send this in full):');
    console.log(JSON.stringify(details, null, 2));
  } catch (err) {
    console.log('\n✗ getOrderDetails threw — RAW ERROR (send this in full):');
    console.log('  message:', err.message);
  }

  console.log('\n' + '='.repeat(70));
  console.log(`referenceNumber used: ${referenceNumber}`);
  console.log('This script calls gift2games.service.js directly — it does NOT go through');
  console.log('the order pipeline, so nothing is written to your DB. That\'s deliberate: this');
  console.log('is purely to see the real response shape, not to test the full order flow.');
  console.log('='.repeat(70));

  return db.end();
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nScript failed:', err);
    process.exit(1);
  });
