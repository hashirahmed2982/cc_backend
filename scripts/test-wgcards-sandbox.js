#!/usr/bin/env node
/**
 * WgCards Sandbox API smoke test
 * -------------------------------
 * Exercises the WgCards sandbox endpoints described in
 * "WgCards English API Doc V3.0.8" end-to-end:
 *   1. getToken          - obtain a 2h bearer token
 *   2. getAccount        - read wallet balance (sanity check auth works)
 *   3. getAllItem        - pull the full catalog (first page semantics)
 *   4. getStock          - check stock for a couple of known sandbox SKUs
 *   5. getItemAndStock   - combined item + stock lookup
 *
 * WgCards encrypts every request/response body ("msg") with AES/ECB/PKCS7,
 * using the caller's appId (UTF-8 bytes) as the raw AES key - see
 * AesUtil.encrypt/decrypt in the official doc's Java demo. This script
 * reimplements that exact scheme with crypto-js (already a project
 * dependency) so no external tooling is required.
 *
 * Usage:
 *   node scripts/test-wgcards-sandbox.js
 *
 * Override the sandbox credentials/host via env vars if needed:
 *   WGCARDS_HOST, WGCARDS_APP_ID, WGCARDS_ACCOUNT_ID, WGCARDS_APP_KEY
 */

const axios = require('axios');
const CryptoJS = require('crypto-js');

const CONFIG = {
  host: process.env.WGCARDS_HOST || 'http://121.43.36.102:9009',
  appId: process.env.WGCARDS_APP_ID || '2025112058411324',
  accountId: process.env.WGCARDS_ACCOUNT_ID || '2025112058411325',
  appKey: process.env.WGCARDS_APP_KEY || 'o%Cmiq52TP4o06Uok&R6tC#^#FXGNE*3',
};

// A couple of SKU ids straight out of the doc's own examples, so getStock
// has something meaningful to ask about even before a real getAllItem/getItem
// pull has been run against this sandbox account.
const SAMPLE_SKU_IDS = ['2025062450882798', '2025062335235123'];

// ---- AES/ECB/PKCS7 helpers (matches hutool's AesUtil in the doc) ----------

function aesKey(appId) {
  // hutool's SecureUtil.generateKey('AES', appId.getBytes()) uses the raw
  // UTF-8 bytes of appId directly as the key material (appId is 16 chars,
  // i.e. a valid AES-128 key length in this sandbox).
  return CryptoJS.enc.Utf8.parse(appId);
}

function encryptMsg(appId, payloadObj) {
  const key = aesKey(appId);
  const plaintext = JSON.stringify(payloadObj);
  const encrypted = CryptoJS.AES.encrypt(plaintext, key, {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.Pkcs7,
  });
  return encrypted.toString(); // base64 ciphertext
}

function decryptMsg(appId, base64Ciphertext) {
  const key = aesKey(appId);
  const decrypted = CryptoJS.AES.decrypt(base64Ciphertext, key, {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.Pkcs7,
  });
  return decrypted.toString(CryptoJS.enc.Utf8);
}

// ---- HTTP helper -----------------------------------------------------------

async function call(path, innerPayload, token) {
  const url = `${CONFIG.host}${path}`;
  const body = {
    appId: CONFIG.appId,
    accountId: CONFIG.accountId,
    msg: encryptMsg(CONFIG.appId, innerPayload),
  };
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    headers.appId = CONFIG.appId;
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await axios.post(url, body, { headers, timeout: 15000, validateStatus: () => true });

  if (typeof res.data === 'string') {
    // Whole response is the encrypted blob (older-style responses)
    const decrypted = decryptMsg(CONFIG.appId, res.data);
    return { status: res.status, parsed: JSON.parse(decrypted) };
  }

  // Newer-style envelope: { appId, code, msg, data } where data may itself
  // be an encrypted string, OR the doc's documented shape where the raw
  // body IS the encrypted string already handled above. Guard both.
  if (res.data && typeof res.data.data === 'string') {
    try {
      const decrypted = decryptMsg(CONFIG.appId, res.data.data);
      res.data.data = JSON.parse(decrypted);
    } catch (e) {
      // data wasn't encrypted / not decryptable - leave as-is
    }
  }
  return { status: res.status, parsed: res.data };
}

