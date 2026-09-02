// jobs/gift2gamesStockSync.js
// Flow C counterpart for Gift2Games — stockSync.js only ever covered
// WgCards, hourly. gift2gamesCatalogSync.js already refreshes cost_price/
// stock_status on every CONFIRMED link as a side effect of its own 6h run
// (Master Plan §9.2 step 4), but that's a 6h-stale window for something as
// time-sensitive as stock/price — this is the same refresh, on WgCards'
// hourly cadence, for confirmed links only (never touches staging/matching
// — that stays exclusively gift2gamesCatalogSync.js's job, run less often
// since it also does the more expensive brand-matching work).
//
// Gift2Games' /products has no per-id batching param (confirmed live: one
// call returns the whole catalog, ~1900 items) — unlike WgCards' getStock,
// there's no chunking to do on the network side; the only work here is
// filtering down to SKUs we already have a confirmed link for.
//
// Usage:
//   node src/jobs/gift2gamesStockSync.js
'use strict';

require('dotenv').config();

const db = require('../config/database');
const logger = require('../utils/logger');
const gift2gamesService = require('../services/gift2games.service');
const supplierLinksRepo = require('../repositories/supplierLinks.repository');
const { checkSupplierEnabled } = require('./_supplierGate');

function resolveCostPriceBaseCurrency(price, currency) {
  return (currency || 'USD').toUpperCase() === 'USD' ? price : null;
}

async function run() {
  const { enabled } = await checkSupplierEnabled('gift2games');
  if (!enabled) {
    logger.info('gift2gamesStockSync: gift2games is disabled by admin — skipping');
    return { skipped: true, reason: 'supplier_disabled' };
  }

  const products = await gift2gamesService.getProducts();
  const summary = { totalProducts: products.length, linksRefreshed: 0, notLinked: 0, errors: [] };

  for (const product of products) {
    const supplierSkuRef = String(product.id);
    try {
      const existingLink = await supplierLinksRepo.getLinkBySupplierRef('gift2games', supplierSkuRef);
      if (!existingLink) {
        summary.notLinked++;
        continue; // unmatched items are gift2gamesCatalogSync.js's concern, not this job's
      }

      const currency = product.currency || 'USD';
      await supplierLinksRepo.upsertLink({
        skuId: existingLink.sku_id,
        supplier: 'gift2games',
        supplierRef: product.categoryId != null ? String(product.categoryId) : null,
        supplierSkuRef,
        costPrice: product.price,
        costCurrency: currency,
        costPriceBaseCurrency: resolveCostPriceBaseCurrency(product.price, currency),
        stockStatus: product.inStock ? 'in_stock' : 'out_of_stock',
      });
      summary.linksRefreshed++;
    } catch (err) {
      logger.error(`gift2gamesStockSync: failed to refresh link for product ${product.id}:`, err);
      summary.errors.push({ productId: product.id, error: err.message });
    }
  }

  return summary;
}

module.exports = { run };

// ── CLI entry point ─────────────────────────────────────────────────────
if (require.main === module) {
  run()
    .then((summary) => {
      console.log('Gift2Games stock sync complete:', JSON.stringify(summary, null, 2));
      return db.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Gift2Games stock sync failed:', err);
      process.exit(1);
    });
}
