// jobs/orderPoller.js
// Flow E (Master Plan §5) — Order Completion Poller, every 5 min.
// For every order_details row with a stored wgcards_order_id and delivery
// not yet complete: getOrderInfoAndDetail -> deliveryStatus -> getBuyCard
// when 2 (partial) or 3 (full). Writes delivered codes into digital_codes
// (source='wgcards_api') so the EXISTING download/ZIP/email machinery in
// order.service.js just works on them like any other code.
//
// Poll cadence & escalation exactly per the doc's table (age = time since
// order_details.created_at, i.e. since the line was placed):
//   0–2h:   every 5 min    (normal)
//   2–24h:  every 30 min   (normal)
//   24–72h: every 2 hours  (flagged "delayed" for admin visibility)
//   >72h:   every 6 hours  (flagged "delayed_needs_admin_decision" — the
//           doc's "auto-alert admin"; there's no admin UI yet (Phase 7),
//           so for now this just means "clearly visible in pending_reason
//           and logged loudly", not an actual notification)
//
// deliveryStatus 4/5 (cancelled) is marked and left for a human — nothing
// auto-refunds here, matching the doc: "Nothing auto-refunds before the
// 72-hour mark for either supplier" and Flow I being manual-admin-only.
//
// Usage:
//   node src/jobs/orderPoller.js
'use strict';

require('dotenv').config();

const db = require('../config/database');
const logger = require('../utils/logger');
const wgcardsService = require('../services/wgcards.service');
const orderService = require('../services/order.service');
const { encrypt, decrypt } = require('../utils/dataCrypto');

const DELIVERY_STATUS = { PENDING: 1, PARTIAL: 2, FULL: 3, PARTIAL_CANCELLED: 4, FULL_CANCELLED: 5 };

// [{ maxAgeHours (exclusive upper bound), intervalMinutes }] — first match wins.
const POLL_TIERS = [
  { maxAgeHours: 2, intervalMinutes: 5 },
  { maxAgeHours: 24, intervalMinutes: 30 },
  { maxAgeHours: 72, intervalMinutes: 120 },
  { maxAgeHours: Infinity, intervalMinutes: 360 },
];

// ── Pure helpers (unit-testable without DB/network) ────────────────────────

function pickIntervalMinutes(ageHours) {
  return POLL_TIERS.find((t) => ageHours < t.maxAgeHours).intervalMinutes;
}

/** Is this row due for a poll right now, given the tiered cadence? */
function shouldPollNow(row, now = new Date()) {
  const ageHours = (now - new Date(row.created_at)) / (1000 * 60 * 60);
  if (!row.last_polled_at) return true;
  const sinceLastPollMinutes = (now - new Date(row.last_polled_at)) / (1000 * 60);
  return sinceLastPollMinutes >= pickIntervalMinutes(ageHours);
}

/** Records getBuyCard hasn't given us before — assumes a stable, append-only
 * ordering across calls for the same orderId (undocumented by WgCards, but
 * the only reasonable assumption without a per-record identifier). */
function newRecordsSince(allRecords, alreadyDeliveredCount) {
  return allRecords.slice(alreadyDeliveredCount);
}

function pendingReasonForAge(ageHours) {
  if (ageHours >= 72) return 'delayed_needs_admin_decision';
  if (ageHours >= 24) return 'delayed';
  return 'awaiting_supplier_delivery';
}

/** Does this getOrderInfo record match the WgCards order we're looking for? */
function matchesOrderId(record, wgcardsOrderId) {
  return String(record.orderId) === String(wgcardsOrderId);
}

// getOrderInfoAndDetail currently rejects every payload variant we've tried
// (reported to WgCards, unresolved as of this writing — see CHANGELOG/PR
// notes). getOrderInfo (the list endpoint) works and includes deliveryStatus
// per record, so it's the fallback — but it has no per-order filter, so the
// search is bounded rather than exhaustive: this is a busy shared sandbox
// (100+ pages), and an unbounded search would burn through rate limits
// chasing an order that fell out of the recent window.
const FALLBACK_MAX_PAGES = 15;
const FALLBACK_PAGE_SIZE = 50;

/** Search getOrderInfo's paginated list (newest first) for a record
 * matching wgcardsOrderId, within FALLBACK_MAX_PAGES. */
