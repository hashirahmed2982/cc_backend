// utils/priceGuard.js
// Shared "admin cannot set a selling price below cost" guard, used by
// every path that lets an admin set/confirm a product's selling price:
// product.service.js#createInternal/createSupplier/update and
// catalogMatching.service.js#createNewFromStaging.
//
// CURRENCY: this portal only ever sells in USD — wallet balances, checkout
// totals, and every client-facing price are bare USD numbers with no
// currency conversion anywhere in the app (product_skus.price_currency is
// recorded on the row but nothing that displays or charges a price ever
// reads it back). A cost captured in any OTHER currency can NOT be safely
// compared against a USD selling price by just comparing the raw numbers —
// confirmed live: WgCards' own sandbox returned skuPriceCurrency:'CNY' for
// one item during testing DESPITE the request explicitly asking for
// currencyCode:'USD' (see catalogSync.test.js's mapSkuForUpsert fixture,
// captured from a real getItem response). Comparing a $10 USD selling
// price against a raw 41.39 (actually CNY, worth roughly $5.70) would
// EITHER wrongly block a perfectly profitable price, OR — the dangerous
// direction — wrongly ALLOW a badly underpriced one if the numbers happened
// to compare the other way. So this never guesses at conversion: a
// non-USD cost blocks the guard outright rather than comparing
// incompatible units, and the caller is expected to surface that as a
// needs_review condition rather than silently defaulting a price.
'use strict';

const { AppError } = require('../middleware/errorHandler');

/**
 * @param {number} sellingPrice
 * @param {number} costPrice
 * @param {string} [costCurrency] — the currency costPrice is actually
 *   denominated in. Defaults to 'USD' for call sites where that's already
 *   guaranteed true (e.g. internal products, which are always USD).
 * @throws {AppError} 400 — a clear, client-safe message either way.
 */
function assertSellingPriceAboveCost(sellingPrice, costPrice, costCurrency = 'USD') {
  const currency = (costCurrency || 'USD').toUpperCase();
  if (currency !== 'USD') {
    throw new AppError(
      `Cannot set a selling price: this SKU's cost is recorded in ${currency}, not USD, and this portal only sells in USD. ` +
      `The currency needs to be resolved (see needs_review) before a price can be verified against cost.`,
      400
    );
  }

  const sp = Number(sellingPrice);
  const cp = Number(costPrice);
  if (!Number.isFinite(sp) || !Number.isFinite(cp)) {
    throw new AppError('Invalid selling price or cost price supplied.', 400);
  }
  if (sp < cp) {
    throw new AppError(
      `Selling price ($${sp.toFixed(2)}) cannot be lower than cost price ($${cp.toFixed(2)}).`,
      400
    );
  }
}

module.exports = { assertSellingPriceAboveCost };
