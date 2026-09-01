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
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('every call is POST (confirmed from the vendor\'s Postman collection — this file used to guess GET for reads)', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue(CFG);
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: { status: 1, data: { userId: '9633', userBalance: '300', userCurrency: 'USD' } },
    });

    await gift2gamesService.checkBalance();

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post.mock.calls[0][0]).toBe('http://g2g.example/check_balance');
  });

  test('sends the JWT raw with NO Bearer prefix (confirmed live), no body/Content-Type for a param-less call', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue(CFG);
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: { status: 1, data: { userId: '9633', userBalance: '300', userCurrency: 'USD' }, metaData: { balance: 300, currency: 'USD' } },
    });

    const result = await gift2gamesService.checkBalance();

    expect(result).toEqual({ userId: '9633', userBalance: '300', userCurrency: 'USD' });
    const [, data, config] = axios.post.mock.calls[0];
    expect(data).toBeUndefined(); // no payload -> no body at all
    expect(config.headers.Authorization).toBe('test-jwt'); // NOT "Bearer test-jwt" — confirmed live
  });

  test('a call WITH a payload sends multipart/form-data (confirmed from the Postman collection\'s "mode": "formdata")', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue(CFG);
    axios.post.mockResolvedValueOnce({ status: 200, data: { status: 1, data: { orderId: 'G2G-1', orderStatus: 'Pending' } } });

    await gift2gamesService.createOrder({ productId: 'p1', referenceNumber: 'r1' });

    const [, data, config] = axios.post.mock.calls[0];
    expect(data).toBeDefined(); // a FormData instance, not undefined
    expect(config.headers['content-type']).toMatch(/multipart\/form-data/);
  });

  test('a rejected login (status:0) does NOT call recordSuccess — regression test for the bug where _authedCall recorded success on HTTP 200 before the body-level check existed', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue(CFG);
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: { status: 0, erorrCode: 'login_unsuccessful', message: 'Incorrect Login' },
    });

    await expect(gift2gamesService.checkBalance()).rejects.toThrow();

    expect(supplierConfigRepo.recordSuccess).not.toHaveBeenCalled();
    expect(supplierConfigRepo.recordFailure).toHaveBeenCalledWith('gift2games');
  });

  test('a status:0 rejection with a non-login erorrCode is a SupplierBusinessError, not auth — and does NOT trip the circuit breaker', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue(CFG);
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: { status: 0, erorrCode: 'invalid_product', message: 'Unknown productId' },
    });

    await expect(gift2gamesService.createOrder({ productId: 'bad', referenceNumber: 'r1' }))
      .rejects.toMatchObject({ code: 'supplier_business_rejection' });
    expect(supplierConfigRepo.recordFailure).not.toHaveBeenCalled();
  });

  test('401 -> SupplierAuthError, no retry built in here (that policy lives in the fulfillment module)', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue(CFG);
    axios.post.mockResolvedValueOnce({ status: 401, data: {} });

    await expect(gift2gamesService.createOrder({ productId: 'p1', referenceNumber: 'r1' }))
      .rejects.toMatchObject({ code: 'supplier_auth_failure' });
    expect(supplierConfigRepo.recordFailure).toHaveBeenCalledWith('gift2games');
  });

  test('429 -> a distinctly-coded rate-limit error, does NOT trip the circuit breaker', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue(CFG);
    axios.post.mockResolvedValueOnce({ status: 429, data: {} });

    await expect(gift2gamesService.createOrder({ productId: 'p1', referenceNumber: 'r1' }))
      .rejects.toMatchObject({ code: 'supplier_rate_limited' });
    expect(supplierConfigRepo.recordFailure).not.toHaveBeenCalled();
  });

  test('createOrder: orderStatus "Rejected" (nested under data) throws SupplierBusinessError, not treated as success', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue(CFG);
    axios.post.mockResolvedValueOnce({ status: 200, data: { status: 1, data: { orderStatus: 'Rejected', message: 'out of stock' } } });

    await expect(gift2gamesService.createOrder({ productId: 'p1', referenceNumber: 'r1' }))
      .rejects.toMatchObject({ code: 'supplier_business_rejection', orderStatus: 'Rejected' });
  });

  test('createOrder: a non-Rejected orderStatus resolves normally', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue(CFG);
    axios.post.mockResolvedValueOnce({ status: 200, data: { status: 1, data: { orderStatus: 'Pending', orderId: 'G2G-1' } } });

    const result = await gift2gamesService.createOrder({ productId: 'p1', referenceNumber: 'r1' });
    expect(result).toEqual({ orderStatus: 'Pending', orderId: 'G2G-1' });
    expect(supplierConfigRepo.recordSuccess).toHaveBeenCalledWith('gift2games');
  });

  test('createOrder flattens additionalFields into individual form fields keyed by name (best-effort, not yet confirmed live)', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue(CFG);
    axios.post.mockResolvedValueOnce({ status: 200, data: { status: 1, data: { orderStatus: 'Pending', orderId: 'G2G-2' } } });

    await gift2gamesService.createOrder({
      productId: 'p1', referenceNumber: 'r1',
      additionalFields: [{ name: 'playerId', value: '1234' }],
    });

    const [, data] = axios.post.mock.calls[0];
    // FormData doesn't expose a plain getter for assertions — check via
    // the underlying stream's boundary-delimited buffer for the field name.
    const buffered = data.getBuffer().toString();
    expect(buffered).toContain('name="playerId"');
    expect(buffered).toContain('1234');
  });

  test('getProducts posts to /products (CORRECTED from an earlier wrong guess of GET /getProducts, which 404\'d)', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue(CFG);
    axios.post.mockResolvedValueOnce({ status: 200, data: { status: 1, data: [{ id: 1, price: 10, sellPrice: 12, inStock: true }] } });

    const result = await gift2gamesService.getProducts({ inStock: true });

    expect(axios.post.mock.calls[0][0]).toBe('http://g2g.example/products');
    expect(result).toEqual([{ id: 1, price: 10, sellPrice: 12, inStock: true }]);
  });

  test('getOrderDetails posts to /orders/details with referenceNumber', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue(CFG);
    axios.post.mockResolvedValueOnce({ status: 200, data: { status: 1, data: { orderStatus: 'Completed' } } });

    await gift2gamesService.getOrderDetails({ referenceNumber: 'ref1234' });

    expect(axios.post.mock.calls[0][0]).toBe('http://g2g.example/orders/details');
  });

  test('getMyOrders defaults to page 1', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValue(CFG);
    axios.post.mockResolvedValueOnce({ status: 200, data: { status: 1, data: [] } });

    await gift2gamesService.getMyOrders();

    const buffered = axios.post.mock.calls[0][1].getBuffer().toString();
    expect(buffered).toContain('name="page"');
    expect(buffered).toContain('\r\n\r\n1');
  });
});
