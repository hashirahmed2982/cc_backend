// jobs/gift2gamesBalanceMonitor.js
// Flow G counterpart for Gift2Games — the balance-threshold alert
// balanceMonitor.js only ever ran for WgCards. Without this, an empty
// Gift2Games wallet was silently invisible until an order failed against it.
//
// checkBalance() is confirmed live (see gift2games.service.js's header) and
// returns a SINGLE wallet directly — {userId, userBalance, userCurrency} —
// unlike WgCards' getAccount(), which returns an array of per-currency
// wallets that balanceMonitor.js has to pick one out of. Nothing to pick
// here: Gift2Games has exactly one balance.
//
// Usage:
//   node src/jobs/gift2gamesBalanceMonitor.js
'use strict';

require('dotenv').config();

const db = require('../config/database');
const logger = require('../utils/logger');
const gift2gamesService = require('../services/gift2games.service');
const supplierConfigRepo = require('../repositories/supplierConfig.repository');
const { checkSupplierEnabled } = require('./_supplierGate');

async function run() {
  const { enabled } = await checkSupplierEnabled('gift2games');
  if (!enabled) {
    logger.info('gift2gamesBalanceMonitor: gift2games is disabled by admin — skipping');
    return { skipped: true, reason: 'supplier_disabled' };
  }

  let data;
  try {
    data = await gift2gamesService.checkBalance();
  } catch (err) {
    // checkBalance already ran recordFailure via _authedCall — this job's
    // own job is just to make a balance-specific alert visible.
    logger.error('gift2gamesBalanceMonitor: checkBalance failed — balance unknown, treating as at-risk:', err.message);
    return { supplier: 'gift2games', ok: false, error: err.message };
  }

  const balance = data?.userBalance !== undefined ? Number(data.userBalance) : null;
  const currency = data?.userCurrency || 'USD';

  if (balance === null || Number.isNaN(balance)) {
    logger.warn('gift2gamesBalanceMonitor: checkBalance response had no usable userBalance — cannot check threshold');
    return { supplier: 'gift2games', ok: false, error: 'no userBalance in response' };
  }

  await supplierConfigRepo.saveBalance('gift2games', balance, currency);

  const cfg = await supplierConfigRepo.getBySupplierName('gift2games');
  const threshold = cfg.low_balance_threshold !== null ? Number(cfg.low_balance_threshold) : null;
  const isLow = threshold !== null && balance < threshold;

  if (isLow) {
    logger.error(`gift2gamesBalanceMonitor: Gift2Games ${currency} balance ($${balance}) is BELOW the configured threshold ($${threshold}) — fund the account soon`);
  }

  return { supplier: 'gift2games', ok: true, balance, currency, threshold, isLow };
}

module.exports = { run };

// ── CLI entry point ─────────────────────────────────────────────────────
if (require.main === module) {
  run()
    .then((summary) => {
      console.log('Gift2Games balance check complete:', JSON.stringify(summary, null, 2));
      return db.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Gift2Games balance check failed:', err);
      process.exit(1);
    });
}
