'use strict';

const crypto = require('crypto');
const { encryptMsg, decryptMsg, deriveBodyKey } = require('../wgcardsCrypto');

describe('wgcardsCrypto (v4 — SHA-256 domain-separated key derivation)', () => {
  test('deriveBodyKey matches an independently computed SHA-256("wgcards-api-v4-body-key" || 0x00 || material)[:16]', () => {
    const material = 'some-body-key-material';
    const expected = crypto
      .createHash('sha256')
      .update(Buffer.concat([Buffer.from('wgcards-api-v4-body-key', 'utf8'), Buffer.from([0x00]), Buffer.from(material, 'utf8')]))
      .digest()
      .subarray(0, 16);

    expect(deriveBodyKey(material)).toEqual(expected);
    expect(deriveBodyKey(material)).toHaveLength(16); // AES-128 key size
  });

  test('a different bodyKeyMaterial derives a completely different key', () => {
    expect(deriveBodyKey('material-a')).not.toEqual(deriveBodyKey('material-b'));
  });

  test('encrypt -> decrypt round-trips a plain object exactly', () => {
    const material = 'replace-with-body-key-material';
    const payload = { currency: 'USD', page: 1, size: 20 };

    const ciphertext = encryptMsg(material, payload);
    expect(typeof ciphertext).toBe('string');
    expect(ciphertext).not.toContain('{'); // base64 output, not plaintext leaking through

    const decrypted = JSON.parse(decryptMsg(material, ciphertext));
    expect(decrypted).toEqual(payload);
  });

  test('decrypting with the WRONG bodyKeyMaterial does not silently return the right plaintext', () => {
    const ciphertext = encryptMsg('correct-material', { secret: 'value' });
    let result;
    try {
      result = decryptMsg('wrong-material', ciphertext);
    } catch {
      result = null; // a thrown padding error is an equally acceptable outcome
    }
    expect(result).not.toBe(JSON.stringify({ secret: 'value' }));
  });
});
