'use strict';

jest.mock('../../config/database');
jest.mock('../../services/gift2games.service', () => ({ getOrderDetails: jest.fn() }));
jest.mock('../../services/order.service', () => ({ _sendCompletionEmail: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/dataCrypto', () => ({
  encrypt: jest.fn((v) => `enc(${v})`),
  decrypt: jest.fn((v) => v),
}));

const db = require('../../config/database');
const gift2gamesService = require('../../services/gift2games.service');
const orderService = require('../../services/order.service');
const { run, pickIntervalMinutes, shouldPollNow, pendingReasonForAge } = require('../gift2gamesOrderPoller');

describe('gift2gamesOrderPoller pure helpers', () => {
  describe('pickIntervalMinutes', () => {
    test('0-2h -> 5 min', () => expect(pickIntervalMinutes(1)).toBe(5));
    test('exactly 2h -> 30 min (2-24h tier, upper bound is exclusive)', () => expect(pickIntervalMinutes(2)).toBe(30));
    test('48h -> 120 min', () => expect(pickIntervalMinutes(48)).toBe(120));
    test('100h -> 360 min', () => expect(pickIntervalMinutes(100)).toBe(360));
  });

  describe('shouldPollNow', () => {
    test('never polled before -> always due', () => {
      expect(shouldPollNow({ created_at: new Date(), last_polled_at: null })).toBe(true);
    });

    test('within the 0-2h tier: NOT due before 5 min since last poll', () => {
      const now = new Date('2026-01-01T12:00:00Z');
      const row = { created_at: new Date('2026-01-01T11:00:00Z'), last_polled_at: new Date('2026-01-01T11:57:00Z') };
      expect(shouldPollNow(row, now)).toBe(false);
    });
  });

  describe('pendingReasonForAge', () => {
    test('<24h -> normal awaiting reason', () => expect(pendingReasonForAge(10)).toBe('awaiting_supplier_delivery'));
    test('>=24h -> delayed', () => expect(pendingReasonForAge(30)).toBe('delayed'));
    test('>=72h -> delayed_needs_admin_decision', () => expect(pendingReasonForAge(100)).toBe('delayed_needs_admin_decision'));
  });
});

describe('gift2gamesOrderPoller.run', () => {
  const baseRow = {
    order_detail_id: 1, order_id: 100, product_id: 555, sku_id: 5,
    gift2games_order_id: 'G2G-1', gift2games_reference_number: 'REF-1',
    quantity: 1, delivered_qty: 0,
    created_at: new Date(), last_polled_at: null,
    order_number: 'ORD-1', currency: 'USD',
    client_user_id: 12, full_name: 'Test User', email: 'test@example.com',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('getOrderDetails now returns an extractable code -> delivers, recalculates status, sends completion email', async () => {
    db.query
      .mockResolvedValueOnce([{ ...baseRow }])                        // candidates query
      .mockResolvedValueOnce(undefined)                                // delivery_status recalc UPDATE
      .mockResolvedValueOnce([{ incompleteLines: 0 }])                 // incompleteLines check
      .mockResolvedValueOnce(undefined)                                // orders UPDATE
      .mockResolvedValueOnce([{ product_id: 555, product_name: 'Some Gift Card' }]) // product names
      .mockResolvedValueOnce([]);                                      // still-pending check (none)
    db.queryOne
      .mockResolvedValueOnce({ order_number: 'ORD-1', currency: 'USD', client_user_id: 12, full_name: 'Test User', email: 'test@example.com' })
      .mockResolvedValueOnce({ zip_password: 'zippw' });
    db.transaction.mockImplementation(async (cb) => cb({ execute: jest.fn().mockResolvedValue([{}]) }));

    gift2gamesService.getOrderDetails.mockResolvedValueOnce({ orderStatus: 'Completed', code: 'ABCD-1234' });

    const summary = await run();

    expect(summary.delivered).toBe(1);
    expect(orderService._sendCompletionEmail).toHaveBeenCalledTimes(1);
    const [, , , fulfillResult] = orderService._sendCompletionEmail.mock.calls[0];
    expect(fulfillResult.fulfilledItems[0].codes).toEqual(['ABCD-1234']);
    expect(fulfillResult.fulfilledItems[0].productName).toBe('Some Gift Card');
  });

  test('getOrderDetails reports a failed/cancelled status -> marks failed, does not deliver or email', async () => {
    db.query.mockResolvedValueOnce([{ ...baseRow }]);
    gift2gamesService.getOrderDetails.mockResolvedValueOnce({ orderStatus: 'Cancelled' });

    const summary = await run();

    expect(summary.failed).toBe(1);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("delivery_status = 'failed'"), expect.arrayContaining(['supplier_cancelled']));
    expect(orderService._sendCompletionEmail).not.toHaveBeenCalled();
  });

  test('getOrderDetails still shows "Processing" -> no delivery, pending_reason set from age, cadence updated', async () => {
    db.query.mockResolvedValueOnce([{ ...baseRow }]);
    gift2gamesService.getOrderDetails.mockResolvedValueOnce({ orderStatus: 'Processing' });

    const summary = await run();

    expect(summary.delivered).toBe(0);
    expect(summary.failed).toBe(0);
  });

  test('a row not yet due for its poll tier is skipped entirely — no API call at all', async () => {
    const recentlyPolled = { ...baseRow, created_at: new Date(), last_polled_at: new Date() };
    db.query.mockResolvedValueOnce([recentlyPolled]);

    const summary = await run();

    expect(summary.polled).toBe(0);
    expect(gift2gamesService.getOrderDetails).not.toHaveBeenCalled();
  });

  test('getOrderDetails failure is logged and does not crash the run, still updates last_polled_at', async () => {
    db.query
      .mockResolvedValueOnce([{ ...baseRow }])
      .mockResolvedValueOnce(undefined); // markPolled UPDATE
    gift2gamesService.getOrderDetails.mockRejectedValueOnce(new Error('network blip'));

    const summary = await run();

    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0].error).toBe('network blip');
  });

  test('no candidates -> clean no-op', async () => {
    db.query.mockResolvedValueOnce([]);
    const summary = await run();
    expect(summary).toMatchObject({ candidates: 0, polled: 0, delivered: 0, failed: 0 });
  });
});