async function findDeliveryStatusViaList(wgcardsOrderId) {
  for (let page = 1; page <= FALLBACK_MAX_PAGES; page++) {
    const result = await wgcardsService.getOrderInfo({ current: page, size: FALLBACK_PAGE_SIZE });
    const records = result?.records || [];
    const match = records.find((r) => matchesOrderId(r, wgcardsOrderId));
    if (match) return { found: true, deliveryStatus: match.deliveryStatus };
    if (!records.length || page >= (result?.pages || 1)) break; // no more pages to check
  }
  return { found: false };
}

// ── DB writes ───────────────────────────────────────────────────────────

async function markPolled(orderDetailId) {
  await db.query('UPDATE order_details SET last_polled_at = NOW() WHERE order_detail_id = ?', [orderDetailId]);
}

async function markCancelled(orderDetailId) {
  await db.query(
    "UPDATE order_details SET delivery_status = 'failed', pending_reason = 'supplier_cancelled' WHERE order_detail_id = ?",
    [orderDetailId]
  );
}

async function markPendingReason(orderDetailId, reason) {
  await db.query('UPDATE order_details SET pending_reason = ? WHERE order_detail_id = ?', [reason, orderDetailId]);
}

/** Atomically writes newly-delivered codes + bumps delivered_qty. Returns the decrypted plaintext codes (for the email). */
async function deliverCodes(orderDetailRow, newRecords) {
  return db.transaction(async (conn) => {
    const plaintextCodes = [];
    for (const rec of newRecords) {
      const codeValue = rec.card || rec.pinCode || rec.snCode || '';
      plaintextCodes.push(codeValue);
      await conn.execute(
        `INSERT INTO digital_codes (sku_id, code, pin_code, sn_code, status, order_id, sold_at, source)
         VALUES (?, ?, ?, ?, 'sold', ?, NOW(), 'wgcards_api')`,
        [
          orderDetailRow.sku_id,
          encrypt(codeValue),
          rec.pinCode ? encrypt(rec.pinCode) : null,
          rec.snCode ? encrypt(rec.snCode) : null,
          orderDetailRow.order_id,
        ]
      );
    }
    await conn.execute(
      'UPDATE order_details SET delivered_qty = delivered_qty + ?, last_polled_at = NOW() WHERE order_detail_id = ?',
      [newRecords.length, orderDetailRow.order_detail_id]
    );
    return plaintextCodes;
  });
}

/** Recalculates order_details.delivery_status + orders' overall status —
 * same logic as order.service.js's placeOrder/completeOrder, duplicated
 * here rather than exported/reused to keep this job self-contained. */
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

async function getZipPassword(userId) {
  const row = await db.queryOne('SELECT zip_password FROM users WHERE user_id = ?', [userId]);
  return row?.zip_password || null;
}

// ── Runner ──────────────────────────────────────────────────────────────

