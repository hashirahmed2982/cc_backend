// services/wgcardsTopup.service.js
// Flow F — WgCards Direct Top-Up. Orchestrates getDirectParam ->
// apiTopUpParamCheck -> placeDirectOrder, the wallet debit/refund around
// it, and the shared resolution logic used by both the inbound webhook
// (routes/webhooks/wgcardsTopup.js, Annex III) and the fallback reconciler
// (jobs/wgcardsTopupReconciler.js, Cron #5). Kept separate from
// wgcardsFulfillment.js (the regular card-order path) — Direct Top-Up has
// its own product type (spuType 5), its own DB table, and a webhook-driven
// async result instead of a poller.
'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const logger = require('../utils/logger');
const wgcardsService = require('./wgcards.service');
const emailService = require('./email.service');

// Same retry policy as wgcardsFulfillment.js's placeOrder loop (§6): only
// raw network/timeout errors are retried, 2s -> 6s backoff.
const RETRY_DELAYS_MS = [2000, 6000];
const DIRECT_TOPUP_SPU_TYPE = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err) {
  return err && err.code !== 'supplier_business_rejection' && err.code !== 'supplier_auth_failure';
}

async function _productNameForSku(skuId) {
  const row = await db.queryOne(
    `SELECT p.product_name FROM products p JOIN product_skus ps ON ps.product_id = p.product_id WHERE ps.sku_id = ?`,
    [skuId]
  );
  return row?.product_name || '';
}

/**
 * Refund the wallet and mark a topup order failed — used both when
 * placement itself fails synchronously (resolvedVia = null — no supplier
 * order was ever placed, so there's no webhook/reconciler race to speak
 * of) and when a webhook/reconciler resolves an already-placed order to
 * status 0 (resolvedVia set).
 */
async function _refundAndMarkFailed({ topupOrderId, orderReference, userId, amount, currency, reason, resolvedVia, user, productName, targetAccount }) {
  await db.transaction(async (conn) => {
    const [walletRows] = await conn.execute('SELECT wallet_id, balance FROM wallets WHERE user_id = ? FOR UPDATE', [userId]);
    if (!walletRows.length) throw new Error(`wgcardsTopup: wallet not found for user ${userId} while refunding topup ${topupOrderId}`);
    const wallet = walletRows[0];
    const balanceBefore = parseFloat(wallet.balance);
    const balanceAfter = parseFloat((balanceBefore + amount).toFixed(2));

    await conn.execute('UPDATE wallets SET balance = ?, updated_at = NOW() WHERE wallet_id = ?', [balanceAfter, wallet.wallet_id]);
    await conn.execute(
      `INSERT INTO wallet_transactions
         (wallet_id, user_id, transaction_type, amount, currency, balance_before, balance_after, description, reference_type, reference_id)
       VALUES (?, ?, 'credit', ?, ?, ?, ?, ?, 'wgcards_topup_refund', ?)`,
      [wallet.wallet_id, userId, amount, currency, balanceBefore, balanceAfter,
        `Refund — failed top-up ${orderReference} (${reason})`, orderReference]
    );
    await conn.execute(
      `UPDATE wgcards_topup_orders
          SET status = 'failed', resolved_via = ?, resolved_at = NOW(),
              last_payload = JSON_MERGE_PATCH(COALESCE(last_payload, '{}'), ?)
        WHERE topup_order_id = ?`,
      [resolvedVia || null, JSON.stringify({ failureReason: reason }), topupOrderId]
    );
  });

  try {
    await emailService.sendTemplate('wgcardsDirectTopupFailed', user.email, {
      Client_Name: user.full_name,
      Order_Reference: orderReference,
      Product_Name: productName || '',
      Target_Account: targetAccount || '',
      Amount: amount.toFixed(2),
      Currency: currency,
      Reason: reason,
    });
  } catch (err) {
    logger.error('wgcardsTopup: failed to send failure email', err);
  }
}

