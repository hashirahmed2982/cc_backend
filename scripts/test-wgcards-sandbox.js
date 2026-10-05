#!/usr/bin/env node
/**
 * WgCards v4 API smoke test
 * -------------------------
 * Exercises the WgCards v4 endpoints described in "WGCards API v4" (doc
 * dated 2026-09-04) end-to-end:
 *   1. POST /api/v4/token         - plaintext, obtain a Bearer access token
 *   2. GET  getAccount            - read wallet balance (sanity check auth works)
 *   3. getAllItem                 - pull the full catalog (no pagination)
 *   4. getItemAndStock            - combined item + price + stock lookup
 *                                    (v4 merged v3's separate getItem/
 *                                    getStock/getItemAndStock into this one
 *                                    endpoint — see wgcards.service.js's
 *                                    header comment for the full list of
 *                                    v3-vs-v4 differences)
 *
 * UNLIKE the v3 version of this script, v4's doc publishes NO fixed public
 * sandbox credentials or worked ciphertext examples to self-test against
 * offline — WGCARDS_APP_ID/WGCARDS_SECRET/WGCARDS_BODY_KEY_MATERIAL below
 * are all REQUIRED, no fallback. The offline self-test (step 0) therefore
 * only proves our own encrypt/decrypt round-trips consistently — it
 * CANNOT confirm the key-derivation algorithm matches WgCards' real
 * server the way v3's fixture-comparison could, since no such fixture
 * exists in the v4 doc. Steps 1+ are the real confirmation.
 *
 * v4 encrypts request/response bodies ("msg") with AES/ECB/PKCS7, using a
 * key derived as SHA-256("wgcards-api-v4-body-key" || 0x00 ||
 * bodyKeyMaterial)[:16] — NOT the caller's appId the way v3 did. This
 * script reimplements that exact scheme with crypto-js + node:crypto
 * (both already project dependencies) so no external tooling is required.
 *
 * Usage:
 *   node scripts/test-wgcards-sandbox.js
 *
 * Required env vars (request a v4 test set from WgCards first — there is
 * no public default):
 *   WGCARDS_HOST, WGCARDS_APP_ID, WGCARDS_SECRET, WGCARDS_BODY_KEY_MATERIAL
 */

const axios = require('axios');
const crypto = require('crypto');
const CryptoJS = require('crypto-js');

const CONFIG = {
  host: process.env.WGCARDS_HOST || 'http://120.26.99.152:9071/wgcards-api',
  appId: process.env.WGCARDS_APP_ID,
  secret: process.env.WGCARDS_SECRET,
  bodyKeyMaterial: process.env.WGCARDS_BODY_KEY_MATERIAL,
};

if (!CONFIG.appId || !CONFIG.secret || !CONFIG.bodyKeyMaterial) {
  console.error(
    '❌ WGCARDS_APP_ID, WGCARDS_SECRET, and WGCARDS_BODY_KEY_MATERIAL must all be set in .env.\n' +
    '   v4 publishes no fixed sandbox credentials (unlike v3) — request a v4 test set from WgCards first.'
  );
  process.exit(1);
}

// ---- AES/ECB/PKCS7 helpers (matches wgcards.service.js / wgcardsCrypto.js) -

const DOMAIN = 'wgcards-api-v4-body-key';

function deriveBodyKey(bodyKeyMaterial) {
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from(DOMAIN, 'utf8'));
  hash.update(Buffer.from([0x00]));
  hash.update(Buffer.from(String(bodyKeyMaterial), 'utf8'));
  return hash.digest().subarray(0, 16);
}

function keyWordArray(bodyKeyMaterial) {
  return CryptoJS.enc.Hex.parse(deriveBodyKey(bodyKeyMaterial).toString('hex'));
}

function encryptMsg(bodyKeyMaterial, payloadObj) {
  const key = keyWordArray(bodyKeyMaterial);
  const plaintext = JSON.stringify(payloadObj);
  const encrypted = CryptoJS.AES.encrypt(plaintext, key, { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 });
  return encrypted.toString();
}

