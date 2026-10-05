// services/wgcards.service.js
// WgCards SupplierAdapter implementation — migrated to the v4 API
// (WGCards API v4, doc dated 2026-09-04). WgCards has been disabled
// (supplier_config.is_active = 0) in production since before this
// migration, so there is no live traffic depending on the old v3 wire
// protocol while this was rewritten — see the v3-vs-v4 comparison this
// migration was planned against for the full list of differences.
//
// DESIGN: every public method below keeps the EXACT same name and
// parameter/return shape it had under v3 — every caller across
// catalogSync.js, stockSync.js, orderPoller.js, healthCheck.js,
// balanceMonitor.js, product.service.js, wgcardsFulfillment.js, and
// wgcardsTopup.service.js needed ZERO changes because of this file. All
// v3-vs-v4 wire differences (new auth model, renamed/merged endpoints,
// reshaped request/response bodies, a numeric spu_type that v4 no longer
// sends) are translated at the boundary, right here — exactly the job a
// SupplierAdapter is supposed to do.
//
// CAVEAT — NOT YET LIVE-CONFIRMED: unlike the original v3 integration
// (which has "CONFIRMED LIVE" notes throughout from real sandbox/
// production testing), this v4 rewrite is written strictly from the v4
// doc's own spec — WgCards' v4 doc publishes no fixed public sandbox
// credentials the way v3's did, so none of this has been exercised
// against a real v4 endpoint yet. Before re-enabling WgCards in
// production, request v4 sandbox credentials and run
// scripts/test-wgcards-sandbox.js (needs updating for v4 first) against
// them — do not flip supplier_config.is_active back to 1 off the
// strength of passing unit tests alone.
//
// TWO KNOWN GAPS vs v3, called out at the exact method they affect below:
//   1. getStock(): v4 has no batch stock-check endpoint — this method now
//      makes one v4 call PER skuId internally to preserve its old
//      "give me stock for this array of skuIds" contract. A big batch (as
//      stockSync.js can send) now costs N calls against a 30/min v4 rate
//      limit instead of 1 call against v3's "40/60s, unlimited with
//      itemId/skuId" limit — a real throughput regression worth watching.
//   2. placeDirectOrder(): v4's documented request fields have no
//      faceValue at all (v3 had it, for custom-denomination top-ups) —
//      see that method for how this is handled.
'use strict';

const axios = require('axios');
const logger = require('../utils/logger');
const supplierConfigRepo = require('../repositories/supplierConfig.repository');
const supplierApiLog = require('./supplierApiLog.service');
const { encryptMsg, decryptMsg } = require('../utils/wgcardsCrypto');
const { productTypeNameToSpuType } = require('./../utils/wgcardsConstants');

const SUPPLIER = 'wgcards';
const V4_BASE = '/api/v4';
// Doc: "expiresIn ... Default: 7200" (2h) — refresh a bit before expiry
// rather than racing it, same margin v3 used.
const TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000;
const DEFAULT_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

class SupplierAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SupplierAuthError';
    this.code = 'supplier_auth_failure';
  }
}

/**
 * A WgCards call that reached a real HTTP response and was rejected as a
 * coherent business/request outcome — v4 always signals this as a
 * plaintext HTTP 400 with {code, message} (catalog.* / order.* passthrough
 * codes), never hidden inside a decrypted 200 envelope the way v3's
 * double-nested placeOrder/placeDirectOrder responses sometimes were.
 * Never retried, never trips the circuit breaker — Section 6 of the
 * master plan: "Business rejection ... No [auto-retry] ... Immediate
 * pendingItems".
 */
class SupplierBusinessError extends Error {
  constructor(message, wgcardsCode) {
    super(message);
    this.name = 'SupplierBusinessError';
    this.code = 'supplier_business_rejection';
    this.wgcardsCode = wgcardsCode;
  }
}

class WgCardsService {
  /** Loads the decrypted supplier_config row. v4 credential mapping onto
   * the existing (WgCards-v3-shaped) encrypted columns — no schema change
   * needed, same pattern gift2games already uses for its own placeholder
   * columns:
   *   app_id     -> v4 appId        (same concept as before)
   *   account_id -> v4 bodyKeyMaterial (repurposed — v4 has no accountId)
   *   app_key    -> v4 secret          (repurposed — this is now the
   *                                     /api/v4/token credential, not the
   *                                     encryption key itself)
   */
  async _config() {
    const cfg = await supplierConfigRepo.getBySupplierName(SUPPLIER);
    if (!cfg) {
      throw new Error(
        "No supplier_config row for 'wgcards' — run `node src/migrations/seed_wgcards_config.js` first " +
        '(needs WGCARDS_APP_ID / WGCARDS_SECRET / WGCARDS_BODY_KEY_MATERIAL set for v4).'
      );
    }
    return cfg;
  }