/** Flow F step 1 — dynamic parameter list a Direct Top-Up SKU needs, for
 * the client UI to prompt for (player ID, phone number, zone, etc). */
async function getTopupParams(skuId) {
  const sku = await db.queryOne(
    `SELECT ps.wgcards_sku_id, p.spu_type
       FROM product_skus ps JOIN products p ON p.product_id = ps.product_id
      WHERE ps.sku_id = ? AND ps.is_active = 1`,
    [skuId]
  );
  if (!sku || !sku.wgcards_sku_id) throw new Error('SKU not found or not a WgCards product');
  if (sku.spu_type !== DIRECT_TOPUP_SPU_TYPE) throw new Error('This SKU is not a Direct Top-Up product');
  return wgcardsService.getDirectParam({ skuId: sku.wgcards_sku_id });
}

/**
 * Flow F steps 2-3 + the wallet debit around them. The wallet is debited
 * up front (same "spend first, refund on failure" pattern as the regular
 * order flow) inside one atomic transaction with creating the
 * wgcards_topup_orders row, so a crash between them can't leave a debit
 * with no corresponding row (or vice versa).
 *
 * @param {object} params
 * @param {number} params.userId
 * @param {number} params.skuId            our internal sku_id
 * @param {Array<{name:string,value:string,label?:string}>} params.attributeValues
 * @param {number} [params.faceValue]      required only for custom-value SKUs
 */
