// utils/wgcardsCrypto.js
// WgCards wire-protocol encryption — AES/ECB/PKCS7, where the AES key is the
// raw UTF-8 bytes of the caller's appId (16 chars in the sandbox = AES-128).
// This matches WgCards' own Java "AesUtil" demo (hutool AES, ECB, PKCS7,
// encryptBase64) documented in WgCards_English_API_Doc_V3_0_8.
//
// Verified against the doc's own worked examples (getToken + getAccount
// sample responses decrypt to byte-for-byte matches — see
// scripts/test-wgcards-sandbox.js's offline self-test).
//
// This is NOT the same as utils/dataCrypto.js (our own DB-at-rest AES-256-CBC
// encryption) — do not mix the two up. This one only ever touches the `msg`
// field of a WgCards request/response body.
'use strict';

const CryptoJS = require('crypto-js');

function aesKey(appId) {
  return CryptoJS.enc.Utf8.parse(appId);
}

/**
 * Encrypt a plain object into WgCards' base64 `msg` field.
 * @param {string} appId
 * @param {object} payloadObj
 * @returns {string} base64 ciphertext
 */
function encryptMsg(appId, payloadObj) {
  const key = aesKey(appId);
  const plaintext = JSON.stringify(payloadObj);
  const encrypted = CryptoJS.AES.encrypt(plaintext, key, {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.Pkcs7,
  });
  return encrypted.toString();
}

/**
 * Decrypt a WgCards base64 ciphertext back to its plaintext JSON string.
 * Caller is responsible for JSON.parse-ing the result.
 * @param {string} appId
 * @param {string} base64Ciphertext
 * @returns {string} decrypted plaintext (JSON string)
 */
function decryptMsg(appId, base64Ciphertext) {
  const key = aesKey(appId);
  const decrypted = CryptoJS.AES.decrypt(base64Ciphertext, key, {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.Pkcs7,
  });
  return decrypted.toString(CryptoJS.enc.Utf8);
}

module.exports = { encryptMsg, decryptMsg };