function decryptMsg(bodyKeyMaterial, base64Ciphertext) {
  const key = keyWordArray(bodyKeyMaterial);
  const decrypted = CryptoJS.AES.decrypt(base64Ciphertext, key, { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 });
  return decrypted.toString(CryptoJS.enc.Utf8);
}

// ---- HTTP helpers -----------------------------------------------------------

/** POST /api/v4/token — plaintext, no body encryption, no Bearer header. */
async function fetchToken() {
  const url = `${CONFIG.host}/api/v4/token`;
  const res = await axios.post(url, { appId: CONFIG.appId, secret: CONFIG.secret }, {
    headers: { 'Content-Type': 'application/json' }, timeout: 15000, validateStatus: () => true,
  });
  return { status: res.status, body: res.data };
}

/** Every other v4 endpoint: Bearer header + encrypted {msg}. Success is raw
 * base64 ciphertext (text/plain); any error status is plaintext JSON. */
async function call(path, innerPayload, token) {
  const url = `${CONFIG.host}${path}`;
  const body = { msg: encryptMsg(CONFIG.bodyKeyMaterial, innerPayload) };
  const res = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    timeout: 15000, validateStatus: () => true,
  });

  if (res.status !== 200) {
    return { status: res.status, parsed: res.data }; // plaintext error JSON, never decrypted
  }
  try {
    const decrypted = decryptMsg(CONFIG.bodyKeyMaterial, res.data);
    return { status: res.status, parsed: JSON.parse(decrypted) };
  } catch (err) {
    return { status: res.status, parsed: null, decryptError: err.message };
  }
}

// ---- Offline crypto self-test -------------------------------------------
// Round-trips a known plaintext through our own encrypt/decrypt. This only
// proves internal consistency — see the file header for why v4 has no
// fixed fixture to compare against the way v3's self-test did.
function selfTestCrypto() {
  const material = CONFIG.bodyKeyMaterial;
  const payload = { currency: 'USD', page: 1, size: 20 };
  try {
    const ciphertext = encryptMsg(material, payload);
    const roundTripped = JSON.parse(decryptMsg(material, ciphertext));
    const ok = JSON.stringify(roundTripped) === JSON.stringify(payload);
    console.log(ok ? '  ✓ AES/ECB/PKCS7 encrypt->decrypt round-trips correctly' : '  ✗ round-trip produced a different object than was encrypted');
    if (!ok) {
      console.log('    sent    :', JSON.stringify(payload));
      console.log('    got back:', JSON.stringify(roundTripped));
    }
    return ok;
  } catch (err) {
    console.log('  ✗ self-test threw:', err.message);
    return false;
  }
}

// ---- Test steps --------------------------------------------------------

