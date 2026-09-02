// utils/gift2gamesDelivery.js
// Shared between gift2gamesFulfillment.js (the immediate response from
// createOrder) and jobs/gift2gamesOrderPoller.js (a later getOrderDetails
// lookup) — both need the exact same "does this response actually contain
// a deliverable code" logic, and it must stay identical in both places or
// the poller could keep "finding" an order the create-time check already
// decided wasn't delivered yet (or vice versa).
//
// CONFIRMED LIVE 2026-09-02 (scripts/test-gift2games-order.js --confirm,
// productId 1048 "MOBILE LEGENDS - 11 DIAMONDS", $0.21). The real
// createOrder/getOrderDetails response is FLAT (no data/card/giftCard
// nesting) and the delivered code field is `serialCode` — NOT any of the
// generic gift-card vendor field names this file originally guessed
// (code/cardCode/redeemCode/etc.). Those guesses are kept as a fallback
// for any other product/serialType this specific sample didn't cover
// (createOrder's response also carries a `serialType` field — 'voucher'
// here — implying the shape may vary by type), but `serialCode` is the
// one now known to be real. Full confirmed sample:
//   { orderId, serialType:'voucher', serialCode, referenceNumber,
//     serialNumber, serialExpiryDate, orderPrice, sellPrice, orderCurrency,
//     OrderFake, time }
// `serialNumber` was already in this file's SERIAL_FIELDS guess and turned
// out correct — no PIN field appears for a voucher-type product.
//
// NOTE: that live response also included "OrderFake": true — flagged to
// the client as worth confirming with Gift2Games support (does this mean
// the balance wasn't actually debited for this specific test purchase, or
// is every order on this account/product marked that way). Doesn't affect
// this extractor either way — it's not a code/pin/serial field.
//
// getMyOrders/getCategories/updateSellPrice remain unconfirmed (see
// gift2games.service.js's header).
//
// If nothing matches, the caller does NOT treat the order as delivered —
// it stays pending and the raw response is preserved (order_details.
// gift2games_raw_response) so a human can read the actual shape and, worst
// case, manually deliver rather than the order silently vanishing the way
// it did before this fix.
'use strict';

const CODE_FIELDS = ['serialCode', 'code', 'cardCode', 'giftCardCode', 'redeemCode', 'voucherCode', 'cdkey', 'cdKey', 'key', 'activationCode', 'serial'];
const PIN_FIELDS = ['pin', 'cardPin', 'giftCardPin'];
const SERIAL_FIELDS = ['serialNumber', 'sn', 'snCode'];

function firstDefined(obj, fields) {
  if (!obj || typeof obj !== 'object') return null;
  for (const f of fields) {
    if (obj[f] !== undefined && obj[f] !== null && obj[f] !== '') return String(obj[f]);
  }
  return null;
}

/**
 * Scans a Gift2Games create_order/orders/details response for a delivered
 * code. Checks the top-level object plus a few likely nesting points
 * (`data`, `card`, `giftCard`, `product`, `order`) since the real shape
 * isn't confirmed live. Returns null if nothing plausible is found —
 * callers must treat that as "not delivered yet", never guess.
 *
 * @returns {{code:string, pin:string|null, serial:string|null}|null}
 */
function extractDeliveredCode(result) {
  if (!result || typeof result !== 'object') return null;
  const candidates = [result, result.data, result.card, result.giftCard, result.product, result.order].filter(
    (c) => c && typeof c === 'object'
  );
  for (const obj of candidates) {
    const code = firstDefined(obj, CODE_FIELDS);
    if (code) {
      return {
        code,
        pin: firstDefined(obj, PIN_FIELDS),
        serial: firstDefined(obj, SERIAL_FIELDS),
      };
    }
  }
  return null;
}

/** Best-effort "is this order actually finished" signal from orderStatus —
 * kept separate from extractDeliveredCode because a status string alone
 * isn't enough to hand something to the customer; it's only used to decide
 * whether a still-undelivered response should stop being polled (e.g. a
 * status that clearly means "failed"/"cancelled" rather than "processing"). */
function isTerminalStatus(orderStatus) {
  if (!orderStatus) return false;
  return /complet|success|deliver/i.test(String(orderStatus));
}

function isFailedStatus(orderStatus) {
  if (!orderStatus) return false;
  return /fail|reject|cancel|error/i.test(String(orderStatus));
}

module.exports = { extractDeliveredCode, isTerminalStatus, isFailedStatus };
