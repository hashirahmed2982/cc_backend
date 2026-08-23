// services/wgcards.service.js
// WgCards SupplierAdapter implementation (Master Plan §1/§5 Flow A1).
//
// Phase 1 scope: token lifecycle + read-only calls (getAccount, getAllItem,
// getStock, getItemAndStock). placeOrder/getOrderStatus/getCode/direct-topup
// methods are stubbed here and filled in during Phase 4/5/9 — kept as stubs
// (not omitted) so the SupplierAdapter interface shape from the doc is
// complete and every future phase has an obvious slot to land in.
'use strict';

const axios = require('axios');
const logger = require('../utils/logger');
const supplierConfigRepo = require('../repositories/supplierConfig.repository');
const supplierApiLog = require('./supplierApiLog.service');
const { encryptMsg, decryptMsg } = require('../utils/wgcardsCrypto');

const SUPPLIER = 'wgcards';
const TOKEN_TTL_MS = 110 * 60 * 1000; // cache for 110 min (doc says token is valid 2h)
const TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000; // refresh if <10 min left

class SupplierAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SupplierAuthError';
    this.code = 'supplier_auth_failure';
  }
}

class WgCardsService {
  /** Loads (and caches for the life of this instance) the decrypted supplier_config row. */
  async _config() {
    const cfg = await supplierConfigRepo.getBySupplierName(SUPPLIER);
    if (!cfg) {
      throw new Error(
        "No supplier_config row for 'wgcards' — run `node src/migrations/seed_wgcards_config.js` first."
      );
    }
    return cfg;
  }

  /**
   * Flow A1 steps 1-2: return a valid token, fetching a fresh one only if
   * missing or expiring within TOKEN_REFRESH_MARGIN_MS.
   */
  async _getValidToken(cfg) {
    const now = Date.now();
    const expiresAt = cfg.token_expires ? new Date(cfg.token_expires).getTime() : 0;
    if (cfg.token && expiresAt - now > TOKEN_REFRESH_MARGIN_MS) {
      return cfg.token;
    }
    return this._fetchNewToken(cfg);
  }

