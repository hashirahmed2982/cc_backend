'use strict';

// Mocks must be declared before requiring the module under test.
jest.mock('axios');
jest.mock('../../repositories/supplierConfig.repository');
jest.mock('../supplierApiLog.service', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const axios = require('axios');
const supplierConfigRepo = require('../../repositories/supplierConfig.repository');
const { encryptMsg, decryptMsg } = require('../../utils/wgcardsCrypto');
const wgcardsService = require('../wgcards.service');

// v4 credential mapping (see wgcards.service.js's _config() comment):
//   app_id -> appId, account_id -> bodyKeyMaterial, app_key -> secret
const BODY_KEY_MATERIAL = 'test-body-key-material';
const BASE_CFG = {
  app_id: 'testAppId',
  account_id: BODY_KEY_MATERIAL,
  app_key: 'test-secret',
  api_base_url: 'http://sandbox.example/wgcards-api',
  token: null,
  token_expires: null,
};
const CACHED_CFG = { ...BASE_CFG, token: 'cached-token', token_expires: new Date(Date.now() + 100 * 60 * 1000) };

/** A successful v4 business response: raw base64 ciphertext, decrypts to {code:200,msg,data}. */
function encryptedAxiosResponse(status, dataObj) {
  return { status, data: encryptMsg(BODY_KEY_MATERIAL, { code: 200, msg: 'success', data: dataObj }) };
}

/** A v4 error response: plaintext JSON, never encrypted. */
function errorAxiosResponse(status, code, message) {
  return { status, data: { code, message, timestamp: Date.now() } };
}

/** Decrypt what we actually sent on a given axios.post call, for asserting request shape. */
function sentPayloadFor(callIndex) {
  const sentBody = axios.post.mock.calls[callIndex][1];
  return JSON.parse(decryptMsg(BODY_KEY_MATERIAL, sentBody.msg));
}

describe('WgCardsService (v4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('token issuance', () => {
    test('fetches and caches a new token when none is cached — plaintext token call, encrypted business call', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...BASE_CFG });
      axios.post.mockResolvedValueOnce({ status: 200, data: { code: 200, msg: 'success', data: { accessToken: 'fresh-token-abc', tokenType: 'Bearer', expiresIn: 7200 } } });
      axios.post.mockResolvedValueOnce(encryptedAxiosResponse(200, { accounts: [{ balance: '100.00', currency: 'USD', effective: true, walletId: 'w1' }] }));

      const result = await wgcardsService.getAccount();

      expect(axios.post).toHaveBeenCalledTimes(2);
      expect(axios.post.mock.calls[0][0]).toContain('/api/v4/token');
      expect(axios.post.mock.calls[0][1]).toEqual({ appId: 'testAppId', secret: 'test-secret' }); // plaintext, no msg field
      expect(axios.post.mock.calls[1][0]).toContain('/api/v4/getAccount');
      expect(axios.post.mock.calls[1][2].headers.Authorization).toBe('Bearer fresh-token-abc');
      expect(result.accounts[0].balance).toBe(100); // parsed back to a number, matching v3's shape
      expect(supplierConfigRepo.saveToken).toHaveBeenCalledWith('wgcards', 'fresh-token-abc', expect.any(Date));
      expect(supplierConfigRepo.recordSuccess).toHaveBeenCalled();
    });

    test('reuses a cached token that is not close to expiring', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...CACHED_CFG });
      axios.post.mockResolvedValueOnce(encryptedAxiosResponse(200, { accounts: [] }));

      await wgcardsService.getAccount();

      expect(axios.post).toHaveBeenCalledTimes(1); // no token call
      expect(axios.post.mock.calls[0][2].headers.Authorization).toBe('Bearer cached-token');
    });

    test('refreshes a token within the 10-minute expiry margin', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({
        ...BASE_CFG, token: 'stale-token', token_expires: new Date(Date.now() + 5 * 60 * 1000),
      });
      axios.post.mockResolvedValueOnce({ status: 200, data: { code: 200, msg: 'success', data: { accessToken: 'renewed-token', expiresIn: 7200 } } });
      axios.post.mockResolvedValueOnce(encryptedAxiosResponse(200, { accounts: [] }));

      await wgcardsService.getAccount();

      expect(axios.post).toHaveBeenCalledTimes(2);
      expect(axios.post.mock.calls[1][2].headers.Authorization).toBe('Bearer renewed-token');
    });
  });

  describe('error handling', () => {
    test('on 401: forces one token refresh and retries the call once, then succeeds', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...CACHED_CFG });
      axios.post
        .mockResolvedValueOnce(errorAxiosResponse(401, 'api.token.expired', 'Token has expired'))
        .mockResolvedValueOnce({ status: 200, data: { code: 200, msg: 'success', data: { accessToken: 'new-token', expiresIn: 7200 } } })
        .mockResolvedValueOnce(encryptedAxiosResponse(200, { accounts: [] }));

      const result = await wgcardsService.getAccount();

      expect(axios.post).toHaveBeenCalledTimes(3);
      expect(supplierConfigRepo.clearToken).toHaveBeenCalledWith('wgcards');
      expect(axios.post.mock.calls[2][2].headers.Authorization).toBe('Bearer new-token');
      expect(result).toEqual({ accounts: [] });
    });

    test('on 401 again after the forced refresh: bubbles up supplier_auth_failure, does not retry a third time', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...CACHED_CFG });
      axios.post
        .mockResolvedValueOnce(errorAxiosResponse(401, 'api.token.expired', 'Token has expired'))
        .mockResolvedValueOnce({ status: 200, data: { code: 200, msg: 'success', data: { accessToken: 'new-token', expiresIn: 7200 } } })
        .mockResolvedValueOnce(errorAxiosResponse(401, 'api.token.invalid', 'Token is invalid'));

      await expect(wgcardsService.getAccount()).rejects.toMatchObject({ code: 'supplier_auth_failure' });
      expect(axios.post).toHaveBeenCalledTimes(3);
      expect(supplierConfigRepo.recordFailure).toHaveBeenCalledWith('wgcards');
    });

    test('403 is treated as an auth failure WITHOUT the retry-once dance (likely an edge/IP-allowlist block, not a bad token)', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...CACHED_CFG });
      axios.post.mockResolvedValueOnce(errorAxiosResponse(403, undefined, 'Forbidden'));

      await expect(wgcardsService.getAccount()).rejects.toMatchObject({ code: 'supplier_auth_failure' });
      expect(axios.post).toHaveBeenCalledTimes(1); // no forced-refresh retry for 403
      expect(supplierConfigRepo.recordFailure).toHaveBeenCalledWith('wgcards');
    });

    test('429 surfaces as supplier_rate_limited, does not trip the circuit breaker', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...CACHED_CFG });
      axios.post.mockResolvedValueOnce(errorAxiosResponse(429, 'api.rate_limited', 'Too many requests'));

      await expect(wgcardsService.getAccount()).rejects.toMatchObject({ code: 'supplier_rate_limited' });
      expect(supplierConfigRepo.recordFailure).not.toHaveBeenCalled();
    });

    test('a 500/503 DOES trip the circuit breaker', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...CACHED_CFG });
      axios.post.mockResolvedValueOnce(errorAxiosResponse(503, 'api.dependency.unavailable', 'Dependency is unavailable'));

      await expect(wgcardsService.getAccount()).rejects.toThrow(/HTTP 503/);
      expect(supplierConfigRepo.recordFailure).toHaveBeenCalledWith('wgcards');
    });

    test('a 400 business/validation rejection throws SupplierBusinessError directly from the plaintext error body — never decrypted, never trips the circuit breaker', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...CACHED_CFG });
      axios.post.mockResolvedValueOnce(errorAxiosResponse(400, 'order.insufficient_balance', 'Wallet balance is insufficient'));

      await expect(wgcardsService.getAccount()).rejects.toMatchObject({
        code: 'supplier_business_rejection', wgcardsCode: 'order.insufficient_balance', message: 'Wallet balance is insufficient',
      });
      expect(supplierConfigRepo.recordFailure).not.toHaveBeenCalled();
    });

    test('a 200 that fails to decrypt is a genuine integration-health failure', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...CACHED_CFG });
      axios.post.mockResolvedValueOnce({ status: 200, data: 'not-valid-base64-ciphertext!!!' });

      await expect(wgcardsService.getAccount()).rejects.toThrow(/could not decrypt/);
      expect(supplierConfigRepo.recordFailure).toHaveBeenCalledWith('wgcards');
    });
  });

  describe('getStock', () => {
    test('rejects an empty/missing skuIds array without making a network call', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...BASE_CFG });
      await expect(wgcardsService.getStock([])).rejects.toThrow(/non-empty array/);
      await expect(wgcardsService.getStock()).rejects.toThrow(/non-empty array/);
      expect(axios.post).not.toHaveBeenCalled();
    });

    test('KNOWN GAP: v4 has no batch endpoint — fans out one getItemAndStock call per skuId, preserving the old batch-array contract', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...CACHED_CFG });
      axios.post
        .mockResolvedValueOnce(encryptedAxiosResponse(200, { records: [{ spuCode: 'item-1', skuInfos: [{ skuId: 'sku-a', stock: 5 }] }] }))
        .mockResolvedValueOnce(encryptedAxiosResponse(200, { records: [{ spuCode: 'item-1', skuInfos: [{ skuId: 'sku-b', stock: -1 }] }] }));

      const result = await wgcardsService.getStock(['sku-a', 'sku-b']);

      expect(axios.post).toHaveBeenCalledTimes(2); // one call per skuId, not a single batched call
      expect(sentPayloadFor(0)).toMatchObject({ skuId: 'sku-a', size: 1 });
      expect(sentPayloadFor(1)).toMatchObject({ skuId: 'sku-b', size: 1 });
      expect(result).toEqual([
        { itemId: 'item-1', skuId: 'sku-a', number: 5 },
        { itemId: 'item-1', skuId: 'sku-b', number: -1 },
      ]);
    });

    test('a per-item lookup failure is omitted from the batch result rather than aborting the whole call', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...CACHED_CFG });
      axios.post
        .mockResolvedValueOnce(errorAxiosResponse(400, 'catalog.sku_code.invalid', 'SKU code is invalid'))
        .mockResolvedValueOnce(encryptedAxiosResponse(200, { records: [{ spuCode: 'item-1', skuInfos: [{ skuId: 'sku-b', stock: 3 }] }] }));

      const result = await wgcardsService.getStock(['bad-sku', 'sku-b']);

      expect(result).toEqual([{ itemId: 'item-1', skuId: 'sku-b', number: 3 }]);
    });
  });

  describe('getItem — translated from v4\'s merged getItemAndStock endpoint', () => {
    test('maps v4 field names back onto v3\'s shape, including the two real gaps (brand, howExchange) as null', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...CACHED_CFG });
      axios.post.mockResolvedValueOnce(encryptedAxiosResponse(200, {
        total: 1, page: 1, pages: 1, size: 20,
        records: [{
          spuCode: 'SPU001', spuName: 'Steam Wallet', currency: 'USD', spuImage: 'https://example.com/x.png',
          productType: { name: 'Gift Cards' },
          skuInfos: [{ skuId: 'SKU001', skuName: 'Steam $10', skuPrice: 10, skuPriceCurrency: 'USD', minFaceValue: null, maxFaceValue: null, minPrice: null, maxPrice: null }],
        }],
      }));

      const result = await wgcardsService.getItem({ itemId: '', current: 1, size: 20 });

      expect(sentPayloadFor(0)).toMatchObject({ currency: 'USD', page: 1, size: 20 });
      expect(result.records[0]).toMatchObject({
        itemId: 'SPU001', itemName: 'Steam Wallet', itemBrandName: null, howExchange: null,
        currencyCode: 'USD', spuType: 2, // 'Gift Cards' -> v3's numeric 2
      });
      expect(result.records[0].skus[0]).toMatchObject({ skuId: 'SKU001', skuName: 'Steam $10', skuPrice: 10, skuPriceCurrency: 'USD' });
    });

    test('an unrecognized productType.name maps to spuType: null rather than a guessed number', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...CACHED_CFG });
      axios.post.mockResolvedValueOnce(encryptedAxiosResponse(200, {
        records: [{ spuCode: 'SPU002', spuName: 'Mystery Item', productType: { name: 'WwgSelected' }, skuInfos: [] }],
      }));

      const result = await wgcardsService.getItem({});

      expect(result.records[0].spuType).toBeNull();
    });
  });

  describe('placeOrder', () => {
    test('success: flat v4 response, no double-nesting', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...CACHED_CFG });
      axios.post.mockResolvedValueOnce(encryptedAxiosResponse(200, {
        orderId: '2607204320107008', outOrderNo: 'svc-1', orderStatus: 0, payStatus: 1, deliveryStatus: 1, totalAmount: 20, currency: 'USD',
      }));

      const result = await wgcardsService.placeOrder({ skuId: 'sku-1', buyNum: 2, currency: 'USD', serviceOrder: 'svc-1' });

      expect(result).toEqual({ wgcardsOrderId: '2607204320107008', message: 'placed' });
      const sent = sentPayloadFor(0);
      expect(sent).toEqual({ outOrderNo: 'svc-1', currency: 'USD', items: [{ skuId: 'sku-1', buyNum: 2 }] });
    });

    test('faceValue is included for custom-value SKUs', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...CACHED_CFG });
      axios.post.mockResolvedValueOnce(encryptedAxiosResponse(200, { orderId: 'order-id' }));

      await wgcardsService.placeOrder({ skuId: 'sku-2', buyNum: 1, faceValue: 25.5, serviceOrder: 'svc-3' });

      expect(sentPayloadFor(0).items).toEqual([{ skuId: 'sku-2', faceValue: 25.5, buyNum: 1 }]);
    });

    test('a business rejection now arrives as a plaintext HTTP 400 (not a 200-wrapped nested code) — still SupplierBusinessError', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...CACHED_CFG });
      axios.post.mockResolvedValueOnce(errorAxiosResponse(400, 'order.insufficient_inventory', 'Inventory is insufficient'));

      await expect(
        wgcardsService.placeOrder({ skuId: 'sku-1', buyNum: 1, serviceOrder: 'svc-2' })
      ).rejects.toMatchObject({ code: 'supplier_business_rejection', wgcardsCode: 'order.insufficient_inventory', message: 'Inventory is insufficient' });
      expect(supplierConfigRepo.recordFailure).not.toHaveBeenCalled();
    });
  });

  describe('placeDirectOrder', () => {
    const attributeValues = [{ name: 'player ID', value: '1234', label: 'Player ID' }];

    test('success: flat response, outOrderNo replaces serviceOrder, quantity defaults to 1', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...CACHED_CFG });
      axios.post.mockResolvedValueOnce(encryptedAxiosResponse(200, { orderId: '2607204320107008', topupStatus: 1 }));

      const result = await wgcardsService.placeDirectOrder({
        skuId: 'sku-topup-1', currency: 'EUR', serviceOrder: 'svc-direct-1', webhook: 'https://example.com/hook', attributeValues,
      });

      expect(result).toEqual({ wgcardsOrderId: '2607204320107008', message: 'placed' });
      const sent = sentPayloadFor(0);
      expect(sent).toEqual({
        outOrderNo: 'svc-direct-1', currency: 'EUR', skuId: 'sku-topup-1', quantity: 1,
        webhook: 'https://example.com/hook', attributeValues,
      });
      expect(sent).not.toHaveProperty('faceValue');
    });

    test('GAP: faceValue is still sent (undocumented in v4) with a loud warning, for custom-value top-ups', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...CACHED_CFG });
      axios.post.mockResolvedValueOnce(encryptedAxiosResponse(200, { orderId: 'order-2' }));
      const warnSpy = jest.spyOn(require('../../utils/logger'), 'warn').mockImplementation(() => {});

      await wgcardsService.placeDirectOrder({
        skuId: 'sku-topup-2', faceValue: 500, currency: 'EUR', serviceOrder: 'svc-direct-2', webhook: '', attributeValues,
      });

      expect(sentPayloadFor(0).faceValue).toBe(500);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('NO faceValue field'));
      warnSpy.mockRestore();
    });

    test('a business rejection arrives as a plaintext HTTP 400', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...CACHED_CFG });
      axios.post.mockResolvedValueOnce(errorAxiosResponse(400, 'order.third_party_order_no.duplicate', 'External order number already exists'));

      await expect(
        wgcardsService.placeDirectOrder({ skuId: 'sku-topup-1', serviceOrder: 'svc-dup', webhook: '', attributeValues })
      ).rejects.toMatchObject({ code: 'supplier_business_rejection', message: 'External order number already exists' });
    });
  });

  describe('getOrderInfo (-> v4 getOrderList)', () => {
    test('translates v4 record field names (orderSource/currency) back to v3\'s (orderWay/cur)', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...CACHED_CFG });
      axios.post.mockResolvedValueOnce(encryptedAxiosResponse(200, {
        total: 1, page: 1, size: 10,
        records: [{ orderId: '123', outOrderNo: 'svc', createTime: '2026-08-11T12:30:00', orderSource: 105, deliveryMode: 1, orderStatus: 0, payStatus: 1, deliveryStatus: 1, totalAmount: 10, currency: 'USD' }],
      }));

      const result = await wgcardsService.getOrderInfo({ current: 1, size: 10 });

      expect(sentPayloadFor(0)).toEqual({ page: 1, size: 10 });
      expect(result.records[0]).toMatchObject({ orderId: '123', cur: 'USD', orderWay: 105, deliveryStatus: 1 });
    });
  });

  describe('getOrderInfoAndDetail — unchanged shape, thin passthrough', () => {
    test('firstTo/secondTos pass through untouched', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...CACHED_CFG });
      axios.post.mockResolvedValueOnce(encryptedAxiosResponse(200, {
        firstTo: { orderId: '123', deliveryStatus: 3 }, secondTos: [],
      }));

      const orderInfo = await wgcardsService.getOrderInfoAndDetail({ orderId: '123' });

      expect(sentPayloadFor(0)).toEqual({ orderId: '123' }); // no userId sent — identity is the Bearer token now
      expect(orderInfo.firstTo.deliveryStatus).toBe(3);
    });
  });

  describe('getBuyCard (-> v4 getBuyCards)', () => {
    test('flattens v4\'s nested cards[] groups back into v3\'s one-flat-record-per-code shape', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...CACHED_CFG });
      axios.post.mockResolvedValueOnce(encryptedAxiosResponse(200, {
        total: 2, page: 1, size: 200,
        records: [{
          orderItemId: 'ITEM-1', skuId: 's1',
          cards: [{ card: 'CODE1', snCode: 'SN1', pinCode: 'PIN1' }, { card: 'CODE2', snCode: 'SN2', pinCode: 'PIN2' }],
        }],
      }));

      const buyCard = await wgcardsService.getBuyCard({ orderId: '123' });

      expect(buyCard.records).toEqual([
        { skuId: 's1', card: 'CODE1', pinCode: 'PIN1', snCode: 'SN1' },
        { skuId: 's1', card: 'CODE2', pinCode: 'PIN2', snCode: 'SN2' },
      ]);
    });
  });
});
