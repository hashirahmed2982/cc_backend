// jobs/catalogSync.js
// Flow B1 (Master Plan §5) — WgCards catalog sync, every 6h.
//
// IMPORTANT deviation from the doc's literal description: the doc says
// "getAllItem({currencyCode, language:'en'}) [1 call]" is enough. Live
// testing against the sandbox proved getAllItem has no pricing (no
// skuPrice/minPrice/maxPrice) — only the paginated getItem (itemId='')
// does. So this job pages through getItem instead. See the comments on
// WgCardsService#getAllItem / #getItem for the full shape difference.
//
// Usage:
//   node src/jobs/catalogSync.js            — full sync, all pages
//   node src/jobs/catalogSync.js --page-size 50
'use strict';

// Must run before requiring ../config/database — that module reads
// process.env.DB_* at require-time to build its connection pool. When this
// file is required transitively (server.js -> jobs/index.js -> here),
// server.js already loaded dotenv first, so this is a harmless no-op. When
// this file is run standalone (node src/jobs/catalogSync.js), this is the
// only thing that loads .env at all — putting it after the requires below
// (as it originally was, down in the CLI block) meant database.js had
// already built its pool with an empty DB_PASSWORD by the time dotenv ran,
// causing 'Access denied ... NO_PASSWORD_ERROR' even with a correct .env.
require('dotenv').config();

const db = require('../config/database');
const logger = require('../utils/logger');
const wgcardsService = require('../services/wgcards.service');
const { checkSupplierEnabled } = require('./_supplierGate');
const { DIRECT_TOPUP_SPU_TYPE } = require('../utils/wgcardsConstants');
const supplierLinksRepo = require('../repositories/supplierLinks.repository');

const PAGE_SIZE = 50;
const PAGE_DELAY_MS = 1600; // keeps us under getItem's 40 calls/60s limit even for a large catalog

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Pure mapping helpers (unit-testable without DB/network) ────────────────

/**
 * Decide face_value/is_custom_value/min/max from a WgCards sku record.
 * A "custom value" card (e.g. top-up with a range) has min !== max.
 */
function mapFaceValue(sku) {
  const min = sku.minFaceValue ?? null;
  const max = sku.maxFaceValue ?? null;
  const isCustom = min !== null && max !== null && min !== max;
  return {
    faceValue: isCustom ? null : min,
    isCustomValue: isCustom,
    minFaceValue: min,
    maxFaceValue: max,
  };
}

/**
 * Compute the selling_price to use ONLY when a SKU is being created for the
 * first time (comment #5 in the master plan comment thread: apply a default
 * margin, flag needs_review, never invent a price out of thin air on an
 * existing SKU).
 */
function computeDefaultSellingPrice(costPrice, defaultMarginPercent) {
  const margin = Number(defaultMarginPercent) || 0;
  return Math.round(costPrice * (1 + margin / 100) * 100) / 100;
}

/** Build the full set of DB-shaped fields for one WgCards sku record.
 *
 * CURRENCY: catalogSync.js always requests getItem({currencyCode:'USD'}),
 * but that request has been observed NOT to be honored — a real captured
 * sandbox response returned skuPriceCurrency:'CNY' despite it (see this
 * file's own tests). This portal only ever sells in USD (see
 * utils/priceGuard.js's header) — applying a margin to a non-USD costPrice
 * would produce a confidently-wrong "USD" price with no visible sign
 * anything's off, so when the currency isn't USD, defaultSellingPrice is
 * left equal to the raw costPrice (no margin) rather than inflated —
 * satisfies the DB's own selling_price >= cost_price constraint without
 * compounding the wrong number, and needs_review (set unconditionally by
 * upsertSku's INSERT) is what flags it for a human either way. */
function mapSkuForUpsert(sku, defaultMarginPercent) {
  const { faceValue, isCustomValue, minFaceValue, maxFaceValue } = mapFaceValue(sku);
  const costPrice = Number(sku.skuPrice);
  const priceCurrency = sku.skuPriceCurrency || 'USD';
  const isUsd = priceCurrency.toUpperCase() === 'USD';
  return {
    wgcardsSkuId: String(sku.skuId),
    skuName: sku.skuName,
    faceValue,
    isCustomValue,
    minFaceValue,
    maxFaceValue,
    costPrice,
    priceCurrency,
    defaultSellingPrice: isUsd ? computeDefaultSellingPrice(costPrice, defaultMarginPercent) : costPrice,
  };
}

// ── DB writes ────────────────────────────────────────────────────────────

async function getDefaultMarginPercent() {
  const row = await db.queryOne(
    "SELECT setting_value FROM system_settings WHERE setting_key = 'default_margin_percent'"
  );
  return row ? Number(row.setting_value) : 20;
}

