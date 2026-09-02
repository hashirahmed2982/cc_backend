// services/gift2gamesDeliveryWriter.js
// Shared DB-write helpers for a delivered/pending Gift2Games order line —
// factored out so gift2gamesFulfillment.js (delivery straight off
// createOrder's response) and jobs/gift2gamesOrderPoller.js (delivery off
// a later getOrderDetails response) write order_details/digital_codes
// identically. Keeping this in one place means the two call sites can
// never drift into writing slightly different columns for the same event.
'use strict';

const db = require('../config/database');
const { encrypt } = require('../utils/dataCrypto');

/** Writes a delivered code into digital_codes and bumps delivered_qty —
 * mirrors orderPoller.js's deliverCodes() for WgCards. Returns the
 * plaintext code (for the confirmation/completion email). */
async function deliverCode({ orderId, skuId, referenceNumber, gift2gamesOrderId, rawResponseJson, delivered }) {
  return db.transaction(async (conn) => {
    await conn.execute(
      `INSERT INTO digital_codes (sku_id, code, pin_code, sn_code, status, order_id, sold_at, source)
       VALUES (?, ?, ?, ?, 'sold', ?, NOW(), 'gift2games_api')`,
      [
        skuId,
        encrypt(delivered.code),
        delivered.pin ? encrypt(delivered.pin) : null,
        delivered.serial ? encrypt(delivered.serial) : null,
        orderId,
      ]
    );
    await conn.execute(
      `UPDATE order_details
          SET delivered_qty = delivered_qty + 1,
              gift2games_reference_number = ?, gift2games_order_id = ?,
              gift2games_raw_response = ?, pending_reason = NULL
        WHERE order_id = ? AND sku_id = ?`,
      [referenceNumber, gift2gamesOrderId, rawResponseJson ? encrypt(rawResponseJson) : null, orderId, skuId]
    );
    return delivered.code;
  });
}

/** Persists the reference/order id (+ raw response for admin visibility)
 * without delivering anything — the not-yet-delivered path. */
async function markPending({ orderId, skuId, referenceNumber, gift2gamesOrderId, rawResponseJson, reason }) {
  await db.query(
    `UPDATE order_details
        SET gift2games_reference_number = ?, gift2games_order_id = ?,
            gift2games_raw_response = ?, pending_reason = ?
      WHERE order_id = ? AND sku_id = ?`,
    [referenceNumber, gift2gamesOrderId, rawResponseJson ? encrypt(rawResponseJson) : null, reason, orderId, skuId]
  );
}

/** Marks a line failed (Gift2Games explicitly reported failure/cancellation
 * on a later poll) — mirrors orderPoller.js's markCancelled() for WgCards. */
async function markFailed(orderId, skuId, reason) {
  await db.query(
    "UPDATE order_details SET delivery_status = 'failed', pending_reason = ? WHERE order_id = ? AND sku_id = ?",
    [reason, orderId, skuId]
  );
}

module.exports = { deliverCode, markPending, markFailed };
