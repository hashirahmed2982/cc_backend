// services/supplierSelection.service.js
// Master Plan §10 — Cheapest-Supplier Selection Logic (Flow D addendum).
// Replaces the single-supplier branch in order.service.js#_fulfillOrder
// for any canonical SKU with an active sku_supplier_links row. With only
// WgCards active today every SKU has exactly one usable link, so this is
// currently just "use the only option" — but the SAME code path that
// runs today is what starts choosing between suppliers the moment a
// second one has a confirmed, active link on the same SKU.
'use strict';

const db = require('../config/database');
const logger = require('../utils/logger');
const supplierConfigRepo = require('../repositories/supplierConfig.repository');
const supplierLinksRepo = require('../repositories/supplierLinks.repository');
const wgcardsFulfillment = require('./wgcardsFulfillment');
const gift2gamesFulfillment = require('./gift2gamesFulfillment');
const { assertSellingPriceAboveCost } = require('../utils/priceGuard');

// Registry Section 5's own header calls for: "_fulfillOrder() calls
// supplierRegistry[product.source] instead of branching on supplier name
// inline." Each module exposes a uniform attemptFulfillment(...).
const FULFILLMENT_MODULES = {
  wgcards: wgcardsFulfillment,
  gift2games: gift2gamesFulfillment,
};

/** A supplier is usable for NEW attempts if it's configured, not admin-
 * disabled, and not circuit-breaker-down. Matches §10 step 2's "filter
 * out any supplier currently flagged integration_down" — is_active is
 * the same kind of gate, just admin-driven instead of auto-detected. */
async function _isSupplierUsable(supplier) {
  const cfg = await supplierConfigRepo.getBySupplierName(supplier);
  if (!cfg) return false;
  if (!cfg.is_active) return false;
  if (cfg.integration_status === 'down') return false;
  return true;
}

/** §10 steps 2-4: drop unusable/never_use links, then either isolate the
 * always_prefer link(s) or sort everything remaining cheapest-first. */
function _pickOrderedLinks(links, usableMap) {
  const usable = links.filter((l) => usableMap[l.supplier] && l.admin_priority_override !== 'never_use');
  // cost_price_base_currency is null exactly when that link's cost could
  // NOT be confirmed USD (see resolveCostPriceBaseCurrency in both catalog
  // sync jobs) — comparing its raw, non-USD cost_price against another
  // link's real USD cost would be comparing incompatible units, the same
  // mistake priceGuard.js exists to prevent everywhere else in this
  // codebase. Such a link sorts LAST — never assumed cheap, never assumed
  // expensive — rather than silently racing on a bogus cross-currency
  // number. selectAndFulfill's own cost-floor re-check (§10 step 5) is
  // what actually refuses to dispatch to it when its turn comes.
  const byCost = (a, b) => {
    const aKnown = a.cost_price_base_currency != null;
    const bKnown = b.cost_price_base_currency != null;
    if (aKnown !== bKnown) return aKnown ? -1 : 1;
    if (!aKnown) return 0; // both unknown — no safe basis to order them either
    return parseFloat(a.cost_price_base_currency) - parseFloat(b.cost_price_base_currency);
  };

  const alwaysPrefer = usable.filter((l) => l.admin_priority_override === 'always_prefer');
  if (alwaysPrefer.length) {
    // More than one always_prefer link on the same SKU is a misconfig —
    // still resolve deterministically (cheapest of the preferred set)
    // rather than pick arbitrarily.
    return alwaysPrefer.sort(byCost);
  }
  return usable.sort(byCost);
}

async function _recordAttempt(orderId, skuId, entry) {
  const row = await db.queryOne(
    'SELECT fulfillment_attempts FROM order_details WHERE order_id = ? AND sku_id = ?',
    [orderId, skuId]
  );
  let history = [];
  if (row?.fulfillment_attempts) {
    history = typeof row.fulfillment_attempts === 'string'
      ? JSON.parse(row.fulfillment_attempts)
      : row.fulfillment_attempts;
  }
  history.push(entry);
  await db.query(
    'UPDATE order_details SET fulfillment_attempts = ? WHERE order_id = ? AND sku_id = ?',
    [JSON.stringify(history), orderId, skuId]
  );
}

/**
 * @param {object} params
 * @param {number} params.orderId
 * @param {object} params.item      { skuId (canonical), quantity, additionalFields? }
 * @param {string} [params.currency]
 * @returns {Promise<{success:boolean, reason?:string, alreadyPlaced?:boolean, supplier?:string, [key:string]:any}>}
 */