async function upsertProduct(conn, itemRaw) {
  const existing = await conn.execute('SELECT product_id FROM products WHERE spu_id = ? AND source = ?', [
    String(itemRaw.itemId),
    'wgcards',
  ]);
  const rows = existing[0];

  if (rows.length) {
    const productId = rows[0].product_id;
    await conn.execute(
      `UPDATE products SET
         product_name = ?, brand_name = ?, description = ?, how_exchange = ?,
         image_url = COALESCE(?, image_url), spu_type = ?, currency_code = ?,
         last_synced_at = NOW()
       WHERE product_id = ?`,
      [
        itemRaw.itemName,
        itemRaw.itemBrandName || null,
        itemRaw.description || null,
        itemRaw.howExchange || null,
        itemRaw.spuImage || null,
        itemRaw.spuType ?? null,
        itemRaw.currencyCode || 'USD',
        productId,
      ]
    );
    return productId;
  }

  // Direct Top-Up (spuType:5) products are never sold (confirmed live incident
  // — order 32 debited a wallet then couldn't fulfill) and are hidden from
  // every listing regardless of is_active. Insert them already inactive as a
  // second line of defense, so a stray direct query against is_active=1
  // still doesn't expose one, and so future syncs never silently "reactivate"
  // one a human deliberately deactivated.
  const isDirectTopUp = Number(itemRaw.spuType) === DIRECT_TOPUP_SPU_TYPE;

  const [result] = await conn.execute(
    `INSERT INTO products
       (spu_id, product_name, brand_name, description, how_exchange,
        image_url, spu_type, currency_code, is_active, source, sync_enabled, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'wgcards', 1, NOW())`,
    [
      String(itemRaw.itemId),
      itemRaw.itemName,
      itemRaw.itemBrandName || null,
      itemRaw.description || null,
      itemRaw.howExchange || null,
      itemRaw.spuImage || null,
      itemRaw.spuType ?? null,
      itemRaw.currencyCode || 'USD',
      isDirectTopUp ? 0 : 1,
    ]
  );
  return result.insertId;
}

