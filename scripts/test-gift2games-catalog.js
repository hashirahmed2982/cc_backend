#!/usr/bin/env node
/**
 * First live call to getProducts() through the real gift2games.service.js.
 * checkBalance() is confirmed working (envelope: {status,data,message,
 * erorrCode}, no Bearer prefix) — this is the next place that confirmed
 * shape either holds up or needs its own correction, same way checkBalance
 * itself needed the Bearer-prefix fix.
 *
 * Usage: node scripts/test-gift2games-catalog.js
 */
'use strict';

require('dotenv').config();
const gift2gamesService = require('../src/services/gift2games.service');
const db = require('../src/config/database');

async function run() {
  console.log('='.repeat(70));
  console.log('Gift2Games getProducts() live test');
  console.log('='.repeat(70));

  try {
    const products = await gift2gamesService.getProducts();
    console.log('\n✓ getProducts succeeded');
    console.log(`Type: ${Array.isArray(products) ? `array, ${products.length} item(s)` : typeof products}`);
    console.log('\nFull response (or first 3 items if this is a big array):');
    const preview = Array.isArray(products) ? products.slice(0, 3) : products;
    console.log(JSON.stringify(preview, null, 2).slice(0, 4000));

    if (Array.isArray(products) && products.length) {
      const sample = products[0];
      console.log('\n' + '-'.repeat(70));
      console.log('Field check against what gift2gamesCatalogSync (not yet built) will need:');
      console.log(`  productId-like field present? ${Object.keys(sample).filter(k => /id/i.test(k)).join(', ') || 'NONE FOUND'}`);
      console.log(`  'price' field (cost — NOT 'sellPrice' per the doc)? ${sample.price !== undefined ? `yes: ${sample.price}` : 'NOT PRESENT'}`);
      console.log(`  'sellPrice' field also present (for comparison)? ${sample.sellPrice !== undefined ? `yes: ${sample.sellPrice}` : 'not present'}`);
      console.log(`  inStock boolean field? ${sample.inStock !== undefined ? `yes: ${sample.inStock}` : 'NOT PRESENT'}`);
    }
  } catch (err) {
    console.log('\n✗ getProducts failed');
    console.log(`  ${err.message}`);
    if (err.code) console.log(`  code: ${err.code}`);
  }

  console.log('\n' + '='.repeat(70));
  await db.end();
  process.exit(0);
}

run();
