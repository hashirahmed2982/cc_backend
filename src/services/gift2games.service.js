// services/gift2games.service.js
// Gift2Games SupplierAdapter implementation (Master Plan §1/§5, Section 10
// table). Written against the vendor's own Postman collection
// (Gift2Games.postman_collection.json, provided 2026-09-01) — not just
// the master plan's paraphrase — so endpoint paths, HTTP method, and body
// encoding below are the vendor's actual documented contract, not a
// guess. Field NAMES inside each request/response are still best-effort
// where the collection's own example didn't need them (e.g. createOrder's
// additionalFields — see that method's comment) or where only the
// request shape is documented, not the response shape.
//
// LIVE STATUS as of 2026-09-01: checkBalance() is CONFIRMED working
// end-to-end (envelope, auth header, real balance returned). Every other
// method below is written correctly against the Postman collection's
// request shape but has NOT yet had its response shape confirmed live —
// don't treat a passing unit test as proof beyond checkBalance().
//
// Confirmed from the Postman collection (all endpoints, not just some):
//   - EVERY endpoint is POST, including read-only ones like check_balance
//     — this file used to guess GET for reads, which happened to also
//     "work" for check_balance (some backends don't enforce method
//     strictly) but getProducts() 404'd at first because of a wrong path,
//     not the method.
//   - Auth: static JWT in the Authorization header, sent RAW — CONFIRMED
//     LIVE no "Bearer " prefix (sending "Bearer <jwt>" gets a
//     200-with-status:0 "Incorrect Login", indistinguishable from a truly
//     bad token unless you already know to suspect the prefix). No
//     refresh endpoint exists — 0 auto-retries on auth failure (a human
//     has to get a new token), unlike WgCards' forced-refresh-and-retry-once.
//   - Request bodies are multipart/form-data (Postman's "mode": "formdata"),
//     NOT JSON and NOT application/x-www-form-urlencoded — this file used
//     to guess urlencoded, which only ever "worked" because check_balance
//     sends no body at all, so the wrong Content-Type never got exercised.
//   - CONFIRMED LIVE (check_balance only): every response is wrapped in
//     {status: 1|0, data, message, erorrCode} (the vendor's own doc has
//     this typo, "erorrCode", preserved here for accuracy) — HTTP 200
//     even when status:0 signals a rejected request, so this is checked
//     explicitly rather than trusting the HTTP status code.
//   - Idempotency: referenceNumber (a UUID we generate, "required and
//     must be unique" per the collection's own field description) — but
//     Gift2Games does NOT reject a duplicate reference the way WgCards
//     rejects a duplicate serviceOrder. Flow H (§10 addendum) exists
//     specifically because of this: an ambiguous create_order failure
//     must be resolved via a getOrderDetails(referenceNumber) lookup
//     BEFORE ever retrying — the collection's own description of that
//     endpoint literally says "use it for timeout scenario", confirming
//     this is the vendor-intended mechanism, not just an inference from
//     the master plan.
'use strict';

const axios = require('axios');
const FormData = require('form-data');
const logger = require('../utils/logger');
const supplierConfigRepo = require('../repositories/supplierConfig.repository');
const supplierApiLog = require('./supplierApiLog.service');

const SUPPLIER = 'gift2games';

class SupplierAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SupplierAuthError';
    this.code = 'supplier_auth_failure';
  }
}

/** Same convention as wgcards.service.js's SupplierBusinessError — a
 * coherent rejection FROM Gift2Games about THIS request, not a sign the
 * integration itself is unhealthy. Never trips the circuit breaker. */
class SupplierBusinessError extends Error {
  constructor(message, orderStatus) {
    super(message);
    this.name = 'SupplierBusinessError';
    this.code = 'supplier_business_rejection';
    this.orderStatus = orderStatus;
  }
}

class Gift2GamesService {
  async _config() {
    const cfg = await supplierConfigRepo.getBySupplierName(SUPPLIER);
    if (!cfg) {
      throw new Error(
        'Gift2Games is not configured — no supplier_config row for "gift2games". ' +
        'Seed it (app_key = the JWT, api_base_url = the Gift2Games host) once credentials exist.'
      );
    }
    return cfg;
  }