  async _getValidToken(cfg) {
    const now = Date.now();
    const expiresAt = cfg.token_expires ? new Date(cfg.token_expires).getTime() : 0;
    if (cfg.token && expiresAt - now > TOKEN_REFRESH_MARGIN_MS) {
      return cfg.token;
    }
    return this._fetchNewToken(cfg);
  }

  /**
   * POST /api/v4/token — Plaintext (doc: "does not require a Bearer Token
   * and does not use body encryption"). Request/response are both bare
   * JSON, no msg/encryptMsg involved at all, unlike every v3 call and
   * every other v4 business call.
   */
  async _fetchNewToken(cfg) {
    const start = Date.now();
    const url = `${cfg.api_base_url}${V4_BASE}/token`;
    const body = { appId: cfg.app_id, secret: cfg.app_key };

    let res;
    try {
      res = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
        validateStatus: () => true,
      });
    } catch (err) {
      await supplierApiLog.log({
        supplierName: SUPPLIER, endpoint: `${V4_BASE}/token`, statusCode: 0,
        responseTimeMs: Date.now() - start, errorMessage: err.message,
      });
      await supplierConfigRepo.recordFailure(SUPPLIER);
      throw err;
    }

    const body200 = res.status === 200 ? res.data : null;
    await supplierApiLog.log({
      supplierName: SUPPLIER, endpoint: `${V4_BASE}/token`, statusCode: res.status,
      responseTimeMs: Date.now() - start, requestBody: { appId: cfg.app_id, secret: '***' },
      responseBody: res.status === 200 ? body200 : res.data,
    });

    if (res.status !== 200 || !body200 || body200.code !== 200 || !body200.data?.accessToken) {
      await supplierConfigRepo.recordFailure(SUPPLIER);
      throw new SupplierAuthError(`WgCards /api/v4/token failed: ${res.data?.message || res.data?.code || res.status}`);
    }

    const { accessToken, expiresIn } = body200.data;
    const ttlMs = Number.isFinite(expiresIn) ? expiresIn * 1000 : DEFAULT_TOKEN_TTL_MS;
    const expiresAt = new Date(Date.now() + ttlMs);
    await supplierConfigRepo.saveToken(SUPPLIER, accessToken, expiresAt);
    await supplierConfigRepo.recordSuccess(SUPPLIER);
    return accessToken;
  }

  /**
   * Core authenticated business-call helper. v4 structurally separates
   * success from failure in a way v3 never did:
   *   - success: HTTP 2xx, body is raw base64 ciphertext (text/plain),
   *     decrypt -> {code:200, msg:'success', data}.
   *   - failure: HTTP 401/400/403/429/503/500, body is PLAINTEXT JSON
   *     {code, message, timestamp} — never encrypted, must never be run
   *     through decryptMsg.
   * So branching happens on res.status FIRST, before ever touching
   * decryption — unlike v3's _authedCall, which had to decrypt first and
   * then inspect an inner code to tell success from a 200-wrapped
   * rejection.
   */
  async _authedCall(endpoint, payload, { _isRetry = false } = {}) {
    const cfg = await this._config();
    const token = _isRetry
      ? await this._fetchNewToken(cfg)
      : await this._getValidToken(cfg);

    const start = Date.now();
    const url = `${cfg.api_base_url}${endpoint}`;
    const body = { msg: encryptMsg(cfg.account_id, payload) };

    let res;
    try {
      res = await axios.post(url, body, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        timeout: 15000,
        validateStatus: () => true,
      });
    } catch (err) {
      await supplierApiLog.log({
        supplierName: SUPPLIER, endpoint, statusCode: 0,
        responseTimeMs: Date.now() - start, requestBody: payload, errorMessage: err.message,
      });
      throw err;
    }

    if ((res.status === 401) && !_isRetry) {
      logger.warn(`WgCardsService: 401 on ${endpoint} — forcing token refresh and retrying once`);
      await supplierConfigRepo.clearToken(SUPPLIER);
      await supplierApiLog.log({
        supplierName: SUPPLIER, endpoint, statusCode: res.status,
        responseTimeMs: Date.now() - start, requestBody: payload, responseBody: res.data,
      });
      return this._authedCall(endpoint, payload, { _isRetry: true });
    }

    // Decrypt once, up front, so both the activity log and the
    // success/failure branching below see the same real data — a
    // success response is base64 ciphertext and MUST be decrypted before
    // logging (an unreadable blob in the admin's Integration Activity Log
    // is no better than not logging it); a non-200 response is already
    // plaintext JSON and must never be run through decryptMsg at all.
    let decrypted = null;
    let decryptFailed = false;
    if (res.status === 200) {
      try {
        decrypted = JSON.parse(decryptMsg(cfg.account_id, res.data));
      } catch (err) {
        decryptFailed = true;
      }
    }

    await supplierApiLog.log({
      supplierName: SUPPLIER, endpoint, statusCode: res.status,
      responseTimeMs: Date.now() - start, requestBody: payload,
      responseBody: res.status === 200 ? (decryptFailed ? '(failed to decrypt)' : decrypted) : res.data,
    });

    if (res.status === 200) {
      if (decryptFailed) {
        await supplierConfigRepo.recordFailure(SUPPLIER);
        throw new Error(`WgCards ${endpoint} failed: could not decrypt/parse response`);
      }
      if (!decrypted || decrypted.code !== 200) {
        await supplierConfigRepo.recordFailure(SUPPLIER);
        throw new Error(`WgCards ${endpoint} failed: unexpected envelope ${JSON.stringify(decrypted)}`);
      }
      await supplierConfigRepo.recordSuccess(SUPPLIER);
      return decrypted.data;
    }

    // Everything below is a real HTTP error status — body is plaintext
    // JSON {code, message, timestamp}, NEVER encrypted.
    const errBody = (res.data && typeof res.data === 'object') ? res.data : {};
    const errCode = errBody.code;
    const errMessage = errBody.message || `HTTP ${res.status}`;

    if (res.status === 401) {
      // Still 401 after the forced-refresh retry above.
      await supplierConfigRepo.recordFailure(SUPPLIER);
      throw new SupplierAuthError(`WgCards ${endpoint}: still 401 (${errCode || 'unknown'}) after forced token refresh`);
    }
    if (res.status === 403) {
      // Not in the v4 doc's own error-code table — seen in practice as an
      // edge/WAF-level block (e.g. IP not allowlisted) rather than an
      // app-level auth rejection, so retrying with a fresh token wouldn't
      // help. Surface it as an auth failure (same bucket v3 used for 403)
      // without the retry-once dance 401 gets.
      await supplierConfigRepo.recordFailure(SUPPLIER);
      throw new SupplierAuthError(`WgCards ${endpoint}: HTTP 403 (${errCode || errMessage}) — likely an IP allowlist or edge-level block, not a bad token`);
    }
    if (res.status === 429) {
      const err = new Error(`WgCards ${endpoint}: rate limited (429) — ${errCode || errMessage}`);
      err.code = 'supplier_rate_limited';
      throw err;
    }
    if (res.status === 400) {
      // catalog.* / order.* business passthrough, or a request-validation
      // failure (api.request.invalid, api.body.invalid) — both arrive the
      // same way in v4, both are "this specific request", not "the
      // integration is unhealthy". Never trips the circuit breaker.
      throw new SupplierBusinessError(errMessage, errCode);
    }
    // 500/503 and anything else unexpected — a real integration-health
    // signal.
    await supplierConfigRepo.recordFailure(SUPPLIER);
    throw new Error(`WgCards ${endpoint} failed: HTTP ${res.status} (${errCode || errMessage})`);
  }

  // ── SupplierAdapter interface (Master Plan §1) ──────────────────────────
  // Every method below returns the SAME shape it did under v3 — see the
  // file header. v4-specific translation is commented at each spot it
  // actually differs.

  /** getAccount — Flow G balance check. v4 takes no body fields at all
   * (identity is purely the Bearer token) and its accounts[] carries
   * balance/freezeBalance/creditLimit/withdrawalsAmount as STRINGS, plus
   * several new profile fields nothing here reads. Only translation
   * needed: parseFloat each wallet's balance back to a number, matching
   * what balanceMonitor.js's numeric threshold comparison already
   * expects from v3. */
  async getAccount() {
    const data = await this._authedCall(`${V4_BASE}/getAccount`, {});
    return {
      ...data,
      accounts: Array.isArray(data?.accounts)
        ? data.accounts.map((a) => ({ ...a, balance: parseFloat(a.balance) || 0 }))
        : [],
    };
  }

  /**
   * getAllItem — lightweight catalog listing. v4's response drops
   * itemBrandName/currencyCode-per-item/skuPrice/min-maxPrice entirely —
   * see getItem() below, which is what catalogSync.js actually uses for
   * pricing; this method is kept for API-shape parity but is even
   * thinner under v4 than it already was under v3.
   */
  async getAllItem() {
    const data = await this._authedCall(`${V4_BASE}/getAllItem`, {});
    const records = (data?.records || []).map((r) => ({
      itemId: r.spuCode,
      itemName: r.spuName,
      itemBrandName: null, // v4 getAllItem has no brand field at all
      currencyCode: r.basicPriceCurrency,
      spuType: productTypeNameToSpuType(r.productType?.name),
      skuList: (r.skuInfos || []).map((s) => ({
        skuId: s.skuCode,
        skuName: s.skuName,
        skuPriceCurrency: s.basicPriceCurrency,
        minFaceValue: s.minFaceValue,
        maxFaceValue: s.maxFaceValue,
      })),
    }));
    return { total: data?.total, records };
  }

  /**
   * getItem() — catalogSync.js's real pricing source. v4 merges what
   * used to be three separate v3 calls (getItem/getStock/getItemAndStock)
   * into ONE endpoint, /api/v4/getItemAndStock, which ALWAYS includes
   * stock now. This method calls that endpoint and translates the
   * response back into v3's getItem shape so catalogSync.js's existing
   * field-mapping code (itemId/itemName/itemBrandName/howExchange/
   * spuImage/spuType/currencyCode at the item level; skuId/skuName/
   * skuPrice/skuPriceCurrency/minFaceValue/maxFaceValue/minPrice/maxPrice
   * at the sku level) keeps working unchanged.
   *
   * TWO REAL GAPS, not just a renaming — v4's getItemAndStock has no
   * brand field and no redemption-instructions (howExchange) field at
   * all. Both translate to null here; catalogSync.js's existing
   * `itemRaw.itemBrandName || itemRaw.itemName` fallback already
   * degrades gracefully for the first one (uses the full item name as
   * the brand), and `itemRaw.howExchange || null` already handles the
   * second — but a brand-new WgCards product onboarded under v4 will
   * simply never get real redemption instructions from the supplier feed
   * the way a v3-sourced one did; that'll need to come from an admin
   * manually editing the product instead.
   */
  async getItem({ itemId = '', itemName = '', currencyCode = 'USD', language = 'en', current = 1, size = 50 } = {}) {
    const data = await this._authedCall(`${V4_BASE}/getItemAndStock`, {
      currency: currencyCode,
      spuId: itemId || undefined,
      page: current,
      size,
    });
    const records = (data?.records || []).map((r) => ({
      itemId: r.spuCode,
      itemName: r.spuName,
      itemTitle: r.spuName,
      itemBrandName: null, // GAP — see method doc comment above
      currencyCode: r.currency,
      description: null,
      howExchange: null, // GAP — see method doc comment above
      spuImage: r.spuImage || null,
      spuType: productTypeNameToSpuType(r.productType?.name),
      skus: (r.skuInfos || []).map((s) => ({
        skuId: s.skuId,
        skuName: s.skuName,
        skuPrice: s.skuPrice,
        skuPriceCurrency: s.skuPriceCurrency,
        minFaceValue: s.minFaceValue,
        maxFaceValue: s.maxFaceValue,
        minPrice: s.minPrice,
        maxPrice: s.maxPrice,
      })),
    }));
    return { current: data?.page, pages: data?.pages, size: data?.size, total: data?.total, records };
  }

  /**
   * getStock(ref) — Flow C batch stock check. KNOWN GAP: v4 has no batch
   * endpoint at all — /api/v4/getItemAndStock only filters by a single
   * skuId. To keep this method's existing "pass an array, get an array
   * back" contract (every caller — stockSync.js, product.service.js —
   * still just awaits one getStock(batch) call), this now makes ONE v4
   * call per skuId, sequentially (not parallel — v4's getItemAndStock is
   * rate-limited to 30 requests/minute, and stockSync.js can pass a batch
   * well over that). A per-item failure doesn't abort the batch — it's
   * reported as stock -1-unknown... actually omitted from the result
   * array entirely, matching v3's existing "missing from the response
   * means unknown" handling already in stockSync.js/product.service.js.
   */
  async getStock(skuIds) {
    if (!Array.isArray(skuIds) || !skuIds.length) {
      throw new Error('getStock requires a non-empty array of skuIds');
    }
    const results = [];
    for (const skuId of skuIds) {
      try {
        const data = await this._authedCall(`${V4_BASE}/getItemAndStock`, {
          currency: 'USD', skuId, page: 1, size: 1,
        });
        const rec = (data?.records || [])[0];
        const sku = rec?.skuInfos?.[0];
        if (sku) {
          results.push({ itemId: rec.spuCode, skuId: sku.skuId, number: sku.stock });
        }
      } catch (err) {
        logger.warn(`WgCardsService.getStock: lookup failed for skuId ${skuId}, omitting from batch result:`, err.message);
      }
    }
    return results;
  }

  /** getItemAndStock — single-SKU live lookup used at checkout time
   * (Flow D's pre-order stock check). Thin passthrough now — this IS the
   * v4 endpoint's native shape of call, just normalized back to v3's
   * single-item field names (skus -> skuInfos handled identically to
   * getItem() above, reusing the same per-sku mapping). */
  async getItemAndStock({ itemId = '', skuId = '', currencyCode = 'USD' } = {}) {
    const data = await this._authedCall(`${V4_BASE}/getItemAndStock`, {
      currency: currencyCode, spuId: itemId || undefined, skuId: skuId || undefined, page: 1, size: 1,
    });
    const rec = (data?.records || [])[0];
    if (!rec) return { records: [] };
    return {
      records: [{
        itemId: rec.spuCode,
        itemName: rec.spuName,
        spuImage: rec.spuImage || null,
        howExchange: null,
        skuInfos: (rec.skuInfos || []).map((s) => ({
          skuId: s.skuId, skuName: s.skuName, skuPrice: s.skuPrice,
          skuPriceCurrency: s.skuPriceCurrency, stock: s.stock,
          minFaceValue: s.minFaceValue, maxFaceValue: s.maxFaceValue,
        })),
      }],
    };
  }

  /**
   * placeOrder — Flow D. v4's response is FLAT ({orderId, outOrderNo,
   * orderStatus, payStatus, deliveryStatus, totalAmount, currency}) —
   * none of v3's double-nesting, and a business rejection now arrives as
   * an HTTP 400 that _authedCall already turns into a thrown
   * SupplierBusinessError before this method's body even runs. So by the
   * time control reaches here the order genuinely succeeded.
   */
  async placeOrder({ skuId, buyNum, faceValue, currency = 'USD', serviceOrder }) {
    const detail = faceValue !== undefined ? { skuId, faceValue, buyNum } : { skuId, buyNum };
    const data = await this._authedCall(`${V4_BASE}/placeOrder`, {
      outOrderNo: serviceOrder,
      currency,
      items: [detail],
    });
    return { wgcardsOrderId: data.orderId, message: 'placed' };
  }

  /**
   * getOrderInfo — v4 renames this GetOrderHistory/list endpoint to
   * getOrderList and adds real filters (unused here — orderPoller.js's
   * fallback search only ever wants the newest-first unfiltered page).
   * Record field names differ (orderWay -> orderSource, cur -> currency)
   * — translated back since orderPoller.js's matchesOrderId only reads
   * .orderId/.deliveryStatus, but keeping the full v3 shape here anyway
   * for anything that might read the others later.
   */
  async getOrderInfo({ current = 1, size = 10 } = {}) {
    const data = await this._authedCall(`${V4_BASE}/getOrderList`, { page: current, size });
    const records = (data?.records || []).map((r) => ({
      orderId: r.orderId,
      cur: r.currency,
      deliveryStatus: r.deliveryStatus,
      orderStatus: r.orderStatus,
      orderWay: r.orderSource,
      totalAmount: r.totalAmount,
      createTime: r.createTime,
    }));
    return { current: data?.page, pages: Math.ceil((data?.total || 0) / (data?.size || size || 1)), size: data?.size, total: data?.total, records };
  }

  /**
   * getOrderInfoAndDetail — Flow E. v4 keeps the SAME {firstTo, secondTos}
   * envelope shape v3 used (just adds a few new fields on top:
   * manualRechargeFlag, goodsType, orderType) — orderPoller.js only ever
   * reads firstTo.deliveryStatus, which is unchanged, so no translation
   * is needed here at all beyond dropping the no-longer-applicable
   * userId body field.
   */
  async getOrderInfoAndDetail({ orderId }) {
    return this._authedCall(`${V4_BASE}/getOrderInfoAndDetail`, { orderId });
  }

  /**
   * getBuyCard — Flow E delivered-code fetch. v4 renames this to
   * getBuyCards (plural) and reshapes the response to group cards[] per
   * orderItemId+skuId instead of v3's one-flat-record-per-code list.
   * orderPoller.js's deliverCodes()/newRecordsSince() only ever read
   * .card/.pinCode/.snCode (and .skuId) off a flat record, so this
   * flattens v4's nested groups back into that exact shape — order
   * preserved (oldest-appearing-first within each group, groups in
   * response order), which matters since newRecordsSince() slices by
   * position to find only the NEW codes since last poll.
   */
  async getBuyCard({ orderId, current = 1, size = 200 }) {
    const data = await this._authedCall(`${V4_BASE}/getBuyCards`, { orderId, page: current, size });
    const records = [];
    for (const group of data?.records || []) {
      for (const c of group.cards || []) {
        records.push({ skuId: group.skuId, card: c.card, pinCode: c.pinCode, snCode: c.snCode });
      }
    }
    return { current: data?.page, size: data?.size, total: data?.total, records };
  }

  /** getDirectParam — Flow F step 1. v4 drops the userId body field
   * (identity via token) and adds an explicit `notExist` flag; paramInfos
   * shape itself is unchanged. */
  async getDirectParam({ skuId }) {
    const data = await this._authedCall(`${V4_BASE}/getDirectParam`, { skuId });
    return data?.paramInfos || [];
  }

  /** apiTopUpParamCheck — Flow F step 2. v4 drops userId/accountId;
   * {passed, reason} response shape is unchanged. */
  async apiTopUpParamCheck({ skuId, attributeValues }) {
    return this._authedCall(`${V4_BASE}/apiTopUpParamCheck`, { skuId, attributeValues });
  }

  /**
   * placeDirectOrder — Flow F step 3. v4's request field names change
   * (serviceOrder -> outOrderNo, adds a required `quantity`) and its
   * response is flat like placeOrder's, business rejections arriving as
   * HTTP 400 the same way.
   *
   * GAP, not just a rename: v4's documented request fields for this
   * endpoint have NO faceValue field at all — v3 used it for
   * custom-denomination top-ups (wgcardsTopup.service.js's
   * initiateTopup still passes it through for is_custom_value SKUs). The
   * v4 doc doesn't say what happens if an undocumented field is sent —
   * most REST backends just ignore it, but this is UNCONFIRMED. Sent
   * anyway (better than silently dropping the amount with no signal) with
   * a loud warning, so a real failure here points straight at this
   * comment instead of looking like a generic rejection. Do not enable
   * custom-value Direct Top-Up SKUs against v4 in production until this
   * is confirmed live or WgCards confirms how custom face values work
   * under v4.
   */
  async placeDirectOrder({ skuId, faceValue, currency = 'USD', serviceOrder, webhook, attributeValues }) {
    const payload = {
      outOrderNo: serviceOrder,
      currency,
      skuId,
      quantity: 1,
      webhook,
      attributeValues,
    };
    if (faceValue !== undefined) {
      logger.warn(
        `WgCardsService.placeDirectOrder: sending faceValue=${faceValue} for skuId ${skuId} — ` +
        'the v4 API doc documents NO faceValue field on this endpoint at all. Sent anyway on the ' +
        'assumption an unrecognized field is ignored rather than rejected; UNCONFIRMED against the ' +
        'real v4 API. If this order is rejected or silently charges the wrong amount, that assumption is wrong.'
      );
      payload.faceValue = faceValue;
    }
    const data = await this._authedCall(`${V4_BASE}/placeDirectOrder`, payload);
    return { wgcardsOrderId: data.orderId, message: 'placed' };
  }
}

module.exports = new WgCardsService();
module.exports.SupplierAuthError = SupplierAuthError;
module.exports.SupplierBusinessError = SupplierBusinessError;
