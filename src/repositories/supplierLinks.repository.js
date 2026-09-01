// repositories/supplierLinks.repository.js
// Master Plan §9 — the multi-supplier normalization layer. Three tables:
//   sku_supplier_links    — confirmed links: canonical SKU <-> supplier SKU
//   supplier_catalog_items — staging area for unmatched incoming catalog items
//   brand_aliases          — normalizes "Steam"/"Steam Wallet"/"Steam Gift
//                            Card" etc into one matching key
'use strict';

const db = require('../config/database');

// ── sku_supplier_links ──────────────────────────────────────────────────

/** All active links for a canonical SKU, cheapest first — exactly the
 * ordered list §10's selection logic starts from. */
async function getActiveLinksForSku(skuId) {
  return db.query(
    `SELECT * FROM sku_supplier_links
      WHERE sku_id = ? AND is_active = 1
      ORDER BY cost_price_base_currency ASC, cost_price ASC`,
    [skuId]
  );
}

async function getLinkBySupplierRef(supplier, supplierSkuRef) {
  return db.queryOne(
    'SELECT * FROM sku_supplier_links WHERE supplier = ? AND supplier_sku_ref = ?',
    [supplier, String(supplierSkuRef)]
  );
}

async function getLinkById(linkId) {
  return db.queryOne('SELECT * FROM sku_supplier_links WHERE link_id = ?', [linkId]);
}

async function getLinksForSku(skuId) {
  return db.query('SELECT * FROM sku_supplier_links WHERE sku_id = ? ORDER BY supplier ASC', [skuId]);
}

/** Create a confirmed link, or refresh price/stock on an existing one
 * (keyed on supplier+supplier_sku_ref, per §9.2 step 4 — "every later
 * sync just updates cost_price/stock_status on the existing link"). */
async function upsertLink({
  skuId, supplier, supplierRef, supplierSkuRef,
  costPrice, costCurrency = 'USD', costPriceBaseCurrency = null,
  fxRateUsed = null, fxRateAt = null, stockStatus = 'unknown',
}) {
  await db.query(
    `INSERT INTO sku_supplier_links
       (sku_id, supplier, supplier_ref, supplier_sku_ref, cost_price, cost_currency,
        cost_price_base_currency, fx_rate_used, fx_rate_at, stock_status, is_active, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())
     ON DUPLICATE KEY UPDATE
       cost_price = VALUES(cost_price), cost_currency = VALUES(cost_currency),
       cost_price_base_currency = VALUES(cost_price_base_currency),
       fx_rate_used = VALUES(fx_rate_used), fx_rate_at = VALUES(fx_rate_at),
       stock_status = VALUES(stock_status), last_synced_at = NOW()`,
    [skuId, supplier, supplierRef || null, String(supplierSkuRef), costPrice, costCurrency,
      costPriceBaseCurrency, fxRateUsed, fxRateAt, stockStatus]
  );
  return getLinkBySupplierRef(supplier, supplierSkuRef);
}

async function setLinkActive(linkId, isActive) {
  await db.query('UPDATE sku_supplier_links SET is_active = ? WHERE link_id = ?', [isActive ? 1 : 0, linkId]);
}

async function setPriorityOverride(linkId, override) {
  // override: null | 'always_prefer' | 'never_use'
  await db.query('UPDATE sku_supplier_links SET admin_priority_override = ? WHERE link_id = ?', [override, linkId]);
}

async function updateStockStatus(supplier, supplierSkuRef, stockStatus) {
  await db.query(
    'UPDATE sku_supplier_links SET stock_status = ?, last_synced_at = NOW() WHERE supplier = ? AND supplier_sku_ref = ?',
    [stockStatus, supplier, String(supplierSkuRef)]
  );
}

// ── supplier_catalog_items (staging) ────────────────────────────────────

/** Insert or refresh a staged catalog item awaiting admin review. Never
 * touches sku_supplier_links — that only happens once an admin confirms
 * a match via markLinked/markCreatedNew. */
