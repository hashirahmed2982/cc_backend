'use strict';

jest.mock('../../config/database');
jest.mock('./../supplierSelection.service');
jest.mock('../wgcardsFulfillment');
jest.mock('../../repositories/supplierLinks.repository');
jest.mock('../email.service');
jest.mock('../audit.service');
jest.mock('../../utils/dataCrypto', () => ({
  encrypt: jest.fn((v) => `enc(${v})`),
  decrypt: jest.fn((v) => (typeof v === 'string' && v.startsWith('enc(') ? v.slice(4, -1) : v)),
}));

const db = require('../../config/database');
const supplierSelection = require('../supplierSelection.service');
const supplierLinksRepo = require('../../repositories/supplierLinks.repository');
const orderService = require('../order.service');

const baseItem = { skuId: 5, productId: 9, productName: 'X', quantity: 1, unitPrice: 1 };

// Covers a real live bug: an internal-sourced product that gets a supplier
// linked to it via confirmLink (Master Plan §9/§10) used to never attempt
// supplier fulfillment at all — the branch decision was keyed purely on
// products.source, which confirmLink never touches. Also covers the
// business rule that followed: local stock always gets priority, a linked
// supplier is only used for whatever local stock doesn't cover — never the
// other way around, and never both blindly.
describe('_fulfillOrder: local stock priority + supplier fallback', () => {
  beforeEach(() => jest.clearAllMocks());

  test('local stock fully covers the line -> delivered locally, supplier never asked even though a link exists', async () => {
    db.query
      .mockResolvedValueOnce([{ code_id: 1, code: 'enc(CODE1)' }]) // SELECT available digital_codes
      .mockResolvedValueOnce(undefined) // UPDATE digital_codes sold
      .mockResolvedValueOnce(undefined) // UPDATE inventory
      .mockResolvedValueOnce(undefined); // UPDATE order_details delivered_qty

    const result = await orderService._fulfillOrder(1, [{ ...baseItem, source: 'internal' }], 1);

    expect(supplierLinksRepo.getActiveLinksForSku).not.toHaveBeenCalled(); // never even checked — no need, local covered it
    expect(supplierSelection.selectAndFulfill).not.toHaveBeenCalled();
    expect(result.fulfilledItems).toEqual([
      { productId: 9, productName: 'X', skuId: 5, quantity: 1, delivered: 1, codes: ['CODE1'] },
    ]);
    expect(result.pendingItems).toHaveLength(0);
  });

  test('internal-sourced item, NO local stock, NO active supplier links -> pending insufficient_inventory, no supplier call', async () => {
    db.query.mockResolvedValueOnce([]); // SELECT available digital_codes -> none
    supplierLinksRepo.getActiveLinksForSku.mockResolvedValueOnce([]);

    const result = await orderService._fulfillOrder(1, [{ ...baseItem, source: 'internal' }], 1);

    expect(supplierSelection.selectAndFulfill).not.toHaveBeenCalled();
    expect(result.pendingItems).toEqual([
      { productId: 9, productName: 'X', skuId: 5, quantity: 1, unitPrice: 1, delivered: 0, pending: 1, reason: 'insufficient_inventory', supplierOrderId: null },
    ]);
  });

  test('internal-sourced item, NO local stock, an active supplier link exists (confirmLink was used) -> supplier is asked for the FULL quantity', async () => {
    db.query.mockResolvedValueOnce([]); // no local stock
    supplierLinksRepo.getActiveLinksForSku.mockResolvedValueOnce([{ link_id: 1, supplier: 'wgcards' }]);
    supplierSelection.selectAndFulfill.mockResolvedValueOnce({ success: true, wgcardsOrderId: 'WG-1' });

    const result = await orderService._fulfillOrder(1, [{ ...baseItem, quantity: 3, source: 'internal' }], 1);

    expect(supplierSelection.selectAndFulfill).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 1, item: { skuId: 5, quantity: 3 } })
    );
    expect(result.pendingItems[0]).toMatchObject({ delivered: 0, pending: 3, reason: 'awaiting_supplier_delivery', supplierOrderId: 'WG-1' });
  });

  test('internal-sourced item, PARTIAL local stock, an active supplier link -> local delivers what it has, supplier is asked for exactly the shortfall', async () => {
    db.query
      .mockResolvedValueOnce([{ code_id: 1, code: 'enc(CODE1)' }]) // only 1 of 3 available locally
      .mockResolvedValueOnce(undefined) // UPDATE digital_codes sold
      .mockResolvedValueOnce(undefined) // UPDATE inventory
      .mockResolvedValueOnce(undefined); // UPDATE order_details delivered_qty
    supplierLinksRepo.getActiveLinksForSku.mockResolvedValueOnce([{ link_id: 1, supplier: 'gift2games' }]);
    supplierSelection.selectAndFulfill.mockResolvedValueOnce({ success: true, gift2gamesOrderId: 'G2G-1' });

    const result = await orderService._fulfillOrder(1, [{ ...baseItem, quantity: 3, source: 'internal' }], 1);

    // The supplier must only ever be asked for the 2 units local stock
    // didn't cover — never the original 3.
    expect(supplierSelection.selectAndFulfill).toHaveBeenCalledWith(
      expect.objectContaining({ item: { skuId: 5, quantity: 2 } })
    );
    expect(result.fulfilledItems[0]).toMatchObject({ delivered: 1, codes: ['CODE1'] });
    expect(result.pendingItems[0]).toMatchObject({ delivered: 1, pending: 2, reason: 'awaiting_supplier_delivery', supplierOrderId: 'G2G-1' });
  });

  test('local delivers some, supplier ALSO synchronously delivers some (Gift2Games) -> both counted together, delivered/pending are correct', async () => {
    db.query
      .mockResolvedValueOnce([{ code_id: 1, code: 'enc(CODE1)' }]) // 1 of 2 available locally
      .mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    supplierLinksRepo.getActiveLinksForSku.mockResolvedValueOnce([{ link_id: 1, supplier: 'gift2games' }]);
    supplierSelection.selectAndFulfill.mockResolvedValueOnce({
      success: true, gift2gamesOrderId: 'G2G-1', delivered: true, codes: ['CODE2'],
    });

    const result = await orderService._fulfillOrder(1, [{ ...baseItem, quantity: 2, source: 'internal' }], 1);

    expect(result.fulfilledItems[0]).toMatchObject({ delivered: 2, codes: ['CODE1', 'CODE2'] });
    expect(result.pendingItems).toHaveLength(0); // fully covered between the two sources
  });

  test('wgcards-sourced item (typical: zero local stock ever exists) -> supplier asked for full quantity, sku_supplier_links check skipped entirely', async () => {
    db.query.mockResolvedValueOnce([]); // no local stock — expected for a pure supplier product
    supplierSelection.selectAndFulfill.mockResolvedValueOnce({ success: true, wgcardsOrderId: 'WG-1' });

    await orderService._fulfillOrder(1, [{ ...baseItem, source: 'wgcards' }], 1);

    expect(supplierLinksRepo.getActiveLinksForSku).not.toHaveBeenCalled(); // source alone already answers it
    expect(supplierSelection.selectAndFulfill).toHaveBeenCalledWith(
      expect.objectContaining({ item: { skuId: 5, quantity: 1 } })
    );
  });

  test('supplier attempt fails outright after a partial local delivery -> reports what was delivered locally, pending reflects the supplier failure reason', async () => {
    db.query
      .mockResolvedValueOnce([{ code_id: 1, code: 'enc(CODE1)' }])
      .mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    supplierLinksRepo.getActiveLinksForSku.mockResolvedValueOnce([{ link_id: 1, supplier: 'wgcards' }]);
    supplierSelection.selectAndFulfill.mockResolvedValueOnce({ success: false, reason: 'supplier_rejected' });

    const result = await orderService._fulfillOrder(1, [{ ...baseItem, quantity: 2, source: 'internal' }], 1);

    expect(result.fulfilledItems[0]).toMatchObject({ delivered: 1 });
    expect(result.pendingItems[0]).toMatchObject({ delivered: 1, pending: 1, reason: 'supplier_rejected', supplierOrderId: null });
  });
});