  /**
   * Core call helper — always POST, always multipart/form-data when there's
   * a body (see file header). `payload` values may be arrays (sent as
   * repeated `key[]` fields, matching the collection's own `ids[]`
   * example on Products) or scalars.
   */
  async _authedCall(endpoint, payload = {}) {
    const cfg = await this._config();
    const start = Date.now();
    const url = `${cfg.api_base_url}${endpoint}`;

    const entries = Object.entries(payload).filter(([, v]) => v !== undefined && v !== null);
    const hasBody = entries.length > 0;
    let form;
    if (hasBody) {
      form = new FormData();
      for (const [key, value] of entries) {
        if (Array.isArray(value)) {
          for (const v of value) form.append(`${key}[]`, String(v));
        } else {
          form.append(key, String(value));
        }
      }
    }

    let res;
    try {
      res = await axios.post(url, hasBody ? form : undefined, {
        headers: {
          // CONFIRMED LIVE: the raw JWT, no "Bearer " prefix.
          Authorization: cfg.app_key,
          ...(hasBody ? form.getHeaders() : {}),
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

    await supplierApiLog.log({
      supplierName: SUPPLIER, endpoint, statusCode: res.status,
      responseTimeMs: Date.now() - start, requestBody: payload, responseBody: res.data,
    });

    if (res.status === 401 || res.status === 403) {
      await supplierConfigRepo.recordFailure(SUPPLIER);
      throw new SupplierAuthError(`Gift2Games ${endpoint}: auth failed (HTTP ${res.status}) — no refresh flow exists, needs a human to re-issue the JWT`);
    }
    if (res.status === 429) {
      // Master plan §6: "exponential backoff, cap at 5 attempts, alert if
      // sustained > 5 min" — the backoff/retry loop itself belongs in the
      // caller (supplierSelection/gift2gamesFulfillment), same split as
      // WgCards' retry policy living in wgcardsFulfillment.js, not here.
      const err = new Error(`Gift2Games ${endpoint}: rate limited (429)`);
      err.code = 'supplier_rate_limited';
      throw err;
    }
    if (res.status !== 200) {
      await supplierConfigRepo.recordFailure(SUPPLIER);
      throw new Error(`Gift2Games ${endpoint} failed: HTTP ${res.status}`);
    }

    const body = res.data;

    // CONFIRMED LIVE (check_balance): Gift2Games wraps every response in
    // {status: 1|0, data, message, erorrCode} and returns HTTP 200 even
    // when status:0 signals a rejection — checked here, generically,
    // BEFORE recordSuccess, so a rejected request can never be mistaken
    // for a healthy call. NOT yet independently confirmed for any
    // endpoint besides check_balance — if one responds differently, this
    // generalization needs revisiting for that endpoint specifically.
    if (body && body.status === 0) {
      const isAuthFailure = /login/i.test(body.erorrCode || body.errorCode || '');
      if (isAuthFailure) {
        await supplierConfigRepo.recordFailure(SUPPLIER);
        throw new SupplierAuthError(`Gift2Games ${endpoint}: ${body.message || body.erorrCode || 'login rejected'}`);
      }
      // A coherent rejection FROM Gift2Games about THIS request (e.g. bad
      // productId, malformed field) — not a sign the integration itself
      // is unhealthy, same convention as WgCards' SupplierBusinessError.
      // Never trips the circuit breaker.
      throw new SupplierBusinessError(body.message || body.erorrCode || `${endpoint} rejected`);
    }

    await supplierConfigRepo.recordSuccess(SUPPLIER);
    return body && body.data !== undefined ? body.data : body;
  }

  // ── SupplierAdapter interface (Master Plan §1) ──────────────────────────

  /** check_balance — Flow G. CONFIRMED LIVE end-to-end: POST, no body,
   * returns {userId, userBalance, userCurrency} (already unwrapped from
   * the envelope by _authedCall). Per the master plan, every response
   * ALSO carries its own metaData.balance/balance2 (dropped by the
   * unwrap — read res.data.metaData directly from api_logs if that's
   * ever needed) — cheapest option is reading that off whatever call
   * you're already making rather than a dedicated call each time; this
   * is still provided as the dedicated fallback for a quiet period with
   * no other activity, same role healthCheck.js gives WgCards'
   * getAccount(). */
  async checkBalance() {
    return this._authedCall('/check_balance');
  }

  /** categories — from the Postman collection, not previously known about
   * from the master plan alone. parentId is optional (omit for top-level
   * categories). Useful for §9's brand/category matching once Gift2Games
   * catalog sync exists. */
  async getCategories({ parentId } = {}) {
    return this._authedCall('/categories', parentId !== undefined ? { parentId } : {});
  }

  /** products — Flow B2. CORRECTED from an earlier guess of GET
   * /getProducts (404'd — wrong path AND wrong method) to the Postman
   * collection's actual POST /products. categoryId/inStock/ids are all
   * optional filters (omit all for a full catalog pull); ids is an array
   * sent as repeated ids[] fields, per the collection's own example.
   * cost is read from the 'price' field, NOT 'sellPrice' (§9 doc note —
   * sellPrice is what update_sell_price sets, your OWN resale price, not
   * what Gift2Games charges you) — that mapping belongs in
   * gift2gamesCatalogSync once it exists, not here; this method just
   * returns whatever's under `data`. inStock is a boolean per SKU (no
   * quantity), unlike WgCards' numeric stock. */
  async getProducts({ categoryId, inStock, ids } = {}) {
    const payload = {};
    if (categoryId !== undefined) payload.categoryId = categoryId;
    if (inStock !== undefined) payload.inStock = inStock ? 1 : 0;
    if (ids !== undefined) payload.ids = ids;
    return this._authedCall('/products', payload);
  }

  /** update_sell_price — from the Postman collection, not previously
   * known about from the master plan alone. Sets YOUR resale price for a
   * product (distinct from Gift2Games' own cost price) — not part of any
   * flow built yet, exposed here for whenever pricing sync needs it. */
  async updateSellPrice({ productId, sellPrice }) {
    return this._authedCall('/update_sell_price', { productId, sellPrice });
  }

  /** orders (paginated order history) — from the Postman collection, not
   * previously known about from the master plan alone. "byDefault page=1,
   * limit=1000" per the collection's own field description — no way to
   * override the page size, only which page. This is Gift2Games'
   * equivalent of WgCards' getOrderInfo, and the natural fallback source
   * for a future orderPoller.js generalization (same role
   * findDeliveryStatusViaList's getOrderInfo paging plays for WgCards). */
  async getMyOrders({ page = 1 } = {}) {
    return this._authedCall('/orders', { page });
  }

  /**
   * orders/details — Flow E status check AND the Flow H idempotency
   * lookup. The collection's own description of this endpoint is
   * literally "use it for timeout scenario" and "return only one order" —
   * confirming Flow H's design (§10 addendum: on an ambiguous
   * create_order failure, look this up by the SAME referenceNumber
   * before ever retrying, since Gift2Games does not reject a duplicate
   * reference the way WgCards rejects a duplicate serviceOrder) is the
   * vendor-intended mechanism, not just an inference from the master plan.
   */
  async getOrderDetails({ referenceNumber }) {
    return this._authedCall('/orders/details', { referenceNumber });
  }

  /**
   * create_order — Flow D. referenceNumber is "required and must be
   * unique" per the collection's own field description — generated fresh
   * per attempt by the caller (never reused across independent attempts,
   * only reused across retries of the SAME attempt per Flow H).
   *
   * additionalFields shape is NOT confirmed live — the collection's own
   * Create Order example only sends productId+referenceNumber (this
   * particular test product apparently needs no extra info), and the
   * master plan's paraphrase says these are "keyed by fieldKey" without
   * showing the wire format. Best-effort: flattened into individual form
   * fields named by `name` directly (e.g. {name:'playerId',value:'123'}
   * becomes a `playerId` form field) — revisit the moment a product that
   * actually needs additionalFields is tested live.
   *
   * result is already unwrapped to the envelope's `data` by _authedCall
   * (confirmed for check_balance, assumed here) — the orderStatus check
   * below is for a well-formed request Gift2Games still declines (e.g.
   * out of stock), distinct from the outer status:0 rejection
   * _authedCall already throws SupplierBusinessError for on its own (a
   * bad productId, say) before this method even sees a result.
   */
  async createOrder({ productId, referenceNumber, additionalFields = [] }) {
    const payload = { productId, referenceNumber };
    for (const field of additionalFields) {
      if (field && field.name !== undefined) payload[field.name] = field.value;
    }
    const result = await this._authedCall('/create_order', payload);
    if (!result || result.orderStatus === 'Rejected') {
      throw new SupplierBusinessError(result?.message || 'create_order rejected', result?.orderStatus);
    }
    return result;
  }
}

module.exports = new Gift2GamesService();
module.exports.SupplierAuthError = SupplierAuthError;
module.exports.SupplierBusinessError = SupplierBusinessError;
