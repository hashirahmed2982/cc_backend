#!/usr/bin/env node
/**
 * Flow F read-only discovery — lists whatever spuType:5 (Direct Top-Up)
 * SKUs catalogSync has already synced into product_skus, and for each one
 * calls the real getDirectParam so you can see exactly what attributeValues
 * a real placeDirectOrder call for it needs (player ID? phone number?
 * zone?) before writing test data by hand.
 *
 * Doesn't spend anything — read-only. Run this BEFORE
 * scripts/test-topup-placement.js.
 *
 * Usage: node scripts/discover-topup-skus.js
 */
'use strict';

require('dotenv').config();

const db = require('../src/config/database');
const wgcardsService = require('../src/services/wgcards.service');

async function run() {
  console.log('='.repeat(70));
  console.log('Flow F — discovering Direct Top-Up (spuType:5) SKUs');
  console.log('='.repeat(70));

  const rows = await db.query(
    `SELECT ps.sku_id, ps.wgcards_sku_id, ps.sku_name, ps.is_custom_value,
            ps.min_face_value, ps.max_face_value, ps.selling_price, p.product_name
       FROM product_skus ps
       JOIN products p ON p.product_id = ps.product_id
      WHERE p.spu_type = 5 AND ps.is_active = 1
      LIMIT 10`
  );

  if (!rows.length) {
    console.log('\nNo spuType:5 SKUs found in product_skus. Run catalogSync first:');
    console.log('  node src/jobs/catalogSync.js');
    await db.end();
    process.exit(1);
  }

  console.log(`\nFound ${rows.length} Direct Top-Up SKU(s):\n`);

  for (const row of rows) {
    console.log('-'.repeat(70));
    console.log(`sku_id=${row.sku_id}  wgcards_sku_id=${row.wgcards_sku_id}`);
    console.log(`product: ${row.product_name} / ${row.sku_name}`);
    console.log(`custom-value: ${!!row.is_custom_value}  range: ${row.min_face_value ?? '-'}–${row.max_face_value ?? '-'}  selling_price: ${row.selling_price}`);
    try {
      const paramInfos = await wgcardsService.getDirectParam({ skuId: row.wgcards_sku_id });
      console.log('getDirectParam ->');
      console.log(JSON.stringify(paramInfos, null, 2));
    } catch (err) {
      console.log(`getDirectParam FAILED: ${err.message}`);
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('Next: node scripts/test-topup-placement.js <userId> <skuId> <attrName> <attrValue> [faceValue]');
  console.log('='.repeat(70));

  await db.end();
  process.exit(0);
}

run().catch((err) => {
  console.error('discover-topup-skus failed:', err);
  process.exit(1);
});
