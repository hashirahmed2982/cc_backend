// jobs/gift2gamesCatalogSync.js
// Gift2Games catalog sync (Master Plan §9.2 — "Matching workflow", the
// Gift2Games counterpart to catalogSync.js). CONFIRMED LIVE against the
// real /products endpoint (2026-09-01): a single call returns the WHOLE
// catalog (1903 items in the live test, no pagination params exist on
// this endpoint per the vendor's own Postman collection) — unlike
// WgCards' getItem, there's no paging loop needed here at all.
//
// §9.2's matching workflow, exactly as designed:
//   1. Every incoming product is looked up by supplier_sku_ref (Gift2Games'
//      own numeric id) against sku_supplier_links.
//   2. Already-linked (an admin confirmed a match previously) -> refresh
//      cost_price/stock_status on the EXISTING link only. Never touched
//      again beyond that — matching is a one-time human decision, syncing
//      price/stock after that is fully automatic (§9.2 step 4).
//   3. Not linked yet -> staged into supplier_catalog_items for admin
//      review (§9.2: "linking two supplier SKUs into one canonical SKU
//      always has a human checkpoint... only the ongoing price/stock
//      refresh after that is automatic"). This job NEVER creates or
//      updates a sku_supplier_links row for an unmatched item on its own.
//
// KNOWN GAP vs the master plan's ideal matching key (brand + face_value +
// currency + region): Gift2Games' /products response has no explicit
// brand or region field at all (confirmed live — see deriveBrandFromTitle
// below), unlike WgCards' itemName/region. Titles look like "MOBILE
// LEGENDS - 11 DIAMONDS" — brand is crudely extracted by splitting on the
// first " - ", which will be wrong for titles with no separator or an
// unusual format. This is exactly what §9.3's brand_aliases table exists
// to correct over time, not something this heuristic needs to get
// perfect on day one — a wrong SUGGESTION still requires an admin click
// to become a real link, so the failure mode is "annoying to review", not
// "silently sells the wrong product".
//
// TWO DIFFERENT CURRENCIES, CONFIRMED LIVE: a real /products record for a
// regional card looks like:
//   { price: 2.632, currency: 'USD', productFaceValue: 2, productFaceValueCurrency: 'GBP', originalPrice: '1.945', originalCurrency: 'GBP' }
// `price`/`currency` (what we actually pay Gift2Games) is ALWAYS USD —
// same confirmed pattern as WgCards' skuPrice/skuPriceCurrency. But
// `productFaceValue`/`productFaceValueCurrency` (what the card is worth in
// its home market, e.g. a UK Apple card really is denominated in GBP) is
// NOT the same currency and must never be conflated with it. This job used
// to store the face-value currency into supplier_catalog_items.currency
// (so the review UI would show "2 GBP" correctly) — but
// catalogMatching.service.js reads that same `currency` column as the
// currency cost_price is IN, so a $2.632 USD cost was ending up mislabeled
// 'GBP' on confirm (migration 016 fixes this split — see its own comment).
// `currency` here now always carries the cost/price currency (USD);
// `faceValueCurrency` carries the card's own denomination separately.
//
// Usage:
//   node src/jobs/gift2gamesCatalogSync.js
'use strict';

require('dotenv').config();

const logger = require('../utils/logger');
const gift2gamesService = require('../services/gift2games.service');
const supplierLinksRepo = require('../repositories/supplierLinks.repository');
const { checkSupplierEnabled } = require('./_supplierGate');

/** Crude first-pass brand extraction — see file header. Exported for unit
 * testing and reuse from a future catalogMatching.service.js. */
function deriveBrandFromTitle(title) {
  if (!title) return '';
  const idx = title.indexOf(' - ');
  return (idx === -1 ? title : title.slice(0, idx)).trim();
}

/** §9.2 step 2's normalized matching key — brand (via the alias table) +
 * face value + currency. Region is omitted entirely (not available from
 * Gift2Games' /products response) — see file header gap note. */
