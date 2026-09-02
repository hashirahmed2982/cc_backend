'use strict';

jest.mock('../../config/database');
jest.mock('../gift2games.service', () => ({ createOrder: jest.fn(), getOrderDetails: jest.fn() }));
jest.mock('../../utils/dataCrypto', () => ({
  encrypt: jest.fn((v) => `enc(${v})`),
  decrypt: jest.fn((v) => v),
}));

const db = require('../../config/database');
const gift2gamesService = require('../gift2games.service');
const { attemptGift2GamesFulfillment } = require('../gift2gamesFulfillment');

const link = { link_id: 2, supplier: 'gift2games', supplier_sku_ref: 'g2g-product-1' };

describe('attemptGift2GamesFulfillment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Every attempt starts with the existing-order idempotency check —
    // default to "no row yet" unless a test overrides it.
    db.queryOne.mockResolvedValue(null);
    db.query.mockResolvedValue(undefined);
    // db.transaction's real implementation runs callback(connection) and
    // returns its result — the auto-mock just needs the same shape, with
    // a connection stub whose .execute() calls are inspectable per test.
    db.transaction.mockImplementation(async (cb) => cb({ execute: jest.fn().mockResolvedValue([{}]) }));
  });

  test('no link / no supplier_sku_ref -> rejected before any network call', async () => {
    const result = await attemptGift2GamesFulfillment({ orderId: 1, item: { skuId: 5, quantity: 1 }, link: null });
    expect(result).toEqual({ success: false, reason: 'not_a_gift2games_sku' });
    expect(gift2gamesService.createOrder).not.toHaveBeenCalled();
  });

  test('already placed (gift2games_order_id set) -> no-op, does not call createOrder again', async () => {
    db.queryOne.mockResolvedValueOnce({ gift2games_order_id: 'G2G-1', gift2games_reference_number: 'REF-1' });

    const result = await attemptGift2GamesFulfillment({ orderId: 1, item: { skuId: 5, quantity: 1 }, link });

    expect(result).toEqual({ success: true, alreadyPlaced: true, gift2gamesOrderId: 'G2G-1', referenceNumber: 'REF-1' });
    expect(gift2gamesService.createOrder).not.toHaveBeenCalled();
  });

  test('happy path with an extractable code -> delivers immediately, writes digital_codes, no pending_reason', async () => {
    gift2gamesService.createOrder.mockResolvedValueOnce({ orderId: 'G2G-1', orderStatus: 'Completed', code: 'ABCD-1234' });

    const result = await attemptGift2GamesFulfillment({ orderId: 1, item: { skuId: 5, quantity: 1 }, link });

    expect(result.success).toBe(true);
    expect(result.delivered).toBe(true);
    expect(result.codes).toEqual(['ABCD-1234']);
    expect(result.gift2gamesOrderId).toBe('G2G-1');
    // Delivered via a transaction (digital_codes insert + delivered_qty bump), not a plain pending UPDATE.
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  test('happy path with NO extractable code -> marks pending for the poller, does not touch digital_codes', async () => {
    gift2gamesService.createOrder.mockResolvedValueOnce({ orderId: 'G2G-1', orderStatus: 'Processing' });

    const result = await attemptGift2GamesFulfillment({ orderId: 1, item: { skuId: 5, quantity: 1 }, link });

    expect(result.success).toBe(true);
    expect(result.delivered).toBe(false);
    expect(result.gift2gamesOrderId).toBe('G2G-1');
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('pending_reason'),
      expect.arrayContaining(['awaiting_supplier_delivery'])
    );
  });

  test('business rejection is NOT retried, and Flow H lookup is never called', async () => {
    const err = new Error('out of stock');
    err.code = 'supplier_business_rejection';
    gift2gamesService.createOrder.mockRejectedValueOnce(err);

    const result = await attemptGift2GamesFulfillment({ orderId: 1, item: { skuId: 5, quantity: 1 }, link, retryDelaysMs: [5, 5] });

    expect(result).toMatchObject({ success: false, reason: 'supplier_rejected' });
    expect(gift2gamesService.createOrder).toHaveBeenCalledTimes(1);
    expect(gift2gamesService.getOrderDetails).not.toHaveBeenCalled();
  });

  test('auth failure gets ZERO retries (master plan: no refresh flow exists)', async () => {
    const err = new Error('bad token');
    err.code = 'supplier_auth_failure';
    gift2gamesService.createOrder.mockRejectedValueOnce(err);

    const result = await attemptGift2GamesFulfillment({ orderId: 1, item: { skuId: 5, quantity: 1 }, link, retryDelaysMs: [5, 5] });

    expect(result).toMatchObject({ success: false, reason: 'supplier_auth_failure' });
    expect(gift2gamesService.createOrder).toHaveBeenCalledTimes(1);
  });

  test('Flow H: an ambiguous failure that the idempotency lookup confirms NOT found is safe to retry, and succeeds', async () => {
    gift2gamesService.createOrder
      .mockRejectedValueOnce(new Error('ECONNABORTED'))
      .mockResolvedValueOnce({ orderId: 'G2G-2', orderStatus: 'Pending' });
    gift2gamesService.getOrderDetails.mockResolvedValueOnce({ orderStatus: 'not_found' });

    const result = await attemptGift2GamesFulfillment({ orderId: 1, item: { skuId: 5, quantity: 1 }, link, retryDelaysMs: [5, 5] });

    expect(result.success).toBe(true);
    expect(gift2gamesService.createOrder).toHaveBeenCalledTimes(2);
    // Both attempts must reuse the exact same referenceNumber — this IS
    // the idempotency key Flow H's lookup is keyed on.
    const [firstCall, secondCall] = gift2gamesService.createOrder.mock.calls;
    expect(firstCall[0].referenceNumber).toBe(secondCall[0].referenceNumber);
  });

  test('Flow H: an ambiguous failure where the lookup finds the order DID go through -> reported as success, never retried', async () => {
    gift2gamesService.createOrder.mockRejectedValueOnce(new Error('timeout'));
    gift2gamesService.getOrderDetails.mockResolvedValueOnce({ orderStatus: 'Completed', orderId: 'G2G-3' });

    const result = await attemptGift2GamesFulfillment({ orderId: 1, item: { skuId: 5, quantity: 1 }, link, retryDelaysMs: [5, 5] });

    expect(result).toMatchObject({ success: true, gift2gamesOrderId: 'G2G-3', recoveredViaIdempotencyCheck: true });
    expect(gift2gamesService.createOrder).toHaveBeenCalledTimes(1); // never actually retried
  });

  test('Flow H recovery WITH an extractable code -> also delivers immediately', async () => {
    gift2gamesService.createOrder.mockRejectedValueOnce(new Error('timeout'));
    gift2gamesService.getOrderDetails.mockResolvedValueOnce({ orderStatus: 'Completed', orderId: 'G2G-3', code: 'EFGH-5678' });

    const result = await attemptGift2GamesFulfillment({ orderId: 1, item: { skuId: 5, quantity: 1 }, link, retryDelaysMs: [5, 5] });

    expect(result).toMatchObject({ success: true, delivered: true, codes: ['EFGH-5678'], recoveredViaIdempotencyCheck: true });
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  test('Flow H: if the idempotency lookup ITSELF fails, do not retry blind — treat as terminal', async () => {
    gift2gamesService.createOrder.mockRejectedValue(new Error('timeout'));
    gift2gamesService.getOrderDetails.mockRejectedValueOnce(new Error('lookup also down'));

    const result = await attemptGift2GamesFulfillment({ orderId: 1, item: { skuId: 5, quantity: 1 }, link, retryDelaysMs: [5, 5] });

    expect(result).toMatchObject({ success: false, reason: 'supplier_timeout' });
    expect(gift2gamesService.createOrder).toHaveBeenCalledTimes(1);
  });

  test('exhausts all retries when the lookup keeps confirming not-found', async () => {
    gift2gamesService.createOrder.mockRejectedValue(new Error('ECONNABORTED'));
    gift2gamesService.getOrderDetails.mockResolvedValue({ orderStatus: 'not_found' });

    const result = await attemptGift2GamesFulfillment({ orderId: 1, item: { skuId: 5, quantity: 1 }, link, retryDelaysMs: [5, 5] });

    expect(result).toMatchObject({ success: false, reason: 'supplier_timeout' });
    expect(gift2gamesService.createOrder).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });
});
