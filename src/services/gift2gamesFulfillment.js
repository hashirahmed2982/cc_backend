// services/gift2gamesFulfillment.js
// Orchestrates a single order line's Gift2Games create_order attempt —
// the Gift2Games counterpart to wgcardsFulfillment.js, called by
// supplierSelection.service.js (Master Plan §10) with the specific
// sku_supplier_links row already resolved.
//
// The happy-path createOrder/getOrderDetails call and the delivered-code
// extraction below are CONFIRMED against the real API as of 2026-09-02
// (a real $0.21 purchase via scripts/test-gift2games-order.js --confirm —
// see gift2games.service.js's header and utils/gift2gamesDelivery.js's
// header for the captured shape). The retry/Flow-H idempotency-recovery
// path (an ambiguous network failure followed by a getOrderDetails
// lookup) is still unverified live — only the direct success path has
// been exercised against a real order so far.
//
// DELIVERY: unlike WgCards (always async — Flow E's orderPoller.js has to
// come back later via getBuyCard), Gift2Games answers createOrder
// SYNCHRONOUSLY with the order already complete — confirmed live
// (orderStatus:'Completed' in the same response). So this module extracts
// the delivered code straight out of createOrder's response
// (utils/gift2gamesDelivery.js) and, when found, writes digital_codes
// immediately rather than parking the line as "awaiting_supplier_delivery"
// the way WgCards always does. If no code is found (a genuinely async
// product, or a response shape this SKU's serialType doesn't share with
// the one confirmed live), it falls back to the WgCards-style pending
// path, and jobs/gift2gamesOrderPoller.js picks it up from there via the
// same extractor against getOrderDetails.
'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const logger = require('../utils/logger');
const gift2gamesService = require('./gift2games.service');
const { extractDeliveredCode } = require('../utils/gift2gamesDelivery');
const { deliverCode, markPending: _markPending } = require('./gift2gamesDeliveryWriter');

// Master plan §6: "2 retries, 2s -> 6s, only AFTER /orders/details lookup
// confirms no order exists" — same backoff shape as WgCards' retry policy,
// but gated behind the Flow H idempotency check rather than applied blind.
const RETRY_DELAYS_MS = [2000, 6000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Delivers exactly one unit — Gift2Games' create_order has no buyNum/
 * quantity parameter (see gift2games.service.js createOrder's own
 * comment), so one createOrder call only ever buys one unit.
 * attemptGift2GamesFulfillment below loops this per unit for a
 * quantity>1 line. Thin wrapper so this file's calls read the same as
 * before the shared-writer extraction. */
async function _deliverImmediately(args) {
  return deliverCode(args);
}

/**
 * @param {object} params
 * @param {number} params.orderId
 * @param {object} params.item   { skuId (canonical), quantity, additionalFields? }
 * @param {string} [params.currency]
 * @param {object} params.link   the active sku_supplier_links row for gift2games
 *                                (link.supplier_sku_ref is Gift2Games' productId)
 * @returns {Promise<{success:boolean, reason?:string, referenceNumber?:string, gift2gamesOrderId?:string, delivered?:boolean, codes?:string[], error?:string}>}
 */
async function attemptGift2GamesFulfillment({ orderId, item, currency = 'USD', link, retryDelaysMs = RETRY_DELAYS_MS }) {
  if (!link || !link.supplier_sku_ref) {
    return { success: false, reason: 'not_a_gift2games_sku' };
  }

  // Idempotency across REPEAT calls to selectAndFulfill (e.g. an admin
  // manually retrying, or a second completeOrder pass) — same convention
  // as wgcardsFulfillment's own existing-order check. supplierSelection.
  // service.js's own fulfillment_supplier check covers the common case,
  // but this is belt-and-suspenders for a direct re-call of this module.
  const existing = await db.queryOne(
    'SELECT gift2games_order_id, gift2games_reference_number FROM order_details WHERE order_id = ? AND sku_id = ?',
    [orderId, item.skuId]
  );
  if (existing?.gift2games_order_id) {
    return {
      success: true,
      alreadyPlaced: true,
      gift2gamesOrderId: existing.gift2games_order_id,
      referenceNumber: existing.gift2games_reference_number,
    };
  }

  // Gift2Games' create_order has no buyNum/quantity parameter (confirmed —
  // see gift2games.service.js's createOrder comment), so one call only
  // ever buys one unit. A quantity>1 line used to just place ONE unit and
  // silently leave the rest pending forever (a known, documented
  // limitation — see this file's header). Fixed: place up to
  // item.quantity SEPARATE createOrder calls in sequence, each its own
  // fully idempotency-safe attempt (_placeSingleUnit below is exactly the
  // single-unit logic this function used to run inline, unchanged).
  //
  // Stops the moment a unit doesn't deliver SYNCHRONOUSLY — either it
  // failed outright, or it placed but only went pending (a genuinely
  // async product/status). order_details has room for exactly ONE
  // gift2games_order_id/gift2games_reference_number at a time; racing
  // ahead to place more units while one is still unresolved would
  // overwrite the only pointer the poller has to ever resolve it. The
  // remaining quantity is picked up on the next fulfillment pass once
  // delivered_qty reflects what already landed (same mechanism
  // order.service.js#_fulfillOrder already uses for local-vs-supplier
  // shortfalls).
  const deliveredCodes = [];
  let lastResult = null;

  for (let unit = 0; unit < item.quantity; unit++) {
    lastResult = await _placeSingleUnit({ orderId, item, link, retryDelaysMs });
    if (!lastResult.success) break;
    if (lastResult.delivered) {
      deliveredCodes.push(...lastResult.codes);
      continue; // synchronous delivery confirmed for this unit — safe to place the next one
    }
    break; // placed but only pending — stop, let the poller resolve it first
  }

  if (deliveredCodes.length === 0) {
    // Nothing delivered this call — return the single attempt's own
    // result verbatim (identical shape to the old single-unit function:
    // success:true+pending, or success:false+reason).
    return lastResult;
  }
  return { ...lastResult, delivered: true, codes: deliveredCodes };
}

/** One createOrder attempt for exactly one unit, with its own retry/Flow H
 * idempotency handling — this is the ENTIRE body attemptGift2GamesFulfillment
 * used to run inline for its one-and-only unit; extracted verbatim so
 * multi-unit lines can call it once per unit above. */
async function _placeSingleUnit({ orderId, item, link, retryDelaysMs }) {
  const referenceNumber = uuidv4();
  let lastError;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    try {
      const result = await gift2gamesService.createOrder({
        productId: link.supplier_sku_ref,
        referenceNumber,
        additionalFields: item.additionalFields || [],
      });
      return await _handleOrderResult({ orderId, item, referenceNumber, result });
    } catch (err) {
      lastError = err;

      if (err.code === 'supplier_business_rejection' || err.code === 'supplier_auth_failure') {
        // Master plan §6: 0 auto-retries on Gift2Games auth failure — no
        // documented refresh mechanism, so retrying just wastes calls; a
        // human has to re-issue the JWT. Business rejections aren't
        // retryable for the usual reason (it's a coherent answer, not a
        // transport failure).
        break;
      }

      // Ambiguous failure (network/timeout/5xx). Flow H — the single most
      // important deviation from the WgCards pattern: Gift2Games does NOT
      // reject a duplicate referenceNumber, so retrying blind here is the
      // one mistake that can double-charge a customer. Always resolve via
      // a lookup on the SAME reference before ever retrying.
      try {
        const existingOrder = await gift2gamesService.getOrderDetails({ referenceNumber });
        if (existingOrder && existingOrder.orderStatus && existingOrder.orderStatus !== 'not_found') {
          // It actually went through (or is now known) despite the
          // apparent failure — authoritative result, do not retry.
          return await _handleOrderResult({ orderId, item, referenceNumber, result: existingOrder, recoveredViaIdempotencyCheck: true });
        }
      } catch (lookupErr) {
        logger.warn(
          `gift2gamesFulfillment: Flow H idempotency lookup itself failed for referenceNumber ${referenceNumber}, treating as terminal rather than risk a duplicate:`,
          lookupErr.message
        );
        break; // can't confirm either way — do NOT retry blindly
      }

      if (attempt < retryDelaysMs.length) {
        logger.warn(
          `gift2gamesFulfillment: createOrder attempt ${attempt + 1} failed (network/timeout, confirmed not-found via idempotency lookup), retrying in ${retryDelaysMs[attempt]}ms:`,
          err.message
        );
        await sleep(retryDelaysMs[attempt]);
      }
    }
  }

  const reason =
    lastError?.code === 'supplier_business_rejection' ? 'supplier_rejected'
      : lastError?.code === 'supplier_auth_failure' ? 'supplier_auth_failure'
        : 'supplier_timeout';

  return { success: false, reason, error: lastError?.message, referenceNumber };
}

