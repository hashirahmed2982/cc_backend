'use strict';

// Mocks must be declared before requiring the module under test.
jest.mock('axios');
jest.mock('../../repositories/supplierConfig.repository');
jest.mock('../supplierApiLog.service', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const axios = require('axios');
const supplierConfigRepo = require('../../repositories/supplierConfig.repository');
const { encryptMsg, decryptMsg } = require('../../utils/wgcardsCrypto');
const wgcardsService = require('../wgcards.service');

const APP_ID = 'testAppId1234567'; // 16 chars — valid AES-128 key length, mirrors the sandbox appId
const BASE_CFG = {
  app_id: APP_ID,
  account_id: 'testAccountId',
  app_key: 'testAppKey',
  api_base_url: 'http://sandbox.example',
  token: null,
  token_expires: null,
};

function encryptedAxiosResponse(status, payloadObj) {
  return { status, data: encryptMsg(APP_ID, payloadObj) };
}

/** Decrypt what we actually sent on a given axios.post call, for asserting request shape. */
function sentPayloadFor(callIndex) {
  const sentBody = axios.post.mock.calls[callIndex][1]; // the object passed to axios.post(url, body, opts)
  return JSON.parse(decryptMsg(APP_ID, sentBody.msg));
}

describe('WgCardsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('fetches and caches a new token when none is cached', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...BASE_CFG });
    axios.post.mockResolvedValueOnce(
      encryptedAxiosResponse(200, { appId: APP_ID, code: 200, data: 'fresh-token-abc', msg: 'success' })
    );
    axios.post.mockResolvedValueOnce(
      encryptedAxiosResponse(200, {
        appId: APP_ID, code: 200,
        data: { accounts: [{ balance: 100, currency: 'USD', effective: true, walletId: 'w1' }], userId: APP_ID },
        msg: 'success',
      })
    );

    const result = await wgcardsService.getAccount();

    expect(axios.post).toHaveBeenCalledTimes(2); // getToken, then getAccount
    expect(axios.post.mock.calls[0][0]).toContain('/api/getToken');
    expect(axios.post.mock.calls[1][0]).toContain('/api/getAccount');
    expect(axios.post.mock.calls[1][2].headers.Authorization).toBe('Bearer fresh-token-abc');
    expect(result.accounts[0].balance).toBe(100);
    expect(supplierConfigRepo.saveToken).toHaveBeenCalledWith('wgcards', 'fresh-token-abc', expect.any(Date));
    expect(supplierConfigRepo.recordSuccess).toHaveBeenCalled();
  });

  test('reuses a cached token that is not close to expiring', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue({
      ...BASE_CFG,
      token: 'cached-token',
      token_expires: new Date(Date.now() + 100 * 60 * 1000), // 100 min left, well above the 10-min margin
    });
    axios.post.mockResolvedValueOnce(
      encryptedAxiosResponse(200, {
        appId: APP_ID, code: 200,
        data: { accounts: [], userId: APP_ID }, msg: 'success',
      })
    );

    await wgcardsService.getAccount();

    expect(axios.post).toHaveBeenCalledTimes(1); // no getToken call
    expect(axios.post.mock.calls[0][2].headers.Authorization).toBe('Bearer cached-token');
  });

  test('refreshes a token that is within the 10-minute expiry margin', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue({
      ...BASE_CFG,
      token: 'stale-token',
      token_expires: new Date(Date.now() + 5 * 60 * 1000), // only 5 min left
    });
    axios.post.mockResolvedValueOnce(
      encryptedAxiosResponse(200, { appId: APP_ID, code: 200, data: 'renewed-token', msg: 'success' })
    );
    axios.post.mockResolvedValueOnce(
      encryptedAxiosResponse(200, { appId: APP_ID, code: 200, data: { accounts: [], userId: APP_ID }, msg: 'success' })
    );

    await wgcardsService.getAccount();

    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(axios.post.mock.calls[1][2].headers.Authorization).toBe('Bearer renewed-token');
  });

  test('on 401: forces one token refresh and retries the call once, then succeeds', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue({
      ...BASE_CFG,
      token: 'expired-but-not-yet-known',
      token_expires: new Date(Date.now() + 100 * 60 * 1000),
    });
    axios.post
      .mockResolvedValueOnce({ status: 401, data: '' })                                    // getAccount -> 401
      .mockResolvedValueOnce(encryptedAxiosResponse(200, { appId: APP_ID, code: 200, data: 'new-token', msg: 'success' })) // forced getToken
      .mockResolvedValueOnce(encryptedAxiosResponse(200, {                                  // retried getAccount
        appId: APP_ID, code: 200, data: { accounts: [], userId: APP_ID }, msg: 'success',
      }));

    const result = await wgcardsService.getAccount();

    expect(axios.post).toHaveBeenCalledTimes(3);
    expect(supplierConfigRepo.clearToken).toHaveBeenCalledWith('wgcards');
    expect(axios.post.mock.calls[2][2].headers.Authorization).toBe('Bearer new-token');
    expect(result).toEqual({ accounts: [], userId: APP_ID });
  });

  test('on 401 again after the forced refresh: bubbles up supplier_auth_failure, does not retry a third time', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue({
      ...BASE_CFG,
      token: 'some-token',
      token_expires: new Date(Date.now() + 100 * 60 * 1000),
    });
    axios.post
      .mockResolvedValueOnce({ status: 401, data: '' })                                    // getAccount -> 401
      .mockResolvedValueOnce(encryptedAxiosResponse(200, { appId: APP_ID, code: 200, data: 'new-token', msg: 'success' })) // forced getToken
      .mockResolvedValueOnce({ status: 401, data: '' });                                    // retried getAccount -> 401 again

    await expect(wgcardsService.getAccount()).rejects.toMatchObject({ code: 'supplier_auth_failure' });
    expect(axios.post).toHaveBeenCalledTimes(3); // no further retries beyond the one forced refresh
    expect(supplierConfigRepo.recordFailure).toHaveBeenCalledWith('wgcards');
  });

  test('a genuine transport-level failure (non-200 HTTP status) DOES trip the circuit breaker', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue({
      ...BASE_CFG, token: 'cached-token', token_expires: new Date(Date.now() + 100 * 60 * 1000),
    });
    axios.post.mockResolvedValueOnce({ status: 502, data: '' });

    await expect(wgcardsService.getAccount()).rejects.toThrow(/HTTP 502/);
    expect(supplierConfigRepo.recordFailure).toHaveBeenCalledWith('wgcards');
  });

  test('a well-formed business rejection (outer code !== 200, real HTTP 200) does NOT trip the circuit breaker', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue({
      ...BASE_CFG, token: 'cached-token', token_expires: new Date(Date.now() + 100 * 60 * 1000),
    });
    axios.post.mockResolvedValueOnce(
      encryptedAxiosResponse(200, { appId: APP_ID, code: 400, msg: 'invalid userId' })
    );

    await expect(wgcardsService.getAccount()).rejects.toMatchObject({ code: 'supplier_business_rejection' });
    expect(supplierConfigRepo.recordFailure).not.toHaveBeenCalled();
  });

  test('getStock rejects an empty/missing skuIds array without making a network call', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...BASE_CFG });
    await expect(wgcardsService.getStock([])).rejects.toThrow(/non-empty array/);
    await expect(wgcardsService.getStock()).rejects.toThrow(/non-empty array/);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('placeDirectOrder is still an explicit not-implemented stub (Flow F, Phase 9)', async () => {
    await expect(wgcardsService.placeDirectOrder({})).rejects.toThrow(/Flow F/);
  });

  describe('placeOrder', () => {
    const cachedCfg = {
      ...BASE_CFG,
      token: 'cached-token',
      token_expires: new Date(Date.now() + 100 * 60 * 1000),
    };

    test('success: returns the nested wgcardsOrderId', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...cachedCfg });
      axios.post.mockResolvedValueOnce(
        encryptedAxiosResponse(200, {
          appId: APP_ID, code: 200,
          data: { code: 200, data: '2025112071040010', message: 'success' },
          msg: 'success',
        })
      );

      const result = await wgcardsService.placeOrder({
        skuId: 'sku-1', buyNum: 2, currency: 'USD', serviceOrder: 'svc-1',
      });

      expect(result).toEqual({ wgcardsOrderId: '2025112071040010', message: 'success' });
      const sentPayload = sentPayloadFor(0);
      expect(sentPayload.detailVos).toEqual([{ skuId: 'sku-1', buyNum: 2 }]); // no faceValue for fixed-value SKUs
      expect(sentPayload.serviceOrder).toBe('svc-1');
    });

    test('a business rejection (nested code !== 200) throws SupplierBusinessError, not a generic Error', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...cachedCfg });
      axios.post.mockResolvedValueOnce(
        encryptedAxiosResponse(200, {
          appId: APP_ID, code: 200,
          data: { code: 4001, data: null, message: 'productOutOfStock' },
          msg: 'success',
        })
      );

      await expect(
        wgcardsService.placeOrder({ skuId: 'sku-1', buyNum: 1, serviceOrder: 'svc-2' })
      ).rejects.toMatchObject({ code: 'supplier_business_rejection', message: 'productOutOfStock' });
    });

    test('a FLAT rejection (outer code !== 200, no nested data — the real shape WgCards sends for a spuType:5 SKU through the wrong endpoint) also throws SupplierBusinessError and does NOT trip the circuit breaker', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...cachedCfg });
      axios.post.mockResolvedValueOnce(
        encryptedAxiosResponse(200, { appId: APP_ID, code: 422, msg: 'no direct top-up parameter info' })
      );

      await expect(
        wgcardsService.placeOrder({ skuId: 'sku-1', buyNum: 1, serviceOrder: 'svc-flat' })
      ).rejects.toMatchObject({ code: 'supplier_business_rejection', wgcardsCode: 422, message: 'no direct top-up parameter info' });
      expect(supplierConfigRepo.recordFailure).not.toHaveBeenCalled();
    });

    test('faceValue is included for custom-value SKUs', async () => {
      supplierConfigRepo.getBySupplierName.mockResolvedValue({ ...cachedCfg });
      axios.post.mockResolvedValueOnce(
        encryptedAxiosResponse(200, {
          appId: APP_ID, code: 200,
          data: { code: 200, data: 'order-id', message: 'success' },
          msg: 'success',
        })
      );

      await wgcardsService.placeOrder({ skuId: 'sku-2', buyNum: 1, faceValue: 25.5, serviceOrder: 'svc-3' });

      expect(sentPayloadFor(0).detailVos).toEqual([{ skuId: 'sku-2', faceValue: 25.5, buyNum: 1 }]);
    });
  });

  test('getOrderInfoAndDetail and getBuyCard pass through the decrypted response', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue({
      ...BASE_CFG, token: 'cached-token', token_expires: new Date(Date.now() + 100 * 60 * 1000),
    });
    axios.post
      .mockResolvedValueOnce(encryptedAxiosResponse(200, {
        appId: APP_ID, code: 200,
        data: { firstTo: { orderId: '123', deliveryStatus: 3 }, secondTos: [] },
        msg: 'success',
      }))
      .mockResolvedValueOnce(encryptedAxiosResponse(200, {
        appId: APP_ID, code: 200,
        data: { records: [{ skuId: 's1', card: 'CODE', pinCode: 'PIN', snCode: 'SN' }] },
        msg: 'success',
      }));

    const orderInfo = await wgcardsService.getOrderInfoAndDetail({ orderId: '123' });
    const buyCard = await wgcardsService.getBuyCard({ orderId: '123' });

    expect(orderInfo.firstTo.deliveryStatus).toBe(3);
    expect(buyCard.records[0].card).toBe('CODE');
  });
});
