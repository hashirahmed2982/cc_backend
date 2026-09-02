// utils/gift2gamesDelivery.js
// Shared between gift2gamesFulfillment.js (the immediate response from
// createOrder) and jobs/gift2gamesOrderPoller.js (a later getOrderDetails
// lookup) — both need the exact same "does this response actually contain
// a deliverable code" logic, and it must stay identical in both places or
// the poller could keep "finding" an order the create-time check already
// decided wasn't delivered yet (or vice versa).
//
// Gift2Games' create_order/orders/details response shape for the DELIVERED
// code has never been confirmed live (see gift2games.service.js's header —
// only checkBalance() and getProducts() are). The vendor's Postman
// collection examples for both endpoints only show request shape. This is
// a best-effort scan across the field names gift-card/top-up vendors most
// commonly use in practice, checked at the top level and a few likely
// nesting points.
//
// If nothing matches, the caller does NOT treat the order as delivered —
// it stays pending and the raw response is preserved (order_details.
// gift2games_raw_response) so a human can read the actual shape and, worst
// case, manually deliver rather than the order silently vanishing the way
// it did before this fix.
'use strict';

const CODE_FIELDS = ['code', 'cardCode', 'giftCardCode', 'redeemCode', 'voucherCode', 'cdkey', 'cdKey', 'key', 'activationCode', 'serial'];
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
