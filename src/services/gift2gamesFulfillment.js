// services/gift2gamesFulfillment.js
// Orchestrates a single order line's Gift2Games create_order attempt —
// the Gift2Games counterpart to wgcardsFulfillment.js, called by
// supplierSelection.service.js (Master Plan §10) with the specific
// sku_supplier_links row already resolved.
//
// UNTESTED AGAINST THE REAL API — see gift2games.service.js's header. The
// retry/idempotency logic below matches the master plan's Flow D/H
// description exactly; only live behavior against the actual Gift2Games
// service is unverified (no JWT configured as of this writing).
'use strict';

const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const gift2gamesService = require('./gift2games.service');

// Master plan §6: "2 retries, 2s -> 6s, only AFTER /orders/details lookup
// confirms no order exists" — same backoff shape as WgCards' retry policy,
// but gated behind the Flow H idempotency check rather than applied blind.
const RETRY_DELAYS_MS = [2000, 6000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object} params
 * @param {number} params.orderId
 * @param {object} params.item   { skuId (canonical), quantity, additionalFields? }
 * @param {string} [params.currency]
 * @param {object} params.link   the active sku_supplier_links row for gift2games
 *                                (link.supplier_sku_ref is Gift2Games' productId)
 * @returns {Promise<{success:boolean, reason?:string, referenceNumber?:string, gift2gamesOrderId?:string, error?:string}>}
 */
async function attemptGift2GamesFulfillment({ orderId, item, currency = 'USD', link, retryDelaysMs = RETRY_DELAYS_MS }) {
  if (!link || !link.supplier_sku_ref) {
    return { success: false, reason: 'not_a_gift2games_sku' };
  }

  // Idempotency across REPEAT calls to selectAndFulfill (e.g. an admin
  // manually retrying) is the dispatcher's job — it checks
  // order_details.fulfillment_supplier before ever reaching here. Within
  // THIS single attempt, referenceNumber is generated once and reused
  // across the retry loop below (never regenerated mid-loop), same
  // convention as WgCards' serviceOrder.
  const referenceNumber = uuidv4();
  let lastError;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    try {
      const result = await gift2gamesService.createOrder({
        productId: link.supplier_sku_ref,
        referenceNumber,
        additionalFields: item.additionalFields || [],
      });
      return {
        success: true,
        referenceNumber,
        gift2gamesOrderId: result.orderId || result.referenceNumber || referenceNumber,
      };
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
        const existing = await gift2gamesService.getOrderDetails({ referenceNumber });
        if (existing && existing.orderStatus && existing.orderStatus !== 'not_found') {
          // It actually went through (or is now known) despite the
          // apparent failure — authoritative result, do not retry.
          return {
            success: true,
            referenceNumber,
            gift2gamesOrderId: existing.orderId || referenceNumber,
            recoveredViaIdempotencyCheck: true,
          };
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

module.exports = { attemptGift2GamesFulfillment, attemptFulfillment: attemptGift2GamesFulfillment };
