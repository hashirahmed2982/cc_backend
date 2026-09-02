// utils/wgcardsConstants.js
// Shared WgCards product-type constants — was duplicated as a local const
// in wgcardsFulfillment.js (the fulfillment-time check) with order.service.js
// having no check at all until this file's introduction (see order.service.js's
// placeOrder — a Direct Top-Up product could be added to cart and checked
// out, debiting the wallet, with fulfillment only failing silently
// afterward; that's the bug this centralization fixes).
'use strict';

// products.spu_type — per the WgCards doc's GetProductInfo field list:
// 1:game 2:gift_card 3:software 4:microsoft_product 5:DirectTop-Up
// 7:WwgSelected 8:topupredeemcode 9:Esim 11:NintendoGames
const DIRECT_TOPUP_SPU_TYPE = 5;

module.exports = { DIRECT_TOPUP_SPU_TYPE };
