'use strict';

jest.mock('../gift2games.service', () => ({ createOrder: jest.fn(), getOrderDetails: jest.fn() }));

const gift2gamesService = require('../gift2games.service');
const { attemptGift2GamesFulfillment } = require('../gift2gamesFulfillment');

const link = { link_id: 2, supplier: 'gift2games', supplier_sku_ref: 'g2g-product-1' };

describe('attemptGift2GamesFulfillment', () => {
  beforeEach(() => jest.clearAllMocks());

  test('no link / no supplier_sku_ref -> rejected before any network call', async () => {
    const result = await attemptGift2GamesFulfillment({ orderId: 1, item: { skuId: 5, quantity: 1 }, link: null });
    expect(result).toEqual({ success: false, reason: 'not_a_gift2games_sku' });
    expect(gift2gamesService.createOrder).not.toHaveBeenCalled();
  });

  test('happy path: places the order, returns a fresh referenceNumber', async () => {
    gift2gamesService.createOrder.mockResolvedValueOnce({ orderId: 'G2G-1', orderStatus: 'Completed' });

    const result = await attemptGift2GamesFulfillment({ orderId: 1, item: { skuId: 5, quantity: 1 }, link });

    expect(result.success).toBe(true);
    expect(result.gift2gamesOrderId).toBe('G2G-1');
    expect(gift2gamesService.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ productId: 'g2g-product-1', referenceNumber: result.referenceNumber })
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