async function initiateTopup({ userId, skuId, attributeValues, faceValue }) {
  if (!Array.isArray(attributeValues) || !attributeValues.length) {
    throw new Error('attributeValues is required');
  }

  const orderReference = uuidv4();

  const placed = await db.transaction(async (conn) => {
    const [skuRows] = await conn.execute(
      `SELECT ps.wgcards_sku_id, ps.is_custom_value, ps.min_face_value, ps.max_face_value,
              ps.selling_price, p.spu_type, p.product_name, p.is_active AS product_active
         FROM product_skus ps JOIN products p ON p.product_id = ps.product_id
        WHERE ps.sku_id = ? AND ps.is_active = 1 FOR UPDATE`,
      [skuId]
    );
    if (!skuRows.length) throw new Error('SKU not found or inactive');
    const sku = skuRows[0];
    if (!sku.product_active) throw new Error('Product is not active');
    if (!sku.wgcards_sku_id) throw new Error('Not a WgCards SKU');
    if (sku.spu_type !== DIRECT_TOPUP_SPU_TYPE) {
      throw new Error('This SKU is not a Direct Top-Up product — use the regular order flow');
    }

    let amount;
    if (sku.is_custom_value) {
      if (faceValue === undefined || faceValue === null) throw new Error('faceValue is required for this product');
      amount = parseFloat(faceValue);
      if (sku.min_face_value != null && amount < parseFloat(sku.min_face_value)) {
        throw new Error(`faceValue below minimum (${sku.min_face_value})`);
      }
      if (sku.max_face_value != null && amount > parseFloat(sku.max_face_value)) {
        throw new Error(`faceValue above maximum (${sku.max_face_value})`);
      }
    } else {
      amount = parseFloat(sku.selling_price);
    }

    const [walletRows] = await conn.execute(
      'SELECT wallet_id, balance, currency, status FROM wallets WHERE user_id = ? FOR UPDATE',
      [userId]
    );
    if (!walletRows.length) throw new Error('Wallet not found');
    const wallet = walletRows[0];
    if (wallet.status !== 'active') throw new Error('Wallet is not active');
    const balance = parseFloat(wallet.balance);
    if (balance < amount) {
      throw new Error(`Insufficient wallet balance. Required: ${amount.toFixed(2)}, Available: ${balance.toFixed(2)}`);
    }

    const balanceAfter = parseFloat((balance - amount).toFixed(2));
    await conn.execute('UPDATE wallets SET balance = ?, updated_at = NOW() WHERE wallet_id = ?', [balanceAfter, wallet.wallet_id]);
    await conn.execute(
      `INSERT INTO wallet_transactions
         (wallet_id, user_id, transaction_type, amount, currency, balance_before, balance_after, description, reference_type, reference_id)
       VALUES (?, ?, 'debit', ?, ?, ?, ?, ?, 'wgcards_topup', ?)`,
      [wallet.wallet_id, userId, amount, wallet.currency, balance, balanceAfter,
        `Direct top-up ${orderReference}`, orderReference]
    );

    const displayAccount = attributeValues[0]?.value != null ? String(attributeValues[0].value) : null;
    const [insertResult] = await conn.execute(
      `INSERT INTO wgcards_topup_orders
         (user_id, sku_id, order_reference, target_account, attribute_values, amount, currency, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [userId, skuId, orderReference, displayAccount, JSON.stringify(attributeValues), amount, wallet.currency]
    );

    const [userRows] = await conn.execute('SELECT full_name, email FROM users WHERE user_id = ?', [userId]);

    return {
      topupOrderId: insertResult.insertId,
      amount,
      currency: wallet.currency,
      wgcardsSkuId: sku.wgcards_sku_id,
      isCustomValue: !!sku.is_custom_value,
      productName: sku.product_name,
      user: userRows[0],
    };
  });

  const { topupOrderId, amount, currency, wgcardsSkuId, isCustomValue, productName, user } = placed;
  const targetAccount = attributeValues[0]?.value != null ? String(attributeValues[0].value) : null;

  // ── Param check — a network call, deliberately outside the DB transaction ──
  let checkResult;
  try {
    checkResult = await wgcardsService.apiTopUpParamCheck({ skuId: wgcardsSkuId, attributeValues });
  } catch (err) {
    // The doc's own worked example for this endpoint IS a rejection
    // ("sku不属于直充类型") — a thrown SupplierBusinessError here is just
    // that same outcome surfaced as an exception; treat it identically to
    // an explicit passed:false rather than as an integration failure.
    checkResult = { passed: false, reason: err.message };
  }
  if (!checkResult || checkResult.passed === false) {
    const reason = checkResult?.reason || 'param_check_failed';
    await _refundAndMarkFailed({
      topupOrderId, orderReference, userId, amount, currency, reason,
      resolvedVia: null, user, productName, targetAccount,
    });
    return { success: false, topupOrderId, orderReference, reason: 'param_check_failed', message: reason };
  }

  // ── placeDirectOrder, same retry policy as the regular placeOrder path ──
  const webhook = process.env.WGCARDS_TOPUP_WEBHOOK_URL || '';
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const result = await wgcardsService.placeDirectOrder({
        skuId: wgcardsSkuId,
        faceValue: isCustomValue ? amount : undefined,
        currency,
        serviceOrder: orderReference,
        webhook,
        attributeValues,
      });
      await db.query('UPDATE wgcards_topup_orders SET wgcards_order_id = ? WHERE topup_order_id = ?', [result.wgcardsOrderId, topupOrderId]);
      return { success: true, topupOrderId, orderReference, wgcardsOrderId: result.wgcardsOrderId, status: 'pending' };
    } catch (err) {
      lastError = err;
      if (!isRetryable(err)) break;
      if (attempt < RETRY_DELAYS_MS.length) {
        logger.warn(
          `wgcardsTopup: placeDirectOrder attempt ${attempt + 1} failed (network/timeout), retrying in ${RETRY_DELAYS_MS[attempt]}ms:`,
          err.message
        );
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  const reason = lastError?.code === 'supplier_business_rejection' ? 'supplier_rejected'
    : lastError?.code === 'supplier_auth_failure' ? 'supplier_auth_failure'
      : 'supplier_timeout';
  await _refundAndMarkFailed({
    topupOrderId, orderReference, userId, amount, currency, reason,
    resolvedVia: null, user, productName, targetAccount,
  });
  return { success: false, topupOrderId, orderReference, reason, error: lastError?.message };
}

/**
 * Resolve a topup order from either the webhook (Annex III payload,
 * requestId/orderId/status) or the reconciler's fallback. Idempotent:
 * WgCards retries the webhook up to 5x within 30 min, and a row already in
 * a terminal state (confirmed/failed/cancelled) is left alone rather than
 * re-processed (in particular, never refund twice).
 *
 * @param {object} params
 * @param {string} params.orderReference   our order_reference (webhook's `requestId`)
 * @param {string} [params.wgcardsOrderId]
 * @param {number} params.status           raw 0/1/2 (failed/success/processing)
 * @param {string} [params.errorMsg]
 * @param {object} [params.payload]        raw payload, stored for support debugging
 * @param {'webhook'|'reconciler'} params.resolvedVia
 */
async function resolveTopup({ orderReference, wgcardsOrderId, status, errorMsg, payload, resolvedVia }) {
  const row = await db.queryOne(
    `SELECT tuo.*, u.full_name, u.email
       FROM wgcards_topup_orders tuo JOIN users u ON u.user_id = tuo.user_id
      WHERE tuo.order_reference = ?`,
    [orderReference]
  );
  if (!row) {
    logger.warn(`wgcardsTopup.resolveTopup: no topup order found for reference ${orderReference}`);
    return { found: false };
  }
  if (row.status === 'confirmed' || row.status === 'failed' || row.status === 'cancelled') {
    return { found: true, alreadyResolved: true, status: row.status };
  }

  const numericStatus = Number(status);
  await db.query(
    `UPDATE wgcards_topup_orders
        SET webhook_status = ?, webhook_received_at = COALESCE(webhook_received_at, NOW()),
            webhook_attempts = webhook_attempts + ?,
            last_payload = ?,
            wgcards_order_id = COALESCE(wgcards_order_id, ?)
      WHERE topup_order_id = ?`,
    [Number.isFinite(numericStatus) ? numericStatus : null, resolvedVia === 'webhook' ? 1 : 0,
      JSON.stringify(payload || {}), wgcardsOrderId || null, row.topup_order_id]
  );

  if (numericStatus === 2) {
    // "processing" — WgCards is still recharging. Not terminal, leave for
    // the next webhook retry (up to 5x/30min) or the next reconciler pass.
    await db.query(`UPDATE wgcards_topup_orders SET status = 'processing' WHERE topup_order_id = ?`, [row.topup_order_id]);
    return { found: true, resolved: false, status: 'processing' };
  }

  const productName = await _productNameForSku(row.sku_id);

  if (numericStatus === 1) {
    await db.query(
      `UPDATE wgcards_topup_orders SET status = 'confirmed', resolved_via = ?, resolved_at = NOW() WHERE topup_order_id = ?`,
      [resolvedVia, row.topup_order_id]
    );
    try {
      await emailService.sendTemplate('wgcardsDirectTopupConfirmed', row.email, {
        Client_Name: row.full_name,
        Order_Reference: row.order_reference,
        Product_Name: productName,
        Target_Account: row.target_account || '',
        Amount: parseFloat(row.amount).toFixed(2),
        Currency: row.currency,
      });
    } catch (err) {
      logger.error('wgcardsTopup: failed to send confirmation email', err);
    }
    return { found: true, resolved: true, status: 'confirmed' };
  }

  // numericStatus === 0, or anything else unrecognized — treat as failed
  // rather than leaving it silently stuck.
  await _refundAndMarkFailed({
    topupOrderId: row.topup_order_id,
    orderReference: row.order_reference,
    userId: row.user_id,
    amount: parseFloat(row.amount),
    currency: row.currency,
    reason: errorMsg || 'supplier_reported_failure',
    resolvedVia,
    user: { full_name: row.full_name, email: row.email },
    productName,
    targetAccount: row.target_account,
  });
  return { found: true, resolved: true, status: 'failed' };
}

module.exports = { getTopupParams, initiateTopup, resolveTopup };
