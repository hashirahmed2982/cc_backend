// services/order.service.js
'use strict';

const db = require('../config/database');
const logger = require('../utils/logger');
const crypto = require('crypto');
const ZipEncrypted = require('archiver-zip-encrypted');
const stream = require('stream');
const emailService = require('./email.service');
const auditService = require('../services/audit.service');


// ─── Decrypt codes (same key as product_service) ─────────────────────────────
const RAW_KEY = process.env.ENCRYPTION_KEY || 'default-32-byte-key-change-this!!';
const ENCRYPTION_KEY = Buffer.from(RAW_KEY.padEnd(32, '0').slice(0, 32));

function decrypt(text) {
  try {
    const [ivHex, encHex] = text.split(':');
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      ENCRYPTION_KEY,
      Buffer.from(ivHex, 'hex')
    );
    return Buffer.concat([
      decipher.update(Buffer.from(encHex, 'hex')),
      decipher.final(),
    ]).toString();
  } catch { return text; }
}

// ─── Generate order number ────────────────────────────────────────────────────
function generateOrderNumber() {
  const ts = Date.now().toString().slice(-8);
  const rand = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `ORD-${ts}-${rand}`;
}

// ─── Derive ZIP password from email + orderNumber ─────────────────────────────
// password = first 12 hex chars of SHA-256("email:orderNumber")
// Deterministic — client can always re-derive from their own email + order number
async function getZipPassword(userId) {
  const row = await db.queryOne(
    'SELECT zip_password FROM users WHERE user_id = ?', [userId]
  );
  // zip_password is stored as plain text (set by admin at user creation)
  return row?.zip_password || null;
}

// ─── Build AES-256 encrypted ZIP buffer ──────────────────────────────────────
// REPLACE the entire buildEncryptedCodesZip function with:
function buildEncryptedCodesZip(orderNumber, fulfilledItems, password) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const output = new stream.PassThrough();
    output.on('data', c => chunks.push(c));
    output.on('end', () => resolve(Buffer.concat(chunks)));
    output.on('error', reject);

    const archive = ZipEncrypted({
      encryptionMethod: 'aes256',
      password: Buffer.from(String(password), 'utf-8'),
      zlib: { level: 9 },
    });
    archive.on('error', reject);
    archive.pipe(output);

    const lines = [
      `CardCove B2B Portal — Order ${orderNumber}`,
      `Generated: ${new Date().toUTCString()}`,
      '='.repeat(60),
      '',
    ];
    for (const item of fulfilledItems) {
      lines.push(`Product: ${item.productName}`);
      lines.push(`Delivered: ${item.delivered} code(s)`);
      lines.push('-'.repeat(40));
      item.codes.forEach((code, i) => lines.push(`${i + 1}. ${code}`));
      lines.push('');
    }

    archive.append(lines.join('\n'), { name: `order_${orderNumber}_codes.txt` });

    // finalize() is void in this version — listen to 'finish', not .then()
    archive.on('finish', () => { /* output 'end' fires after pipe drains */ });
    archive.finalize();
  });
}
class OrderService {

  // ══════════════════════════════════════════════════════════════════════════
  //  PLACE ORDER  (client)
  //  items: [{ productId, skuId?, quantity }]
  //  Deducts wallet, allocates codes, sends email, marks status
  // ══════════════════════════════════════════════════════════════════════════

