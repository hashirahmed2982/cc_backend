// utils/wgcardsCrypto.js
// WgCards wire-protocol encryption — v4.
//
// V3 (superseded): AES key = raw UTF-8 bytes of the caller's appId. V4
// replaces this entirely with a domain-separated key derivation from a
// dedicated secret (bodyKeyMaterial) WgCards assigns alongside appId/secret
// — the appId is no longer part of the encryption key at all. Per the v4
// doc's "Body Encryption Rules" and Java/Python crypto examples:
//
//   bodyKey = SHA-256("wgcards-api-v4-body-key" || 0x00 || bodyKeyMaterial)[:16]
//   ciphertext = AES/ECB/PKCS7(bodyKey, utf8(plaintextJson))
//
// Still AES/ECB/PKCS7 like v3 — only the key derivation changed. Business
// endpoint request bodies are fixed as {"msg":"Base64Ciphertext"}; a
// successful business response is the raw base64 ciphertext itself
// (Content-Type: text/plain), decrypted directly into {code,msg,data}.
// Error responses are NEVER encrypted (plaintext JSON, real HTTP status) —
// callers must not run decryptMsg on those at all. See wgcards.service.js
// for where that branch happens.
//
// This is NOT the same as utils/dataCrypto.js (our own DB-at-rest AES-256-CBC
// encryption) — do not mix the two up. This one only ever touches the `msg`
// field of a WgCards v4 business request/response body.
'use strict';

const crypto = require('crypto');
const CryptoJS = require('crypto-js');

const DOMAIN = 'wgcards-api-v4-body-key';

/** SHA-256("wgcards-api-v4-body-key" || 0x00 || bodyKeyMaterial), first 16 bytes. */
function deriveBodyKey(bodyKeyMaterial) {
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from(DOMAIN, 'utf8'));
  hash.update(Buffer.from([0x00]));
  hash.update(Buffer.from(String(bodyKeyMaterial), 'utf8'));
  return hash.digest().subarray(0, 16);
}

function keyWordArray(bodyKeyMaterial) {
  // crypto-js wants a WordArray, not a raw Buffer — hex round-trip is the
  // simplest reliable conversion.
  return CryptoJS.enc.Hex.parse(deriveBodyKey(bodyKeyMaterial).toString('hex'));
}

/**
 * Encrypt a plain object into WgCards v4's base64 `msg` field.
 * @param {string} bodyKeyMaterial
 * @param {object} payloadObj
 * @returns {string} base64 ciphertext
 */
function encryptMsg(bodyKeyMaterial, payloadObj) {
  const key = keyWordArray(bodyKeyMaterial);
  const plaintext = JSON.stringify(payloadObj);
  const encrypted = CryptoJS.AES.encrypt(plaintext, key, {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.Pkcs7,
  });
  return encrypted.toString();
}

/**
 * Decrypt a WgCards v4 base64 ciphertext (a successful business response
 * body, raw text/plain) back to its plaintext JSON string. Caller is
 * responsible for JSON.parse-ing the result. Do NOT call this on an error
 * response — those are plaintext JSON already, never encrypted.
 * @param {string} bodyKeyMaterial
 * @param {string} base64Ciphertext
 * @returns {string} decrypted plaintext (JSON string)
 */
function decryptMsg(bodyKeyMaterial, base64Ciphertext) {
  const key = keyWordArray(bodyKeyMaterial);
  const decrypted = CryptoJS.AES.decrypt(base64Ciphertext, key, {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.Pkcs7,
  });
  return decrypted.toString(CryptoJS.enc.Utf8);
}

module.exports = { encryptMsg, decryptMsg, deriveBodyKey };
