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
// MATCHING WORKFLOW: this job used to upsert directly into products/
// product_skus for every WgCards item, bypassing Master Plan §9.2's
// staging/matching review entirely — a holdover from before Gift2Games
// existed, when WgCards' catalog WAS the whole products table with no
// separate "canonical catalog" to match against. Now that multiple
// suppliers exist (and internal products predate WgCards too — there was
// always something to match against, this job just never did), a
// genuinely NEW item is staged into supplier_catalog_items for admin
// review via catalogMatching.service.js, exactly like
// gift2gamesCatalogSync.js already does. Three cases per item:
//   1. Item already known (products.spu_id/source matches) -> routine
//      refresh + add any new denomination directly, no review needed —
//      matching only matters for a genuinely new item, not a new size of
//      something already confirmed real.
//   2. Item unrecognized, but Direct Top-Up (spuType:5) -> skipped
//      entirely, not even staged. Client decision: "we would not sell
//      those" — staging something that can only ever be rejected is just
//      admin busywork.
//   3. Item unrecognized, sellable -> staged for review (§9.2).
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
 * compounding the wrong number, and needs_review (set unconditionally
 * whenever a SKU is newly created) is what flags it for a human either way. */
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

/** §9.2 step 2's normalized matching key — brand (via the alias table) +
 * face value + currency, same shape gift2gamesCatalogSync.js's
 * buildMatchKey uses. WgCards gives an explicit brand field directly
 * (itemBrandName) — no title-splitting heuristic needed, unlike
 * Gift2Games' /products response. Region is omitted (WgCards' getItem
 * doesn't expose one either), matching the same simplification. */
async function buildMatchKey(itemRaw, mapped) {
  const rawBrand = itemRaw.itemBrandName || itemRaw.itemName;
  const canonicalBrand = await supplierLinksRepo.getCanonicalBrand(rawBrand);
  const fv = mapped.faceValue != null ? Number(mapped.faceValue).toFixed(2) : 'na';
  const cur = (mapped.priceCurrency || '').toUpperCase();
  return `${canonicalBrand}|${fv}|${cur}`;
}

function resolveCostPriceBaseCurrency(price, currency) {
  return (currency || 'USD').toUpperCase() === 'USD' ? price : null;
}

// ── DB writes ────────────────────────────────────────────────────────────

async function getDefaultMarginPercent() {
  const row = await db.queryOne(
    "SELECT setting_value FROM system_settings WHERE setting_key = 'default_margin_percent'"
  );
  return row ? Number(row.setting_value) : 20;
}

/** Item-level refresh only — never creates. Returns the existing
 * product_id, or null if this item has never been seen before (the
 * signal that decides staging vs routine-refresh in syncOneItem). */
async function findAndRefreshProduct(itemRaw) {
  const existing = await db.queryOne('SELECT product_id FROM products WHERE spu_id = ? AND source = ?', [
    String(itemRaw.itemId),
    'wgcards',
  ]);
  if (!existing) return null;

  await db.query(
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
      existing.product_id,
    ]
  );
  return existing.product_id;
}

/** Refresh an already-catalogued SKU's product_skus row — used for both
 * "already linked" and "linked but the link row itself was missing"
 * (a pre-existing-data gap this job backfills rather than re-stages). */
async function refreshSku(skuId, mapped) {
  return db.transaction(async (conn) => {
    // selling_price is deliberately NOT in this UPDATE — never overwritten once set.
    await conn.execute(
      `UPDATE product_skus SET
         sku_name = ?, face_value = ?, is_custom_value = ?, min_face_value = ?, max_face_value = ?,
         cost_price = ?, price_currency = ?
       WHERE sku_id = ?`,
      [mapped.skuName, mapped.faceValue, mapped.isCustomValue ? 1 : 0, mapped.minFaceValue, mapped.maxFaceValue,
        mapped.costPrice, mapped.priceCurrency, skuId]
    );
    await ensureInventoryRowConn(conn, skuId);
  });
}

/** A new denomination on an ALREADY-KNOWN product — no staging, this
 * isn't a matching decision (the item itself is already confirmed real,
 * this is just a size WgCards added that we haven't seen yet). */
