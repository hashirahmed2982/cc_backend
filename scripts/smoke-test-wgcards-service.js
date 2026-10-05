#!/usr/bin/env node
/**
 * Live smoke test — exercises the REAL services/wgcards.service.js (not a
 * reimplementation) against whatever the DB's supplier_config row points
 * at. v4 migration note: unlike v3, there is no public sandbox fallback —
 * WGCARDS_APP_ID/WGCARDS_SECRET/WGCARDS_BODY_KEY_MATERIAL must be set to a
 * real v4 test credential set before running `npm run seed:wgcards`, and
 * the sample SKU IDs below are v3-sandbox placeholders — replace them with
 * real SKU IDs from a v4 getAllItem()/getItem() call once you have
 * credentials, or this step will just report a clean "not found"-style
 * rejection rather than a true pass. Run this after:
 *   1. npm run migrate            (or apply 007_wgcards_integration.sql to an
 *                                   existing DB)
 *   2. npm run seed:wgcards       (requires real v4 WGCARDS_* env vars)
 *
 * Usage: node scripts/smoke-test-wgcards-service.js
 */
'use strict';

require('dotenv').config();
const wgcardsService = require('../src/services/wgcards.service');
const db = require('../src/config/database');

async function run() {
  console.log('='.repeat(70));
  console.log('WgCards service smoke test (real services/wgcards.service.js)');
  console.log('='.repeat(70));

  const steps = [
    ['getAccount', () => wgcardsService.getAccount()],
    ['getAllItem', () => wgcardsService.getAllItem({ currencyCode: 'CNY', language: 'en' })],
    ['getStock (sample SKUs from the doc)', () => wgcardsService.getStock(['2025062450882798', '2025062335235123'])],
  ];

  let allOk = true;
  for (const [name, fn] of steps) {
    try {
      const result = await fn();
      console.log(`\n✓ ${name}`);
      console.log(JSON.stringify(result, null, 2).slice(0, 1000));
    } catch (err) {
      allOk = false;
      console.log(`\n✗ ${name}`);
      console.log(`  ${err.message}`);
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log(allOk ? 'ALL PASSED' : 'SOME FAILED — see above');
  console.log('='.repeat(70));
  await db.end();
  process.exit(allOk ? 0 : 1);
}

run();
