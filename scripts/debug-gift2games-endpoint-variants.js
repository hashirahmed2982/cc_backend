#!/usr/bin/env node
/**
 * getProducts() 404'd at /getProducts — check_balance (confirmed working)
 * is snake_case, so the master plan's "getProducts({inStock:1})" was
 * likely just JS-style paraphrase of a differently-named real endpoint,
 * same way "createOrder"/"getOrderDetails" turned out to really be
 * /create_order and /orders/details. This tries several plausible paths
 * for the product catalog listing, using the now-confirmed auth (raw JWT,
 * no Bearer) and GET, same as check_balance.
 *
 * Usage: node scripts/debug-gift2games-endpoint-variants.js
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

const paths = [
  '/get_products',
  '/getProducts',
  '/products',
  '/get_product',
  '/product_list',
  '/getProductList',
  '/list_products',
  '/catalog',
  '/get_catalog',
];

async function tryPath(path) {
  const url = `${HOST}${path}`;
  try {
    const res = await axios.get(url, {
      headers: { Authorization: JWT, 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
      validateStatus: () => true,
    });
    const bodyPreview = typeof res.data === 'object'
      ? JSON.stringify(res.data).slice(0, 300)
      : String(res.data).slice(0, 200);
    return { path, status: res.status, bodyPreview };
  } catch (err) {
    return { path, status: 'ERR', bodyPreview: err.message };
  }
}

async function run() {
  console.log('='.repeat(70));
  console.log(`Probing ${paths.length} candidate paths for the products catalog endpoint`);
  console.log('='.repeat(70));

  for (const path of paths) {
    const result = await tryPath(path);
    const marker = result.status === 200 ? '✓' : result.status === 404 ? '·' : '?';
    console.log(`\n${marker} ${result.path}`);
    console.log(`  HTTP ${result.status} — ${result.bodyPreview}`);
  }

  console.log('\n' + '='.repeat(70));
  console.log('A 404 means the path is wrong (same host/auth, different route).');
  console.log('A non-404 non-200 (e.g. 400, 422) usually means the path IS right but');
  console.log('the request needs different params — worth investigating over just widening this list.');
  console.log('If NONE of these hit, the real path is something not guessed here — worth asking');
  console.log('whoever supplied the JWT for the actual Gift2Games API doc.');
  console.log('='.repeat(70));
}

run();
