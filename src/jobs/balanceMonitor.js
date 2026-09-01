// jobs/balanceMonitor.js
// Flow G (Master Plan §5, Cron #6 — "Account Balance Monitor", every 30
// min). getAccount() -> balance/currency per wallet; below threshold (or
// the call itself failing) gets the same "temporarily unavailable" scoping
// as Flow A — logged loudly here since there's no admin-alert channel yet
// (Phase 7).
//
// WgCards' getAccount can return multiple currency wallets at once (we've
// seen CNY/GBP/USD together on the sandbox). This tracks the USD one
// specifically, since that's what orders/catalog pricing are denominated
// in (catalogSync always requests currencyCode:'USD') — the others aren't
// what we spend against when placing orders.
//
// Usage:
//   node src/jobs/balanceMonitor.js
'use strict';

require('dotenv').config();

const db = require('../config/database');
const logger = require('../utils/logger');
const wgcardsService = require('../services/wgcards.service');
const supplierConfigRepo = require('../repositories/supplierConfig.repository');
const { checkSupplierEnabled } = require('./_supplierGate');

const TRACKED_CURRENCY = 'USD';

/** Pick the wallet we actually care about out of getAccount's accounts array. */
function pickTrackedAccount(accounts, currency = TRACKED_CURRENCY) {
  if (!Array.isArray(accounts)) return null;
  return accounts.find((a) => a.currency === currency) || null;
}

async function run() {
  const { enabled } = await checkSupplierEnabled('wgcards');
  if (!enabled) {
    logger.info('balanceMonitor: wgcards is disabled by admin — skipping');
    return { skipped: true, reason: 'supplier_disabled' };
  }

  let accountData;
  try {
    accountData = await wgcardsService.getAccount();
  } catch (err) {
    // getAccount already ran recordFailure via _authedCall — this job's
    // own job is just to make a balance-specific alert visible.
    logger.error(`balanceMonitor: getAccount failed — balance unknown, treating as at-risk:`, err.message);
    return { supplier: 'wgcards', ok: false, error: err.message };
  }

  const account = pickTrackedAccount(accountData?.accounts);
  if (!account) {
    logger.warn(`balanceMonitor: no ${TRACKED_CURRENCY} wallet found in getAccount's response — cannot check threshold`);
    return { supplier: 'wgcards', ok: false, error: `no ${TRACKED_CURRENCY} wallet in response` };
  }

  await supplierConfigRepo.saveBalance('wgcards', account.balance, account.currency);

  const cfg = await supplierConfigRepo.getBySupplierName('wgcards');
  const threshold = cfg.low_balance_threshold !== null ? Number(cfg.low_balance_threshold) : null;
  const isLow = threshold !== null && account.balance < threshold;

  if (isLow) {
    logger.error(`balanceMonitor: WgCards ${account.currency} balance ($${account.balance}) is BELOW the configured threshold ($${threshold}) — fund the account soon`);
  }
  if (!account.effective) {
    logger.error(`balanceMonitor: WgCards ${account.currency} wallet reports effective=false — treat as unusable`);
  }

  return {
    supplier: 'wgcards',
    ok: true,
    balance: account.balance,
    currency: account.currency,
    threshold,
    isLow,
    effective: account.effective,
  };
}

module.exports = { run, pickTrackedAccount, TRACKED_CURRENCY };

// ── CLI entry point ─────────────────────────────────────────────────────
if (require.main === module) {
  run()
    .then((summary) => {
      console.log('Balance check complete:', JSON.stringify(summary, null, 2));
      return db.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Balance check failed:', err);
      process.exit(1);
    });
}
