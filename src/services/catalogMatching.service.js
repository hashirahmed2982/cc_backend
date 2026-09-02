// services/catalogMatching.service.js
// Master Plan §9.2 — the admin side of "Link Products": turning a staged,
// unmatched supplier_catalog_items row into either a confirmed
// sku_supplier_links row (existing canonical product) or a brand-new
// canonical product+SKU, always via an explicit admin action. Nothing in
// gift2gamesCatalogSync.js (or a future WgCards equivalent) calls any of
// these — that job only ever stages, it never links.
'use strict';

const db = require('../config/database');
const logger = require('../utils/logger');
const supplierLinksRepo = require('../repositories/supplierLinks.repository');
const { computeDefaultSellingPrice } = require('../jobs/catalogSync');
const { assertSellingPriceAboveCost } = require('../utils/priceGuard');
const { AppError } = require('../middleware/errorHandler');

async function getDefaultMarginPercent() {
  const row = await db.queryOne("SELECT setting_value FROM system_settings WHERE setting_key = 'default_margin_percent'");
  return row ? Number(row.setting_value) : 20;
}

/** Same shape as gift2gamesCatalogSync's buildMatchKey, applied to a
 * CANONICAL product/SKU instead of an incoming supplier item — so a
 * staged item's match_key can be compared against the existing catalog.
 * region is omitted (neither supplier's sync populates products.region
 * today) — same simplification the staging side already makes. */
async function buildCanonicalMatchKey({ brandName, faceValue, currency }) {
  const canonicalBrand = await supplierLinksRepo.getCanonicalBrand(brandName);
  const fv = faceValue != null ? Number(faceValue).toFixed(2) : 'na';
  const cur = (currency || '').toUpperCase();
  return `${canonicalBrand}|${fv}|${cur}`;
}

/**
 * §9.2 steps 2-3 — computed on demand when an admin opens a staged item
 * for review, not pre-stored for all ~thousands of staged items (most of
 * which will never be reviewed). The canonical catalog is small enough
 * today (dozens of SKUs) that scanning it per lookup is cheap; would need
 * indexing/batching if it grows into the thousands.
 */
async function findSuggestedMatches(item, { limit = 5 } = {}) {
  const matchKey = item.match_key || await buildCanonicalMatchKey({
    brandName: item.brand_name, faceValue: item.face_value, currency: item.currency,
  });

  const candidates = await db.query(
    `SELECT ps.sku_id, ps.sku_name, ps.face_value, ps.price_currency, ps.selling_price,
            p.product_id, p.product_name, p.brand_name, p.source
       FROM product_skus ps JOIN products p ON p.product_id = ps.product_id
      WHERE ps.is_active = 1`
  );

  const matches = [];
  for (const c of candidates) {
    const key = await buildCanonicalMatchKey({ brandName: c.brand_name || c.product_name, faceValue: c.face_value, currency: c.price_currency });
    if (key === matchKey) {
      matches.push(c);
      if (matches.length >= limit) break;
    }
  }
  return { matchKey, matches };
}

async function getPendingReview(opts) {
  return supplierLinksRepo.getPendingReview(opts);
}

async function getStagingItemWithSuggestions(stagingId) {
  const item = await supplierLinksRepo.getStagingItem(stagingId);
  if (!item) return null;
  const { matchKey, matches } = await findSuggestedMatches(item);
  return { ...item, computedMatchKey: matchKey, suggestedMatches: matches };
}

function assertPendingReview(item) {
  if (!item) throw new Error('Staging item not found');
  if (item.status !== 'pending_review') throw new Error(`Staging item is already ${item.status}`);
}

/** Admin confirms: this staged item IS the same product as existing
 * canonical sku_id. Creates the sku_supplier_links row (§9.2 step 4 — from
 * here on, syncs just refresh price/stock on this link automatically). */
async function confirmLink({ stagingId, skuId, reviewedBy }) {
  const item = await supplierLinksRepo.getStagingItem(stagingId);
  assertPendingReview(item);

  const currency = item.currency || 'USD';
  await supplierLinksRepo.upsertLink({
    skuId,
    supplier: item.supplier,
    supplierRef: item.supplier_ref,
    supplierSkuRef: item.supplier_sku_ref,
    costPrice: item.cost_price,
    costCurrency: currency,
    costPriceBaseCurrency: currency.toUpperCase() === 'USD' ? item.cost_price : null,
    stockStatus: 'unknown',
  });
  await supplierLinksRepo.markStagingStatus(stagingId, 'linked', reviewedBy);
  return { skuId };
}

/**
 * Admin confirms: no existing canonical product matches — create a new
 * one. `source` is set to this item's supplier — still meaningful even
 * in the additive multi-supplier model, since product.service.js and the
 * admin Products page both still read it directly (see the file-level
 * note in order.service.js about the same tension, from Phase 8.1).
 * is_active starts FALSE — same as the existing manual createSupplier
 * flow — an admin reviews pricing/category before it's sellable.
 */
