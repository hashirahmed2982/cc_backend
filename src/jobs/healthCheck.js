// jobs/healthCheck.js
// Flow A/G circuit breaker heartbeat (Master Plan §5, Cron #7 — "Integration
// Health Check", every 15 min).
//
// The circuit breaker's DETECTION side already runs on every single WgCards
// call — wgcards.service.js's _authedCall calls supplierConfigRepo.
// recordFailure/recordSuccess unconditionally (see Phase 0/1). What this job
// adds is a dedicated, cheap heartbeat (getAccount) so a down integration is
// still detected within 15 min even during a quiet period with no catalog
// sync / order activity — and, symmetrically, it's the thing that notices
// recovery and clears the flag, since wgcardsFulfillment (Phase 6, this
// commit) now skips placeOrder entirely while integration_status is 'down'
// rather than continuing to hammer a known-dead integration.
//
// Usage:
//   node src/jobs/healthCheck.js
'use strict';

require('dotenv').config();

const db = require('../config/database');
const logger = require('../utils/logger');
const wgcardsService = require('../services/wgcards.service');
const supplierConfigRepo = require('../repositories/supplierConfig.repository');

async function run() {
  const before = await supplierConfigRepo.getBySupplierName('wgcards');
  const wasDown = before?.integration_status === 'down';

  try {
    await wgcardsService.getAccount(); // _authedCall handles recordSuccess/recordFailure itself
  } catch (err) {
    // Already logged + recorded inside wgcards.service.js — nothing more to
    // do here except make it visible in this job's own output/summary.
    const after = await supplierConfigRepo.getBySupplierName('wgcards');
    if (after.integration_status === 'down' && !wasDown) {
      logger.error(`healthCheck: WgCards integration just flipped to DOWN after ${after.consecutive_failures} consecutive failures — its products should now show as temporarily unavailable`);
    }
    return { supplier: 'wgcards', status: 'down', error: err.message, consecutiveFailures: after.consecutive_failures };
  }

  const after = await supplierConfigRepo.getBySupplierName('wgcards');
  if (wasDown && after.integration_status === 'healthy') {
    logger.info('healthCheck: WgCards integration RECOVERED — products are orderable again');
  }
  return { supplier: 'wgcards', status: after.integration_status, consecutiveFailures: after.consecutive_failures };
}

module.exports = { run };

// ── CLI entry point ─────────────────────────────────────────────────────
if (require.main === module) {
  run()
    .then((summary) => {
      console.log('Health check complete:', JSON.stringify(summary, null, 2));
      return db.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Health check failed:', err);
      process.exit(1);
    });
}