async function run() {
  const candidates = await db.query(
    `SELECT od.*, o.order_number, o.currency, u.user_id AS client_user_id, u.full_name, u.email
       FROM order_details od
       JOIN orders o ON o.order_id = od.order_id
       JOIN users u ON u.user_id = o.user_id
      WHERE od.wgcards_order_id IS NOT NULL
        AND od.delivery_status IN ('pending', 'partial')`
  );

  const summary = { candidates: candidates.length, polled: 0, delivered: 0, cancelled: 0, errors: [] };
  const deliveredThisRunByOrder = new Map(); // orderId -> { fulfilledItems: [...] }

  for (const row of candidates) {
    if (!shouldPollNow(row)) continue;
    summary.polled++;

    let info;
    try {
      info = await wgcardsService.getOrderInfoAndDetail({ orderId: row.wgcards_order_id });
    } catch (err) {
      if (err.code === 'supplier_business_rejection') {
        logger.warn(`orderPoller: getOrderInfoAndDetail rejected order_detail ${row.order_detail_id} (${err.message}) — falling back to getOrderInfo list search`);
        let fallback;
        try {
          fallback = await findDeliveryStatusViaList(row.wgcards_order_id);
        } catch (fallbackErr) {
          logger.warn(`orderPoller: getOrderInfo fallback also failed for order_detail ${row.order_detail_id}:`, fallbackErr.message);
          summary.errors.push({ orderDetailId: row.order_detail_id, error: fallbackErr.message });
          await markPolled(row.order_detail_id);
          continue;
        }
        if (!fallback.found) {
          logger.warn(`orderPoller: wgcards order ${row.wgcards_order_id} not found in getOrderInfo's first ${FALLBACK_MAX_PAGES} pages — will retry next cycle`);
          summary.errors.push({ orderDetailId: row.order_detail_id, error: 'not found in getOrderInfo fallback search' });
          await markPolled(row.order_detail_id);
          continue;
        }
        info = { firstTo: { deliveryStatus: fallback.deliveryStatus } };
      } else {
        logger.warn(`orderPoller: getOrderInfoAndDetail failed for order_detail ${row.order_detail_id} (wgcards order ${row.wgcards_order_id}):`, err.message);
        summary.errors.push({ orderDetailId: row.order_detail_id, error: err.message });
        await markPolled(row.order_detail_id); // still respect the tiered cadence even on failure
        continue;
      }
    }

    const deliveryStatus = info?.firstTo?.deliveryStatus;

    if (deliveryStatus === DELIVERY_STATUS.PARTIAL || deliveryStatus === DELIVERY_STATUS.FULL) {
      try {
        const buyCard = await wgcardsService.getBuyCard({ orderId: row.wgcards_order_id });
        const allRecords = buyCard?.records || [];
        const fresh = newRecordsSince(allRecords, row.delivered_qty);
        if (fresh.length > 0) {
          const codes = await deliverCodes(row, fresh);
          summary.delivered += fresh.length;

          if (!deliveredThisRunByOrder.has(row.order_id)) deliveredThisRunByOrder.set(row.order_id, []);
          deliveredThisRunByOrder.get(row.order_id).push({
            productId: row.product_id,
            productName: null, // filled in below once we know we need it
            skuId: row.sku_id,
            quantity: fresh.length,
            delivered: fresh.length,
            codes,
          });
        } else {
          await markPolled(row.order_detail_id);
        }
      } catch (err) {
        logger.warn(`orderPoller: getBuyCard failed for order_detail ${row.order_detail_id}:`, err.message);
        summary.errors.push({ orderDetailId: row.order_detail_id, error: err.message });
        await markPolled(row.order_detail_id);
      }
    } else if (deliveryStatus === DELIVERY_STATUS.PARTIAL_CANCELLED || deliveryStatus === DELIVERY_STATUS.FULL_CANCELLED) {
      await markCancelled(row.order_detail_id);
      summary.cancelled++;
      logger.warn(`orderPoller: WgCards order ${row.wgcards_order_id} (order_detail ${row.order_detail_id}) cancelled by supplier (deliveryStatus ${deliveryStatus}) — flagged for admin, NOT auto-refunded`);
    } else {
      // Still pending (1) or an unrecognized status — just track cadence/age escalation.
      const ageHours = (Date.now() - new Date(row.created_at)) / (1000 * 60 * 60);
      await markPendingReason(row.order_detail_id, pendingReasonForAge(ageHours));
      await markPolled(row.order_detail_id);
      if (ageHours >= 72) {
        logger.warn(`orderPoller: order_detail ${row.order_detail_id} (order ${row.order_id}) has been pending >72h — needs an admin decision (Flow I)`);
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
      logger.error(`orderPoller: failed to finalize/email order ${orderId} after delivering codes:`, err);
      summary.errors.push({ orderId, error: err.message, stage: 'finalize' });
    }
  }

  return summary;
}

module.exports = {
  run,
  DELIVERY_STATUS, POLL_TIERS, FALLBACK_MAX_PAGES, FALLBACK_PAGE_SIZE,
  pickIntervalMinutes, shouldPollNow, newRecordsSince, pendingReasonForAge,
  matchesOrderId, findDeliveryStatusViaList,
};

// ── CLI entry point ─────────────────────────────────────────────────────
if (require.main === module) {
  run()
    .then((summary) => {
      console.log('Order poll complete:', JSON.stringify(summary, null, 2));
      return db.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Order poll failed:', err);
      process.exit(1);
    });
}
