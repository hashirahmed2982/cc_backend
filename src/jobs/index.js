// jobs/index.js
// Cron registration (Master Plan §4 — "Cron Jobs, Master Table"). Only the
// jobs that exist so far are registered here; each phase adds its own line
// as it lands, following the doc's cadence.
'use strict';

const cron = require('node-cron');
const logger = require('../utils/logger');
const catalogSync = require('./catalogSync');
const stockSync = require('./stockSync');
const orderPoller = require('./orderPoller');

function guarded(name, fn) {
  return async () => {
    logger.info(`[cron] ${name}: starting`);
    try {
      const summary = await fn();
      logger.info(`[cron] ${name}: done`, summary);
    } catch (err) {
      logger.error(`[cron] ${name}: failed`, err);
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
}

module.exports = { start };
