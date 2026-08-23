// services/wgcardsFulfillment.js
// Orchestrates a single order line's WgCards placeOrder attempt (Flow D +
// the retry policy from §6 of the master plan). Kept separate from
// order.service.js (already 995 lines) and from wgcards.service.js (the
// pure API adapter) — this is the piece that knows about order_details,
// idempotency, and the retry/backoff policy.
'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const logger = require('../utils/logger');
const wgcardsService = require('./wgcards.service');

// "retry network/timeout only: 2 retries, 2s -> 6s backoff" (§6)
const RETRY_DELAYS_MS = [2000, 6000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Only a raw network/timeout error is retryable — business rejections and
 * auth failures (both real HTTP responses we understood) are not. */
function isRetryable(err) {
  return err && err.code !== 'supplier_business_rejection' && err.code !== 'supplier_auth_failure';
}

/**
 * Attempt to fulfill one order line via WgCards. Safe to call multiple
 * times for the same (orderId, skuId) — if a supplier order was already
 * placed (wgcards_order_id set), it's a no-op that just reports the
 * existing state rather than placing a second order.
 *
 * @param {object} params
 * @param {number} params.orderId
 * @param {object} params.item      { skuId (our internal sku_id), quantity }
 * @param {string} [params.currency]
 * @returns {Promise<{success: boolean, reason?: string, wgcardsOrderId?: string, serviceOrder?: string, alreadyPlaced?: boolean, error?: string}>}
 */
async function attemptWgCardsFulfillment({ orderId, item, currency = 'USD', retryDelaysMs = RETRY_DELAYS_MS }) {
  const existing = await db.queryOne(
    'SELECT wgcards_order_id, wgcards_service_order FROM order_details WHERE order_id = ? AND sku_id = ?',
    [orderId, item.skuId]
  );
  if (existing?.wgcards_order_id) {
    // Already placed on a prior attempt (e.g. an earlier completeOrder run)
    // — Flow E's poller owns delivery from here, never re-place.
    return {
      success: true,
      alreadyPlaced: true,
      wgcardsOrderId: existing.wgcards_order_id,
      serviceOrder: existing.wgcards_service_order,
    };
  }

  const skuRow = await db.queryOne(
    'SELECT wgcards_sku_id, is_custom_value FROM product_skus WHERE sku_id = ?',
    [item.skuId]
  );
  if (!skuRow || !skuRow.wgcards_sku_id) {
    return { success: false, reason: 'not_a_wgcards_sku' };
  }
  if (skuRow.is_custom_value) {
    // Checkout doesn't yet capture a customer-chosen face value within a
    // custom-value/top-up range — safer to punt to support than guess one.
    return { success: false, reason: 'custom_value_not_supported_yet' };
  }

  // Flow D: live stock check before ordering. Best-effort — if this call
  // itself fails we still try placeOrder, which is the authoritative check
  // anyway (and the doc explicitly recommends not fully trusting cache,
  // not that this specific pre-check is required to succeed).
  try {
    await wgcardsService.getItemAndStock({ skuId: skuRow.wgcards_sku_id });
  } catch (err) {
    logger.warn(`wgcardsFulfillment: live stock check failed for sku ${skuRow.wgcards_sku_id}, attempting placeOrder anyway:`, err.message);
  }

  const serviceOrder = uuidv4();
  let lastError;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    try {
      const result = await wgcardsService.placeOrder({
        skuId: skuRow.wgcards_sku_id,
        buyNum: item.quantity,
        currency,
        serviceOrder,
      });
      await db.query(
        'UPDATE order_details SET wgcards_service_order = ?, wgcards_order_id = ?, pending_reason = ? WHERE order_id = ? AND sku_id = ?',
        [serviceOrder, result.wgcardsOrderId, 'awaiting_supplier_delivery', orderId, item.skuId]
      );
      return { success: true, wgcardsOrderId: result.wgcardsOrderId, serviceOrder };
    } catch (err) {
      lastError = err;
      if (!isRetryable(err)) break;
      if (attempt < retryDelaysMs.length) {
        logger.warn(
          `wgcardsFulfillment: placeOrder attempt ${attempt + 1} failed (network/timeout), retrying in ${retryDelaysMs[attempt]}ms:`,
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

  await db.query(
    'UPDATE order_details SET wgcards_service_order = ?, pending_reason = ? WHERE order_id = ? AND sku_id = ?',
    [serviceOrder, reason, orderId, item.skuId]
  );

  return { success: false, reason, error: lastError?.message, serviceOrder };
}

module.exports = { attemptWgCardsFulfillment };
