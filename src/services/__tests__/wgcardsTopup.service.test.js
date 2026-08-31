'use strict';

jest.mock('../../config/database', () => ({
  transaction: jest.fn(),
  query: jest.fn(),
  queryOne: jest.fn(),
}));
jest.mock('../wgcards.service');
jest.mock('../email.service', () => ({ sendTemplate: jest.fn().mockResolvedValue(undefined) }));
jest.mock('uuid', () => ({ v4: jest.fn(() => 'fixed-uuid') }));

const db = require('../../config/database');
const wgcardsService = require('../wgcards.service');
const emailService = require('../email.service');
const { getTopupParams, initiateTopup, resolveTopup } = require('../wgcardsTopup.service');

/** Build a fake mysql2 connection whose .execute() replays `results` in
 * order — each entry is what `conn.execute(...)` resolves to (already in
 * the [rows_or_okpacket, fields] tuple shape mysql2 returns). */
function fakeConn(results) {
  const execute = jest.fn();
  results.forEach((r) => execute.mockResolvedValueOnce(r));
  return { execute };
}

describe('getTopupParams', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rejects a SKU that is not a Direct Top-Up product (wrong spu_type)', async () => {
    db.queryOne.mockResolvedValueOnce({ wgcards_sku_id: 'wg-1', spu_type: 2 });
    await expect(getTopupParams(5)).rejects.toThrow(/not a Direct Top-Up product/);
    expect(wgcardsService.getDirectParam).not.toHaveBeenCalled();
  });

  test('rejects a non-WgCards SKU', async () => {
    db.queryOne.mockResolvedValueOnce({ wgcards_sku_id: null, spu_type: 5 });
    await expect(getTopupParams(5)).rejects.toThrow(/not found or not a WgCards product/);
  });

  test('happy path: returns the adapter\'s paramInfos', async () => {
    db.queryOne.mockResolvedValueOnce({ wgcards_sku_id: 'wg-topup-1', spu_type: 5 });
    wgcardsService.getDirectParam.mockResolvedValueOnce([{ name: 'playerId', type: 'input' }]);

    const result = await getTopupParams(5);

    expect(result).toEqual([{ name: 'playerId', type: 'input' }]);
    expect(wgcardsService.getDirectParam).toHaveBeenCalledWith({ skuId: 'wg-topup-1' });
  });
});

