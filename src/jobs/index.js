// jobs/index.js
// Cron registration (Master Plan §4 — "Cron Jobs, Master Table"). Only the
// jobs that exist so far are registered here; each phase adds its own line
// as it lands, following the doc's cadence.
'use strict';

const cron = require('node-cron');
const logger = require('../utils/logger');
const catalogSync = require('./catalogSync');

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
}

module.exports = { start };
