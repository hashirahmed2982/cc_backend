// jobs/gift2gamesOrderPoller.js
// Flow E counterpart for Gift2Games — the piece that was completely
// missing before this fix. gift2gamesFulfillment.js delivers immediately
// whenever createOrder's response itself contains a code (the common
// case, per the vendor's own "use orders/details for timeout scenario"
// hint — see that file's header), so most Gift2Games lines never reach
// this job at all. This exists for the remainder: a genuinely async
// product, or a createOrder response shape the extractor didn't recognize
// at create-time — either way, the line is left with gift2games_order_id
// set and delivery_status still pending/partial, and this job is what
// eventually completes it via getOrderDetails on the SAME referenceNumber
// (also the vendor-documented way to resolve a timeout, per Flow H).
//
// Same tiered poll cadence as WgCards' orderPoller.js (age = time since
// order_details.created_at):
//   0–2h:   every 5 min
//   2–24h:  every 30 min
//   24–72h: every 2 hours  (flagged "delayed")
//   >72h:   every 6 hours  (flagged "delayed_needs_admin_decision")
//
// Usage:
//   node src/jobs/gift2gamesOrderPoller.js
'use strict';

require('dotenv').config();

const db = require('../config/database');
const logger = require('../utils/logger');
const gift2gamesService = require('../services/gift2games.service');
const orderService = require('../services/order.service');
const { extractDeliveredCode, isFailedStatus } = require('../utils/gift2gamesDelivery');
const { deliverCode, markFailed } = require('../services/gift2gamesDeliveryWriter');

async function getZipPassword(userId) {
  const row = await db.queryOne('SELECT zip_password FROM users WHERE user_id = ?', [userId]);
  return row?.zip_password || null;
}

// [{ maxAgeHours (exclusive upper bound), intervalMinutes }] — first match wins.
// Identical shape/values to orderPoller.js's POLL_TIERS — kept as its own
// copy rather than a shared import so the two jobs stay independently
// tunable per supplier without coupling their cadence together.
const POLL_TIERS = [
  { maxAgeHours: 2, intervalMinutes: 5 },
  { maxAgeHours: 24, intervalMinutes: 30 },
  { maxAgeHours: 72, intervalMinutes: 120 },
  { maxAgeHours: Infinity, intervalMinutes: 360 },
];

function pickIntervalMinutes(ageHours) {
  return POLL_TIERS.find((t) => ageHours < t.maxAgeHours).intervalMinutes;
}

function shouldPollNow(row, now = new Date()) {
  const ageHours = (now - new Date(row.created_at)) / (1000 * 60 * 60);
  if (!row.last_polled_at) return true;
  const sinceLastPollMinutes = (now - new Date(row.last_polled_at)) / (1000 * 60);
  return sinceLastPollMinutes >= pickIntervalMinutes(ageHours);
}

function pendingReasonForAge(ageHours) {
  if (ageHours >= 72) return 'delayed_needs_admin_decision';
  if (ageHours >= 24) return 'delayed';
  return 'awaiting_supplier_delivery';
}

async function markPolled(orderDetailId) {
  await db.query('UPDATE order_details SET last_polled_at = NOW() WHERE order_detail_id = ?', [orderDetailId]);
}

async function markPendingReason(orderDetailId, reason) {
  await db.query('UPDATE order_details SET pending_reason = ? WHERE order_detail_id = ?', [reason, orderDetailId]);
}

/** Same recalculation order.service.js/orderPoller.js both do after a
 * delivery — duplicated here rather than shared, matching orderPoller.js's
 * own precedent for keeping each job self-contained. */
async function recalculateOrderStatus(orderId) {
  await db.query(
    `UPDATE order_details SET delivery_status = CASE
       WHEN delivered_qty >= quantity THEN 'completed'
       WHEN delivered_qty > 0 THEN 'partial'
       ELSE 'pending' END
     WHERE order_id = ?`,
    [orderId]
  );
  const rows = await db.query(
    `SELECT SUM(CASE WHEN delivered_qty < quantity THEN 1 ELSE 0 END) AS incompleteLines
       FROM order_details WHERE order_id = ?`,
    [orderId]
  );
  const incompleteLines = parseInt(rows[0].incompleteLines, 10);
  const orderStatus = incompleteLines === 0 ? 'completed' : 'processing';
  const deliveryStatus = incompleteLines === 0 ? 'completed' : 'partial';
  await db.query(
    `UPDATE orders SET order_status = ?, delivery_status = ?, completed_at = ${orderStatus === 'completed' ? 'NOW()' : 'NULL'}
     WHERE order_id = ?`,
    [orderStatus, deliveryStatus, orderId]
  );
}