describe('initiateTopup', () => {
  const attributeValues = [{ name: 'player ID', value: '1234', label: 'Player ID' }];
  const skuRow = {
    wgcards_sku_id: 'wg-topup-1', is_custom_value: 0, min_face_value: null, max_face_value: null,
    selling_price: '10.00', spu_type: 5, product_name: 'Test Direct Top-Up', product_active: 1,
  };
  const walletRow = { wallet_id: 1, balance: '100.00', currency: 'USD', status: 'active' };
  const userRow = { full_name: 'Test User', email: 'test@example.com' };

  beforeEach(() => jest.clearAllMocks());

  test('happy path: debits the wallet, places the order, records wgcards_order_id', async () => {
    const conn = fakeConn([
      [[skuRow]],            // SELECT sku FOR UPDATE
      [[walletRow]],          // SELECT wallet FOR UPDATE
      [{}],                    // UPDATE wallets
      [{}],                    // INSERT wallet_transactions
      [{ insertId: 42 }],     // INSERT wgcards_topup_orders
      [[userRow]],             // SELECT user
    ]);
    db.transaction.mockImplementation((cb) => cb(conn));
    wgcardsService.apiTopUpParamCheck.mockResolvedValueOnce({ passed: true });
    wgcardsService.placeDirectOrder.mockResolvedValueOnce({ wgcardsOrderId: 'wg-order-1', message: 'success' });

    const result = await initiateTopup({ userId: 7, skuId: 5, attributeValues });

    expect(result).toEqual({ success: true, topupOrderId: 42, orderReference: 'fixed-uuid', wgcardsOrderId: 'wg-order-1', status: 'pending' });
    expect(wgcardsService.placeDirectOrder).toHaveBeenCalledWith(
      expect.objectContaining({ skuId: 'wg-topup-1', currency: 'USD', serviceOrder: 'fixed-uuid', attributeValues })
    );
    expect(db.query).toHaveBeenCalledWith(
      'UPDATE wgcards_topup_orders SET wgcards_order_id = ? WHERE topup_order_id = ?',
      ['wg-order-1', 42]
    );
  });

  test('insufficient balance throws before any supplier call', async () => {
    const conn = fakeConn([
      [[skuRow]],
      [[{ ...walletRow, balance: '1.00' }]],
    ]);
    db.transaction.mockImplementation((cb) => cb(conn));

    await expect(initiateTopup({ userId: 7, skuId: 5, attributeValues })).rejects.toThrow(/Insufficient wallet balance/);
    expect(wgcardsService.apiTopUpParamCheck).not.toHaveBeenCalled();
    expect(wgcardsService.placeDirectOrder).not.toHaveBeenCalled();
  });

  test('custom-value SKU requires faceValue within range', async () => {
    const conn = fakeConn([
      [[{ ...skuRow, is_custom_value: 1, min_face_value: '5.00', max_face_value: '50.00' }]],
    ]);
    db.transaction.mockImplementation((cb) => cb(conn));

    await expect(initiateTopup({ userId: 7, skuId: 5, attributeValues, faceValue: 500 })).rejects.toThrow(/above maximum/);
  });

  test('param check rejected (passed: false) refunds the wallet and marks the row failed', async () => {
    const placementConn = fakeConn([
      [[skuRow]], [[walletRow]], [{}], [{}], [{ insertId: 42 }], [[userRow]],
    ]);
    const refundConn = fakeConn([
      [[{ wallet_id: 1, balance: '90.00' }]], // wallet after the earlier debit
      [{}], [{}], [{}],
    ]);
    db.transaction
      .mockImplementationOnce((cb) => cb(placementConn))
      .mockImplementationOnce((cb) => cb(refundConn));
    wgcardsService.apiTopUpParamCheck.mockResolvedValueOnce({ passed: false, reason: 'sku不属于直充类型' });

    const result = await initiateTopup({ userId: 7, skuId: 5, attributeValues });

    expect(result).toEqual({ success: false, topupOrderId: 42, orderReference: 'fixed-uuid', reason: 'param_check_failed', message: 'sku不属于直充类型' });
    expect(wgcardsService.placeDirectOrder).not.toHaveBeenCalled();
    expect(emailService.sendTemplate).toHaveBeenCalledWith('wgcardsDirectTopupFailed', 'test@example.com', expect.objectContaining({ Order_Reference: 'fixed-uuid' }));
  });

  test('placeDirectOrder business rejection refunds the wallet, is NOT retried', async () => {
    const placementConn = fakeConn([
      [[skuRow]], [[walletRow]], [{}], [{}], [{ insertId: 42 }], [[userRow]],
    ]);
    const refundConn = fakeConn([
      [[{ wallet_id: 1, balance: '90.00' }]], [{}], [{}], [{}],
    ]);
    db.transaction
      .mockImplementationOnce((cb) => cb(placementConn))
      .mockImplementationOnce((cb) => cb(refundConn));
    wgcardsService.apiTopUpParamCheck.mockResolvedValueOnce({ passed: true });
    const rejectErr = new Error('duplicate serviceOrder');
    rejectErr.code = 'supplier_business_rejection';
    wgcardsService.placeDirectOrder.mockRejectedValueOnce(rejectErr);

    const result = await initiateTopup({ userId: 7, skuId: 5, attributeValues });

    expect(result).toMatchObject({ success: false, reason: 'supplier_rejected' });
    expect(wgcardsService.placeDirectOrder).toHaveBeenCalledTimes(1);
  });

  test('network/timeout error is retried, then refunds on final failure', async () => {
    const placementConn = fakeConn([
      [[skuRow]], [[walletRow]], [{}], [{}], [{ insertId: 42 }], [[userRow]],
    ]);
    const refundConn = fakeConn([
      [[{ wallet_id: 1, balance: '90.00' }]], [{}], [{}], [{}],
    ]);
    db.transaction
      .mockImplementationOnce((cb) => cb(placementConn))
      .mockImplementationOnce((cb) => cb(refundConn));
    wgcardsService.apiTopUpParamCheck.mockResolvedValueOnce({ passed: true });
    wgcardsService.placeDirectOrder.mockRejectedValue(new Error('ECONNABORTED'));

    const result = await initiateTopup({ userId: 7, skuId: 5, attributeValues });

    expect(result).toMatchObject({ success: false, reason: 'supplier_timeout' });
    expect(wgcardsService.placeDirectOrder).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  }, 10000);
});