/** Common tail for both the direct createOrder response and the
 * Flow H idempotency-recovered response — persists the order and, if a
 * code can be confidently extracted, delivers it immediately. */
async function _handleOrderResult({ orderId, item, referenceNumber, result, recoveredViaIdempotencyCheck }) {
  const gift2gamesOrderId = result?.orderId || result?.referenceNumber || referenceNumber;
  let rawResponseJson;
  try {
    rawResponseJson = JSON.stringify(result);
  } catch {
    rawResponseJson = null; // circular/unserializable — extremely unlikely, never worth failing the order over
  }

  const delivered = extractDeliveredCode(result);

  if (delivered) {
    try {
      const code = await _deliverImmediately({
        orderId, skuId: item.skuId, referenceNumber, gift2gamesOrderId, rawResponseJson, delivered,
      });
      return { success: true, referenceNumber, gift2gamesOrderId, delivered: true, codes: [code], recoveredViaIdempotencyCheck };
    } catch (err) {
      // The order is real and placed on Gift2Games' side — losing that
      // fact because our own INSERT/UPDATE failed would be worse than
      // falling back to "pending" (the poller will pick it back up via
      // getOrderDetails, which should return the same extractable code).
      logger.error(`gift2gamesFulfillment: order placed (ref ${referenceNumber}) but writing the delivered code failed — falling back to pending for the poller to retry:`, err);
      await _markPending({ orderId, skuId: item.skuId, referenceNumber, gift2gamesOrderId, rawResponseJson, reason: 'supplier_api_pending' }).catch(() => {});
      return { success: true, referenceNumber, gift2gamesOrderId, delivered: false, recoveredViaIdempotencyCheck };
    }
  }

  // No extractable code yet — either a genuinely async product/status, or
  // a response shape the extractor doesn't recognize. Either way: the
  // order is placed (createOrder didn't throw), so this is success=true,
  // just not yet delivered. jobs/gift2gamesOrderPoller.js takes over from
  // here via getOrderDetails on the same referenceNumber.
  await _markPending({ orderId, skuId: item.skuId, referenceNumber, gift2gamesOrderId, rawResponseJson, reason: 'awaiting_supplier_delivery' });
  return { success: true, referenceNumber, gift2gamesOrderId, delivered: false, recoveredViaIdempotencyCheck };
}

module.exports = { attemptGift2GamesFulfillment, attemptFulfillment: attemptGift2GamesFulfillment };
