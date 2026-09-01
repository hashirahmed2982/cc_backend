#!/usr/bin/env node
/**
 * Diagnostic — check_balance returned HTTP 200 with a body signaling a
 * REJECTED login ({status:0, erorrCode:"login_unsuccessful"}), meaning
 * the request reached Gift2Games' real auth logic rather than failing at
 * the transport/routing level. This tries several plausible ways of
 * sending the JWT to narrow down whether it's a request-shape mismatch
 * (fixable in code) or the token itself being wrong/expired (needs a new
 * one from Gift2Games — no self-service refresh exists).
 *
 * Reads GIFT2GAMES_JWT / GIFT2GAMES_HOST directly from .env — does NOT go
 * through supplier_config, so this runs even before/without seeding.
 *
 * Usage: node scripts/debug-gift2games-auth-variants.js
 */
'use strict';

require('dotenv').config();
const axios = require('axios');

const JWT = process.env.GIFT2GAMES_JWT;
const HOST = process.env.GIFT2GAMES_HOST;

if (!JWT || !HOST) {
  console.error('GIFT2GAMES_JWT and GIFT2GAMES_HOST must both be set in .env');
  process.exit(1);
}

const url = `${HOST}/check_balance`;

const variants = [
  {
    name: 'Authorization: Bearer <jwt>  (current gift2games.service.js behavior)',
    config: { method: 'GET', url, headers: { Authorization: `Bearer ${JWT}` } },
  },
  {
    name: 'Authorization: <jwt>  (no Bearer prefix)',
    config: { method: 'GET', url, headers: { Authorization: JWT } },
  },
  {
    name: 'header "token": <jwt>',
    config: { method: 'GET', url, headers: { token: JWT } },
  },
  {
    name: 'header "x-auth-token": <jwt>',
    config: { method: 'GET', url, headers: { 'x-auth-token': JWT } },
  },
  {
    name: 'JWT as a query param ?token=<jwt>, no auth header',
    config: { method: 'GET', url, params: { token: JWT } },
  },
  {
    name: 'JWT as a form body field {token: <jwt>}, POST',
    config: { method: 'POST', url, data: new URLSearchParams({ token: JWT }).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  },
  {
    name: 'POST with Authorization: Bearer <jwt> (same header, POST instead of GET)',
    config: { method: 'POST', url, headers: { Authorization: `Bearer ${JWT}` } },
  },
];

async function run() {
  console.log('='.repeat(70));
  console.log(`Testing ${variants.length} request shapes against ${url}`);
  console.log('='.repeat(70));

  for (const v of variants) {
    try {
      const res = await axios.request({ ...v.config, timeout: 10000, validateStatus: () => true });
      const bodyPreview = typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data).slice(0, 200);
      const looksSuccessful = typeof res.data === 'object' && res.data !== null &&
        (res.data.status === 1 || res.data.status === true || res.data.erorrCode === undefined && res.data.errorCode === undefined);
      console.log(`\n${looksSuccessful ? '✓' : '✗'} ${v.name}`);
      console.log(`  HTTP ${res.status} — ${bodyPreview}`);
    } catch (err) {
      console.log(`\n✗ ${v.name}`);
      console.log(`  request failed: ${err.message}`);
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('Look for the one with status:1 (or no erorrCode/errorCode) — that\'s the correct shape.');
  console.log('If EVERY variant comes back "Incorrect Login", the token itself is most likely wrong or');
  console.log('expired rather than a request-shape issue — worth confirming directly with Gift2Games.');
  console.log('='.repeat(70));
}

run();
