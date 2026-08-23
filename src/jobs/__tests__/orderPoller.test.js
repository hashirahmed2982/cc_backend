'use strict';

jest.mock('../../config/database');
jest.mock('../../services/wgcards.service');
jest.mock('../../services/order.service', () => ({ _sendCompletionEmail: jest.fn().mockResolvedValue(undefined) }));

const db = require('../../config/database');
const wgcardsService = require('../../services/wgcards.service');
const orderService = require('../../services/order.service');
const {
  run, DELIVERY_STATUS,
  pickIntervalMinutes, shouldPollNow, newRecordsSince, pendingReasonForAge,
} = require('../orderPoller');

describe('orderPoller pure helpers', () => {
  describe('pickIntervalMinutes', () => {
    test('0-2h -> 5 min', () => expect(pickIntervalMinutes(1)).toBe(5));
    test('exactly 2h -> 30 min (2-24h tier, upper bound is exclusive)', () => expect(pickIntervalMinutes(2)).toBe(30));
    test('12h -> 30 min', () => expect(pickIntervalMinutes(12)).toBe(30));
    test('48h -> 120 min', () => expect(pickIntervalMinutes(48)).toBe(120));
    test('100h -> 360 min', () => expect(pickIntervalMinutes(100)).toBe(360));
  });

  describe('shouldPollNow', () => {
    test('never polled before -> always due', () => {
      expect(shouldPollNow({ created_at: new Date(), last_polled_at: null })).toBe(true);
    });

    test('within the 0-2h tier: due after 5+ min since last poll', () => {
      const now = new Date('2026-01-01T12:00:00Z');
      const row = { created_at: new Date('2026-01-01T11:00:00Z'), last_polled_at: new Date('2026-01-01T11:54:00Z') };
      expect(shouldPollNow(row, now)).toBe(true); // 6 min since last poll >= 5
    });

    test('within the 0-2h tier: NOT due before 5 min since last poll', () => {
      const now = new Date('2026-01-01T12:00:00Z');
      const row = { created_at: new Date('2026-01-01T11:00:00Z'), last_polled_at: new Date('2026-01-01T11:57:00Z') };
      expect(shouldPollNow(row, now)).toBe(false); // only 3 min since last poll
    });

    test('an old (30h) order on its last poll 1h ago is NOT due (needs 2h in that tier)', () => {
      const now = new Date('2026-01-03T00:00:00Z');
      const row = { created_at: new Date('2026-01-01T18:00:00Z'), last_polled_at: new Date('2026-01-02T23:00:00Z') };
      expect(shouldPollNow(row, now)).toBe(false);
    });
  });

  describe('newRecordsSince', () => {
    test('returns only records past the already-delivered count', () => {
      const records = [{ skuId: 'a' }, { skuId: 'b' }, { skuId: 'c' }];
      expect(newRecordsSince(records, 1)).toEqual([{ skuId: 'b' }, { skuId: 'c' }]);
    });

    test('nothing new if already delivered >= records length', () => {
      const records = [{ skuId: 'a' }];
      expect(newRecordsSince(records, 1)).toEqual([]);
      expect(newRecordsSince(records, 5)).toEqual([]);
    });
  });

  describe('pendingReasonForAge', () => {
    test('<24h -> normal awaiting reason', () => expect(pendingReasonForAge(10)).toBe('awaiting_supplier_delivery'));
    test('>=24h -> delayed', () => expect(pendingReasonForAge(30)).toBe('delayed'));
    test('>=72h -> delayed_needs_admin_decision', () => expect(pendingReasonForAge(100)).toBe('delayed_needs_admin_decision'));
  });
});

