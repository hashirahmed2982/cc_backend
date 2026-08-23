#!/usr/bin/env node
/**
 * Phase 0+1 live smoke test — exercises the REAL services/wgcards.service.js
 * (not a reimplementation) against whatever the DB's supplier_config row
 * points at. Run this after:
 *   1. npm run migrate            (or apply 007_wgcards_integration.sql to an
 *                                   existing DB)
 *   2. npm run seed:wgcards       (seeds sandbox creds unless WGCARDS_* env
 *                                   vars are set)
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