async function createNewFromStaging({ stagingId, reviewedBy, sellingPrice, category }) {
  const item = await supplierLinksRepo.getStagingItem(stagingId);
  assertPendingReview(item);

  const currency = item.currency || 'USD';
  const costPrice = parseFloat(item.cost_price) || 0;

  const conn = await db.getConnection();
  let productId, skuId;
  try {
    await conn.beginTransaction();

    // spu_id is WgCards' own legacy identity column — catalogSync.js looks
    // a product up by (spu_id, source='wgcards') to decide "is this a
    // known item" on every future sync. Leaving it NULL here would make
    // this exact product look unrecognized again on the very next sync,
    // re-staging it forever. Only meaningful for wgcards; NULL for any
    // other supplier, same as it always was for a product created any
    // other way.
    const spuId = item.supplier === 'wgcards' ? item.supplier_ref : null;

    const [pr] = await conn.execute(
      `INSERT INTO products
         (product_name, brand_name, category, is_active, source, supplier_name, supplier_ref, spu_id, sync_enabled)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, 1)`,
      [item.item_name, item.brand_name || null, category || null, item.supplier, item.supplier, item.supplier_ref || null, spuId]
    );
    productId = pr.insertId;

    let finalSellingPrice = sellingPrice != null ? parseFloat(sellingPrice) : null;
    let needsReview = false;
    if (finalSellingPrice == null) {
      // Auto-computing a margin off costPrice only makes sense when
      // costPrice is actually USD — this portal sells in USD only (see
      // utils/priceGuard.js's header), and a margin baked onto a raw
      // non-USD number would become a confidently-wrong "USD" price with
      // no visible sign anything's off. Refuse to guess; require an
      // explicit admin-entered price instead.
      if (currency.toUpperCase() !== 'USD') {
        // Let the existing catch block below roll back — don't roll back
        // here too, a double rollback on the same connection can itself
        // throw and mask this cleaner error.
        throw new AppError(
          `This item's cost is recorded in ${currency}, not USD — a default margin can't be computed safely. ` +
          `Enter a selling price explicitly.`,
          400
        );
      }
      const marginPercent = await getDefaultMarginPercent();
      finalSellingPrice = computeDefaultSellingPrice(costPrice, marginPercent);
      needsReview = true; // same "admin hasn't confirmed this price yet" flag catalogSync.js uses
    } else {
      // Admin gave an explicit price — still enforce the floor when we
      // can trust the currency; when we can't, skip the numeric check
      // (comparing incompatible units either way) but keep needs_review
      // so it stays visibly flagged rather than looking confirmed.
      if (currency.toUpperCase() === 'USD') {
        assertSellingPriceAboveCost(finalSellingPrice, costPrice, currency);
      } else {
        needsReview = true;
      }
    }

    // wgcards_sku_id is the OTHER legacy column wgcardsFulfillment.js reads
    // directly (it doesn't know about sku_supplier_links at all — see its
    // own SKU lookup) to know which WgCards SKU to actually place an order
    // against. Leaving this NULL for a wgcards-sourced product would make
    // it look unrecognized ("not_a_wgcards_sku") at checkout despite the
    // product being real and linked.
    const wgcardsSkuId = item.supplier === 'wgcards' ? item.supplier_sku_ref : null;

    const [sr] = await conn.execute(
      `INSERT INTO product_skus
         (product_id, sku_name, supplier_sku_ref, wgcards_sku_id, face_value, cost_price, selling_price,
          price_currency, needs_review, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [productId, item.item_name, item.supplier_sku_ref, wgcardsSkuId, item.face_value, costPrice, finalSellingPrice, currency, needsReview ? 1 : 0]
    );
    skuId = sr.insertId;

    // Unlimited stock — no quantity tracked for supplier products, same
    // convention as product.service.js#createSupplier.
    await conn.execute(
      'INSERT INTO inventory (sku_id, stock_quantity, reserved_qty, unlimited_stock) VALUES (?, 0, 0, 1)',
      [skuId]
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    logger.error('catalogMatching.createNewFromStaging:', err);
    throw err;
  } finally {
    conn.release();
  }

  // Deliberately after commit — the product/sku/inventory creation is
  // already atomic; the link row is a separate, retryable step (if this
  // fails, the product still exists correctly, just unlinked — an admin
  // can re-run confirmLink against it manually).
  await supplierLinksRepo.upsertLink({
    skuId, supplier: item.supplier, supplierRef: item.supplier_ref, supplierSkuRef: item.supplier_sku_ref,
    costPrice, costCurrency: currency,
    costPriceBaseCurrency: currency.toUpperCase() === 'USD' ? costPrice : null,
    stockStatus: 'unknown',
  });
  await supplierLinksRepo.markStagingStatus(stagingId, 'created_new', reviewedBy);

  return { productId, skuId };
}

async function ignoreStaging({ stagingId, reviewedBy }) {
  const item = await supplierLinksRepo.getStagingItem(stagingId);
  if (!item) throw new Error('Staging item not found');
  await supplierLinksRepo.markStagingStatus(stagingId, 'ignored', reviewedBy);
}

module.exports = {
  buildCanonicalMatchKey, findSuggestedMatches, getPendingReview,
  getStagingItemWithSuggestions, confirmLink, createNewFromStaging, ignoreStaging,
};
