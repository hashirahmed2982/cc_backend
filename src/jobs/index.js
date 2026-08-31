// jobs/index.js
// Cron registration (Master Plan §4 — "Cron Jobs, Master Table"). Only the
// jobs that exist so far are registered here; each phase adds its own line
// as it lands, following the doc's cadence.
'use strict';

const cron = require('node-cron');
const logger = require('../utils/logger');
const cronJobRunsRepo = require('../repositories/cronJobRuns.repository');
const catalogSync = require('./catalogSync');
const stockSync = require('./stockSync');
const orderPoller = require('./orderPoller');
const healthCheck = require('./healthCheck');
const balanceMonitor = require('./balanceMonitor');
const wgcardsTopupReconciler = require('./wgcardsTopupReconciler');

function guarded(name, fn) {
  return async () => {
    logger.info(`[cron] ${name}: starting`);
    try {
      const summary = await fn();
      logger.info(`[cron] ${name}: done`, summary);
      // Best-effort — the admin panel's Cron Health widget reads this, but
      // a logging failure here must never be why a job run itself reports
      // as failed.
      await cronJobRunsRepo.recordRun(name, { status: 'success', summary }).catch((err) => {
        logger.error(`[cron] ${name}: failed to record run status`, err);
      });
    } catch (err) {
      logger.error(`[cron] ${name}: failed`, err);
      await cronJobRunsRepo.recordRun(name, { status: 'failed', error: err.message }).catch((recErr) => {
        logger.error(`[cron] ${name}: failed to record run status`, recErr);
      });
    }
  };
}

function start() {
  // Job #1 — Catalog Sync, every 6h (Flow B1).
  cron.schedule('0 */6 * * *', guarded('catalogSync', () => catalogSync.run()));
  logger.info('[cron] registered: catalogSync (every 6h)');

  // Job #2 — Stock Sync, every 60 min (Flow C).
  cron.schedule('0 * * * *', guarded('stockSync', () => stockSync.run()));
  logger.info('[cron] registered: stockSync (every 60 min)');

  // Job #4 — Order Completion Poller, every 5 min (Flow E). The job itself
  // applies the tiered cadence (5min/30min/2h/6h by order age) per row, so
  // running the cron every 5 min and letting shouldPollNow() skip rows that
  // aren't due yet is correct and matches the doc's own table.
  cron.schedule('*/5 * * * *', guarded('orderPoller', () => orderPoller.run()));
  logger.info('[cron] registered: orderPoller (every 5 min, tiered per-order cadence)');

  // Job #7 — Integration Health Check, every 15 min (Flow A circuit breaker
  // heartbeat).
  cron.schedule('*/15 * * * *', guarded('healthCheck', () => healthCheck.run()));
  logger.info('[cron] registered: healthCheck (every 15 min)');

  // Job #6 — Account Balance Monitor, every 30 min (Flow G).
  cron.schedule('*/30 * * * *', guarded('balanceMonitor', () => balanceMonitor.run()));
  logger.info('[cron] registered: balanceMonitor (every 30 min)');

  // Job #5 — Top-up Reconciler, every 10 min (Flow F fallback). The job
  // itself only acts on rows past the 35-min mark (RECONCILE_AFTER_MINUTES),
  // so running the cron every 10 min and letting it skip everything younger
  // is correct and matches the doc's own "every 10 min from the 35-min mark".
  cron.schedule('*/10 * * * *', guarded('wgcardsTopupReconciler', () => wgcardsTopupReconciler.run()));
  logger.info('[cron] registered: wgcardsTopupReconciler (every 10 min, 35-min fallback window)');
}

module.exports = { start };