async function run() {
  console.log('='.repeat(70));
  console.log('WgCards v4 API smoke test');
  console.log(`Host: ${CONFIG.host}`);
  console.log(`appId: ${CONFIG.appId}`);
  console.log('='.repeat(70));

  console.log('\n[0] Offline AES/ECB/PKCS7 round-trip self-test');
  const cryptoOk = selfTestCrypto();
  const results = [['crypto self-test', cryptoOk ? 'PASS' : 'FAIL']];
  let token;

  // 1. /api/v4/token — plaintext
  try {
    const { status, body } = await fetchToken();
    console.log('\n[1] POST /api/v4/token');
    console.log('  HTTP status:', status);
    console.log('  Response:', JSON.stringify(body));
    if (status === 200 && body?.code === 200 && body?.data?.accessToken) {
      token = body.data.accessToken;
      results.push(['token', 'PASS']);
    } else {
      results.push(['token', 'FAIL - unexpected response']);
    }
  } catch (err) {
    console.log('\n[1] POST /api/v4/token');
    console.log('  ERROR:', err.message);
    results.push(['token', `FAIL - ${err.message}`]);
  }

  // 2. getAccount
  if (token) {
    try {
      const { status, parsed, decryptError } = await call('/api/v4/getAccount', {}, token);
      console.log('\n[2] POST /api/v4/getAccount');
      console.log('  HTTP status:', status);
      console.log('  Response:', decryptError ? `(decrypt failed: ${decryptError})` : JSON.stringify(parsed));
      results.push(['getAccount', status === 200 && parsed?.code === 200 ? 'PASS' : 'FAIL - unexpected response']);
    } catch (err) {
      console.log('\n[2] POST /api/v4/getAccount');
      console.log('  ERROR:', err.message);
      results.push(['getAccount', `FAIL - ${err.message}`]);
    }
  } else {
    console.log('\n[2] POST /api/v4/getAccount - SKIPPED (no token from step 1)');
    results.push(['getAccount', 'SKIPPED']);
  }

  // 3. getAllItem — no body fields, no pagination
  if (token) {
    try {
      const { status, parsed, decryptError } = await call('/api/v4/getAllItem', {}, token);
      console.log('\n[3] POST /api/v4/getAllItem');
      console.log('  HTTP status:', status);
      if (decryptError) {
        console.log('  decrypt failed:', decryptError);
      } else {
        const records = parsed?.data?.records;
        console.log('  Record count:', Array.isArray(records) ? records.length : 'n/a (see raw response below)');
        if (Array.isArray(records) && records.length) {
          console.log('  Sample record:', JSON.stringify(records[0], null, 2).slice(0, 1500));
        } else {
          console.log('  Raw parsed response:', JSON.stringify(parsed, null, 2).slice(0, 3000));
        }
      }
      results.push(['getAllItem', status === 200 && parsed?.code === 200 ? 'PASS' : 'FAIL - unexpected response']);
    } catch (err) {
      console.log('\n[3] POST /api/v4/getAllItem');
      console.log('  ERROR:', err.message);
      results.push(['getAllItem', `FAIL - ${err.message}`]);
    }
  } else {
    console.log('\n[3] POST /api/v4/getAllItem - SKIPPED (no token from step 1)');
    results.push(['getAllItem', 'SKIPPED']);
  }

  // 4. getItemAndStock — v4's merged pricing+stock endpoint. No known-good
  //    spuId yet on a fresh v4 account, so this runs unfiltered (page 1)
  //    to see whatever the account can see, rather than guessing an id.
  if (token) {
    try {
      const { status, parsed, decryptError } = await call('/api/v4/getItemAndStock', { currency: 'USD', page: 1, size: 10 }, token);
      console.log('\n[4] POST /api/v4/getItemAndStock');
      console.log('  HTTP status:', status);
      if (decryptError) {
        console.log('  decrypt failed:', decryptError);
      } else {
        console.log('  Raw parsed response:', JSON.stringify(parsed, null, 2).slice(0, 3000));
        const skuInfos = parsed?.data?.records?.[0]?.skuInfos;
        const hasStock = Array.isArray(skuInfos) && skuInfos.some((s) => s.stock !== undefined);
        console.log('  Any SKU has a stock field?', hasStock);
      }
      results.push(['getItemAndStock', status === 200 && parsed?.code === 200 ? 'PASS' : 'FAIL - unexpected response']);
    } catch (err) {
      console.log('\n[4] POST /api/v4/getItemAndStock');
      console.log('  ERROR:', err.message);
      results.push(['getItemAndStock', `FAIL - ${err.message}`]);
    }
  } else {
    console.log('\n[4] POST /api/v4/getItemAndStock - SKIPPED (no token from step 1)');
    results.push(['getItemAndStock', 'SKIPPED']);
  }

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  for (const [name, outcome] of results) {
    console.log(`  ${name.padEnd(18)} ${outcome}`);
  }
  const allOk = results.every(([, o]) => o === 'PASS');
  process.exit(allOk ? 0 : 1);
}

run();
