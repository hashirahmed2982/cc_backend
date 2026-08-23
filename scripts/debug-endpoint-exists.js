#!/usr/bin/env node
/**
 * Both param variants for /api/getOrderInfoAndDetail failed identically
 * with {appId:null, code:400, msg:"bad request"} — appId:null suggests the
 * request may never have reached app-level decryption/routing at all (a
 * gateway-level "route not found" often looks exactly like this). Testing
 * that theory: call a deliberately-wrong path, and the OTHER (list-style)
 * order endpoint, to see whether the error shape matches or differs.
 */
'use strict';

require('dotenv').config();

const wgcardsService = require('../src/services/wgcards.service');
const db = require('../src/config/database');

async function tryCall(label, endpoint, payload) {
  console.log(`\n--- ${label} (${endpoint}) ---`);
  try {
    // _authedCall is "private" only by convention — reachable directly for
    // this diagnostic since we need to hit arbitrary endpoints.
    const result = await wgcardsService._authedCall(endpoint, payload);
    console.log('SUCCESS:', JSON.stringify(result, null, 2).slice(0, 600));
  } catch (err) {
    console.log('THREW:', err.name, '-', err.message, err.wgcardsCode !== undefined ? `(wgcardsCode=${err.wgcardsCode})` : '');
  }
}

async function run() {
  const cfg = await require('../src/repositories/supplierConfig.repository').getBySupplierName('wgcards');

  await tryCall('Deliberately wrong path (sanity check for route-not-found shape)', '/api/thisRouteDoesNotExist', { userId: cfg.app_id });

  await tryCall('The OTHER order endpoint — getOrderInfo (paginated list, not detail)', '/api/getOrderInfo', { uesrId: cfg.app_id, current: 1, size: 10 });
}

run()
  .then(() => db.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Diagnostic script failed:', err);
    process.exit(1);
  });