async function upsertSku(conn, productId, skuRow) {
  const existing = await conn.execute('SELECT sku_id, selling_price FROM product_skus WHERE wgcards_sku_id = ?', [
    skuRow.wgcardsSkuId,
  ]);
  const rows = existing[0];

  if (rows.length) {
    // selling_price is deliberately NOT in this UPDATE — never overwritten once set.
    const skuId = rows[0].sku_id;
    await conn.execute(
      `UPDATE product_skus SET
         sku_name = ?, face_value = ?, is_custom_value = ?, min_face_value = ?, max_face_value = ?,
         cost_price = ?, price_currency = ?
       WHERE sku_id = ?`,
      [
        skuRow.skuName, skuRow.faceValue, skuRow.isCustomValue ? 1 : 0,
        skuRow.minFaceValue, skuRow.maxFaceValue, skuRow.costPrice, skuRow.priceCurrency,
        skuId,
      ]
    );
    return { skuId, isNew: false };
  }

  const [result] = await conn.execute(
    `INSERT INTO product_skus
       (product_id, wgcards_sku_id, sku_name, face_value, is_custom_value,
        min_face_value, max_face_value, cost_price, selling_price, price_currency,
        needs_review, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
    [
      productId, skuRow.wgcardsSkuId, skuRow.skuName, skuRow.faceValue, skuRow.isCustomValue ? 1 : 0,
      skuRow.minFaceValue, skuRow.maxFaceValue, skuRow.costPrice,
      skuRow.defaultSellingPrice, skuRow.priceCurrency,
    ]
  );
  return { skuId: result.insertId, isNew: true };
}

async function ensureInventoryRow(conn, skuId) {
  const existing = await conn.execute('SELECT inventory_id FROM inventory WHERE sku_id = ?', [skuId]);
  if (existing[0].length) return;
  // Stock quantity is Flow C's job (stock sync cron) — this just makes sure
  // the row exists so stock sync has something to UPDATE.
  await conn.execute(
    'INSERT INTO inventory (sku_id, stock_quantity, reserved_qty, unlimited_stock) VALUES (?, 0, 0, 0)',
    [skuId]
  );
}

async function syncOneItem(itemRaw, defaultMarginPercent) {
  const { productId, created, updated, totalSkus, linkedSkus } = await db.transaction(async (conn) => {
    const productId = await upsertProduct(conn, itemRaw);
    const skus = itemRaw.skus || itemRaw.skuList || [];
    let created = 0;
    let updated = 0;
    const linkedSkus = [];
    for (const sku of skus) {
      if (sku.skuPrice === undefined) {
        logger.warn(`catalogSync: skipping sku ${sku.skuId} on item ${itemRaw.itemId} — no skuPrice in response`);
        continue;
      }
      const mapped = mapSkuForUpsert(sku, defaultMarginPercent);
      if (mapped.priceCurrency.toUpperCase() !== 'USD') {
        // See mapSkuForUpsert's header — this is the confirmed-live anomaly
        // (requesting currencyCode:'USD' does not guarantee it's honored).
        logger.warn(`catalogSync: wgcards sku ${mapped.wgcardsSkuId} (item ${itemRaw.itemId}) returned non-USD pricing (${mapped.priceCurrency}) despite requesting USD — selling_price left equal to the raw cost rather than margin-inflated; needs manual review.`);
      }
      const { skuId, isNew } = await upsertSku(conn, productId, mapped);
      await ensureInventoryRow(conn, skuId);
      isNew ? created++ : updated++;
      linkedSkus.push({ skuId, wgcardsSkuId: mapped.wgcardsSkuId, costPrice: mapped.costPrice, priceCurrency: mapped.priceCurrency });
    }
    return { productId, created, updated, totalSkus: skus.length, linkedSkus };
  });

  // §9/§10's sku_supplier_links, kept in sync on every regular catalog
  // sync run — NOT inside the transaction above: supplierLinksRepo.upsertLink
  // uses the shared pool (a different connection), so calling it before
  // that transaction commits would block waiting on a lock the commit
  // itself is what releases (a guaranteed hang). WgCards is the canonical
  // source of its own catalog, unlike Gift2Games — so unlike
  // gift2gamesCatalogSync.js's staging/matching workflow, every synced
  // WgCards SKU is linked directly, no admin review needed. This is what
  // scripts/backfill-sku-supplier-links.js used to be the ONLY way to get
  // (a one-time catch-up); this makes it happen automatically going
  // forward for every SKU the sync ever touches, new or existing.
  for (const s of linkedSkus) {
    try {
      await supplierLinksRepo.upsertLink({
        skuId: s.skuId,
        supplier: 'wgcards',
        supplierRef: String(itemRaw.itemId),
        supplierSkuRef: s.wgcardsSkuId,
        costPrice: s.costPrice,
        costCurrency: s.priceCurrency,
        costPriceBaseCurrency: (s.priceCurrency || 'USD').toUpperCase() === 'USD' ? s.costPrice : null,
        stockStatus: 'unknown', // stockSync.js (Flow C, hourly) is the source of truth for this — never guessed here
      });
    } catch (err) {
      // A link-sync failure must never fail the catalog sync itself — the
      // product/SKU data is already safely committed above; worst case
      // this SKU falls back to order.service.js's own no_active_supplier_link
      // safety net until the next successful sync run retries the link.
      logger.error(`catalogSync: failed to upsert sku_supplier_links for wgcards sku ${s.wgcardsSkuId} (sku_id ${s.skuId}):`, err);
    }
  }

  return { productId, created, updated, totalSkus };
}

// ── Pagination driver ───────────────────────────────────────────────────

async function run({ pageSize = PAGE_SIZE } = {}) {
  const { enabled } = await checkSupplierEnabled('wgcards');
  if (!enabled) {
    logger.info('catalogSync: wgcards is disabled by admin — skipping');
    return { skipped: true, reason: 'supplier_disabled' };
  }

  const defaultMarginPercent = await getDefaultMarginPercent();
  const summary = { itemsProcessed: 0, skusCreated: 0, skusUpdated: 0, skusSkipped: 0, errors: [] };

  let current = 1;
  let pages = 1;

  do {
    const page = await wgcardsService.getItem({ itemId: '', current, size: pageSize });
    pages = page.pages || 1;
    const records = page.records || [];

    for (const itemRaw of records) {
      try {
        const result = await syncOneItem(itemRaw, defaultMarginPercent);
        summary.itemsProcessed++;
        summary.skusCreated += result.created;
        summary.skusUpdated += result.updated;
        summary.skusSkipped += result.totalSkus - result.created - result.updated;
      } catch (err) {
        logger.error(`catalogSync: failed to sync item ${itemRaw.itemId}:`, err);
        summary.errors.push({ itemId: itemRaw.itemId, error: err.message });
      }
    }

    current++;
    if (current <= pages) await sleep(PAGE_DELAY_MS);
  } while (current <= pages);

  return summary;
}

module.exports = { run, mapFaceValue, computeDefaultSellingPrice, mapSkuForUpsert, syncOneItem };

// ── CLI entry point ─────────────────────────────────────────────────────
if (require.main === module) {
  run()
    .then((summary) => {
      console.log('Catalog sync complete:', JSON.stringify(summary, null, 2));
      return db.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Catalog sync failed:', err);
      process.exit(1);
    });
}
