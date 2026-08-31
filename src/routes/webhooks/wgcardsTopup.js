// routes/webhooks/wgcardsTopup.js
// Inbound webhook — WgCards Direct Top-Up result notification (Annex III).
// Deliberately NOT behind `protect`/JWT auth (WgCards calls this directly,
// it has no CardCove session) and NOT encrypted (Annex III's request body
// is plain JSON, unlike every outbound call in wgcards.service.js).
//
// Per the doc: WgCards calls this URL up to 5 times within 30 minutes until
// it gets back the literal string 'success' — anything else (including a
// non-200 status) is treated as "not delivered" and triggers a retry. So
// the one rule here is: only ever send exactly 'success', and only once
// resolveTopup has actually recorded the result — a wrongly-early 'success'
// on a real failure would mean we silently never hear about it again.
'use strict';

const express = require('express');
const router = express.Router();
const wgcardsTopupService = require('../../services/wgcardsTopup.service');
const logger = require('../../utils/logger');

router.post('/', async (req, res) => {
  const body = req.body || {};
  const { orderId, requestId, status, errorMsg } = body;

  if (!requestId) {
    // Nothing to key off — but this also can't be fixed by WgCards retrying
    // the same malformed payload again, so ack it to stop the retry loop
    // rather than let a bad payload retry pointlessly for 30 minutes.
    logger.warn('wgcardsTopup webhook: payload missing requestId, acking without resolving', body);
    return res.status(200).send('success');
  }

  try {
    const result = await wgcardsTopupService.resolveTopup({
      orderReference: requestId,
      wgcardsOrderId: orderId,
      status,
      errorMsg,
      payload: body,
      resolvedVia: 'webhook',
    });
    if (!result.found) {
      // Unknown requestId — could be a stale/duplicate delivery for an order
      // that's since been pruned, or a genuine mismatch worth seeing in the
      // logs, but either way retrying won't make it findable.
      logger.warn(`wgcardsTopup webhook: no matching topup order for requestId ${requestId}`);
    }
    return res.status(200).send('success');
  } catch (err) {
    logger.error('wgcardsTopup webhook: resolveTopup failed, letting WgCards retry', err);
    return res.status(500).send('error');
  }
});

module.exports = router;