async function run() {
  const candidates = await db.query(
    `SELECT od.*, o.order_number, o.currency, u.user_id AS client_user_id, u.full_name, u.email
       FROM order_details od
       JOIN orders o ON o.order_id = od.order_id
       JOIN users u ON u.user_id = o.user_id
      WHERE od.gift2games_order_id IS NOT NULL
        AND od.delivery_status IN ('pending', 'partial')`
  );

  const summary = { candidates: candidates.length, polled: 0, delivered: 0, failed: 0, errors: [] };
  const deliveredThisRunByOrder = new Map(); // orderId -> [{productId, skuId, quantity, delivered, codes}]

  for (const row of candidates) {
    if (!shouldPollNow(row)) continue;
    summary.polled++;

    let result;
    try {
      result = await gift2gamesService.getOrderDetails({ referenceNumber: row.gift2games_reference_number });
    } catch (err) {
      logger.warn(`gift2gamesOrderPoller: getOrderDetails failed for order_detail ${row.order_detail_id} (ref ${row.gift2games_reference_number}):`, err.message);
      summary.errors.push({ orderDetailId: row.order_detail_id, error: err.message });
      await markPolled(row.order_detail_id); // still respect the tiered cadence even on failure
      continue;
    }

    const delivered = extractDeliveredCode(result);

    if (delivered) {
      try {
        const rawResponseJson = (() => { try { return JSON.stringify(result); } catch { return null; } })();
        const code = await deliverCode({
          orderId: row.order_id,
          skuId: row.sku_id,
          referenceNumber: row.gift2games_reference_number,
          gift2gamesOrderId: row.gift2games_order_id,
          rawResponseJson,
          delivered,
        });
        summary.delivered++;

        if (!deliveredThisRunByOrder.has(row.order_id)) deliveredThisRunByOrder.set(row.order_id, []);
        deliveredThisRunByOrder.get(row.order_id).push({
          productId: row.product_id,
          productName: null, // filled in below once we know we need it
          skuId: row.sku_id,
          quantity: 1,
          delivered: 1,
          codes: [code],
        });
      } catch (err) {
        logger.warn(`gift2gamesOrderPoller: found a deliverable code but writing it failed for order_detail ${row.order_detail_id}:`, err.message);
        summary.errors.push({ orderDetailId: row.order_detail_id, error: err.message });
        await markPolled(row.order_detail_id);
      }
    } else if (isFailedStatus(result?.orderStatus)) {
      await markFailed(row.order_id, row.sku_id, 'supplier_cancelled');
      summary.failed++;
      logger.warn(`gift2gamesOrderPoller: Gift2Games order ${row.gift2games_order_id} (order_detail ${row.order_detail_id}) reported status "${result?.orderStatus}" — flagged for admin, NOT auto-refunded`);
    } else {
      // Still processing (or an unrecognized-but-not-failed status) — just
      // track cadence/age escalation, same as WgCards' poller.
      const ageHours = (Date.now() - new Date(row.created_at)) / (1000 * 60 * 60);
      await markPendingReason(row.order_detail_id, pendingReasonForAge(ageHours));
      await markPolled(row.order_detail_id);
      if (ageHours >= 72) {
        logger.warn(`gift2gamesOrderPoller: order_detail ${row.order_detail_id} (order ${row.order_id}) has been pending >72h — needs an admin decision (Flow I)`);
      }
    }
  }

  // Finalize + email once per order that got new codes this run.
  for (const [orderId, items] of deliveredThisRunByOrder) {
    try {
      await recalculateOrderStatus(orderId);

      const orderRow = await db.queryOne(
        `SELECT o.order_number, o.currency, u.user_id AS client_user_id, u.full_name, u.email
           FROM orders o JOIN users u ON u.user_id = o.user_id WHERE o.order_id = ?`,
        [orderId]
      );
      const productNames = await db.query(
        'SELECT product_id, product_name FROM products WHERE product_id IN (?)',
        [items.map((i) => i.productId)]
      );
      const nameById = Object.fromEntries(productNames.map((p) => [p.product_id, p.product_name]));
      for (const item of items) item.productName = nameById[item.productId] || `Product ${item.productId}`;

      const pendingRows = await db.query(
        "SELECT 1 FROM order_details WHERE order_id = ? AND delivery_status IN ('pending','partial')",
        [orderId]
      );

      const zipPassword = await getZipPassword(orderRow.client_user_id);
      await orderService._sendCompletionEmail(
        { full_name: orderRow.full_name, email: orderRow.email },
        orderRow.order_number,
        orderId,
        { fulfilledItems: items, pendingItems: pendingRows },
        orderRow.currency,
        zipPassword
      );
    } catch (err) {
      logger.error(`gift2gamesOrderPoller: failed to finalize/email order ${orderId} after delivering codes:`, err);
      summary.errors.push({ orderId, error: err.message, stage: 'finalize' });
    }
  }

  return summary;
}

module.exports = {
  run,
  POLL_TIERS, pickIntervalMinutes, shouldPollNow, pendingReasonForAge,
};

// ── CLI entry point ─────────────────────────────────────────────────────
if (require.main === module) {
  run()
    .then((summary) => {
      console.log('Gift2Games order poll complete:', JSON.stringify(summary, null, 2));
      return db.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Gift2Games order poll failed:', err);
      process.exit(1);
    });
}
