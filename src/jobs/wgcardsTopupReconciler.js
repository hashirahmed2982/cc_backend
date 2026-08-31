// jobs/wgcardsTopupReconciler.js
// Flow F fallback (Master Plan §5, Cron #5 — "Top-up Reconciler", every 10
// min, only acting on rows past the 35-min mark). WgCards' own webhook
// mechanism (Annex III) is the primary path and is fairly reliable on paper
// — up to 5 delivery attempts within 30 minutes — but "the webhook never
// arrives" is explicitly called out in the doc's own risk table, so this is
// the automatic catch-all for that case rather than leaving a topup stuck
// on 'pending' forever.
//
// What this checks with, and why: the doc has no dedicated "get direct
// top-up order status" endpoint. queryCodeActivate is marked (Deprecated),
// and getOrderInfoAndDetail — the natural candidate — is the same endpoint
// that's been consistently broken on this sandbox since Phase 5 (reported
// to WgCards, unresolved). getOrderInfo (the list endpoint) is confirmed
// working and its records carry deliveryStatus, so — same fallback
// orderPoller.js already proved out live for regular card orders — this
// reuses THAT exact search (findDeliveryStatusViaList) against the
// wgcards_order_id placeDirectOrder returned. This is a genuine assumption,
// not something confirmed live yet: it assumes Direct Top-Up orders show up
// in the same getOrderInfo listing as card orders, with deliveryStatus
// 3 (FullyDelivered) meaning the recharge completed and 4/5 (cancelled)
// meaning it didn't. If that assumption turns out wrong once tested live,
// affected rows simply stay 'pending' (safe — nothing auto-refunds on a
// stuck row) and this comment is the pointer to what to fix.
//
// Usage:
//   node src/jobs/wgcardsTopupReconciler.js
'use strict';

require('dotenv').config();

const db = require('../config/database');
const logger = require('../utils/logger');
const wgcardsTopupService = require('../services/wgcardsTopup.service');
const { findDeliveryStatusViaList, DELIVERY_STATUS } = require('./orderPoller');

const RECONCILE_AFTER_MINUTES = 35;

/** Map orderPoller's card-order deliveryStatus enum onto the webhook's
 * 0/1/2 (failed/success/processing) status vocabulary resolveTopup expects. */
function deliveryStatusToTopupStatus(deliveryStatus) {
  if (deliveryStatus === DELIVERY_STATUS.FULL) return 1;
  if (deliveryStatus === DELIVERY_STATUS.PARTIAL_CANCELLED || deliveryStatus === DELIVERY_STATUS.FULL_CANCELLED) return 0;
  return 2; // PENDING/PARTIAL — still in flight, leave for the next pass
}

async function run() {
  const due = await db.query(
    `SELECT topup_order_id, order_reference, wgcards_order_id, created_at
       FROM wgcards_topup_orders
      WHERE status IN ('pending', 'processing')
        AND wgcards_order_id IS NOT NULL
        AND created_at <= DATE_SUB(NOW(), INTERVAL ${RECONCILE_AFTER_MINUTES} MINUTE)`
  );

  let checked = 0;
  let resolved = 0;
  let stillPending = 0;
  let errors = 0;

  for (const row of due) {
    checked++;
    try {
      const found = await findDeliveryStatusViaList(row.wgcards_order_id);
      if (!found?.found) {
        stillPending++;
        logger.warn(`wgcardsTopupReconciler: topup ${row.topup_order_id} (wgcards order ${row.wgcards_order_id}) not found in getOrderInfo's fallback window — will retry next cycle`);
        continue;
      }
      const topupStatus = deliveryStatusToTopupStatus(found.deliveryStatus);
      if (topupStatus === 2) {
        stillPending++;
        continue; // found, but still in flight per WgCards — nothing to resolve yet
      }
      const result = await wgcardsTopupService.resolveTopup({
        orderReference: row.order_reference,
        wgcardsOrderId: row.wgcards_order_id,
        status: topupStatus,
        payload: { source: 'reconciler_fallback', deliveryStatus: found.deliveryStatus },
        resolvedVia: 'reconciler',
      });
      if (result.resolved) resolved++;
    } catch (err) {
      errors++;
      logger.error(`wgcardsTopupReconciler: failed to reconcile topup ${row.topup_order_id}`, err);
    }
  }

  return { checked, resolved, stillPending, errors };
}

module.exports = { run, deliveryStatusToTopupStatus, RECONCILE_AFTER_MINUTES };

// ── CLI entry point ─────────────────────────────────────────────────────
if (require.main === module) {
  run()
    .then((summary) => {
      console.log('Top-up reconciliation complete:', JSON.stringify(summary, null, 2));
      return db.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Top-up reconciliation failed:', err);
      process.exit(1);
    });
}
