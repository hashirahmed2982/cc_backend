'use strict';

const { extractDeliveredCode, isTerminalStatus, isFailedStatus } = require('../gift2gamesDelivery');

describe('extractDeliveredCode', () => {
  test('CONFIRMED LIVE: real createOrder response (productId 1048, MOBILE LEGENDS - 11 DIAMONDS, $0.21)', () => {
    // Captured 2026-09-02 via scripts/test-gift2games-order.js --confirm.
    // This is the exact response that exposed the original field-name
    // guesses as wrong — none of them matched `serialCode`.
    const realCreateOrderResponse = {
      orderId: 19810885,
      serialType: 'voucher',
      serialCode: 'PdrkQilZNpzpJu7H',
      referenceNumber: 'f7a0801d-8435-4525-ac52-aab55347bf70',
      serialNumber: '166297654916',
      serialExpiryDate: 1796235784,
      orderPrice: 0.21,
      sellPrice: 0,
      orderCurrency: 'USD',
      OrderFake: true,
      time: 1788369784,
    };

    expect(extractDeliveredCode(realCreateOrderResponse)).toEqual({
      code: 'PdrkQilZNpzpJu7H',
      pin: null,
      serial: '166297654916',
    });
  });

  test('CONFIRMED LIVE: real getOrderDetails response for the same order', () => {
    const realGetOrderDetailsResponse = {
      orderId: '19810885',
      referenceNumber: 'f7a0801d-8435-4525-ac52-aab55347bf70',
      dateTime: '1788369784',
      orderPrice: '0.21',
      orderCurrency: 'USD',
      orderStatus: 'Completed',
      OrderFake: true,
      productName: 'MOBILE LEGENDS - 11 DIAMONDS',
      serialCode: 'PdrkQilZNpzpJu7H',
      serialNumber: '166297654916',
    };

    expect(extractDeliveredCode(realGetOrderDetailsResponse)).toEqual({
      code: 'PdrkQilZNpzpJu7H',
      pin: null,
      serial: '166297654916',
    });
    expect(isTerminalStatus(realGetOrderDetailsResponse.orderStatus)).toBe(true);
  });

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