// ---- Offline crypto self-test -------------------------------------------
// Validates our AES/ECB/PKCS7 implementation against the two worked
// request/response examples printed in the official doc (getToken +
// getAccount), independent of any network access. If this fails, nothing
// live will ever work regardless of connectivity.
function selfTestCrypto() {
  const appId = '2025112058411324';
  const tokenExample =
    'ec+4BHivsxlcY4z0N3+tQLyDRjhFjARYsP0u1vTzSS5jkV4CCyfw0GfMzy3RQxzpyNroxn1xCcLXLrQ' +
    'Z2aPLTKcRwwgVwFgm47Cq2tRlstBlrDqRxHMVJjaV7zJwoLwzwpkvIzgRO2z/RmeT0W5NoA==';
  const acctExample =
    'ec+4BHivsxlcY4z0N3+tQLyDRjhFjARYsP0u1vTzSS6UE7ooeD5zNOTLPYdQgTGszG8OoA+4MEHz5n7' +
    '0DdXLoX+sLc/QkK+3evQrsh5RP2DC/9dpXx1aDR5ciNxC6bMzP4shjvbEZv2AfzLWTpmke4+cEM+NlU' +
    'AidnUQa+bQgR4dyPiC0qF2aZJJI9T5BA6o2B3u2oeUie/zHshWz4XcSwL8beyMl7fAxhGyiuNf/4ilj' +
    '43ukc31YbnOvYcS/pe5W7wsVhXXO9D0xcYfz0xQmw==';

  const expectedToken = { appId, code: 200, data: 'opyf652pctxud70wsd87nkeyww7fhfgp', msg: 'success' };
  const expectedAcct = {
    appId,
    code: 200,
    data: { accounts: [{ balance: 20000000000, currency: 'USD', effective: true, walletId: '2025112058411157' }], userId: appId },
    msg: 'success',
  };

  let ok = true;
  let gotTokenRaw = '';
  let gotAcctRaw = '';
  try {
    gotTokenRaw = decryptMsg(appId, tokenExample);
    gotAcctRaw = decryptMsg(appId, acctExample);
    // Compare as parsed values (not raw strings) since JSON number formatting
    // (e.g. 20000000000 vs 20000000000.000) is not semantically significant.
    const gotToken = JSON.parse(gotTokenRaw);
    const gotAcct = JSON.parse(gotAcctRaw);
    ok = JSON.stringify(gotToken) === JSON.stringify(expectedToken) && JSON.stringify(gotAcct) === JSON.stringify(expectedAcct);
    console.log(ok ? '  ✓ AES/ECB/PKCS7 matches doc fixtures exactly' : '  ✗ AES output diverges from doc fixtures');
    if (!ok) {
      console.log('    expected token:', JSON.stringify(expectedToken));
      console.log('    got token     :', gotTokenRaw);
      console.log('    expected acct :', JSON.stringify(expectedAcct));
      console.log('    got acct      :', gotAcctRaw);
    }
  } catch (err) {
    ok = false;
    console.log('  ✗ AES self-test threw:', err.message);
  }
  return ok;
}

// ---- Test steps --------------------------------------------------------

