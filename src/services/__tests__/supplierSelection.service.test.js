'use strict';

jest.mock('../../config/database', () => ({ queryOne: jest.fn(), query: jest.fn() }));
jest.mock('../../repositories/supplierConfig.repository', () => ({ getBySupplierName: jest.fn() }));
jest.mock('../../repositories/supplierLinks.repository', () => ({ getActiveLinksForSku: jest.fn() }));
jest.mock('../wgcardsFulfillment', () => ({ attemptFulfillment: jest.fn() }));
jest.mock('../gift2gamesFulfillment', () => ({ attemptFulfillment: jest.fn() }));

const db = require('../../config/database');
const supplierConfigRepo = require('../../repositories/supplierConfig.repository');
const supplierLinksRepo = require('../../repositories/supplierLinks.repository');
const wgcardsFulfillment = require('../wgcardsFulfillment');
const gift2gamesFulfillment = require('../gift2gamesFulfillment');
const { selectAndFulfill } = require('../supplierSelection.service');

const wgcardsLink = { link_id: 1, sku_id: 5, supplier: 'wgcards', supplier_sku_ref: 'wg-1', cost_price: 10, cost_price_base_currency: 10, admin_priority_override: null };
const gift2gamesLink = { link_id: 2, sku_id: 5, supplier: 'gift2games', supplier_sku_ref: 'g2g-1', cost_price: 8, cost_price_base_currency: 8, admin_priority_override: null };
const healthyCfg = { is_active: 1, integration_status: 'healthy' };