describe('resolveTopup', () => {
  beforeEach(() => jest.clearAllMocks());

  test('unknown orderReference -> found: false', async () => {
    db.queryOne.mockResolvedValueOnce(null);
    const result = await resolveTopup({ orderReference: 'nope', status: 1, resolvedVia: 'webhook' });
    expect(result).toEqual({ found: false });
  });

  test('already-terminal row -> idempotent no-op, no wallet touched', async () => {
    db.queryOne.mockResolvedValueOnce({ topup_order_id: 1, status: 'confirmed' });
    const result = await resolveTopup({ orderReference: 'ref-1', status: 1, resolvedVia: 'webhook' });
    expect(result).toEqual({ found: true, alreadyResolved: true, status: 'confirmed' });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('status 2 (processing) -> not terminal, no email, no refund', async () => {
    db.queryOne.mockResolvedValueOnce({ topup_order_id: 1, status: 'pending', sku_id: 9, user_id: 7, amount: '10.00', currency: 'USD', full_name: 'A', email: 'a@x.com', order_reference: 'ref-1' });
    db.query.mockResolvedValue(undefined);

    const result = await resolveTopup({ orderReference: 'ref-1', wgcardsOrderId: 'wg-1', status: 2, resolvedVia: 'webhook' });

    expect(result).toEqual({ found: true, resolved: false, status: 'processing' });
    expect(emailService.sendTemplate).not.toHaveBeenCalled();
  });

  test('status 1 (success) -> marks confirmed, sends confirmation email', async () => {
    db.queryOne
      .mockResolvedValueOnce({ topup_order_id: 1, status: 'pending', sku_id: 9, user_id: 7, amount: '10.00', currency: 'USD', full_name: 'A', email: 'a@x.com', order_reference: 'ref-1', target_account: '1234' })
      .mockResolvedValueOnce({ product_name: 'Test Game' }); // _productNameForSku
    db.query.mockResolvedValue(undefined);

    const result = await resolveTopup({ orderReference: 'ref-1', wgcardsOrderId: 'wg-1', status: 1, resolvedVia: 'webhook' });

    expect(result).toEqual({ found: true, resolved: true, status: 'confirmed' });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'confirmed'"),
      ['webhook', 1]
    );
    expect(emailService.sendTemplate).toHaveBeenCalledWith('wgcardsDirectTopupConfirmed', 'a@x.com', expect.objectContaining({ Order_Reference: 'ref-1' }));
  });

  test('status 0 (failed) -> refunds the wallet, marks failed, sends failure email', async () => {
    db.queryOne
      .mockResolvedValueOnce({ topup_order_id: 1, status: 'pending', sku_id: 9, user_id: 7, amount: '10.00', currency: 'USD', full_name: 'A', email: 'a@x.com', order_reference: 'ref-1', target_account: '1234' })
      .mockResolvedValueOnce({ product_name: 'Test Game' }); // _productNameForSku
    db.query.mockResolvedValue(undefined);
    const refundConn = fakeConn([
      [[{ wallet_id: 3, balance: '90.00' }]], [{}], [{}], [{}],
    ]);
    db.transaction.mockImplementation((cb) => cb(refundConn));

    const result = await resolveTopup({ orderReference: 'ref-1', wgcardsOrderId: 'wg-1', status: 0, errorMsg: 'recharge failed', resolvedVia: 'reconciler' });

    expect(result).toEqual({ found: true, resolved: true, status: 'failed' });
    expect(emailService.sendTemplate).toHaveBeenCalledWith('wgcardsDirectTopupFailed', 'a@x.com', expect.objectContaining({ Reason: 'recharge failed' }));
  });
});