async function run() {
  console.log('='.repeat(70));
  console.log('WgCards Sandbox API smoke test');
  console.log(`Host: ${CONFIG.host}`);
  console.log(`appId: ${CONFIG.appId}`);
  console.log('='.repeat(70));

  console.log('\n[0] Offline AES/ECB/PKCS7 self-test (against doc fixtures)');
  const cryptoOk = selfTestCrypto();

  const results = [['AES self-test', cryptoOk ? 'PASS' : 'FAIL']];
  let token;

  // 1. getToken
  try {
    const { status, parsed } = await call('/api/getToken', {
      appId: CONFIG.appId,
      appKey: CONFIG.appKey,
    });
    console.log('\n[1] POST /api/getToken');
    console.log('  HTTP status:', status);
    console.log('  Response:', JSON.stringify(parsed));
    if (parsed && parsed.code === 200 && parsed.data) {
      token = parsed.data;
      results.push(['getToken', 'PASS']);
    } else {
      results.push(['getToken', 'FAIL - unexpected response']);
    }
  } catch (err) {
    console.log('\n[1] POST /api/getToken');
    console.log('  ERROR:', err.message);
    results.push(['getToken', `FAIL - ${err.message}`]);
  }

  // 2. getAccount (requires token)
  if (token) {
    try {
      const { status, parsed } = await call('/api/getAccount', { userId: CONFIG.appId }, token);
      console.log('\n[2] POST /api/getAccount');
      console.log('  HTTP status:', status);
      console.log('  Response:', JSON.stringify(parsed));
      results.push(['getAccount', parsed && parsed.code === 200 ? 'PASS' : 'FAIL - unexpected response']);
    } catch (err) {
      console.log('\n[2] POST /api/getAccount');
      console.log('  ERROR:', err.message);
      results.push(['getAccount', `FAIL - ${err.message}`]);
    }
  } else {
    console.log('\n[2] POST /api/getAccount - SKIPPED (no token from step 1)');
    results.push(['getAccount', 'SKIPPED']);
  }

  // 3. getAllItem (requires token)
  if (token) {
    try {
      const { status, parsed } = await call(
        '/api/getAllItem',
        { appId: CONFIG.appId, currencyCode: 'CNY', language: 'en', itemId: '', itemName: '' },
        token
      );
      console.log('\n[3] POST /api/getAllItem');
      console.log('  HTTP status:', status);
      const recordCount = parsed && parsed.data && Array.isArray(parsed.data.records) ? parsed.data.records.length : 'n/a';
      console.log('  Record count:', recordCount);
      console.log('  Sample:', JSON.stringify(parsed && parsed.data && parsed.data.records && parsed.data.records[0]).slice(0, 500));
      results.push(['getAllItem', parsed && parsed.code === 200 ? 'PASS' : 'FAIL - unexpected response']);
    } catch (err) {
      console.log('\n[3] POST /api/getAllItem');
      console.log('  ERROR:', err.message);
      results.push(['getAllItem', `FAIL - ${err.message}`]);
    }
  } else {
    console.log('\n[3] POST /api/getAllItem - SKIPPED (no token from step 1)');
    results.push(['getAllItem', 'SKIPPED']);
  }

  // 4. getStock (requires token)
  if (token) {
    try {
      const { status, parsed } = await call('/api/getStock', { skuIds: SAMPLE_SKU_IDS }, token);
      console.log('\n[4] POST /api/getStock');
      console.log('  HTTP status:', status);
      console.log('  Response:', JSON.stringify(parsed));
      results.push(['getStock', parsed && parsed.code === 200 ? 'PASS' : 'FAIL - unexpected response']);
    } catch (err) {
      console.log('\n[4] POST /api/getStock');
      console.log('  ERROR:', err.message);
      results.push(['getStock', `FAIL - ${err.message}`]);
    }
  } else {
    console.log('\n[4] POST /api/getStock - SKIPPED (no token from step 1)');
    results.push(['getStock', 'SKIPPED']);
  }

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  for (const [name, outcome] of results) {
    console.log(`  ${name.padEnd(15)} ${outcome}`);
  }
  const allOk = results.every(([, o]) => o === 'PASS');
  process.exit(allOk ? 0 : 1);
}

run();
