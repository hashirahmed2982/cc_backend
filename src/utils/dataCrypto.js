// utils/dataCrypto.js
// AES-256-CBC at-rest encryption for sensitive DB columns (random IV per call).
// Extracted from services/product.service.js (used there for digital_codes.code)
// so other services — supplier credentials, API logs — can reuse the same
// scheme instead of re-implementing it. This is NOT the WgCards wire-protocol
// encryption (see utils/wgcardsCrypto.js for that) — this one is purely for
// what we store in our own database.
'use strict';

const crypto = require('crypto');

const RAW_KEY = process.env.ENCRYPTION_KEY || 'default-32-byte-key-change-this!!';
const ENCRYPTION_KEY = Buffer.from(RAW_KEY.padEnd(32, '0').slice(0, 32));
const IV_LENGTH = 16;

function encrypt(text) {
  if (text === null || text === undefined) return text;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(text)), cipher.final()]);
  return iv.toString('hex') + ':' + enc.toString('hex');
}

function decrypt(text) {
  if (text === null || text === undefined) return text;
  try {
    const [ivHex, encHex] = String(text).split(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, Buffer.from(ivHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString();
  } catch {
    return text;
  }
}

function hashCode(code) {
  // Deterministic hash — same plaintext always gives same hash (used for dedup lookups)
  return crypto.createHmac('sha256', process.env.ENCRYPTION_KEY || RAW_KEY)
    .update(String(code).trim().toLowerCase())
    .digest('hex');
}

module.exports = { encrypt, decrypt, hashCode };