async function buildMatchKey(product) {
  const rawBrand = deriveBrandFromTitle(product.title);
  const canonicalBrand = await supplierLinksRepo.getCanonicalBrand(rawBrand);
  const faceValue = product.productFaceValue != null ? Number(product.productFaceValue).toFixed(2) : 'na';
  const currency = (product.productFaceValueCurrency || product.currency || '').toUpperCase();
  return `${canonicalBrand}|${faceValue}|${currency}`;
}

/** Resolve cost_price into the USD base-reporting-currency, matching the
 * same "no real FX conversion yet, just mirror when already USD" stance
 * scripts/backfill-sku-supplier-links.js takes for WgCards. */
function resolveCostPriceBaseCurrency(price, currency) {
  return (currency || 'USD').toUpperCase() === 'USD' ? price : null;
}

async function syncOneProduct(product) {
  const supplierSkuRef = String(product.id);
  const existingLink = await supplierLinksRepo.getLinkBySupplierRef('gift2games', supplierSkuRef);
  const currency = product.currency || 'USD';

  if (existingLink) {
    // §9.2 step 4 — already confirmed, just refresh price/stock.
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
    return 'link_refreshed';
  }

  const wasAlreadyStaged = !!(await supplierLinksRepo.getStagingItemBySupplierRef('gift2games', supplierSkuRef));
  await supplierLinksRepo.upsertStagingItem({
    supplier: 'gift2games',
    supplierRef: product.categoryId != null ? String(product.categoryId) : null,
    supplierSkuRef,
    itemName: product.title,
    brandName: deriveBrandFromTitle(product.title),
    faceValue: product.productFaceValue,
    // `currency` = what cost_price is denominated in (always USD, per file
    // header). `faceValueCurrency` = what the card itself is worth in its
    // home market (e.g. GBP) — kept separate so it never leaks into
    // cost_price's currency tag downstream. See migration 016.
    currency,
    faceValueCurrency: product.productFaceValueCurrency || currency,
    region: null, // not exposed by Gift2Games' /products response — see file header
    costPrice: product.price,
    matchKey: await buildMatchKey(product),
    suggestedSkuId: null, // TODO: real suggestion lookup — see the "not yet built" Link Products matching service
    rawPayload: product,
  });
  return wasAlreadyStaged ? 'staging_refreshed' : 'newly_staged';
}

async function run() {
  const { enabled } = await checkSupplierEnabled('gift2games');
  if (!enabled) {
    logger.info('gift2gamesCatalogSync: gift2games is disabled by admin — skipping');
    return { skipped: true, reason: 'supplier_disabled' };
  }

  const products = await gift2gamesService.getProducts();
  const summary = { totalProducts: products.length, linksRefreshed: 0, newlyStaged: 0, stagingRefreshed: 0, errors: [] };

  for (const product of products) {
    try {
      const outcome = await syncOneProduct(product);
      if (outcome === 'link_refreshed') summary.linksRefreshed++;
      else if (outcome === 'newly_staged') summary.newlyStaged++;
      else summary.stagingRefreshed++;
    } catch (err) {
      logger.error(`gift2gamesCatalogSync: failed to sync product ${product.id}:`, err);
      summary.errors.push({ productId: product.id, error: err.message });
    }
  }

  logger.info(
    `gift2gamesCatalogSync: ${summary.linksRefreshed} confirmed link(s) refreshed, ` +
    `${summary.newlyStaged} newly staged for review, ${summary.stagingRefreshed} staged item(s) refreshed, ` +
    `${summary.errors.length} error(s)`
  );
  return summary;
}

module.exports = { run, deriveBrandFromTitle, buildMatchKey, syncOneProduct };

// ── CLI entry point ─────────────────────────────────────────────────────
if (require.main === module) {
  const db = require('../config/database');
  run()
    .then((summary) => {
      console.log('Gift2Games catalog sync complete:', JSON.stringify(summary, null, 2));
      return db.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Gift2Games catalog sync failed:', err);
      process.exit(1);
    });
}
