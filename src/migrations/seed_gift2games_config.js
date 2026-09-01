// migrations/seed_gift2games_config.js
// Seeds (or updates) the supplier_config row for Gift2Games from env vars.
// Run once per environment after 012_multi_supplier_framework.sql:
//
//   node src/migrations/seed_gift2games_config.js
//
// Reads GIFT2GAMES_JWT / GIFT2GAMES_HOST from .env — no sandbox fallback
// like seed_wgcards_config.js has, since there's no public Gift2Games
// sandbox to default to; both are required.
//
// Gift2Games' auth model has no separate app_id/account_id the way WgCards
// does (Master Plan §1: "static JWT in Authorization header, no refresh
// endpoint documented") — supplier_config's app_id/account_id columns are
// NOT NULL because the table was originally shaped for WgCards' two-part
// auth, so this fills them with placeholders rather than real Gift2Games
// concepts: app_id = a fixed literal, account_id = the `email` claim
// decoded out of the JWT itself (the only real identifying information in
// it), purely so the admin panel's Suppliers page has something
// meaningful to show, not because Gift2Games' API uses either value.
'use strict';

require('dotenv').config();
const supplierConfigRepo = require('../repositories/supplierConfig.repository');
const db = require('../config/database');

function decodeJwtEmail(jwt) {
  try {
    const payloadB64 = jwt.split('.')[1];
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
    return payload.email || null;
  } catch {
    return null; // not fatal — just means the placeholder account_id below is generic
  }
}

async function seed() {
  const jwt = process.env.GIFT2GAMES_JWT;
  const apiBaseUrl = process.env.GIFT2GAMES_HOST;

  if (!jwt || !apiBaseUrl) {
    console.error('❌ GIFT2GAMES_JWT and GIFT2GAMES_HOST must both be set in .env — no sandbox default exists for this supplier.');
    process.exit(1);
  }

  const email = decodeJwtEmail(jwt);
  console.log(`✓ Seeding supplier_config 'gift2games' — host: ${apiBaseUrl}${email ? `, token issued for: ${email}` : ''}`);

  await supplierConfigRepo.upsertCredentials('gift2games', {
    appId: 'gift2games', // placeholder — see file header comment
    accountId: email || 'gift2games', // placeholder — see file header comment
    appKey: jwt, // the actual credential — sent as `Authorization: Bearer <appKey>` in gift2games.service.js
    apiBaseUrl,
  });

  console.log(`✅ supplier_config 'gift2games' row ready (host: ${apiBaseUrl})`);
  console.log('Nothing calls this automatically yet — catalogSync/stockSync/healthCheck/balanceMonitor are all still WgCards-only, and supplierSelection.service.js only ever dispatches to gift2games for a canonical SKU that already has an active gift2games sku_supplier_links row, which nothing creates yet either. This seed is inert until both of those exist.');
  console.log('Run scripts/test-gift2games-connectivity.js next to confirm the JWT+host actually work before building on top of it.');
  await db.end();
}

seed().catch((err) => {
  console.error('❌ Seed failed:', err.message);
  process.exit(1);
});