async function upsertStagingItem({
  supplier, supplierRef, supplierSkuRef, itemName, brandName,
  faceValue, currency, region, costPrice, matchKey, suggestedSkuId, rawPayload,
}) {
  await db.query(
    `INSERT INTO supplier_catalog_items
       (supplier, supplier_ref, supplier_sku_ref, item_name, brand_name, face_value,
        currency, region, cost_price, match_key, suggested_sku_id, status, raw_payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?)
     ON DUPLICATE KEY UPDATE
       item_name = VALUES(item_name), brand_name = VALUES(brand_name), face_value = VALUES(face_value),
       currency = VALUES(currency), region = VALUES(region), cost_price = VALUES(cost_price),
       match_key = VALUES(match_key), suggested_sku_id = VALUES(suggested_sku_id),
       raw_payload = VALUES(raw_payload)
       -- deliberately NOT touching status — a re-sync of an item an admin
       -- already reviewed (linked/rejected/ignored) must not reset it back
       -- to pending_review`,
    [supplier, supplierRef || null, String(supplierSkuRef), itemName, brandName || null,
      faceValue ?? null, currency || null, region || null, costPrice ?? null,
      matchKey || null, suggestedSkuId || null, rawPayload ? JSON.stringify(rawPayload) : null]
  );
}

async function getStagingItemBySupplierRef(supplier, supplierSkuRef) {
  return db.queryOne(
    'SELECT * FROM supplier_catalog_items WHERE supplier = ? AND supplier_sku_ref = ?',
    [supplier, String(supplierSkuRef)]
  );
}

async function getPendingReview({ supplier, page = 1, limit = 50 } = {}) {
  const conds = ["status = 'pending_review'"];
  const params = [];
  if (supplier) { conds.push('supplier = ?'); params.push(supplier); }
  const where = `WHERE ${conds.join(' AND ')}`;
  const safeLimit = Math.min(parseInt(limit) || 50, 200);
  const offset = (Math.max(parseInt(page) || 1, 1) - 1) * safeLimit;

  const rows = await db.query(
    `SELECT sci.*, ps.sku_name AS suggested_sku_name, p.product_name AS suggested_product_name
       FROM supplier_catalog_items sci
       LEFT JOIN product_skus ps ON ps.sku_id = sci.suggested_sku_id
       LEFT JOIN products p ON p.product_id = ps.product_id
       ${where}
      ORDER BY sci.created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, safeLimit, offset]
  );
  const [{ total }] = await db.query(`SELECT COUNT(*) AS total FROM supplier_catalog_items ${where}`, params);
  return { rows, pagination: { page: Math.max(parseInt(page) || 1, 1), limit: safeLimit, total } };
}

async function getStagingItem(stagingId) {
  return db.queryOne('SELECT * FROM supplier_catalog_items WHERE staging_id = ?', [stagingId]);
}

async function markStagingStatus(stagingId, status, reviewedBy) {
  await db.query(
    'UPDATE supplier_catalog_items SET status = ?, reviewed_by = ?, reviewed_at = NOW() WHERE staging_id = ?',
    [status, reviewedBy || null, stagingId]
  );
}

// ── brand_aliases ────────────────────────────────────────────────────────

async function getCanonicalBrand(rawBrand) {
  if (!rawBrand) return null;
  const row = await db.queryOne('SELECT canonical_brand FROM brand_aliases WHERE alias = ?', [rawBrand.trim()]);
  // No alias on file yet — fall back to the normalized raw string itself
  // so matching still works for a brand nobody's aliased, it's just not
  // as forgiving of spelling variants until an admin adds one.
  return row?.canonical_brand || rawBrand.trim().toLowerCase();
}

async function addAlias(alias, canonicalBrand) {
  await db.query(
    'INSERT INTO brand_aliases (alias, canonical_brand) VALUES (?, ?) ON DUPLICATE KEY UPDATE canonical_brand = VALUES(canonical_brand)',
    [alias.trim(), canonicalBrand.trim().toLowerCase()]
  );
}

module.exports = {
  getActiveLinksForSku, getLinkBySupplierRef, getLinkById, getLinksForSku,
  upsertLink, setLinkActive, setPriorityOverride, updateStockStatus,
  upsertStagingItem, getPendingReview, getStagingItem, getStagingItemBySupplierRef, markStagingStatus,
  getCanonicalBrand, addAlias,
};
