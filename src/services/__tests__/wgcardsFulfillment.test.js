'use strict';

jest.mock('../../config/database');
jest.mock('../wgcards.service');
jest.mock('../../repositories/supplierConfig.repository');

const db = require('../../config/database');
const wgcardsService = require('../wgcards.service');
const supplierConfigRepo = require('../../repositories/supplierConfig.repository');
const { attemptWgCardsFulfillment } = require('../wgcardsFulfillment');

describe('attemptWgCardsFulfillment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('already placed (wgcards_order_id set) -> no-op, does not call placeOrder again', async () => {
    db.queryOne.mockResolvedValueOnce({ wgcards_order_id: 'ORD-1', wgcards_service_order: 'SVC-1' });

    const result = await attemptWgCardsFulfillment({ orderId: 1, item: { skuId: 5, quantity: 2 } });

    expect(result).toEqual({ success: true, alreadyPlaced: true, wgcardsOrderId: 'ORD-1', serviceOrder: 'SVC-1' });
    expect(wgcardsService.placeOrder).not.toHaveBeenCalled();
    expect(wgcardsService.getItemAndStock).not.toHaveBeenCalled();
  });

  test('circuit breaker: integration_status "down" blocks placement immediately, no network calls at all', async () => {
    db.queryOne.mockResolvedValueOnce(null); // no existing order_details row
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ integration_status: 'down' });

    const result = await attemptWgCardsFulfillment({ orderId: 1, item: { skuId: 5, quantity: 1 } });

    expect(result).toEqual({ success: false, reason: 'supplier_integration_down' });
    expect(wgcardsService.getItemAndStock).not.toHaveBeenCalled();
    expect(wgcardsService.placeOrder).not.toHaveBeenCalled();
  });

  test('circuit breaker: integration_status "healthy" proceeds as normal', async () => {
    db.queryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ wgcards_sku_id: 'wg-1', is_custom_value: 0, spu_type: 2 });
    db.query.mockResolvedValue(undefined);
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ integration_status: 'healthy' });
    wgcardsService.getItemAndStock.mockResolvedValueOnce({});
    wgcardsService.placeOrder.mockResolvedValueOnce({ wgcardsOrderId: 'ORD-1' });

    const result = await attemptWgCardsFulfillment({ orderId: 1, item: { skuId: 5, quantity: 1 } });

    expect(result.success).toBe(true);
  });

  test('sku has no wgcards_sku_id -> rejected before any network call', async () => {
    db.queryOne
      .mockResolvedValueOnce(null) // no existing order_details row
      .mockResolvedValueOnce({ wgcards_sku_id: null, is_custom_value: 0 });

    const result = await attemptWgCardsFulfillment({ orderId: 1, item: { skuId: 5, quantity: 1 } });

    expect(result).toEqual({ success: false, reason: 'not_a_wgcards_sku' });
    expect(wgcardsService.placeOrder).not.toHaveBeenCalled();
  });

  test('custom-value SKU is punted, not guessed at', async () => {
    db.queryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ wgcards_sku_id: 'wg-1', is_custom_value: 1 });

    const result = await attemptWgCardsFulfillment({ orderId: 1, item: { skuId: 5, quantity: 1 } });

    expect(result).toEqual({ success: false, reason: 'custom_value_not_supported_yet' });
    expect(wgcardsService.placeOrder).not.toHaveBeenCalled();
  });

  test('a Direct Top-Up product (spu_type: 5) is rejected fast, without ever calling placeOrder', async () => {
    // Confirmed live: WgCards rejects /api/placeOrder for these with
    // "no direct top-up parameter info" — burning 2 pointless retries
    // every time until Flow F exists. Fail fast instead.
    db.queryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ wgcards_sku_id: 'wg-1', is_custom_value: 0, spu_type: 5 });

    const result = await attemptWgCardsFulfillment({ orderId: 1, item: { skuId: 5, quantity: 1 } });

    expect(result).toEqual({ success: false, reason: 'requires_direct_topup_flow' });
    expect(wgcardsService.placeOrder).not.toHaveBeenCalled();
    expect(wgcardsService.getItemAndStock).not.toHaveBeenCalled();
  });

  test('happy path: places the order and records service_order/order_id/pending_reason', async () => {
    db.queryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ wgcards_sku_id: 'wg-1', is_custom_value: 0 });
    db.query.mockResolvedValue(undefined);
    wgcardsService.getItemAndStock.mockResolvedValueOnce({ number: 10 });
    wgcardsService.placeOrder.mockResolvedValueOnce({ wgcardsOrderId: 'ORD-99', message: 'success' });

    const result = await attemptWgCardsFulfillment({ orderId: 1, item: { skuId: 5, quantity: 2 } });

    expect(result.success).toBe(true);
    expect(result.wgcardsOrderId).toBe('ORD-99');
    expect(wgcardsService.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ skuId: 'wg-1', buyNum: 2, currency: 'USD' })
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE order_details SET wgcards_service_order'),
      expect.arrayContaining(['ORD-99', 'awaiting_supplier_delivery'])
    );
  });

  test('a live stock-check failure does not block placeOrder from being attempted', async () => {
    db.queryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ wgcards_sku_id: 'wg-1', is_custom_value: 0 });
    db.query.mockResolvedValue(undefined);
    wgcardsService.getItemAndStock.mockRejectedValueOnce(new Error('timeout'));
    wgcardsService.placeOrder.mockResolvedValueOnce({ wgcardsOrderId: 'ORD-1' });

    const result = await attemptWgCardsFulfillment({ orderId: 1, item: { skuId: 5, quantity: 1 } });

    expect(result.success).toBe(true);
    expect(wgcardsService.placeOrder).toHaveBeenCalledTimes(1);
  });

  test('business rejection (e.g. out of stock) is NOT retried', async () => {
    db.queryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ wgcards_sku_id: 'wg-1', is_custom_value: 0 });
    db.query.mockResolvedValue(undefined);
    wgcardsService.getItemAndStock.mockResolvedValueOnce({});
    const businessErr = new Error('out of stock');
    businessErr.code = 'supplier_business_rejection';
    wgcardsService.placeOrder.mockRejectedValueOnce(businessErr);

    const result = await attemptWgCardsFulfillment({ orderId: 1, item: { skuId: 5, quantity: 1 }, retryDelaysMs: [10, 10] });

    expect(result).toMatchObject({ success: false, reason: 'supplier_rejected' });
    expect(wgcardsService.placeOrder).toHaveBeenCalledTimes(1); // no retry
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE order_details SET wgcards_service_order'),
      expect.arrayContaining(['supplier_rejected'])
    );
  });

  test('auth failure is NOT retried', async () => {
    db.queryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ wgcards_sku_id: 'wg-1', is_custom_value: 0 });
    db.query.mockResolvedValue(undefined);
    wgcardsService.getItemAndStock.mockResolvedValueOnce({});
    const authErr = new Error('still 401 after refresh');
    authErr.code = 'supplier_auth_failure';
    wgcardsService.placeOrder.mockRejectedValueOnce(authErr);

    const result = await attemptWgCardsFulfillment({ orderId: 1, item: { skuId: 5, quantity: 1 }, retryDelaysMs: [10, 10] });

    expect(result).toMatchObject({ success: false, reason: 'supplier_auth_failure' });
    expect(wgcardsService.placeOrder).toHaveBeenCalledTimes(1);
  });

  test('network/timeout errors ARE retried up to retryDelaysMs.length extra attempts, then give up', async () => {
    db.queryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ wgcards_sku_id: 'wg-1', is_custom_value: 0 });
    db.query.mockResolvedValue(undefined);
    wgcardsService.getItemAndStock.mockResolvedValueOnce({});
    wgcardsService.placeOrder.mockRejectedValue(new Error('ECONNABORTED'));

    const result = await attemptWgCardsFulfillment({ orderId: 1, item: { skuId: 5, quantity: 1 }, retryDelaysMs: [5, 5] });

    expect(result).toMatchObject({ success: false, reason: 'supplier_timeout' });
    expect(wgcardsService.placeOrder).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  test('network/timeout error that succeeds on the retry reports success', async () => {
    db.queryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ wgcards_sku_id: 'wg-1', is_custom_value: 0 });
    db.query.mockResolvedValue(undefined);
    wgcardsService.getItemAndStock.mockResolvedValueOnce({});
    wgcardsService.placeOrder
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ wgcardsOrderId: 'ORD-retry-ok' });

    const result = await attemptWgCardsFulfillment({ orderId: 1, item: { skuId: 5, quantity: 1 }, retryDelaysMs: [5, 5] });

    expect(result).toEqual({ success: true, wgcardsOrderId: 'ORD-retry-ok', serviceOrder: expect.any(String) });
    expect(wgcardsService.placeOrder).toHaveBeenCalledTimes(2);
    // Both attempts must reuse the exact same serviceOrder (idempotency key) —
    // never regenerate it mid-retry, or WgCards' dedup check becomes useless.
    const firstCallServiceOrder = wgcardsService.placeOrder.mock.calls[0][0].serviceOrder;
    const secondCallServiceOrder = wgcardsService.placeOrder.mock.calls[1][0].serviceOrder;
    expect(firstCallServiceOrder).toBe(secondCallServiceOrder);
  });
});
