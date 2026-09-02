'use strict';

jest.mock('../../config/database');
jest.mock('./../supplierSelection.service');
jest.mock('../wgcardsFulfillment');
jest.mock('../../repositories/supplierLinks.repository');
jest.mock('../email.service');
jest.mock('../audit.service');

const db = require('../../config/database');
const supplierSelection = require('../supplierSelection.service');
const supplierLinksRepo = require('../../repositories/supplierLinks.repository');
const orderService = require('../order.service');

// This exists specifically to cover a real live bug: an internal-sourced
// product that gets a supplier linked to it via confirmLink (Master Plan
// §9/§10) used to never attempt supplier fulfillment at all — the branch
// decision was keyed purely on products.source, which confirmLink never
// touches. See order.service.js#_fulfillOrder's own comment for the story.
describe('_fulfillOrder: source vs. active supplier links', () => {
  beforeEach(() => jest.clearAllMocks());

  test('internal-sourced item with NO active supplier links -> allocates from local digital_codes, never asks supplierSelection', async () => {
    supplierLinksRepo.getActiveLinksForSku.mockResolvedValueOnce([]);
    db.query
      .mockResolvedValueOnce([{ code_id: 1, code: 'enc(CODE1)' }]) // SELECT available digital_codes
      .mockResolvedValueOnce(undefined) // UPDATE digital_codes sold
      .mockResolvedValueOnce(undefined) // UPDATE inventory
      .mockResolvedValueOnce(undefined); // UPDATE order_details delivered_qty

    const result = await orderService._fulfillOrder(
      1, [{ source: 'internal', skuId: 5, productId: 9, productName: 'X', quantity: 1, unitPrice: 1 }], 1
    );

    expect(supplierLinksRepo.getActiveLinksForSku).toHaveBeenCalledWith(5);
    expect(supplierSelection.selectAndFulfill).not.toHaveBeenCalled();
    expect(result.fulfilledItems).toHaveLength(1);
  });

  test('internal-sourced item WITH an active supplier link (confirmLink was used) -> tries supplier fulfillment, never touches local inventory', async () => {
    supplierLinksRepo.getActiveLinksForSku.mockResolvedValueOnce([{ link_id: 1, supplier: 'wgcards' }]);
    supplierSelection.selectAndFulfill.mockResolvedValueOnce({ success: true, wgcardsOrderId: 'WG-1' });

    const result = await orderService._fulfillOrder(
      1, [{ source: 'internal', skuId: 5, productId: 9, productName: 'X', quantity: 1, unitPrice: 1 }], 1
    );

    expect(supplierLinksRepo.getActiveLinksForSku).toHaveBeenCalledWith(5);
    expect(supplierSelection.selectAndFulfill).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 1, item: { skuId: 5, quantity: 1 } })
    );
    expect(db.query).not.toHaveBeenCalledWith(expect.stringContaining('digital_codes'), expect.any(Array));
    expect(result.pendingItems).toHaveLength(1);
    expect(result.pendingItems[0].reason).toBe('awaiting_supplier_delivery');
  });

  test('a wgcards-sourced item never queries sku_supplier_links for the branch decision (already known to need the supplier path)', async () => {
    supplierSelection.selectAndFulfill.mockResolvedValueOnce({ success: true, wgcardsOrderId: 'WG-1' });

    await orderService._fulfillOrder(
      1, [{ source: 'wgcards', skuId: 5, productId: 9, productName: 'X', quantity: 1, unitPrice: 1 }], 1
    );

    expect(supplierLinksRepo.getActiveLinksForSku).not.toHaveBeenCalled();
  });
});
