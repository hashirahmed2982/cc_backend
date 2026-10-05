// utils/wgcardsConstants.js
// Shared WgCards product-type constants — was duplicated as a local const
// in wgcardsFulfillment.js (the fulfillment-time check) with order.service.js
// having no check at all until this file's introduction (see order.service.js's
// placeOrder — a Direct Top-Up product could be added to cart and checked
// out, debiting the wallet, with fulfillment only failing silently
// afterward; that's the bug this centralization fixes).
'use strict';

// products.spu_type — per the WgCards v3 doc's GetProductInfo field list:
// 1:game 2:gift_card 3:software 4:microsoft_product 5:DirectTop-Up
// 7:WwgSelected 8:topupredeemcode 9:Esim 11:NintendoGames
//
// Kept as the stable internal representation even after the v4 migration
// below — every existing caller (wgcardsFulfillment.js,
// userProduct.service.js, product.service.js's output) checks this numeric
// value, not a string, so changing it would ripple everywhere for no
// reason. wgcards.service.js translates v4's string productType.name back
// into this numeric scheme before anything else in the codebase sees it.
const DIRECT_TOPUP_SPU_TYPE = 5;

// v4's GetAllProducts/Products-and-Stock endpoints replaced the v3 numeric
// spu_type with a human-readable productType.name string (see the v4 doc's
// "Product Type productType.name" status dictionary) — WgCards' v4 response
// no longer sends a numeric type at all. This is the inverse mapping back
// onto the original v3 scheme, used only inside wgcards.service.js so every
// other file keeps working against the numeric spu_type it already expects.
//
// NOT a lossless mapping both ways: v4's dictionary lists only 6 names
// (Game, Gift Cards, software, Direct Top-Up, Top-Up Redeem Code, esim) —
// v3's 7:WwgSelected, 4:microsoft_product, and 11:NintendoGames have no
// confirmed v4 name. An item whose productType.name doesn't match any
// entry below maps to null (unknown) rather than a guessed number, since a
// wrong DIRECT_TOPUP_SPU_TYPE guess is the one mistake that's actually
// dangerous here (a non-top-up item wrongly blocked from checkout, or
// worse, a top-up item wrongly let through).
const PRODUCT_TYPE_NAME_TO_SPU_TYPE = {
  'game': 1,
  'gift cards': 2,
  'software': 3,
  'direct top-up': DIRECT_TOPUP_SPU_TYPE,
  'top-up redeem code': 8,
  'esim': 9,
};

/**
 * v4's productType.name (string, e.g. "Direct Top-Up") -> v3's numeric
 * spu_type the rest of the codebase already understands. Returns null for
 * an unmapped/unknown name or a missing value, same "honestly unknown"
 * posture as everything else in this integration — never guesses.
 */
function productTypeNameToSpuType(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PRODUCT_TYPE_NAME_TO_SPU_TYPE, key)
    ? PRODUCT_TYPE_NAME_TO_SPU_TYPE[key]
    : null;
}

module.exports = { DIRECT_TOPUP_SPU_TYPE, productTypeNameToSpuType };
