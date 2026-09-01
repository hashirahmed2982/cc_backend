// jobs/stockSync.js
// Flow C (Master Plan §5) — WgCards stock sync, every 60 min.
// Batch getStock(skuIds) in chunks of 50, ~2s apart (well under the doc's
// 40 calls/60s limit for getStock). A failed batch is skipped, not retried
// within the same run — Flow C's own fallback is "retry on the next hourly
// run", not an in-run retry loop.
//
// Usage:
//   node src/jobs/stockSync.js
'use strict';

require('dotenv').config();

const db = require('../config/database');
const logger = require('../utils/logger');
const wgcardsService = require('../services/wgcards.service');
const { checkSupplierEnabled } = require('./_supplierGate');

const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 2000; // "~2s apart" per the doc's own Flow C description
const STALE_HOURS = 2; // doc: flag SKUs whose last_sync is older than this

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Pure helpers (unit-testable without DB/network) ────────────────────────

/** Split an array into fixed-size chunks. */
function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * getStock's `number` field: -1 means unlimited (per the doc). Anything
 * else is a real quantity — clamp negative-but-not--1 values defensively
 * rather than ever writing a negative stock_quantity (the DB has a CHECK
 * constraint that would reject it anyway, but better to not even try).
 */
function deriveInventoryUpdate(stockEntry) {
  const unlimited = stockEntry.number === -1;
  return {
    wgcardsSkuId: String(stockEntry.skuId),
    stockQuantity: unlimited ? 0 : Math.max(0, Number(stockEntry.number) || 0),
    unlimitedStock: unlimited,
  };
}

// ── DB ──────────────────────────────────────────────────────────────────

async function getActiveWgCardsSkuIds() {
  const rows = await db.query(
    `SELECT ps.wgcards_sku_id
       FROM product_skus ps
       JOIN products p ON p.product_id = ps.product_id
      WHERE ps.wgcards_sku_id IS NOT NULL AND ps.is_active = 1 AND p.is_active = 1`
  );
  return rows.map((r) => r.wgcards_sku_id);
}

async function applyStockUpdate(update) {
  await db.query(
    `UPDATE inventory inv
       JOIN product_skus ps ON ps.sku_id = inv.sku_id
        SET inv.stock_quantity = ?, inv.unlimited_stock = ?, inv.last_sync = NOW()
      WHERE ps.wgcards_sku_id = ?`,
    [update.stockQuantity, update.unlimitedStock ? 1 : 0, update.wgcardsSkuId]
  );
}

async function countStaleInventory() {
  const row = await db.queryOne(
    `SELECT COUNT(*) AS n
       FROM inventory inv
       JOIN product_skus ps ON ps.sku_id = inv.sku_id
      WHERE ps.wgcards_sku_id IS NOT NULL
        AND (inv.last_sync IS NULL OR inv.last_sync < DATE_SUB(NOW(), INTERVAL ? HOUR))`,
    [STALE_HOURS]
  );
  return row ? row.n : 0;
}

// ── Runner ──────────────────────────────────────────────────────────────

async function run({ batchSize = BATCH_SIZE, batchDelayMs = BATCH_DELAY_MS } = {}) {
  const { enabled } = await checkSupplierEnabled('wgcards');
  if (!enabled) {
    logger.info('stockSync: wgcards is disabled by admin — skipping');
    return { skipped: true, reason: 'supplier_disabled' };
  }

  const skuIds = await getActiveWgCardsSkuIds();
  const batches = chunk(skuIds, batchSize);
  const summary = { totalSkus: skuIds.length, batches: batches.length, updated: 0, failedBatches: [] };

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    try {
      const stockEntries = await wgcardsService.getStock(batch);
      for (const entry of stockEntries) {
        const update = deriveInventoryUpdate(entry);
        await applyStockUpdate(update);
        summary.updated++;
      }
    } catch (err) {
      // Flow C fallback: skip this batch, let the next hourly run pick it
      // back up — do NOT retry within this run.
      logger.warn(`stockSync: batch ${i + 1}/${batches.length} failed, skipping (retried next run):`, err.message);
      summary.failedBatches.push({ batchIndex: i, skuIds: batch, error: err.message });
    }

    if (i < batches.length - 1) await sleep(batchDelayMs);
  }

  summary.staleCount = await countStaleInventory();
  if (summary.staleCount > 0) {
    logger.warn(`stockSync: ${summary.staleCount} SKU(s) have stock data older than ${STALE_HOURS}h`);
  }

  return summary;
}

module.exports = { run, chunk, deriveInventoryUpdate };

// ── CLI entry point ─────────────────────────────────────────────────────
if (require.main === module) {
  run()
    .then((summary) => {
      console.log('Stock sync complete:', JSON.stringify(summary, null, 2));
      return db.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Stock sync failed:', err);
      process.exit(1);
    });
}
