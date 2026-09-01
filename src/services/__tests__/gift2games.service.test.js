'use strict';

jest.mock('axios');
jest.mock('../../repositories/supplierConfig.repository');
jest.mock('../supplierApiLog.service', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const axios = require('axios');
const supplierConfigRepo = require('../../repositories/supplierConfig.repository');
const gift2gamesService = require('../gift2games.service');

const CFG = { app_key: 'test-jwt', api_base_url: 'http://g2g.example' };

describe('Gift2GamesService', () => {
  beforeEach(() => jest.clearAllMocks());

  test('throws a clear "not configured" error when no supplier_config row exists at all', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce(null);
    await expect(gift2gamesService.checkBalance()).rejects.toThrow(/not configured/);
    expect(axios.request).not.toHaveBeenCalled();
  });

  test('sends the JWT as a Bearer token, unencrypted body (unlike WgCards)', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue(CFG);
    axios.request.mockResolvedValueOnce({ status: 200, data: { userBalance: 100, userCurrency: 'USD' } });

    const result = await gift2gamesService.checkBalance();

    expect(result).toEqual({ userBalance: 100, userCurrency: 'USD' });
    const call = axios.request.mock.calls[0][0];
    expect(call.headers.Authorization).toBe('Bearer test-jwt');
    expect(call.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  test('checkBalance: HTTP 200 with {status:0, erorrCode} (a rejected login, confirmed live) throws SupplierAuthError rather than reporting success', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue(CFG);
    axios.request.mockResolvedValueOnce({
      status: 200,
      data: { status: 0, erorrCode: 'login_unsuccessful', message: 'Incorrect Login' },
    });

    await expect(gift2gamesService.checkBalance()).rejects.toMatchObject({
      code: 'supplier_auth_failure',
      message: expect.stringContaining('Incorrect Login'),
    });
  });

  test('401 -> SupplierAuthError, no retry built in here (that policy lives in the fulfillment module)', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue(CFG);
    axios.request.mockResolvedValueOnce({ status: 401, data: {} });

    await expect(gift2gamesService.createOrder({ productId: 'p1', referenceNumber: 'r1' }))
      .rejects.toMatchObject({ code: 'supplier_auth_failure' });
    expect(supplierConfigRepo.recordFailure).toHaveBeenCalledWith('gift2games');
  });

  test('429 -> a distinctly-coded rate-limit error, does NOT trip the circuit breaker', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue(CFG);
    axios.request.mockResolvedValueOnce({ status: 429, data: {} });

    await expect(gift2gamesService.createOrder({ productId: 'p1', referenceNumber: 'r1' }))
      .rejects.toMatchObject({ code: 'supplier_rate_limited' });
    expect(supplierConfigRepo.recordFailure).not.toHaveBeenCalled();
  });

  test('createOrder: orderStatus "Rejected" throws SupplierBusinessError, not treated as success', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue(CFG);
    axios.request.mockResolvedValueOnce({ status: 200, data: { orderStatus: 'Rejected', message: 'out of stock' } });

    await expect(gift2gamesService.createOrder({ productId: 'p1', referenceNumber: 'r1' }))
      .rejects.toMatchObject({ code: 'supplier_business_rejection', orderStatus: 'Rejected' });
  });

  test('createOrder: a non-Rejected orderStatus resolves normally', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue(CFG);
    axios.request.mockResolvedValueOnce({ status: 200, data: { orderStatus: 'Pending', orderId: 'G2G-1' } });

    const result = await gift2gamesService.createOrder({ productId: 'p1', referenceNumber: 'r1' });
    expect(result).toEqual({ orderStatus: 'Pending', orderId: 'G2G-1' });
    expect(supplierConfigRepo.recordSuccess).toHaveBeenCalledWith('gift2games');
  });
});