describe('orderPoller.run', () => {
  const baseRow = {
    order_detail_id: 1, order_id: 100, product_id: 11391, sku_id: 5,
    wgcards_order_id: 'WG-1', quantity: 1, delivered_qty: 0,
    created_at: new Date(), last_polled_at: null,
    order_number: 'ORD-1', currency: 'USD',
    client_user_id: 12, full_name: 'Test User', email: 'test@example.com',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('deliveryStatus FULL (3): fetches codes, writes them, recalculates status, sends completion email', async () => {
    db.query
      .mockResolvedValueOnce([{ ...baseRow }])                      // candidates query
      .mockResolvedValueOnce(undefined)                              // delivery_status recalc UPDATE
      .mockResolvedValueOnce([{ incompleteLines: 0 }])               // incompleteLines check
      .mockResolvedValueOnce(undefined)                              // orders UPDATE
      .mockResolvedValueOnce([{ product_id: 11391, product_name: 'Airplane-chefs' }]) // product names
      .mockResolvedValueOnce([]);                                    // still-pending check (none)
    db.queryOne
      .mockResolvedValueOnce({ order_number: 'ORD-1', currency: 'USD', client_user_id: 12, full_name: 'Test User', email: 'test@example.com' })
      .mockResolvedValueOnce({ zip_password: 'zippw' });
    db.transaction.mockImplementation(async (cb) => cb({ execute: jest.fn().mockResolvedValue([{}]) }));

    wgcardsService.getOrderInfoAndDetail.mockResolvedValueOnce({ firstTo: { deliveryStatus: DELIVERY_STATUS.FULL } });
    wgcardsService.getBuyCard.mockResolvedValueOnce({ records: [{ skuId: '12182768136', card: 'CODE1', pinCode: 'PIN1', snCode: 'SN1' }] });

    const summary = await run();

    expect(summary.delivered).toBe(1);
    expect(orderService._sendCompletionEmail).toHaveBeenCalledTimes(1);
    const [, , , fulfillResult] = orderService._sendCompletionEmail.mock.calls[0];
    expect(fulfillResult.fulfilledItems[0].codes).toEqual(['CODE1']);
    expect(fulfillResult.fulfilledItems[0].productName).toBe('Airplane-chefs');
  });

  test('deliveryStatus CANCELLED (5): marks the line failed/supplier_cancelled, does NOT touch the wallet or send email', async () => {
    db.query.mockResolvedValueOnce([{ ...baseRow }]);
    wgcardsService.getOrderInfoAndDetail.mockResolvedValueOnce({ firstTo: { deliveryStatus: DELIVERY_STATUS.FULL_CANCELLED } });

    const summary = await run();

    expect(summary.cancelled).toBe(1);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("delivery_status = 'failed'"), [1]);
    expect(wgcardsService.getBuyCard).not.toHaveBeenCalled();
    expect(orderService._sendCompletionEmail).not.toHaveBeenCalled();
  });

  test('deliveryStatus PENDING (1): no delivery attempted, pending_reason set from age, cadence updated', async () => {
    db.query.mockResolvedValueOnce([{ ...baseRow }]);
    wgcardsService.getOrderInfoAndDetail.mockResolvedValueOnce({ firstTo: { deliveryStatus: DELIVERY_STATUS.PENDING } });

    const summary = await run();

    expect(summary.delivered).toBe(0);
    expect(summary.cancelled).toBe(0);
    expect(wgcardsService.getBuyCard).not.toHaveBeenCalled();
  });

  test('a row not yet due for its poll tier is skipped entirely — no API call at all', async () => {
    const recentlyPolled = {
      ...baseRow,
      created_at: new Date(),
      last_polled_at: new Date(), // just polled -> not due again for 5 min
    };
    db.query.mockResolvedValueOnce([recentlyPolled]);

    const summary = await run();

    expect(summary.polled).toBe(0);
    expect(wgcardsService.getOrderInfoAndDetail).not.toHaveBeenCalled();
  });

  test('getOrderInfoAndDetail failure is logged and does not crash the run, still updates last_polled_at', async () => {
    db.query
      .mockResolvedValueOnce([{ ...baseRow }])
      .mockResolvedValueOnce(undefined); // markPolled UPDATE
    wgcardsService.getOrderInfoAndDetail.mockRejectedValueOnce(new Error('network blip'));

    const summary = await run();

    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0].error).toBe('network blip');
  });

  test('no candidates -> clean no-op', async () => {
    db.query.mockResolvedValueOnce([]);
    const summary = await run();
    expect(summary).toMatchObject({ candidates: 0, polled: 0, delivered: 0, cancelled: 0 });
  });
});