async function createSkuUnderProduct(productId, mapped) {
  return db.transaction(async (conn) => {
    const [result] = await conn.execute(
      `INSERT INTO product_skus
         (product_id, wgcards_sku_id, sku_name, face_value, is_custom_value,
          min_face_value, max_face_value, cost_price, selling_price, price_currency,
          needs_review, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
      [
        productId, mapped.wgcardsSkuId, mapped.skuName, mapped.faceValue, mapped.isCustomValue ? 1 : 0,
        mapped.minFaceValue, mapped.maxFaceValue, mapped.costPrice, mapped.defaultSellingPrice, mapped.priceCurrency,
      ]
    );
    await ensureInventoryRowConn(conn, result.insertId);
    return result.insertId;
  });
}

async function ensureInventoryRowConn(conn, skuId) {
  const existing = await conn.execute('SELECT inventory_id FROM inventory WHERE sku_id = ?', [skuId]);
  if (existing[0].length) return;
  // Stock quantity is Flow C's job (stock sync cron) — this just makes sure
  // the row exists so stock sync has something to UPDATE.
  await conn.execute(
    'INSERT INTO inventory (sku_id, stock_quantity, reserved_qty, unlimited_stock) VALUES (?, 0, 0, 0)',
    [skuId]
  );
}

/** §9/§10's sku_supplier_links — kept in sync on every regular run for
 * anything actually catalogued (linked, backfilled, or a newly-added
 * denomination). NOT called from inside refreshSku/createSkuUnderProduct's
 * own transaction — upsertLink uses the shared pool (a different
 * connection), so calling it before that transaction commits would block
 * waiting on a lock the commit itself is what releases (a guaranteed
 * hang). Must always run AFTER that transaction's own commit. */
async function linkSku(skuId, itemRaw, mapped) {
  await supplierLinksRepo.upsertLink({
    skuId,
    supplier: 'wgcards',
    supplierRef: String(itemRaw.itemId),
    supplierSkuRef: mapped.wgcardsSkuId,
    costPrice: mapped.costPrice,
    costCurrency: mapped.priceCurrency,
    costPriceBaseCurrency: resolveCostPriceBaseCurrency(mapped.costPrice, mapped.priceCurrency),
    stockStatus: 'unknown', // stockSync.js (Flow C, hourly) is the source of truth for this — never guessed here
  });
}

async function stageSku(itemRaw, sku, mapped) {
  const wasAlreadyStaged = !!(await supplierLinksRepo.getStagingItemBySupplierRef('wgcards', mapped.wgcardsSkuId));
  await supplierLinksRepo.upsertStagingItem({
    supplier: 'wgcards',
    supplierRef: String(itemRaw.itemId),
    supplierSkuRef: mapped.wgcardsSkuId,
    itemName: itemRaw.itemName,
    brandName: itemRaw.itemBrandName || null,
    faceValue: mapped.faceValue,
    currency: mapped.priceCurrency,
    region: null, // WgCards' getItem doesn't expose one either
    costPrice: mapped.costPrice,
    matchKey: await buildMatchKey(itemRaw, mapped),
    suggestedSkuId: null, // computed on demand when an admin opens the item — see catalogMatching.service.js#findSuggestedMatches
    rawPayload: { itemId: itemRaw.itemId, itemName: itemRaw.itemName, itemBrandName: itemRaw.itemBrandName, spuType: itemRaw.spuType, sku },
  });
  return wasAlreadyStaged ? 'staging_refreshed' : 'newly_staged';
}

/** Resolves one SKU to exactly one outcome, trying (in order): already
 * linked -> refresh; product_sku exists but its link is missing (a data
 * gap, not a new item) -> backfill the link; the item itself is already a
 * known product -> add this as a new denomination, no review; otherwise
 * -> stage (or skip, for Direct Top-Up) for admin review. */
async function resolveOrStageSku(itemRaw, sku, mapped, existingProductId, isDirectTopUp) {
  const existingLink = await supplierLinksRepo.getLinkBySupplierRef('wgcards', mapped.wgcardsSkuId);
  if (existingLink) {
    await refreshSku(existingLink.sku_id, mapped);
    await linkSku(existingLink.sku_id, itemRaw, mapped);
    return 'link_refreshed';
  }

  const existingSkuRow = await db.queryOne('SELECT sku_id FROM product_skus WHERE wgcards_sku_id = ?', [mapped.wgcardsSkuId]);
  if (existingSkuRow) {
    await refreshSku(existingSkuRow.sku_id, mapped);
    await linkSku(existingSkuRow.sku_id, itemRaw, mapped);
    return 'link_backfilled';
  }

  if (existingProductId) {
    const newSkuId = await createSkuUnderProduct(existingProductId, mapped);
    await linkSku(newSkuId, itemRaw, mapped);
    return 'sku_added';
  }

  if (isDirectTopUp) return 'topup_skipped';

  return stageSku(itemRaw, sku, mapped);
}

async function syncOneItem(itemRaw, defaultMarginPercent) {
  const isDirectTopUp = Number(itemRaw.spuType) === DIRECT_TOPUP_SPU_TYPE;
  const existingProductId = await findAndRefreshProduct(itemRaw);

  const skus = itemRaw.skus || itemRaw.skuList || [];
  const outcomes = { link_refreshed: 0, link_backfilled: 0, sku_added: 0, newly_staged: 0, staging_refreshed: 0, topup_skipped: 0, skipped_no_price: 0 };
  const errors = [];

  for (const sku of skus) {
    if (sku.skuPrice === undefined) {
      logger.warn(`catalogSync: skipping sku ${sku.skuId} on item ${itemRaw.itemId} — no skuPrice in response`);
      outcomes.skipped_no_price++;
      continue;
    }
    const mapped = mapSkuForUpsert(sku, defaultMarginPercent);
    if (mapped.priceCurrency.toUpperCase() !== 'USD') {
      // See mapSkuForUpsert's header — this is the confirmed-live anomaly
      // (requesting currencyCode:'USD' does not guarantee it's honored).
      logger.warn(`catalogSync: wgcards sku ${mapped.wgcardsSkuId} (item ${itemRaw.itemId}) returned non-USD pricing (${mapped.priceCurrency}) despite requesting USD — selling_price left equal to the raw cost rather than margin-inflated; needs manual review.`);
    }

    try {
      const outcome = await resolveOrStageSku(itemRaw, sku, mapped, existingProductId, isDirectTopUp);
      outcomes[outcome] = (outcomes[outcome] || 0) + 1;
    } catch (err) {
      // A single bad SKU must never take down the rest of this item's
      // denominations — logged and counted, everything else still syncs.
      logger.error(`catalogSync: failed to sync wgcards sku ${mapped.wgcardsSkuId} (item ${itemRaw.itemId}):`, err);
      errors.push({ skuId: mapped.wgcardsSkuId, error: err.message });
    }
  }

  return { itemId: itemRaw.itemId, totalSkus: skus.length, outcomes, errors };
}

// ── Pagination driver ───────────────────────────────────────────────────

async function run({ pageSize = PAGE_SIZE } = {}) {
  const { enabled } = await checkSupplierEnabled('wgcards');
  if (!enabled) {
    logger.info('catalogSync: wgcards is disabled by admin — skipping');
    return { skipped: true, reason: 'supplier_disabled' };
  }

  const defaultMarginPercent = await getDefaultMarginPercent();
  const summary = {
    itemsProcessed: 0,
    linksRefreshed: 0, linksBackfilled: 0, skusAdded: 0,
    newlyStaged: 0, stagingRefreshed: 0, topupSkipped: 0, skusSkipped: 0,
    errors: [],
  };

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
        summary.linksRefreshed += result.outcomes.link_refreshed;
        summary.linksBackfilled += result.outcomes.link_backfilled;
        summary.skusAdded += result.outcomes.sku_added;
        summary.newlyStaged += result.outcomes.newly_staged;
        summary.stagingRefreshed += result.outcomes.staging_refreshed;
        summary.topupSkipped += result.outcomes.topup_skipped;
        summary.skusSkipped += result.outcomes.skipped_no_price;
        summary.errors.push(...result.errors);
      } catch (err) {
        logger.error(`catalogSync: failed to sync item ${itemRaw.itemId}:`, err);
        summary.errors.push({ itemId: itemRaw.itemId, error: err.message });
      }
    }

    current++;
    if (current <= pages) await sleep(PAGE_DELAY_MS);
  } while (current <= pages);

  logger.info(
    `catalogSync: ${summary.itemsProcessed} item(s) processed — ${summary.linksRefreshed} link(s) refreshed, ` +
    `${summary.linksBackfilled} link(s) backfilled, ${summary.skusAdded} new denomination(s) added, ` +
    `${summary.newlyStaged} newly staged for review, ${summary.stagingRefreshed} staged item(s) refreshed, ` +
    `${summary.topupSkipped} direct top-up sku(s) skipped, ${summary.errors.length} error(s)`
  );
  return summary;
}

module.exports = { run, mapFaceValue, computeDefaultSellingPrice, mapSkuForUpsert, buildMatchKey, syncOneItem };

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
