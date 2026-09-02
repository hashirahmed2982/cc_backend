'use strict';

const { extractDeliveredCode, isTerminalStatus, isFailedStatus } = require('../gift2gamesDelivery');

describe('extractDeliveredCode', () => {
  test('finds a top-level code field', () => {
    expect(extractDeliveredCode({ code: 'ABCD-1234' })).toEqual({ code: 'ABCD-1234', pin: null, serial: null });
  });

  test('finds code + pin + serial together', () => {
    expect(extractDeliveredCode({ cardCode: 'X1', cardPin: 'P1', serialNumber: 'S1' }))
      .toEqual({ code: 'X1', pin: 'P1', serial: 'S1' });
  });

  test('checks nested data/card/giftCard/product/order objects', () => {
    expect(extractDeliveredCode({ data: { redeemCode: 'RD-1' } })).toEqual({ code: 'RD-1', pin: null, serial: null });
    expect(extractDeliveredCode({ card: { voucherCode: 'VC-1' } })).toEqual({ code: 'VC-1', pin: null, serial: null });
    expect(extractDeliveredCode({ giftCard: { key: 'KY-1' } })).toEqual({ code: 'KY-1', pin: null, serial: null });
  });

  test('no known field anywhere -> null, never guesses', () => {
    expect(extractDeliveredCode({ orderId: 'G2G-1', orderStatus: 'Processing' })).toBeNull();
  });

  test('empty string / null field values do not count as found', () => {
    expect(extractDeliveredCode({ code: '', cardCode: null })).toBeNull();
  });

  test('non-object input -> null', () => {
    expect(extractDeliveredCode(null)).toBeNull();
    expect(extractDeliveredCode(undefined)).toBeNull();
    expect(extractDeliveredCode('a string')).toBeNull();
  });
});

describe('isTerminalStatus / isFailedStatus', () => {
  test.each(['Completed', 'Success', 'Delivered', 'delivery_complete'])('%s is terminal', (s) => {
    expect(isTerminalStatus(s)).toBe(true);
  });

  test.each(['Pending', 'Processing', undefined, null])('%s is not terminal', (s) => {
    expect(isTerminalStatus(s)).toBe(false);
  });

  test.each(['Failed', 'Rejected', 'Cancelled', 'Error'])('%s is a failure', (s) => {
    expect(isFailedStatus(s)).toBe(true);
  });

  test.each(['Pending', 'Completed', undefined])('%s is not a failure', (s) => {
    expect(isFailedStatus(s)).toBe(false);
  });
});