  async placeOrder(userId, items, notes = '') {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      // ── 1. Validate wallet ──────────────────────────────────────────────
      const [walletRows] = await conn.execute(
        'SELECT wallet_id, balance, currency, status FROM wallets WHERE user_id = ? FOR UPDATE',
        [userId]
      );
      if (!walletRows.length) throw new Error('Wallet not found');
      const wallet = walletRows[0];
      if (wallet.status !== 'active') throw new Error('Wallet is not active');

      // ── 2. Resolve SKUs + prices for each item ───────────────────────────
      const resolvedItems = [];
      let totalAmount = 0;

      for (const item of items) {
        const productId = parseInt(item.productId);
        const qty = parseInt(item.quantity) || 1;

        // Get product
        const [prodRows] = await conn.execute(
          'SELECT product_id, product_name, source, is_active FROM products WHERE product_id = ?',
          [productId]
        );
        if (!prodRows.length) throw new Error(`Product ${productId} not found`);
        if (!prodRows[0].is_active) throw new Error(`Product "${prodRows[0].product_name}" is not active`);

        // Get primary active SKU (or specific one if provided)
        const skuQuery = item.skuId
          ? 'SELECT sku_id, selling_price FROM product_skus WHERE sku_id = ? AND product_id = ? AND is_active = 1 LIMIT 1'
          : 'SELECT sku_id, selling_price FROM product_skus WHERE product_id = ? AND is_active = 1 ORDER BY sku_id LIMIT 1';
        const skuParams = item.skuId ? [item.skuId, productId] : [productId];
        const [skuRows] = await conn.execute(skuQuery, skuParams);
        if (!skuRows.length) throw new Error(`No active SKU found for product "${prodRows[0].product_name}"`);
        const sku = skuRows[0];

        // Check user-specific custom price
        const [cpRows] = await conn.execute(
          'SELECT custom_price FROM client_pricing WHERE user_id = ? AND sku_id = ? LIMIT 1',
          [userId, sku.sku_id]
        );
        const unitPrice = cpRows.length
          ? parseFloat(cpRows[0].custom_price)
          : parseFloat(sku.selling_price);

        const lineTotal = unitPrice * qty;
        totalAmount += lineTotal;

        resolvedItems.push({
          productId,
          productName: prodRows[0].product_name,
          source: prodRows[0].source,
          skuId: sku.sku_id,
          quantity: qty,
          unitPrice,
          lineTotal,
        });
      }

      // ── 3. Check wallet balance ──────────────────────────────────────────
      const balance = parseFloat(wallet.balance);
      if (balance < totalAmount) {
        throw new Error(
          `Insufficient wallet balance. Required: $${totalAmount.toFixed(2)}, Available: $${balance.toFixed(2)}`
        );
      }

      // ── 4. Create order record ───────────────────────────────────────────
      const orderNumber = generateOrderNumber();
      const [orderResult] = await conn.execute(
        `INSERT INTO orders
           (order_number, user_id, order_status, delivery_status, total_amount, currency, payment_method, notes)
         VALUES (?, ?, 'pending', 'pending', ?, ?, 'wallet', ?)`,
        [orderNumber, userId, totalAmount, wallet.currency, notes || null]
      );
      const orderId = orderResult.insertId;

      // ── 5. Insert order details ──────────────────────────────────────────
      for (const item of resolvedItems) {
        await conn.execute(
          `INSERT INTO order_details
             (order_id, product_id, sku_id, quantity, unit_cost, unit_price, currency)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [orderId, item.productId, item.skuId, item.quantity, item.unitPrice, item.unitPrice, wallet.currency]
        );
      }

      // ── 6. Debit wallet ──────────────────────────────────────────────────
      const balanceBefore = balance;
      const balanceAfter = balance - totalAmount;

      await conn.execute(
        'UPDATE wallets SET balance = ?, updated_at = NOW() WHERE wallet_id = ?',
        [balanceAfter, wallet.wallet_id]
      );
      await conn.execute(
        `INSERT INTO wallet_transactions
           (wallet_id, user_id, transaction_type, amount, currency,
            balance_before, balance_after, description, reference_type, reference_id)
         VALUES (?, ?, 'debit', ?, ?, ?, ?, ?, 'order', ?)`,
        [wallet.wallet_id, userId, totalAmount, wallet.currency,
          balanceBefore, balanceAfter, `Order ${orderNumber}`, String(orderId)]
      );

      await conn.commit();

      // ── 7. Fulfill codes (outside transaction for performance) ───────────
      const fulfillResult = await this._fulfillOrder(orderId, resolvedItems, userId);

      // ── 8. Send confirmation email ───────────────────────────────────────
      const [userRows] = await conn.execute(
        'SELECT full_name, email FROM users WHERE user_id = ?', [userId]
      );
      const user = userRows[0];
      const zipPassword = await getZipPassword(userId);
      await this._sendOrderEmail(user, orderNumber, orderId, fulfillResult, wallet.currency, zipPassword);
      // await this._sendOrderEmail(user, orderNumber, orderId, fulfillResult, wallet.currency);

      return {
        orderId,
        orderNumber,
        totalAmount,
        currency: wallet.currency,
        status: fulfillResult.orderStatus,
        deliveryStatus: fulfillResult.deliveryStatus,
        fulfilledItems: fulfillResult.fulfilledItems,
        pendingItems: fulfillResult.pendingItems,
      };
    } catch (err) {
      await conn.rollback();
      logger.error('OrderService.placeOrder:', err);
      throw err;
    } finally {
      conn.release();
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  INTERNAL: Allocate digital codes from inventory
  // ══════════════════════════════════════════════════════════════════════════

  async _fulfillOrder(orderId, resolvedItems, userId) {
    const fulfilledItems = [];
    const pendingItems = [];
    let totalFulfilled = 0;
    let totalQty = 0;

    for (const item of resolvedItems) {
      totalQty += item.quantity;

      if (item.source !== 'internal') {
        pendingItems.push({ ...item, reason: 'supplier_api_pending', allocatedCodes: [] });
        continue;
      }

      // Get available codes for this SKU
      const codes = await db.query(
        `SELECT code_id, code FROM digital_codes
          WHERE sku_id = ? AND status = 'available'
          LIMIT ?`,
        [item.skuId, item.quantity]
      );

      const allocated = codes.slice(0, item.quantity);
      const needed = item.quantity - allocated.length;

      if (allocated.length > 0) {
        // Mark codes as sold
        const codeIds = allocated.map(c => c.code_id);
        await db.query(
          `UPDATE digital_codes
              SET status = 'sold', order_id = ?, sold_at = NOW()
            WHERE code_id IN (${codeIds.map(() => '?').join(',')})`,
          [orderId, ...codeIds]
        );

        // Update inventory
        await db.query(
          'UPDATE inventory SET stock_quantity = stock_quantity - ? WHERE sku_id = ?',
          [allocated.length, item.skuId]
        );

        // Update order_details delivered_qty
        await db.query(
          `UPDATE order_details
              SET delivered_qty = ?, delivery_status = ?
            WHERE order_id = ? AND sku_id = ?`,
          [
            allocated.length,
            allocated.length >= item.quantity ? 'completed' : 'partial',
            orderId,
            item.skuId,
          ]
        );
        // await db.query(
        //   `UPDATE order_details
        //       SET delivered_qty = delivered_qty + ?,
        //           delivery_status = CASE
        //             WHEN delivered_qty + ? >= quantity THEN 'completed'
        //             ELSE 'partial'
        //           END
        //     WHERE order_id = ? AND sku_id = ?`,
        //   [allocated.length, allocated.length, orderId, item.skuId]
        // );

        totalFulfilled += allocated.length;

        fulfilledItems.push({
          productId: item.productId,
          productName: item.productName,
          skuId: item.skuId,
          quantity: item.quantity,
          delivered: allocated.length,
          codes: allocated.map(c => decrypt(c.code)),
        });
      }

      if (needed > 0) {
        pendingItems.push({
          productId: item.productId,
          productName: item.productName,
          skuId: item.skuId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          delivered: allocated.length,
          pending: needed,
          reason: 'insufficient_inventory',
        });
      }
    }

    // ── Determine order status ──────────────────────────────────────────────
    let orderStatus, deliveryStatus;

    if (pendingItems.length === 0) {
      orderStatus = 'completed';
      deliveryStatus = 'completed';
    } else if (fulfilledItems.length === 0) {
      orderStatus = 'pending';
      deliveryStatus = 'pending';
    } else {
      orderStatus = 'processing';
      deliveryStatus = 'partial';
    }

    await db.query(
      `UPDATE orders
          SET order_status = ?, delivery_status = ?,
              completed_at = ${orderStatus === 'completed' ? 'NOW()' : 'NULL'}
        WHERE order_id = ?`,
      [orderStatus, deliveryStatus, orderId]
    );

    return { fulfilledItems, pendingItems, orderStatus, deliveryStatus };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  ADMIN: Complete a pending order — fulfill remaining items + send email
  // ══════════════════════════════════════════════════════════════════════════

  async completeOrder(orderId, adminId) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      // Get order
      const [orderRows] = await conn.execute(
        `SELECT o.*, u.full_name, u.email, u.user_id AS client_user_id, w.currency
           FROM orders o
           JOIN users u ON u.user_id = o.user_id
           JOIN wallets w ON w.user_id = o.user_id
          WHERE o.order_id = ?`,
        [orderId]
      );
      if (!orderRows.length) throw new Error('Order not found');
      const order = orderRows[0];
      if (order.order_status === 'completed') throw new Error('Order is already completed');

      // Get pending order_details (not yet fully delivered)
      const [detailRows] = await conn.execute(
        `SELECT od.*, p.product_name, p.source
           FROM order_details od
           JOIN products p ON p.product_id = od.product_id
          WHERE od.order_id = ?
            AND od.delivery_status IN ('pending', 'partial')`,
        [orderId]
      );

      await conn.commit();

      // Build items list for remaining quantity
      const remainingItems = detailRows.map(d => ({
        productId: d.product_id,
        productName: d.product_name,
        source: d.source,
        skuId: d.sku_id,
        quantity: d.quantity - d.delivered_qty, // only what's still needed
        unitPrice: parseFloat(d.unit_price),
        lineTotal: 0,
      }));

      // Fulfill remaining
      const fulfillResult = await this._fulfillOrder(orderId, remainingItems, order.client_user_id);

      // Always mark order as completed when admin presses Complete
      // await db.query(
      //   `UPDATE orders
      //       SET order_status = 'completed',
      //           delivery_status = ?,
      //           completed_at = NOW()
      //     WHERE order_id = ?`,
      //   [fulfillResult.pendingItems.length === 0 ? 'completed' : 'partial', orderId]
      // );

      // Send email with remaining codes (only if new codes were delivered)
      if (fulfillResult.fulfilledItems.length > 0) {
        const user = { full_name: order.full_name, email: order.email };
        const zipPassword = await getZipPassword(order.client_user_id);
        await this._sendCompletionEmail(user, order.order_number, orderId, fulfillResult, order.currency, zipPassword);
      }

      // Audit
      await db.query(
        `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_values)
         VALUES (?, 'order_completed', 'order', ?, ?)`,
        [adminId, String(orderId), JSON.stringify({ completedBy: adminId })]
      );

      return {
        orderId,
        orderNumber: order.order_number,
        orderStatus: 'completed',
        deliveryStatus: fulfillResult.pendingItems.length === 0 ? 'completed' : 'partial',
        ...fulfillResult,
      };
    } catch (err) {
      await conn.rollback();
      logger.error('OrderService.completeOrder:', err);
      throw err;
    } finally {
      conn.release();
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  ADMIN: Cancel order — refund undelivered items to wallet
  // ══════════════════════════════════════════════════════════════════════════

  async cancelOrder(orderId, adminId, reason = '') {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const [orderRows] = await conn.execute(
        `SELECT o.*, u.full_name, u.email, u.user_id AS client_user_id,
                w.wallet_id, w.balance AS walletBalance, w.currency
           FROM orders o
           JOIN users u   ON u.user_id = o.user_id
           JOIN wallets w ON w.user_id = o.user_id
          WHERE o.order_id = ?`,
        [orderId]
      );
      if (!orderRows.length) throw new Error('Order not found');
      const order = orderRows[0];
      if (order.order_status === 'cancelled') throw new Error('Order is already cancelled');

      const [detailRows] = await conn.execute(
        `SELECT od.*, p.product_name FROM order_details od
           JOIN products p ON p.product_id = od.product_id
          WHERE od.order_id = ?`,
        [orderId]
      );

      // Calculate refund for undelivered items
      let refundAmount = 0;
      const refundLines = [];
      for (const row of detailRows) {
        const undelivered = row.quantity - row.delivered_qty;
        if (undelivered > 0) {
          const lineRefund = parseFloat((undelivered * parseFloat(row.unit_price)).toFixed(2));
          refundAmount += lineRefund;
          refundLines.push({ productName: row.product_name, qty: undelivered, unitPrice: parseFloat(row.unit_price), refund: lineRefund });
        }
      }
      refundAmount = parseFloat(refundAmount.toFixed(2));

      // Release any reserved codes
      await conn.execute(
        `UPDATE digital_codes SET status = 'available', order_id = NULL, reserved_at = NULL
          WHERE order_id = ? AND status IN ('reserved', 'pending')`,
        [orderId]
      );

      // Mark undelivered lines as failed
      await conn.execute(
        `UPDATE order_details SET delivery_status = 'failed'
          WHERE order_id = ? AND delivery_status IN ('pending', 'partial')`,
        [orderId]
      );

      // Mark order cancelled
      await conn.execute(
        `UPDATE orders SET order_status = 'cancelled', completed_at = NOW() WHERE order_id = ?`,
        [orderId]
      );

      // Refund wallet
      if (refundAmount > 0) {
        const balanceBefore = parseFloat(order.walletBalance);
        const balanceAfter = parseFloat((balanceBefore + refundAmount).toFixed(2));
        await conn.execute('UPDATE wallets SET balance = ? WHERE wallet_id = ?', [balanceAfter, order.wallet_id]);
        await conn.execute(
          `INSERT INTO wallet_transactions
             (wallet_id, user_id, transaction_type, amount, currency,
              balance_before, balance_after, description, reference_type, reference_id)
           VALUES (?, ?, 'credit', ?, ?, ?, ?, ?, 'order', ?)`,
          [order.wallet_id, order.client_user_id, refundAmount, order.currency,
            balanceBefore, balanceAfter,
          `Refund — cancelled Order ${order.order_number}${reason ? ': ' + reason : ''}`,
          String(orderId)]
        );
      }

      await conn.commit();

      // Send cancellation email
      await this._sendCancellationEmail(
        { full_name: order.full_name, email: order.email },
        order.order_number, orderId, refundAmount, refundLines, order.currency, reason
      );

      await db.query(
        `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_values)
         VALUES (?, 'order_cancelled', 'order', ?, ?)`,
        [adminId, String(orderId), JSON.stringify({ cancelledBy: adminId, reason, refundAmount })]
      );

      return { orderId, orderNumber: order.order_number, refundAmount, refundLines, currency: order.currency };
    } catch (err) {
      await conn.rollback();
      logger.error('OrderService.cancelOrder:', err);
      throw err;
    } finally {
      conn.release();
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  READ — Client
  // ══════════════════════════════════════════════════════════════════════════

  async getClientOrders(userId, { status, page = 1, limit = 20 } = {}) {
    const offset = (page - 1) * limit;
    const conds = ['o.user_id = ?'];
    const params = [parseInt(userId)];
    if (status) { conds.push('o.order_status = ?'); params.push(status); }

    const where = `WHERE ${conds.join(' AND ')}`;

    const rows = await db.query(
      `SELECT
         o.order_id       AS id,
         o.order_number   AS orderNumber,
         o.order_status   AS status,
         o.delivery_status AS deliveryStatus,
         o.total_amount   AS total,
         o.currency,
         o.created_at     AS createdAt,
         o.completed_at   AS completedAt,
         GROUP_CONCAT(p.product_name ORDER BY p.product_name SEPARATOR ', ') AS products,
         SUM(od.quantity) AS totalQty,
         SUM(od.delivered_qty) AS deliveredQty
       FROM orders o
       JOIN order_details od ON od.order_id = o.order_id
       JOIN products p        ON p.product_id = od.product_id
       ${where}
       GROUP BY o.order_id
       ORDER BY o.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    const countRow = await db.queryOne(
      `SELECT COUNT(DISTINCT o.order_id) AS n FROM orders o ${where}`, params
    );

    return {
      data: rows.map(r => ({ ...r, id: String(r.id), total: parseFloat(r.total) })),
      pagination: { page: parseInt(page), limit: parseInt(limit), total: countRow.n, totalPages: Math.ceil(countRow.n / limit) },
    };
  }

  async getClientOrderById(orderId, userId) {
    const rows = await db.query(
      `SELECT o.order_id, o.order_number, o.order_status, o.delivery_status,
              o.total_amount, o.currency, o.notes, o.created_at, o.completed_at,
              NULL AS clientName, NULL AS clientEmail, NULL AS clientCompany,
              od.order_detail_id, od.product_id, od.sku_id, od.quantity,
              od.delivered_qty, od.unit_price, od.delivery_status AS item_delivery_status,
              p.product_name
         FROM orders o
         JOIN order_details od ON od.order_id   = o.order_id
         JOIN products p        ON p.product_id  = od.product_id
        WHERE o.order_id = ? AND o.user_id = ?`,
      [orderId, userId]
    );
    if (!rows.length) return null;
    return this._formatOrderDetail(rows);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  READ — Admin
  // ══════════════════════════════════════════════════════════════════════════

  async getAllOrders({ page = 1, limit = 20, status, userId, search, dateFrom, dateTo } = {}) {
    const whereClauses = [];
    const params = [];

    if (status) { whereClauses.push('o.order_status = ?'); params.push(status); }
    if (userId) { whereClauses.push('o.user_id = ?'); params.push(userId); }
    if (search) {
      whereClauses.push('(o.order_number LIKE ? OR u.full_name LIKE ? OR u.company_name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (dateFrom) { whereClauses.push('DATE(o.created_at) >= ?'); params.push(dateFrom); }
    if (dateTo) { whereClauses.push('DATE(o.created_at) <= ?'); params.push(dateTo); }

    // Default to today when no date range given
    if (!dateFrom && !dateTo) {
      whereClauses.push('DATE(o.created_at) = CURDATE()');
    }

    const whereClause = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const offset = (page - 1) * limit;
    const rows = await db.query(
      `SELECT
         o.order_id        AS id,
         o.order_number    AS orderNumber,
         o.order_status    AS status,
         o.delivery_status AS deliveryStatus,
         o.total_amount    AS total,
         o.currency,
         o.created_at      AS createdAt,
         o.completed_at    AS completedAt,
         u.full_name       AS clientName,
         u.email           AS clientEmail,
         u.company_name    AS clientCompany,
         GROUP_CONCAT(p.product_name ORDER BY p.product_name SEPARATOR ', ') AS products,
         SUM(od.quantity)       AS totalQty,
         SUM(od.delivered_qty)  AS deliveredQty
       FROM orders o
       JOIN users u           ON u.user_id        = o.user_id
       JOIN order_details od  ON od.order_id      = o.order_id
       JOIN products p        ON p.product_id     = od.product_id
       ${whereClause}
       GROUP BY o.order_id
       ORDER BY o.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    const countRow = await db.queryOne(
      `SELECT COUNT(DISTINCT o.order_id) AS n FROM orders o ${whereClause}`, params
    );

    return {
      data: rows.map(r => ({ ...r, id: String(r.id), total: parseFloat(r.total) })),
      pagination: { page: parseInt(page), limit: parseInt(limit), total: countRow.n, totalPages: Math.ceil(countRow.n / limit) },
    };
  }

  async getOrderById(orderId) {
    const rows = await db.query(
      `SELECT
         o.order_id, o.order_number, o.order_status, o.delivery_status,
         o.total_amount, o.currency, o.notes, o.created_at, o.completed_at,
         u.full_name AS clientName, u.email AS clientEmail, u.company_name AS clientCompany,
         od.order_detail_id, od.product_id, od.sku_id, od.quantity,
         od.delivered_qty, od.unit_price, od.delivery_status AS item_delivery_status,
         p.product_name
       FROM orders o
       JOIN users u           ON u.user_id      = o.user_id
       JOIN order_details od  ON od.order_id    = o.order_id
       JOIN products p        ON p.product_id   = od.product_id
       WHERE o.order_id = ?`,
      [orderId]
    );
    if (!rows.length) return null;
    return this._formatOrderDetail(rows);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  _formatOrderDetail(rows) {
    const o = rows[0];
    return {
      id: String(o.order_id),
      orderNumber: o.order_number,
      status: o.order_status,
      deliveryStatus: o.delivery_status,
      total: parseFloat(o.total_amount),
      currency: o.currency,
      notes: o.notes,
      createdAt: o.created_at,
      completedAt: o.completed_at,
      clientName: o.clientName,
      clientEmail: o.clientEmail,
      clientCompany: o.clientCompany,
      client: {
        full_name: o.clientName,
        email: o.clientEmail,
        company_name: o.clientCompany,
      },
      totalAmount: parseFloat(o.total_amount),
      items: rows.map(r => ({
        orderDetailId: r.order_detail_id,
        productId: r.product_id,
        productName: r.product_name,
        skuId: r.sku_id,
        quantity: r.quantity,
        deliveredQty: r.delivered_qty,
        pendingQty: r.quantity - r.delivered_qty,
        unitPrice: parseFloat(r.unit_price),
        deliveryStatus: r.item_delivery_status,
      })),
    };
  }

  // ─── Email: order placed ──────────────────────────────────────────────────

  async _sendOrderEmail(user, orderNumber, orderId, fulfillResult, currency, zipPassword) {
    const { fulfilledItems, pendingItems, orderStatus } = fulfillResult;

    const statusLabel = orderStatus === 'completed'
      ? '✅ Fully Delivered'
      : orderStatus === 'processing'
        ? '⚡ Partially Delivered'
        : '⏳ Pending Fulfillment';

    const pendingHtml = pendingItems.length
      ? `<p style="color:#b45309;">⏳ The following items are pending fulfillment:</p>
         <ul>${pendingItems.map(i => `<li>${i.productName} — ${i.pending ?? i.quantity} remaining</li>`).join('')}</ul>`
      : '';

    // Build ZIP attachment if any codes were delivered
    const attachments = [];
    if (fulfilledItems.length > 0) {
      // const zipPassword = deriveZipPassword(user.email, orderNumber);
      try {
        const zipBuffer = await buildEncryptedCodesZip(orderNumber, fulfilledItems, zipPassword);
        attachments.push({
          filename: `order_${orderNumber}_codes.zip`,
          content: zipBuffer,
          contentType: 'application/zip',
        });

        const html = `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
            <h2 style="color:#1d4ed8;">Order Confirmation — ${orderNumber}</h2>
            <p>Hi ${user.full_name},</p>
            <p>Your order has been placed. Status: <strong>${statusLabel}</strong></p>
            <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:16px;margin:16px 0;">
              <p style="margin:0 0 8px;font-weight:600;">📎 Your codes are attached as an encrypted ZIP file</p>
              <p style="margin:8px 0 0;font-size:12px;color:#6b7280;">
                This password is unique to this order. To re-derive it at any time:<br/>
                SHA-256(<em>your_email</em>:<em>${orderNumber}</em>), first 12 hex characters.
              </p>
            </div>
            ${pendingHtml}
            <p style="color:#6b7280;font-size:12px;margin-top:24px;">Order ID: ${orderId} · CardCove B2B Portal</p>
          </div>`;

        await emailService.sendEmail(
          user.email,
          `Order ${orderNumber} — ${statusLabel}`,
          html,
          `Order ${orderNumber} placed. ${fulfilledItems.length} products delivered. ${pendingItems.length} pending. ZIP password: ${zipPassword}`,
          attachments
        );
      } catch (zipErr) {
        logger.error('ZIP build failed for order email:', zipErr);
        // Fallback: send without attachment
        await emailService.sendEmail(
          user.email,
          `Order ${orderNumber} — ${statusLabel}`,
          `<p>Hi ${user.full_name}, your order ${orderNumber} has been placed. Codes could not be attached — please contact support.</p>`,
          `Order ${orderNumber} placed.`
        );
      }
    } else {
      // No codes delivered yet — plain pending email, no attachment
      const html = `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
          <h2 style="color:#1d4ed8;">Order Confirmation — ${orderNumber}</h2>
          <p>Hi ${user.full_name},</p>
          <p>Your order has been placed. Status: <strong>${statusLabel}</strong></p>
          ${pendingHtml}
          <p style="color:#6b7280;font-size:12px;margin-top:24px;">Order ID: ${orderId} · CardCove B2B Portal</p>
        </div>`;
      await emailService.sendEmail(
        user.email,
        `Order ${orderNumber} — ${statusLabel}`,
        html,
        `Order ${orderNumber} placed. ${pendingItems.length} items pending fulfillment.`
      );
    }
  }

  // ─── Email: admin completes order ─────────────────────────────────────────

  async _sendCompletionEmail(user, orderNumber, orderId, fulfillResult, currency, zipPassword) {
    const { fulfilledItems, pendingItems } = fulfillResult;
    if (!fulfilledItems.length) return;

    const pendingNote = pendingItems.length
      ? `<p style="color:#b45309;">⏳ ${pendingItems.length} item(s) are still pending — contact support to cancel those items for a refund.</p>`
      : '';

    const attachments = [];
    try {
      const zipBuffer = await buildEncryptedCodesZip(orderNumber, fulfilledItems, zipPassword);
      attachments.push({
        filename: `order_${orderNumber}_additional_codes.zip`,
        content: zipBuffer,
        contentType: 'application/zip',
      });
    } catch (zipErr) {
      logger.error('ZIP build failed for completion email:', zipErr);
    }

    const html = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#16a34a;">Order ${orderNumber} — Additional Codes Delivered</h2>
        <p>Hi ${user.full_name},</p>
        <p>More codes from your order are now available.</p>
        <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:16px;margin:16px 0;">
          <p style="margin:0 0 8px;font-weight:600;">📎 Additional codes attached as encrypted ZIP</p>
        </div>
        ${pendingNote}
        <p style="color:#6b7280;font-size:12px;margin-top:24px;">Order ID: ${orderId} · CardCove B2B Portal</p>
      </div>`;

    await emailService.sendEmail(
      user.email,
      `Order ${orderNumber} — Additional Codes Delivered`,
      html,
      `Additional codes for order ${orderNumber} have been delivered. ZIP password: ${zipPassword}`,
      attachments
    );
  }
  async getDeliveredCodes(orderId) {
    const rows = await db.query(
      `SELECT
       dc.code_id,
       dc.code,
       dc.status,
       dc.sold_at,
       p.product_name,
       ps.face_value,
       ps.selling_price
     FROM digital_codes dc
     JOIN order_details od ON od.order_id = ? AND od.sku_id = dc.sku_id
     JOIN product_skus ps  ON ps.sku_id   = dc.sku_id
     JOIN products p       ON p.product_id = ps.product_id
     WHERE dc.order_id = ? AND dc.status = 'sold'
     ORDER BY p.product_name, dc.sold_at`,
      [orderId, orderId]
    );

    // Decrypt codes and group by product
    const grouped = {};
    for (const row of rows) {
      const name = row.product_name;
      if (!grouped[name]) {
        grouped[name] = {
          productName: name,
          faceValue: parseFloat(row.face_value || 0),
          unitPrice: parseFloat(row.selling_price || 0),
          codes: [],
        };
      }
      grouped[name].codes.push({
        codeId: row.code_id,
        code: decrypt(row.code),
        soldAt: row.sold_at,
      });
    }

    return Object.values(grouped);
  }

  async resendCodesEmail(orderId, adminId) {
    // Get order + client info
    const order = await this.getOrderById(orderId);
    if (!order) throw new Error('Order not found');

    const deliveredGroups = await this.getDeliveredCodes(orderId);
    if (!deliveredGroups.length) throw new Error('No delivered codes found for this order');

    // Build fulfilledItems shape for _sendCompletionEmail
    const fulfilledItems = deliveredGroups.map(g => ({
      productName: g.productName,
      delivered: g.codes.length,
      codes: g.codes.map(c => c.code),
    }));

    // Get ZIP password
    const userRow = await db.queryOne(
      'SELECT user_id, zip_password FROM users WHERE email = ?',
      [order.clientEmail]
    );
    const zipPassword = userRow?.zip_password || null;

    if (!zipPassword) throw new Error('No ZIP password set for this client');

    const user = { full_name: order.clientName, email: order.clientEmail };

    await this._sendCompletionEmail(
      user, order.orderNumber, orderId,
      { fulfilledItems, pendingItems: [] },
      order.currency,
      zipPassword
    );

    await auditService.log({
      user_id: adminId,
      action: 'order_email_resent',
      entity_type: 'order',
      entity_id: String(orderId),
      new_values: { resentBy: adminId, codesCount: fulfilledItems.reduce((s, i) => s + i.codes.length, 0) },
    });
  }
  // ─── Email: order cancelled ───────────────────────────────────────────────

  async _sendCancellationEmail(user, orderNumber, orderId, refundAmount, refundLines, currency, reason) {
    const refundHtml = refundAmount > 0
      ? `<div style="background:#dcfce7;border:1px solid #16a34a;border-radius:6px;padding:16px;margin-top:16px;">
           <strong>Refund: ${currency} ${refundAmount.toFixed(2)} has been credited to your wallet</strong>
           <ul style="margin:8px 0 0;">
             ${refundLines.map(l => `<li>${l.productName} × ${l.qty} — ${currency} ${l.refund.toFixed(2)}</li>`).join('')}
           </ul>
         </div>`
      : '<p>No undelivered items — no refund was issued.</p>';

    const reasonNote = reason ? `<p><strong>Reason:</strong> ${reason}</p>` : '';

    const html = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#dc2626;">Order ${orderNumber} — Cancelled</h2>
        <p>Hi ${user.full_name},</p>
        <p>Your order has been cancelled.</p>
        ${reasonNote}
        ${refundHtml}
        <p style="color:#6b7280;font-size:12px;margin-top:24px;">Order ID: ${orderId} · CardCove B2B Portal</p>
      </div>`;

    await emailService.sendEmail(
      user.email,
      `Order ${orderNumber} — Cancelled${refundAmount > 0 ? ` (Refund: ${currency} ${refundAmount.toFixed(2)})` : ''}`,
      html,
      `Order ${orderNumber} cancelled. Refund: ${currency} ${refundAmount.toFixed(2)}.`
    );
  }
}

module.exports = new OrderService();