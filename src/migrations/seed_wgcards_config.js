// migrations/seed_wgcards_config.js
// Seeds (or updates) the supplier_config row for WgCards from env vars —
// migrated to v4 credentials. Run once per environment after
// 000_full_schema.sql / 007_wgcards_integration.sql:
//
//   node src/migrations/seed_wgcards_config.js
//
// Reads WGCARDS_APP_ID / WGCARDS_SECRET / WGCARDS_BODY_KEY_MATERIAL /
// WGCARDS_HOST from .env. UNLIKE v3, the v4 doc publishes NO fixed public
// sandbox credentials at all (its "Request Example" uses placeholder
// values like "app_001"/"client-secret") — so appId/secret/bodyKeyMaterial
// are all REQUIRED here, no fallback. Only the HOST has a safe default,
// since the v4 doc's test-environment URL is public, non-secret
// information (unlike v3, where the whole bundle including a real appId/
// accountId/appKey was published together).
//
// Credential mapping onto supplier_config's existing (WgCards-v3-shaped)
// encrypted columns — see wgcards.service.js's _config() for the same
// note:
//   app_id     <- WGCARDS_APP_ID             (same concept as v3)
//   account_id <- WGCARDS_BODY_KEY_MATERIAL   (repurposed — v4 has no accountId)
//   app_key    <- WGCARDS_SECRET              (repurposed — the /api/v4/token credential)
'use strict';

require('dotenv').config();
const supplierConfigRepo = require('../repositories/supplierConfig.repository');
const db = require('../config/database');

const DEFAULT_TEST_HOST = 'http://120.26.99.152:9071/wgcards-api';

async function seed() {
  const appId = process.env.WGCARDS_APP_ID;
  const secret = process.env.WGCARDS_SECRET;
  const bodyKeyMaterial = process.env.WGCARDS_BODY_KEY_MATERIAL;
  const apiBaseUrl = process.env.WGCARDS_HOST || DEFAULT_TEST_HOST;

  if (!appId || !secret || !bodyKeyMaterial) {
    console.error(
      '❌ WGCARDS_APP_ID, WGCARDS_SECRET, and WGCARDS_BODY_KEY_MATERIAL must all be set in .env.\n' +
      '   v4 publishes no fixed sandbox credentials (unlike v3) — request a v4 test appId/secret/' +
      'bodyKeyMaterial from WgCards before running this.'
    );
    process.exit(1);
  }

  const usingDefaultHost = !process.env.WGCARDS_HOST;
  console.log(usingDefaultHost
    ? `✓ Seeding supplier_config from WGCARDS_* env vars — WGCARDS_HOST not set, defaulting to the v4 TEST environment (${DEFAULT_TEST_HOST}).`
    : '✓ Seeding supplier_config from WGCARDS_* env vars.');

  await supplierConfigRepo.upsertCredentials('wgcards', {
    appId,
    accountId: bodyKeyMaterial,
    appKey: secret,
    apiBaseUrl,
    rateLimits: {
      token: '20/min',
      getAccount: '60/min',
      getAllItem: '1/hour',
      getItemAndStock: '30/min',
      getDirectParam: '120/min',
      apiTopUpParamCheck: '120/min',
      getOrderList: '60/min',
      getOrderInfoAndDetail: '60/min',
      getBuyCards: 'unlimited',
      placeOrder: 'unlimited',
      placeDirectOrder: 'unlimited',
    },
  });

  console.log(`✅ supplier_config 'wgcards' row ready (host: ${apiBaseUrl})`);
  console.log(
    'Not yet confirmed against a real v4 endpoint — this integration was rewritten strictly from ' +
    'the v4 doc spec. Run scripts/test-wgcards-sandbox.js next (needs updating for v4 first) before ' +
    'flipping supplier_config.is_active back to 1 in production.'
  );
  await db.end();
}

seed().catch((err) => {
  console.error('❌ Seed failed:', err.message);
  process.exit(1);
});