async function selectAndFulfill({ orderId, item, currency = 'USD' }) {
  // Idempotent across repeat calls for the same line regardless of WHICH
  // supplier eventually wins — a re-entry (admin manual retry, a second
  // completeOrder pass) short-circuits here rather than re-querying links
  // and potentially double-attempting. Individual fulfillment modules
  // (e.g. wgcardsFulfillment's own wgcards_order_id check) still guard
  // this too — belt and suspenders, not a substitute for this check.
  const existing = await db.queryOne(
    'SELECT fulfillment_supplier FROM order_details WHERE order_id = ? AND sku_id = ?',
    [orderId, item.skuId]
  );
  if (existing?.fulfillment_supplier) {
    return { success: true, alreadyPlaced: true, supplier: existing.fulfillment_supplier };
  }

  const links = await supplierLinksRepo.getActiveLinksForSku(item.skuId);
  if (!links.length) {
    // Nothing linked yet for this canonical SKU at all — shouldn't happen
    // for anything catalogSync has ever touched post-backfill, but a
    // product created by hand without going through Link Products would
    // land here rather than silently doing nothing.
    return { success: false, reason: 'no_active_supplier_link' };
  }

  const usableMap = {};
  for (const supplier of [...new Set(links.map((l) => l.supplier))]) {
    usableMap[supplier] = await _isSupplierUsable(supplier);
  }

  const ordered = _pickOrderedLinks(links, usableMap);
  if (!ordered.length) {
    return { success: false, reason: 'no_usable_supplier_link' };
  }

  // Every price guard elsewhere in this codebase (confirmLink,
  // createNewFromStaging, product.service.js#update) only checks at GATE
  // time — when a link is confirmed, or when an admin edits a price. None
  // of them run again right here, at the one moment that actually spends
  // money: dispatching a real order to a supplier. A routine catalog/stock
  // sync can silently raise sku_supplier_links.cost_price at any time
  // between those gates and this call — without this, nothing would catch
  // a supplier whose cost has since risen above the product's current
  // selling price before an order goes out at a loss.
  const skuRow = await db.queryOne('SELECT selling_price FROM product_skus WHERE sku_id = ?', [item.skuId]);
  const sellingPrice = skuRow ? parseFloat(skuRow.selling_price) : null;

  let lastResult = null;

  for (const link of ordered) {
    const fulfillmentModule = FULFILLMENT_MODULES[link.supplier];
    if (!fulfillmentModule) {
      logger.error(`supplierSelection: no fulfillment module registered for supplier "${link.supplier}" — skipping link ${link.link_id}`);
      continue;
    }

    const attemptedAt = new Date().toISOString();

    // The re-check described above — refuses to even dispatch to a link
    // whose cost no longer clears the current selling price (or whose
    // cost currency isn't confirmed USD, same as every other price guard
    // in this codebase refuses to guess at conversion). Treated exactly
    // like any other per-supplier failure: recorded, and the loop falls
    // through to the next-cheapest remaining link.
    if (sellingPrice != null) {
      try {
        assertSellingPriceAboveCost(sellingPrice, parseFloat(link.cost_price), link.cost_currency || 'USD');
      } catch (err) {
        logger.warn(`supplierSelection: refusing to dispatch to ${link.supplier} link ${link.link_id} for sku ${item.skuId} — ${err.message}`);
        lastResult = { success: false, reason: 'cost_exceeds_selling_price', error: err.message };
        await _recordAttempt(orderId, item.skuId, {
          supplier: link.supplier, reference: null, attemptedAt,
          result: 'failed', reason: 'cost_exceeds_selling_price', errorDetail: err.message,
        });
        continue;
      }
    }

    let result;
    try {
      result = await fulfillmentModule.attemptFulfillment({ orderId, item, currency, link });
    } catch (err) {
      // Every fulfillment module is designed to catch its own errors and
      // return {success:false,...} — this is a safety net so a module bug
      // fails over to the next supplier instead of aborting the whole line.
      logger.error(`supplierSelection: ${link.supplier} fulfillment module threw unexpectedly`, err);
      result = { success: false, reason: 'unexpected_error', error: err.message };
    }
    lastResult = result;

    await _recordAttempt(orderId, item.skuId, {
      supplier: link.supplier,
      reference: result.serviceOrder || result.referenceNumber || null,
      attemptedAt,
      result: result.success ? 'success' : 'failed',
      reason: result.reason || null,
      // The short `reason` code (e.g. 'supplier_rejected') was the only
      // thing ever persisted — the supplier's own descriptive message
      // (e.g. WgCards' "This method not support skuId : X", confirmed
      // live) was silently dropped, visible nowhere but a transient log
      // line. Neither order_details nor fulfillment_attempts has room for
      // a per-attempt raw-response blob the way Gift2Games' single-slot
      // gift2games_raw_response does, so it's carried here instead.
      errorDetail: result.error || null,
    });

    if (result.success) {
      // unit_cost: replaces the placement-time cost estimate with the
      // REAL cost of whichever link actually fulfilled this line — safe
      // to trust now that the re-check above has confirmed it's USD and
      // clears the selling price. See order.service.js#placeOrder's own
      // comment on the placement-time estimate this supersedes.
      await db.query(
        'UPDATE order_details SET fulfillment_supplier = ?, unit_cost = ? WHERE order_id = ? AND sku_id = ?',
        [link.supplier, parseFloat(link.cost_price), orderId, item.skuId]
      );
      return { ...result, supplier: link.supplier };
    }

    // §10 step 6: a BUSINESS rejection (or any other terminal per-supplier
    // failure — network/timeout was already retried inside that supplier's
    // own module first) fails over to the next-cheapest remaining link.
    // Only once every active, usable link has been tried does this loop
    // fall through to the pendingItems return below.
  }

  return lastResult || { success: false, reason: 'no_usable_supplier_link' };
}

module.exports = { selectAndFulfill, FULFILLMENT_MODULES };
