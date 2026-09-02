// jobs/gift2gamesHealthCheck.js
// Flow A/G circuit breaker heartbeat for Gift2Games — the counterpart to
// healthCheck.js, which only ever covered WgCards. Without this, a dead
// Gift2Games integration was only ever detected the next time an order
// actually tried to use it (or never, during a quiet period) — same gap
// WgCards had before healthCheck.js existed.
//
// checkBalance() is the cheapest confirmed-live Gift2Games call (see
// gift2games.service.js's header) — used purely as a heartbeat here, same
// as WgCards' healthCheck.js uses getAccount(). Circuit breaker DETECTION
// already runs on every Gift2Games call via gift2games.service.js's
// _authedCall (recordSuccess/recordFailure unconditionally) — this job
// just guarantees a check happens at least every 15 min even with no
// catalog sync/order activity, and is what notices recovery.
//
// Usage:
//   node src/jobs/gift2gamesHealthCheck.js
'use strict';

require('dotenv').config();

const db = require('../config/database');
const logger = require('../utils/logger');
const gift2gamesService = require('../services/gift2games.service');
const supplierConfigRepo = require('../repositories/supplierConfig.repository');

async function run() {
  const before = await supplierConfigRepo.getBySupplierName('gift2games');
  if (before && !before.is_active) {
    logger.info('gift2gamesHealthCheck: gift2games is disabled by admin — skipping');
    return { skipped: true, reason: 'supplier_disabled' };
  }
  const wasDown = before?.integration_status === 'down';

  try {
    await gift2gamesService.checkBalance(); // _authedCall handles recordSuccess/recordFailure itself
  } catch (err) {
    const after = await supplierConfigRepo.getBySupplierName('gift2games');
    if (after.integration_status === 'down' && !wasDown) {
      logger.error(`gift2gamesHealthCheck: Gift2Games integration just flipped to DOWN after ${after.consecutive_failures} consecutive failures — its products should now show as temporarily unavailable`);
    }
    return { supplier: 'gift2games', status: 'down', error: err.message, consecutiveFailures: after.consecutive_failures };
  }

  const after = await supplierConfigRepo.getBySupplierName('gift2games');
  if (wasDown && after.integration_status === 'healthy') {
    logger.info('gift2gamesHealthCheck: Gift2Games integration RECOVERED — products are orderable again');
  }
  return { supplier: 'gift2games', status: after.integration_status, consecutiveFailures: after.consecutive_failures };
}

module.exports = { run };

// ── CLI entry point ─────────────────────────────────────────────────────
if (require.main === module) {
  run()
    .then((summary) => {
      console.log('Gift2Games health check complete:', JSON.stringify(summary, null, 2));
      return db.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Gift2Games health check failed:', err);
      process.exit(1);
    });
}
