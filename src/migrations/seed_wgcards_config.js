// migrations/seed_wgcards_config.js
// Seeds (or updates) the supplier_config row for WgCards from env vars.
// Run once per environment after 000_full_schema.sql / 007_wgcards_integration.sql:
//
//   node src/migrations/seed_wgcards_config.js
//
// Reads WGCARDS_APP_ID / WGCARDS_ACCOUNT_ID / WGCARDS_APP_KEY / WGCARDS_HOST
// from .env. Falls back to the public sandbox debug credentials published in
// WgCards_English_API_Doc_V3_0_8 if unset, so `npm run seed:wgcards` works
// out of the box against the sandbox with zero config.
'use strict';

require('dotenv').config();
const supplierConfigRepo = require('../repositories/supplierConfig.repository');
const db = require('../config/database');

const SANDBOX_DEFAULTS = {
  appId: '2025112058411324',
  accountId: '2025112058411325',
  appKey: 'o%Cmiq52TP4o06Uok&R6tC#^#FXGNE*3',
  apiBaseUrl: 'http://121.43.36.102:9009',
};

async function seed() {
  const appId = process.env.WGCARDS_APP_ID || SANDBOX_DEFAULTS.appId;
  const accountId = process.env.WGCARDS_ACCOUNT_ID || SANDBOX_DEFAULTS.accountId;
  const appKey = process.env.WGCARDS_APP_KEY || SANDBOX_DEFAULTS.appKey;
  const apiBaseUrl = process.env.WGCARDS_HOST || SANDBOX_DEFAULTS.apiBaseUrl;

  const usingDefaults = !process.env.WGCARDS_APP_ID;
  console.log(usingDefaults
    ? '⚠️  No WGCARDS_* env vars set — seeding the public sandbox debug credentials from the doc.'
    : '✓ Seeding supplier_config from WGCARDS_* env vars.');

  await supplierConfigRepo.upsertCredentials('wgcards', {
    appId,
    accountId,
    appKey,
    apiBaseUrl,
    rateLimits: {
      getToken: '40/60s',
      getAccount: '40/60s',
      getItem: '40/60s',
      getAllItem: '20/60s',
      getStock: '40/60s',
      getItemAndStock: '40/1h (waived if itemId/skuId given)',
    },
  });

  console.log(`✅ supplier_config 'wgcards' row ready (host: ${apiBaseUrl})`);
  await db.end();
}

seed().catch((err) => {
  console.error('❌ Seed failed:', err.message);
  process.exit(1);
});