function fakeConn(results) {
  const execute = jest.fn();
  results.forEach((r) => execute.mockResolvedValueOnce(r));
  return { execute, beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() };
}

// Neither WgCards nor Gift2Games exposes a cancel/refund API — a line
// whose supplier order is already placed can't be un-ordered. These cover
// the fix: such a line is left pending/partial (tagged with a reason)
// instead of being marked failed, so orderPoller.js/gift2gamesOrderPoller.js
// keep watching it and can still recover a late-arriving code as spare
// stock rather than losing it outright.
describe('cancelOrder', () => {
  beforeEach(() => jest.clearAllMocks());

  const orderRow = {
    order_id: 1, order_number: 'ORD-1', order_status: 'processing', full_name: 'A', email: 'a@x.com',
    client_user_id: 3, wallet_id: 7, walletBalance: 10, currency: 'USD',
  };

  test('throws when the order does not exist', async () => {
    const conn = fakeConn([[[]]]);
    db.getConnection.mockResolvedValueOnce(conn);
    await expect(orderService.cancelOrder(1, 99, '')).rejects.toThrow(/not found/);
    expect(conn.rollback).toHaveBeenCalled();
  });

  test('throws when already cancelled', async () => {
    const conn = fakeConn([[[{ ...orderRow, order_status: 'cancelled' }]]]);
    db.getConnection.mockResolvedValueOnce(conn);
    await expect(orderService.cancelOrder(1, 99, '')).rejects.toThrow(/already cancelled/);
  });

  test('a line with NO supplier order placed -> marked failed immediately, full refund', async () => {
    const conn = fakeConn([
      [[orderRow]],
      [[{ order_detail_id: 1, product_id: 9, product_name: 'X', quantity: 2, delivered_qty: 0, unit_price: 5, wgcards_order_id: null, gift2games_order_id: null }]],
      undefined, undefined, undefined, undefined, undefined, undefined,
    ]);
    db.getConnection.mockResolvedValueOnce(conn);

    const result = await orderService.cancelOrder(1, 99, 'test reason');

    expect(result.refundAmount).toBe(10); // 2 * 5, nothing delivered
    const failedCall = conn.execute.mock.calls.find(
      ([sql]) => sql.includes("delivery_status = 'failed'") && sql.includes('wgcards_order_id IS NULL')
    );
    expect(failedCall).toBeTruthy();
  });

  test("a line WITH a supplier order already placed -> NOT marked failed, tagged 'cancelled_recovering_supplier_cost' instead, still refunded to the customer", async () => {
    const conn = fakeConn([
      [[orderRow]],
      [[{ order_detail_id: 2, product_id: 9, product_name: 'X', quantity: 1, delivered_qty: 0, unit_price: 8, wgcards_order_id: 'WG-1', gift2games_order_id: null }]],
      undefined, undefined, undefined, undefined, undefined, undefined,
    ]);
    db.getConnection.mockResolvedValueOnce(conn);

    const result = await orderService.cancelOrder(1, 99, '');

    expect(result.refundAmount).toBe(8); // customer is still refunded immediately
    const failedCall = conn.execute.mock.calls.find(
      ([sql]) => sql.includes("delivery_status = 'failed'") && sql.includes('wgcards_order_id IS NULL')
    );
    // The blanket "no supplier order" UPDATE runs regardless (it's a WHERE
    // clause, not a branch) but must not have matched this row — verified
    // via the reason UPDATE below actually being the one that applies.
    expect(failedCall).toBeTruthy();
    const reasonCall = conn.execute.mock.calls.find(([sql]) => sql.includes('cancelled_recovering_supplier_cost'));
    expect(reasonCall).toBeTruthy();
    expect(reasonCall[0]).toContain('wgcards_order_id IS NOT NULL OR gift2games_order_id IS NOT NULL');
  });

  test('fully delivered line -> zero refund, order still flips to cancelled (no wallet writes at all)', async () => {
    const conn = fakeConn([
      [[orderRow]],
      [[{ order_detail_id: 3, product_id: 9, product_name: 'X', quantity: 1, delivered_qty: 1, unit_price: 8, wgcards_order_id: null, gift2games_order_id: null }]],
      undefined, undefined, undefined, undefined,
    ]);
    db.getConnection.mockResolvedValueOnce(conn);

    const result = await orderService.cancelOrder(1, 99, '');

    expect(result.refundAmount).toBe(0);
    expect(conn.execute).toHaveBeenCalledTimes(6); // no wallet UPDATE/INSERT when refundAmount is 0
  });
});
