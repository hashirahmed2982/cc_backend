// services/gift2games.service.js
// Gift2Games SupplierAdapter implementation (Master Plan §1/§5, Section 10
// table). Structurally complete — same shape a caller in supplierSelection.
// service.js can dispatch to exactly like wgcards.service.js — but every
// method that hits the network will fail until a real JWT/host is in
// supplier_config, because there isn't one yet (no Gift2Games account
// access as of this writing). DO NOT treat a passing unit test here as
// proof this adapter works against the real Gift2Games API — the request/
// response shapes below come from the master plan's own description of
// the doc, not a live call, and have never been exercised against the
// actual service.
//
// Key differences from wgcards.service.js, per the master plan:
//   - Auth: static JWT in the Authorization header. No refresh endpoint
//     exists — 0 auto-retries on auth failure (a human has to get a new
//     token), unlike WgCards' forced-refresh-and-retry-once.
//   - No payload encryption at all (WgCards AES/ECB's every request+response).
//   - Idempotency: referenceNumber (a UUID we generate) — but Gift2Games
//     does NOT reject a duplicate reference the way WgCards rejects a
//     duplicate serviceOrder. Flow H (§10 addendum) exists specifically
//     because of this: an ambiguous create_order failure must be resolved
//     via a getOrderDetails(referenceNumber) lookup BEFORE ever retrying,
//     never by just retrying with a fresh reference.
'use strict';

const axios = require('axios');
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
   * Core call helper. Unlike wgcards.service.js's _authedCall there is no
   * encryption and no forced-refresh-on-401 — a 401 here just fails, per
   * the master plan's explicit "0 auto-retries on auth failure" policy
   * (no documented refresh mechanism, so retrying blindly wastes calls;
   * this needs a human to obtain a new token — see healthCheck.js once
   * this adapter is wired into it).
   */
  async _authedCall(endpoint, payload, { method = 'POST' } = {}) {
    const cfg = await this._config();
    const start = Date.now();
    const url = `${cfg.api_base_url}${endpoint}`;

    let res;
    try {
      res = await axios.request({
        url, method,
        data: method !== 'GET' ? payload : undefined,
        params: method === 'GET' ? payload : undefined,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Bearer ${cfg.app_key}`, // app_key column repurposed to hold the static JWT
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

    await supplierConfigRepo.recordSuccess(SUPPLIER);
    return res.data;
  }

  // ── SupplierAdapter interface (Master Plan §1) ──────────────────────────

  /** check_balance — Flow G. Per the doc, every response ALSO carries its
   * own metaData.balance/balance2 — cheapest option is reading that off
   * whatever call you're already making rather than a dedicated call each
   * time, per the master plan's own note; this is still provided as the
   * dedicated fallback for a quiet period with no other activity, same
   * role healthCheck.js gives WgCards' getAccount(). */
  async checkBalance() {
    return this._authedCall('/check_balance', {}, { method: 'GET' });
  }

  /** getProducts — Flow B2. cost is read from the 'price' field, NOT
   * 'sellPrice' (the doc explicitly calls this out) — that mapping
   * belongs in gift2gamesCatalogSync once it exists, not here; this
   * method just returns whatever the supplier sends. inStock is a
   * boolean per SKU (no quantity), unlike WgCards' numeric stock. */
  async getProducts({ inStock } = {}) {
    return this._authedCall('/getProducts', inStock !== undefined ? { inStock: inStock ? 1 : 0 } : {}, { method: 'GET' });
  }

  /**
   * getOrderDetails — Flow E status check AND the Flow H idempotency
   * lookup (§10 addendum: "On ambiguous create_order failure: call
   * /orders/details with the SAME referenceNumber" before ever retrying —
   * Gift2Games does not reject a duplicate reference the way WgCards
   * rejects a duplicate serviceOrder, so skipping this check is how a
   * customer gets double-charged).
   */
  async getOrderDetails({ referenceNumber }) {
    return this._authedCall('/orders/details', { referenceNumber }, { method: 'GET' });
  }

  /**
   * create_order — Flow D. additionalFields are keyed by fieldKey (per
   * the doc — mirrors WgCards' Direct Top-Up attributeValues in spirit,
   * a dynamic named list rather than fixed columns).
   * referenceNumber MUST be freshly generated per attempt by the caller
   * (never reused) — but per Flow H, callers must getOrderDetails() with
   * that SAME reference before ever retrying an ambiguous failure, so the
   * reference only changes across independent attempts, not within one.
   */
  async createOrder({ productId, referenceNumber, additionalFields = [] }) {
    const result = await this._authedCall('/create_order', { productId, referenceNumber, additionalFields });
    if (!result || result.orderStatus === 'Rejected') {
      throw new SupplierBusinessError(result?.message || 'create_order rejected', result?.orderStatus);
    }
    return result;
  }
}

module.exports = new Gift2GamesService();
module.exports.SupplierAuthError = SupplierAuthError;
module.exports.SupplierBusinessError = SupplierBusinessError;
