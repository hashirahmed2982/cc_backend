'use strict';

jest.mock('../../config/database', () => ({ query: jest.fn(), end: jest.fn() }));
jest.mock('../../services/wgcardsTopup.service', () => ({ resolveTopup: jest.fn() }));
jest.mock('../../repositories/supplierConfig.repository');
jest.mock('../orderPoller', () => ({
  findDeliveryStatusViaList: jest.fn(),
  DELIVERY_STATUS: { PENDING: 1, PARTIAL: 2, FULL: 3, PARTIAL_CANCELLED: 4, FULL_CANCELLED: 5 },
}));

const db = require('../../config/database');
const wgcardsTopupService = require('../../services/wgcardsTopup.service');
const supplierConfigRepo = require('../../repositories/supplierConfig.repository');
const { findDeliveryStatusViaList } = require('../orderPoller');
const { run, deliveryStatusToTopupStatus } = require('../wgcardsTopupReconciler');

describe('deliveryStatusToTopupStatus', () => {
  test('FULL (3) -> 1 (success)', () => expect(deliveryStatusToTopupStatus(3)).toBe(1));
  test('PARTIAL_CANCELLED (4) -> 0 (failed)', () => expect(deliveryStatusToTopupStatus(4)).toBe(0));
  test('FULL_CANCELLED (5) -> 0 (failed)', () => expect(deliveryStatusToTopupStatus(5)).toBe(0));
  test('PENDING/PARTIAL -> 2 (still in flight)', () => {
    expect(deliveryStatusToTopupStatus(1)).toBe(2);
    expect(deliveryStatusToTopupStatus(2)).toBe(2);
  });
});

describe('wgcardsTopupReconciler.run', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    supplierConfigRepo.getBySupplierName.mockResolvedValue({ is_active: 1 });
  });

  test('supplier disabled by admin -> skips entirely, never queries wgcards_topup_orders', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ is_active: 0 });

    const result = await run();

    expect(result).toEqual({ skipped: true, reason: 'supplier_disabled' });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('no rows past the 35-min mark -> no-op', async () => {
    db.query.mockResolvedValueOnce([]);
    const result = await run();
    expect(result).toEqual({ checked: 0, resolved: 0, stillPending: 0, errors: 0 });
    expect(findDeliveryStatusViaList).not.toHaveBeenCalled();
  });

  test('not found in the getOrderInfo fallback window -> left pending for next pass', async () => {
    db.query.mockResolvedValueOnce([{ topup_order_id: 1, order_reference: 'ref-1', wgcards_order_id: 'wg-1' }]);
    findDeliveryStatusViaList.mockResolvedValueOnce({ found: false });

    const result = await run();

    expect(result).toEqual({ checked: 1, resolved: 0, stillPending: 1, errors: 0 });
    expect(wgcardsTopupService.resolveTopup).not.toHaveBeenCalled();
  });

  test('found but still in flight (deliveryStatus PENDING) -> not resolved yet', async () => {
    db.query.mockResolvedValueOnce([{ topup_order_id: 1, order_reference: 'ref-1', wgcards_order_id: 'wg-1' }]);
    findDeliveryStatusViaList.mockResolvedValueOnce({ found: true, deliveryStatus: 1 });

    const result = await run();

    expect(result.stillPending).toBe(1);
    expect(wgcardsTopupService.resolveTopup).not.toHaveBeenCalled();
  });

  test('found and FULL -> resolves as confirmed via reconciler', async () => {
    db.query.mockResolvedValueOnce([{ topup_order_id: 1, order_reference: 'ref-1', wgcards_order_id: 'wg-1' }]);
    findDeliveryStatusViaList.mockResolvedValueOnce({ found: true, deliveryStatus: 3 });
    wgcardsTopupService.resolveTopup.mockResolvedValueOnce({ found: true, resolved: true, status: 'confirmed' });

    const result = await run();

    expect(result.resolved).toBe(1);
    expect(wgcardsTopupService.resolveTopup).toHaveBeenCalledWith(
      expect.objectContaining({ orderReference: 'ref-1', wgcardsOrderId: 'wg-1', status: 1, resolvedVia: 'reconciler' })
    );
  });

  test('a per-row failure is caught and counted, does not abort the batch', async () => {
    db.query.mockResolvedValueOnce([
      { topup_order_id: 1, order_reference: 'ref-1', wgcards_order_id: 'wg-1' },
      { topup_order_id: 2, order_reference: 'ref-2', wgcards_order_id: 'wg-2' },
    ]);
    findDeliveryStatusViaList
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ found: true, deliveryStatus: 5 });
    wgcardsTopupService.resolveTopup.mockResolvedValueOnce({ found: true, resolved: true, status: 'failed' });

    const result = await run();

    expect(result).toEqual({ checked: 2, resolved: 1, stillPending: 0, errors: 1 });
  });
});
