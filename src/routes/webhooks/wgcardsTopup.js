// routes/webhooks/wgcardsTopup.js
// Inbound webhook — WgCards Direct Top-Up result notification. Migrated to
// v4's unified webhook payload (shared by card orders and direct top-ups
// now) — NOT the v3 Annex III shape anymore. Deliberately NOT behind
// `protect`/JWT auth (WgCards calls this directly, it has no CardCove
// session) and NOT encrypted (v4 doc: plain JSON, same as v3's was).
//
// v4 payload: {eventId, orderId, outOrderNo, orderStatus, deliveryMode,
// deliveryStatus, topupStatus, fulfillmentStatus, fulfillmentStatusName,
// finishTime} — no more requestId/status/errorMsg/createTime/chargeAccount
// the way v3's Annex III payload had. `outOrderNo` is what we sent as
// `serviceOrder` on placeDirectOrder, so it's still the key into
// wgcards_topup_orders.order_reference. `topupStatus` replaces v3's 0/1/2
// `status` field — translated below into that same legacy 0/1/2 scheme so
// wgcardsTopup.service.js#resolveTopup needed ZERO changes.
//
// Per the v4 doc: WgCards retries at 2s/10s/1m/10m/30m until the response
// body, trimmed, equals exactly 'SUCCESS' (uppercase — v3 wanted lowercase
// 'success'; this is a real, easy-to-miss breaking change, not just a
// style choice). Anything else (including a non-2xx status) is treated as
// "not delivered". So the one rule here is: only ever send exactly
// 'SUCCESS', and only once resolveTopup has actually recorded the result —
// a wrongly-early ack on a real failure would mean we silently never hear
// about it again.
'use strict';

const express = require('express');
const router = express.Router();
const wgcardsTopupService = require('../../services/wgcardsTopup.service');
const logger = require('../../utils/logger');

// v4 topupStatus (1 pending, 2 topping up, 3 all succeeded, 4 partially
// succeeded, 5 all canceled) -> the legacy 0/1/2 (failed/success/
// processing) scheme resolveTopup already understands. A single
// Direct-Top-Up order here is always qty 1 (wgcardsTopup.service.js never
// sends quantity>1), so "partially succeeded" shouldn't occur in practice
// — treated as still-processing (not a final state) rather than guessed
// as success or failure, same "don't resolve on an ambiguous signal"
// posture as everything else in this flow.
function topupStatusToLegacy(topupStatus) {
  if (topupStatus === 3) return 1; // success
  if (topupStatus === 5) return 0; // failed/cancelled
  return 2; // 1 (pending), 2 (topping up), 4 (partially succeeded), or unrecognized — not final yet
}

router.post('/', async (req, res) => {
  const body = req.body || {};
  const { orderId, outOrderNo, topupStatus, fulfillmentStatusName } = body;

  if (!outOrderNo) {
    // Nothing to key off — but this also can't be fixed by WgCards retrying
    // the same malformed payload again, so ack it to stop the retry loop
    // rather than let a bad payload retry pointlessly for 30 minutes.
    logger.warn('wgcardsTopup webhook: payload missing outOrderNo, acking without resolving', body);
    return res.status(200).send('SUCCESS');
  }

  try {
    const result = await wgcardsTopupService.resolveTopup({
      orderReference: outOrderNo,
      wgcardsOrderId: orderId,
      status: topupStatusToLegacy(topupStatus),
      errorMsg: fulfillmentStatusName || null,
      payload: body,
      resolvedVia: 'webhook',
    });
    if (!result.found) {
      // Unknown outOrderNo — could be a stale/duplicate delivery for an
      // order that's since been pruned, or a genuine mismatch worth seeing
      // in the logs, but either way retrying won't make it findable.
      logger.warn(`wgcardsTopup webhook: no matching topup order for outOrderNo ${outOrderNo}`);
    }
    return res.status(200).send('SUCCESS');
  } catch (err) {
    logger.error('wgcardsTopup webhook: resolveTopup failed, letting WgCards retry', err);
    return res.status(500).send('error');
  }
});

module.exports = router;
