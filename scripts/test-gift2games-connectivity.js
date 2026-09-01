#!/usr/bin/env node
/**
 * First-ever live call against the real Gift2Games API through the actual
 * services/gift2games.service.js (not a reimplementation). checkBalance()
 * is the cheapest read-only call available — confirms the JWT is valid
 * and the host is reachable before trusting gift2gamesFulfillment.js with
 * a real order.
 *
 * Run this AFTER: node src/migrations/seed_gift2games_config.js
 *
 * Usage: node scripts/test-gift2games-connectivity.js
 */
'use strict';

require('dotenv').config();
const gift2gamesService = require('../src/services/gift2games.service');
const db = require('../src/config/database');

async function run() {
  console.log('='.repeat(70));
  console.log('Gift2Games connectivity test (real services/gift2games.service.js)');
  console.log('='.repeat(70));

  try {
    const result = await gift2gamesService.checkBalance();
    console.log('\n✓ checkBalance succeeded');
    console.log(JSON.stringify(result, null, 2));
    console.log('\n' + '='.repeat(70));
    console.log('JWT + host are valid. Next: try getProducts() to see the real catalog shape');
    console.log('(the request/response field names in gift2games.service.js were written from');
    console.log('the master plan\'s description of the API, not the raw doc — this is the first');
    console.log('point where a mismatch there would actually surface).');
    console.log('='.repeat(70));
  } catch (err) {
    console.log('\n✗ checkBalance failed');
    console.log(`  ${err.message}`);
    if (err.code) console.log(`  code: ${err.code}`);
    console.log('\n' + '='.repeat(70));
    console.log('Check, in order: is GIFT2GAMES_HOST exactly right (this script sent to');
    console.log(`  ${process.env.GIFT2GAMES_HOST || '(GIFT2GAMES_HOST not set)'}/check_balance ), is the JWT still valid`);
    console.log('(no refresh flow exists — a human has to get a new one from Gift2Games if it');
    console.log('expired), and does /check_balance even use GET (gift2games.service.js assumes');
    console.log('GET with no body — the real doc may say otherwise).');
    console.log('='.repeat(70));
  }

  await db.end();
  process.exit(0);
}

run();