  async _fetchNewToken(cfg) {
    const start = Date.now();
    const url = `${cfg.api_base_url}/api/getToken`;
    const body = {
      appId: cfg.app_id,
      accountId: cfg.account_id,
      msg: encryptMsg(cfg.app_id, { appId: cfg.app_id, appKey: cfg.app_key }),
    };

    let res;
    try {
      res = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
        validateStatus: () => true,
      });
    } catch (err) {
      await supplierApiLog.log({
        supplierName: SUPPLIER, endpoint: '/api/getToken', statusCode: 0,
        responseTimeMs: Date.now() - start, errorMessage: err.message,
      });
      await supplierConfigRepo.recordFailure(SUPPLIER);
      throw err;
    }

    const parsed = this._decryptEnvelope(cfg.app_id, res.data);
    await supplierApiLog.log({
      supplierName: SUPPLIER, endpoint: '/api/getToken', statusCode: res.status,
      responseTimeMs: Date.now() - start, requestBody: { appId: cfg.app_id, appKey: '***' },
      responseBody: parsed,
    });

    if (res.status !== 200 || !parsed || parsed.code !== 200 || !parsed.data) {
      await supplierConfigRepo.recordFailure(SUPPLIER);
      throw new SupplierAuthError(`WgCards getToken failed: ${parsed?.msg || res.status}`);
    }

    const token = parsed.data;
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
    await supplierConfigRepo.saveToken(SUPPLIER, token, expiresAt);
    await supplierConfigRepo.recordSuccess(SUPPLIER);
    return token;
  }

  _decryptEnvelope(appId, rawResponseData) {
    // WgCards responses come back as a single base64 string (the whole body
    // IS the encrypted msg) — see doc examples for every endpoint.
    if (typeof rawResponseData !== 'string') return rawResponseData;
    try {
      return JSON.parse(decryptMsg(appId, rawResponseData));
    } catch (err) {
      logger.error('WgCardsService: failed to decrypt/parse response', err);
      return null;
    }
  }

  /**
   * Core authenticated call helper — Flow A1 step 4: on 401, force refresh
   * once and retry the same call once; anything else bubbles up.
   */
  async _authedCall(endpoint, payload, { _isRetry = false } = {}) {
    const cfg = await this._config();
    const token = _isRetry
      ? await this._fetchNewToken(cfg)
      : await this._getValidToken(cfg);

    const start = Date.now();
    const url = `${cfg.api_base_url}${endpoint}`;
    const body = {
      appId: cfg.app_id,
      accountId: cfg.account_id,
      msg: encryptMsg(cfg.app_id, payload),
    };

    let res;
    try {
      res = await axios.post(url, body, {
        headers: {
          'Content-Type': 'application/json',
          appId: cfg.app_id,
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

    if (res.status === 401 && !_isRetry) {
      logger.warn(`WgCardsService: 401 on ${endpoint} — forcing token refresh and retrying once`);
      await supplierConfigRepo.clearToken(SUPPLIER);
      return this._authedCall(endpoint, payload, { _isRetry: true });
    }

    const parsed = this._decryptEnvelope(cfg.app_id, res.data);
    await supplierApiLog.log({
      supplierName: SUPPLIER, endpoint, statusCode: res.status,
      responseTimeMs: Date.now() - start, requestBody: payload, responseBody: parsed,
    });

    if (res.status === 401 && _isRetry) {
      await supplierConfigRepo.recordFailure(SUPPLIER);
      throw new SupplierAuthError(`WgCards ${endpoint}: still 401 after forced token refresh`);
    }
    if (res.status !== 200 || !parsed || parsed.code !== 200) {
      await supplierConfigRepo.recordFailure(SUPPLIER);
      throw new Error(`WgCards ${endpoint} failed: ${parsed?.msg || res.status}`);
    }

    await supplierConfigRepo.recordSuccess(SUPPLIER);
    return parsed.data;
  }

  // ── SupplierAdapter interface (Master Plan §1) ──────────────────────────

  /** getAccount — Flow G balance check. */
  async getAccount() {
    const cfg = await this._config();
    return this._authedCall('/api/getAccount', { userId: cfg.app_id });
  }

  /** getCatalog() — Flow B1: full catalog pull, one call. */
  async getAllItem({ currencyCode = 'USD', language = 'en', itemId = '', itemName = '' } = {}) {
    const cfg = await this._config();
    return this._authedCall('/api/getAllItem', {
      appId: cfg.app_id, currencyCode, language, itemId, itemName,
    });
  }

  /** getStock(ref) — Flow C: batch stock check, up to the caller to chunk into 50s. */
  async getStock(skuIds) {
    if (!Array.isArray(skuIds) || !skuIds.length) {
      throw new Error('getStock requires a non-empty array of skuIds');
    }
    return this._authedCall('/api/getStock', { skuIds });
  }

  /** getItemAndStock — combined item + live stock lookup (used at checkout, Flow D). */
  async getItemAndStock({ itemId = '', skuId = '', currencyCode = 'USD', language = 'en' } = {}) {
    const cfg = await this._config();
    return this._authedCall('/api/getItemAndStock', {
      appId: cfg.app_id, itemId, skuId, currencyCode, language,
    });
  }

  // ── Stubs — filled in during later phases, kept here so the adapter's
  //    shape matches the doc's SupplierAdapter interface end to end. ──────

  /** placeOrder({ productId, idempotencyKey, fields, qty }) — Phase 4 (Flow D). */
  async placeOrder(/* { productId, idempotencyKey, fields, qty } */) {
    throw new Error('WgCardsService.placeOrder: not implemented yet (Phase 4)');
  }

  /** getOrderStatus(idempotencyKeyOrOrderId) — Phase 5 (Flow E, getOrderInfoAndDetail). */
  async getOrderStatus(/* orderId */) {
    throw new Error('WgCardsService.getOrderStatus: not implemented yet (Phase 5)');
  }

  /** getCode(orderIdOrReference) — Phase 5 (Flow E, getBuyCard). */
  async getCode(/* orderId */) {
    throw new Error('WgCardsService.getCode: not implemented yet (Phase 5)');
  }

  /** Direct top-up flow (getDirectParam/apiTopUpParamCheck/placeDirectOrder) — Phase 9 / Flow F. */
  async placeDirectOrder(/* { skuId, targetAccount, webhookUrl } */) {
    throw new Error('WgCardsService.placeDirectOrder: not implemented yet (Flow F)');
  }
}

module.exports = new WgCardsService();
module.exports.SupplierAuthError = SupplierAuthError;