describe('supplierSelection.selectAndFulfill', () => {
  beforeEach(() => jest.clearAllMocks());

  test('already fulfilled (fulfillment_supplier set) short-circuits — no links queried, no supplier called', async () => {
    db.queryOne.mockResolvedValueOnce({ fulfillment_supplier: 'wgcards' });

    const result = await selectAndFulfill({ orderId: 1, item: { skuId: 5, quantity: 1 } });

    expect(result).toEqual({ success: true, alreadyPlaced: true, supplier: 'wgcards' });
    expect(supplierLinksRepo.getActiveLinksForSku).not.toHaveBeenCalled();
  });

  test('no active links at all -> no_active_supplier_link', async () => {
    db.queryOne.mockResolvedValueOnce(null);
    supplierLinksRepo.getActiveLinksForSku.mockResolvedValueOnce([]);

    const result = await selectAndFulfill({ orderId: 1, item: { skuId: 5, quantity: 1 } });

    expect(result).toEqual({ success: false, reason: 'no_active_supplier_link' });
  });

  test('single link, supplier down (circuit breaker) -> filtered out entirely, no attempt made', async () => {
    db.queryOne.mockResolvedValueOnce(null); // fulfillment_supplier check
    supplierLinksRepo.getActiveLinksForSku.mockResolvedValueOnce([wgcardsLink]);
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ is_active: 1, integration_status: 'down' });

    const result = await selectAndFulfill({ orderId: 1, item: { skuId: 5, quantity: 1 } });

    expect(result).toEqual({ success: false, reason: 'no_usable_supplier_link' });
    expect(wgcardsFulfillment.attemptFulfillment).not.toHaveBeenCalled();
  });

  test('single link, supplier admin-disabled (is_active false) -> filtered out entirely', async () => {
    db.queryOne.mockResolvedValueOnce(null);
    supplierLinksRepo.getActiveLinksForSku.mockResolvedValueOnce([wgcardsLink]);
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ is_active: 0, integration_status: 'healthy' });

    const result = await selectAndFulfill({ orderId: 1, item: { skuId: 5, quantity: 1 } });

    expect(result).toEqual({ success: false, reason: 'no_usable_supplier_link' });
    expect(wgcardsFulfillment.attemptFulfillment).not.toHaveBeenCalled();
  });

  test('happy path: single usable link succeeds, records the attempt, sets fulfillment_supplier', async () => {
    db.queryOne
      .mockResolvedValueOnce(null) // fulfillment_supplier check
      .mockResolvedValueOnce({ fulfillment_attempts: null }); // _recordAttempt's read
    db.query.mockResolvedValue(undefined);
    supplierLinksRepo.getActiveLinksForSku.mockResolvedValueOnce([wgcardsLink]);
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce(healthyCfg);
    wgcardsFulfillment.attemptFulfillment.mockResolvedValueOnce({ success: true, wgcardsOrderId: 'ORD-1', serviceOrder: 'svc-1' });

    const result = await selectAndFulfill({ orderId: 1, item: { skuId: 5, quantity: 1 } });

    expect(result).toMatchObject({ success: true, supplier: 'wgcards', wgcardsOrderId: 'ORD-1' });
    expect(gift2gamesFulfillment.attemptFulfillment).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE order_details SET fulfillment_supplier'),
      ['wgcards', 1, 5]
    );
    const attemptWrite = db.query.mock.calls.find(([sql]) => sql.includes('fulfillment_attempts'));
    expect(JSON.parse(attemptWrite[1][0])[0]).toMatchObject({ supplier: 'wgcards', result: 'success' });
  });

  test('cheapest-first: gift2games (cheaper) is tried before wgcards, wgcards never called', async () => {
    db.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ fulfillment_attempts: null });
    db.query.mockResolvedValue(undefined);
    supplierLinksRepo.getActiveLinksForSku.mockResolvedValueOnce([wgcardsLink, gift2gamesLink]); // wgcards=10, gift2games=8
    supplierConfigRepo.getBySupplierName.mockResolvedValue(healthyCfg);
    gift2gamesFulfillment.attemptFulfillment.mockResolvedValueOnce({ success: true, gift2gamesOrderId: 'G2G-1', referenceNumber: 'ref-1' });

    const result = await selectAndFulfill({ orderId: 1, item: { skuId: 5, quantity: 1 } });

    expect(result).toMatchObject({ success: true, supplier: 'gift2games' });
    expect(wgcardsFulfillment.attemptFulfillment).not.toHaveBeenCalled();
  });

  test('failover: cheapest supplier business-rejects, next-cheapest succeeds, both attempts recorded', async () => {
    db.queryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ fulfillment_attempts: null })
      .mockResolvedValueOnce({ fulfillment_attempts: JSON.stringify([{ supplier: 'gift2games', result: 'failed' }]) });
    db.query.mockResolvedValue(undefined);
    supplierLinksRepo.getActiveLinksForSku.mockResolvedValueOnce([wgcardsLink, gift2gamesLink]);
    supplierConfigRepo.getBySupplierName.mockResolvedValue(healthyCfg);
    gift2gamesFulfillment.attemptFulfillment.mockResolvedValueOnce({ success: false, reason: 'supplier_rejected' });
    wgcardsFulfillment.attemptFulfillment.mockResolvedValueOnce({ success: true, wgcardsOrderId: 'ORD-2' });

    const result = await selectAndFulfill({ orderId: 1, item: { skuId: 5, quantity: 1 } });

    expect(result).toMatchObject({ success: true, supplier: 'wgcards' });
    expect(gift2gamesFulfillment.attemptFulfillment).toHaveBeenCalledTimes(1);
    expect(wgcardsFulfillment.attemptFulfillment).toHaveBeenCalledTimes(1);
    const secondAttemptWrite = db.query.mock.calls.filter(([sql]) => sql.includes('fulfillment_attempts'))[1];
    const history = JSON.parse(secondAttemptWrite[1][0]);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ supplier: 'gift2games', result: 'failed' });
    expect(history[1]).toMatchObject({ supplier: 'wgcards', result: 'success' });
  });

  test('every link tried and failed -> pendingItems, fulfillment_supplier never set', async () => {
    db.queryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ fulfillment_attempts: null })
      .mockResolvedValueOnce({ fulfillment_attempts: '[]' });
    db.query.mockResolvedValue(undefined);
    supplierLinksRepo.getActiveLinksForSku.mockResolvedValueOnce([wgcardsLink, gift2gamesLink]);
    supplierConfigRepo.getBySupplierName.mockResolvedValue(healthyCfg);
    gift2gamesFulfillment.attemptFulfillment.mockResolvedValueOnce({ success: false, reason: 'supplier_timeout' });
    wgcardsFulfillment.attemptFulfillment.mockResolvedValueOnce({ success: false, reason: 'supplier_rejected' });

    const result = await selectAndFulfill({ orderId: 1, item: { skuId: 5, quantity: 1 } });

    expect(result).toMatchObject({ success: false, reason: 'supplier_rejected' }); // last attempt's result
    expect(db.query).not.toHaveBeenCalledWith(expect.stringContaining('fulfillment_supplier ='), expect.anything());
  });

  test('always_prefer override skips price comparison entirely, even against a cheaper link', async () => {
    db.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ fulfillment_attempts: null });
    db.query.mockResolvedValue(undefined);
    const preferredWgcards = { ...wgcardsLink, admin_priority_override: 'always_prefer' }; // pricier (10) but preferred
    supplierLinksRepo.getActiveLinksForSku.mockResolvedValueOnce([preferredWgcards, gift2gamesLink]); // gift2games is cheaper (8)
    supplierConfigRepo.getBySupplierName.mockResolvedValue(healthyCfg);
    wgcardsFulfillment.attemptFulfillment.mockResolvedValueOnce({ success: true, wgcardsOrderId: 'ORD-3' });

    const result = await selectAndFulfill({ orderId: 1, item: { skuId: 5, quantity: 1 } });

    expect(result).toMatchObject({ success: true, supplier: 'wgcards' });
    expect(gift2gamesFulfillment.attemptFulfillment).not.toHaveBeenCalled();
  });

  test('never_use override excludes a link even if it is the only option', async () => {
    db.queryOne.mockResolvedValueOnce(null);
    const neverUse = { ...wgcardsLink, admin_priority_override: 'never_use' };
    supplierLinksRepo.getActiveLinksForSku.mockResolvedValueOnce([neverUse]);
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce(healthyCfg);

    const result = await selectAndFulfill({ orderId: 1, item: { skuId: 5, quantity: 1 } });

    expect(result).toEqual({ success: false, reason: 'no_usable_supplier_link' });
    expect(wgcardsFulfillment.attemptFulfillment).not.toHaveBeenCalled();
  });

  test('a fulfillment module throwing unexpectedly is caught and treated as a failed attempt, not aborted', async () => {
    db.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ fulfillment_attempts: null });
    db.query.mockResolvedValue(undefined);
    supplierLinksRepo.getActiveLinksForSku.mockResolvedValueOnce([wgcardsLink]);
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce(healthyCfg);
    wgcardsFulfillment.attemptFulfillment.mockRejectedValueOnce(new Error('boom'));

    const result = await selectAndFulfill({ orderId: 1, item: { skuId: 5, quantity: 1 } });

    expect(result).toMatchObject({ success: false, reason: 'unexpected_error' });
  });
});
