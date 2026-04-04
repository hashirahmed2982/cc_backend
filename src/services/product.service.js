// services/product.service.js
'use strict';

const db     = require('../config/database');
const logger = require('../utils/logger');
const crypto = require('crypto');

// ─── AES-256-CBC encryption for digital codes ────────────────────────────────
const RAW_KEY = process.env.ENCRYPTION_KEY || 'default-32-byte-key-change-this!!';
const ENCRYPTION_KEY = Buffer.from(RAW_KEY.padEnd(32, '0').slice(0, 32));
const IV_LENGTH = 16;

function encrypt(text) {
  const iv     = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  const enc    = Buffer.concat([cipher.update(String(text)), cipher.final()]);
  return iv.toString('hex') + ':' + enc.toString('hex');
}

function decrypt(text) {
  try {
    const [ivHex, encHex] = text.split(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), Buffer.from(ivHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString();
  } catch { return text; }
}

// ─── Reusable SELECT fragment ─────────────────────────────────────────────────
const PRODUCT_SELECT = `
  SELECT
    p.product_id,
    p.product_name,
    p.brand_name,
    p.description,
    p.category,
    p.image_url,
    p.how_exchange,
    p.is_active,
    p.source,
    p.supplier_name,
    p.supplier_ref,
    p.sync_enabled,
    p.last_synced_at,
    p.created_at,
    p.updated_at,
    MIN(ps.sku_id)            AS primary_sku_id,
    MIN(ps.selling_price)     AS price,
    MIN(ps.cost_price)        AS cost_price,
    MIN(ps.face_value)        AS face_value,
    MIN(ps.supplier_sku_ref)  AS supplier_sku_ref,
    MIN(ps.realtime_price)    AS realtime_price,
    COALESCE(MAX(inv.unlimited_stock), 0)            AS unlimited_stock,
    COALESCE(SUM(inv.stock_quantity),  0)            AS total_codes,
    COALESCE(SUM(inv.available_qty),   0)            AS available_codes,
    COALESCE(SUM(inv.stock_quantity) - SUM(inv.available_qty), 0) AS sold_codes
  FROM products p
  LEFT JOIN product_skus ps ON ps.product_id = p.product_id AND ps.is_active = 1
  LEFT JOIN inventory    inv ON inv.sku_id    = ps.sku_id
`;

class ProductService {

  // ══════════════════════════════════════════════════════════════════════════
  //  READ
  // ══════════════════════════════════════════════════════════════════════════

  async getAll({ page = 1, limit = 20, search, category, brand, status, source } = {}) {
    try {
      const offset = (page - 1) * limit;
      const conds  = [], params = [];

      if (search) {
        conds.push('(p.product_name LIKE ? OR p.brand_name LIKE ? OR p.category LIKE ?)');
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }
      if (category) { conds.push('p.category = ?');    params.push(category); }
      if (brand)    { conds.push('p.brand_name = ?');  params.push(brand); }
      if (source)   { conds.push('p.source = ?');      params.push(source); }
      if (status === 'active')   conds.push('p.is_active = 1');
      if (status === 'inactive') conds.push('p.is_active = 0');

      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

      const total = (await db.queryOne(
        `SELECT COUNT(DISTINCT p.product_id) AS n FROM products p ${where}`, params
      )).n;

      const rows = await db.query(
        `${PRODUCT_SELECT} ${where} GROUP BY p.product_id ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );

      return {
        data:       rows.map(r => this._format(r)),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      };
    } catch (err) { logger.error('ProductService.getAll:', err); throw err; }
  }

  async getById(productId) {
    try {
      const row = await db.queryOne(
        `${PRODUCT_SELECT} WHERE p.product_id = ? GROUP BY p.product_id`,
        [productId]
      );
      return row ? this._format(row) : null;
    } catch (err) { logger.error('ProductService.getById:', err); throw err; }
  }

  async getCategories() {
    return (await db.query(
      'SELECT DISTINCT category FROM products WHERE category IS NOT NULL ORDER BY category'
    )).map(r => r.category);
  }

  async getBrands() {
    return (await db.query(
      'SELECT DISTINCT brand_name FROM products WHERE brand_name IS NOT NULL ORDER BY brand_name'
    )).map(r => r.brand_name);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  CREATE — INTERNAL (manual code upload)
  // ══════════════════════════════════════════════════════════════════════════

  async createInternal(data, createdBy) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const [pr] = await conn.execute(`
        INSERT INTO products
          (product_name, brand_name, description, category,
           image_url, how_exchange, is_active, source, created_by)
        VALUES (?, ?, ?, ?, ?, ?, 0, 'internal', ?)
      `, [
        data.name,
        data.brand || null,
        data.description || null,
        data.category || null,
        data.images?.length ? JSON.stringify(data.images) : null,
        data.redemptionInstructions || null,
        createdBy,
      ]);

      const productId    = pr.insertId;
      const sellingPrice = Math.round(parseFloat(data.price) * 100) / 100 || 0;
      const costPrice    = data.discountPrice ? Math.round(parseFloat(data.discountPrice) * 100) / 100 : sellingPrice;

      const [sr] = await conn.execute(`
        INSERT INTO product_skus
          (product_id, sku_name, face_value, cost_price, selling_price, price_currency, is_active)
        VALUES (?, ?, ?, ?, ?, 'USD', 1)
      `, [productId, data.name, sellingPrice, costPrice, sellingPrice]);

      await conn.execute(
        'INSERT INTO inventory (sku_id, stock_quantity, reserved_qty, unlimited_stock) VALUES (?, 0, 0, 0)',
        [sr.insertId]
      );

      await conn.commit();
      return this.getById(productId);
    } catch (err) {
      await conn.rollback();
      logger.error('ProductService.createInternal:', err);
      throw err;
    } finally { conn.release(); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  CREATE — SUPPLIER (real-time fulfilment, no stored codes)
  // ══════════════════════════════════════════════════════════════════════════

  async createSupplier(data, createdBy) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const [pr] = await conn.execute(`
        INSERT INTO products
          (product_name, brand_name, description, category,
           image_url, how_exchange, is_active,
           source, supplier_name, supplier_ref, sync_enabled, created_by)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
      `, [
        data.name,
        data.brand || null,
        data.description || null,
        data.category || null,
        data.images?.length ? JSON.stringify(data.images) : null,
        data.redemptionInstructions || null,
        data.supplierName || 'carrypin',
        data.supplierRef  || null,
        data.syncEnabled  ? 1 : 0,
        createdBy,
      ]);

      const productId    = pr.insertId;
      const sellingPrice = Math.round(parseFloat(data.price)     * 100) / 100 || 0;
      const costPrice    = Math.round((parseFloat(data.costPrice) || sellingPrice) * 100) / 100;
      const faceValue    = Math.round((parseFloat(data.faceValue) || sellingPrice) * 100) / 100;

      const [sr] = await conn.execute(`
        INSERT INTO product_skus
          (product_id, sku_name, carrypin_sku_id, supplier_sku_ref,
           face_value, cost_price, selling_price, price_currency,
           realtime_price, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'USD', ?, 1)
      `, [
        productId,
        data.name,
        data.supplierSkuRef || null,
        data.supplierSkuRef || null,
        faceValue,
        costPrice,
        sellingPrice,
        data.realtimePrice ? 1 : 0,
      ]);

      // Unlimited stock — no quantity tracked for supplier products
      await conn.execute(
        'INSERT INTO inventory (sku_id, stock_quantity, reserved_qty, unlimited_stock) VALUES (?, 0, 0, 1)',
        [sr.insertId]
      );

      await conn.commit();
      return this.getById(productId);
    } catch (err) {
      await conn.rollback();
      logger.error('ProductService.createSupplier:', err);
      throw err;
    } finally { conn.release(); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  UPDATE
  // ══════════════════════════════════════════════════════════════════════════

  async update(productId, data, updatedBy) {
    try {
      const fields = [], params = [];

      const colMap = {
        name:                   'product_name',
        brand:                  'brand_name',
        description:            'description',
        category:               'category',
        redemptionInstructions: 'how_exchange',
        supplierRef:            'supplier_ref',
        supplierName:           'supplier_name',
        syncEnabled:            'sync_enabled',
      };
      for (const [k, col] of Object.entries(colMap)) {
        if (data[k] !== undefined) { fields.push(`${col} = ?`); params.push(data[k]); }
      }
      if (data.images !== undefined) { fields.push('image_url = ?'); params.push(JSON.stringify(data.images)); }

      if (fields.length) {
        fields.push('updated_by = ?'); params.push(updatedBy);
        params.push(productId);
        await db.query(`UPDATE products SET ${fields.join(', ')} WHERE product_id = ?`, params);
      }

      if (data.price !== undefined) {
        const selling = Math.round(parseFloat(data.price) * 100) / 100;
        const cost    = data.discountPrice ? Math.round(parseFloat(data.discountPrice) * 100) / 100
                       : data.costPrice    ? Math.round(parseFloat(data.costPrice)    * 100) / 100
                       : selling;
        await db.query(`
          UPDATE product_skus
             SET selling_price = ?, cost_price = ?, realtime_price = ?
           WHERE product_id = ? AND is_active = 1
           ORDER BY sku_id LIMIT 1
        `, [selling, cost, data.realtimePrice ? 1 : 0, productId]);
      }

      return this.getById(productId);
    } catch (err) { logger.error('ProductService.update:', err); throw err; }
  }

  async toggleStatus(productId, updatedBy) {
    try {
      await db.query(
        'UPDATE products SET is_active = NOT is_active, updated_by = ? WHERE product_id = ?',
        [updatedBy, productId]
      );
      return this.getById(productId);
    } catch (err) { logger.error('ProductService.toggleStatus:', err); throw err; }
  }

  async delete(productId) {
    try {
      await db.query('DELETE FROM products WHERE product_id = ?', [productId]);
      return { deleted: true };
    } catch (err) { logger.error('ProductService.delete:', err); throw err; }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  CODES — internal products only
  // ══════════════════════════════════════════════════════════════════════════

  async getCodes(productId, { page = 1, limit = 50, status } = {}) {
    try {
      const offset = (page - 1) * limit;
      const sku = await db.queryOne(
        'SELECT sku_id FROM product_skus WHERE product_id = ? AND is_active = 1 ORDER BY sku_id LIMIT 1',
        [productId]
      );
      if (!sku) return { data: [], pagination: { page, limit, total: 0, totalPages: 0 } };

      const conds = ['dc.sku_id = ?'], cp = [sku.sku_id];
      if (status) { conds.push('dc.status = ?'); cp.push(status); }
      const where = `WHERE ${conds.join(' AND ')}`;

      const total = (await db.queryOne(`SELECT COUNT(*) AS n FROM digital_codes dc ${where}`, cp)).n;
      const rows  = await db.query(`
        SELECT dc.code_id, dc.code, dc.status, dc.source, dc.upload_batch,
               dc.created_at, dc.sold_at, dc.reserved_at
          FROM digital_codes dc ${where}
         ORDER BY dc.created_at DESC LIMIT ? OFFSET ?
      `, [...cp, limit, offset]);

      return {
        data:       rows.map(r => ({ ...r, code: decrypt(r.code) })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      };
    } catch (err) { logger.error('ProductService.getCodes:', err); throw err; }
  }
async uploadCodes(productId, entries, uploadedBy, batchName) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
 
      const [prodRows] = await conn.execute(
        'SELECT source FROM products WHERE product_id = ?', [productId]
      );
      if (!prodRows.length) throw new Error('Product not found');
      if (prodRows[0].source !== 'internal') {
        throw new Error('Cannot upload codes to a supplier product — fulfilled in real-time');
      }
 
      const [skuRows] = await conn.execute(
        'SELECT sku_id FROM product_skus WHERE product_id = ? AND is_active = 1 ORDER BY sku_id LIMIT 1',
        [productId]
      );
      if (!skuRows.length) throw new Error('No active SKU found');
      const skuId  = skuRows[0].sku_id;
      const batchId = batchName || `BATCH-${Date.now()}`;
 
      // ── 1. Deduplicate within the batch in memory (instant) ───────────────
      let invalid = 0;
      const seen = new Set();
      const unique = [];
      for (const entry of entries) {
        const code   = String(typeof entry === 'object' ? entry.code : entry).trim();
        const status = (typeof entry === 'object' && entry.status) ? entry.status : 'available';
        if (!code) { invalid++; continue; }
        if (seen.has(code)) continue;
        seen.add(code);
        unique.push({ code, status });
      }
 
      if (unique.length === 0) {
        await conn.rollback();
        return { totalRows: entries.length, validCodes: 0, duplicates: entries.length - invalid, invalidCodes: invalid, uploadedCodes: 0, newAvailable: 0, batchId };
      }
 
      // ── 2. Batch INSERT IGNORE in chunks of 500 ───────────────────────────
      // INSERT IGNORE skips rows that violate the unique key on (sku_id, code).
      // Run: ALTER TABLE digital_codes ADD UNIQUE KEY uq_sku_code (sku_id, code);
      const CHUNK = 500;
      let totalAffected = 0;
      const now = new Date();
 
      for (let i = 0; i < unique.length; i += CHUNK) {
        const chunk        = unique.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '(?,?,?,?,?,?,?,?)').join(',');
        const values       = [];
 
        for (const { code, status } of chunk) {
          values.push(
            skuId,
            encrypt(code),
            status,
            'excel_upload',
            batchId,
            uploadedBy,
            status === 'sold'     ? now : null,
            status === 'reserved' ? now : null,
          );
        }
 
        const [result] = await conn.execute(
          `INSERT IGNORE INTO digital_codes
             (sku_id, code, status, source, upload_batch, created_by, sold_at, reserved_at)
           VALUES ${placeholders}`,
          values
        );
        totalAffected += result.affectedRows;
      }
 
      const inserted   = totalAffected;
      const duplicates = unique.length - inserted;
 
      // ── 3. Count how many newly inserted codes are available ──────────────
      const [[{ newAvailable }]] = await conn.execute(
        `SELECT COUNT(*) AS newAvailable FROM digital_codes
          WHERE sku_id = ? AND upload_batch = ? AND status = 'available'`,
        [skuId, batchId]
      );
 
      // ── 4. Update inventory stock count ──────────────────────────────────
      if (newAvailable > 0) {
        await conn.execute(
          'UPDATE inventory SET stock_quantity = stock_quantity + ? WHERE sku_id = ?',
          [newAvailable, skuId]
        );
      }
 
      await conn.commit();
      return {
        totalRows:     entries.length,
        validCodes:    inserted,
        duplicates,
        invalidCodes:  invalid,
        uploadedCodes: inserted,
        newAvailable,
        batchId,
      };
    } catch (err) {
      await conn.rollback();
      logger.error('ProductService.uploadCodes:', err);
      throw err;
    } finally { conn.release(); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SUPPLIER STOCK CHECK  (stub — replace with real API when ready)
  // ══════════════════════════════════════════════════════════════════════════

  async checkSupplierStock(productId) {
    try {
      const product = await this.getById(productId);
      if (!product) throw new Error('Product not found');
      if (product.source === 'internal') {
        return { available: product.availableCodes > 0, stockLevel: this._stockLevel(product), price: product.price };
      }
      // TODO: Replace with real supplier API call
      // const result = await supplierService.checkStock(product.supplierSkuRef);
      return { available: true, stockLevel: 'live', price: product.price, note: 'Real-time — API not yet connected' };
    } catch (err) { logger.error('ProductService.checkSupplierStock:', err); throw err; }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PRIVATE
  // ══════════════════════════════════════════════════════════════════════════

  _format(row) {
    let images = [];
    if (row.image_url) {
      try { images = JSON.parse(row.image_url); } catch { images = [row.image_url]; }
    }

    const isSupplier     = row.source && row.source !== 'internal';
    const unlimitedStock = parseInt(row.unlimited_stock) === 1;

    const status = row.is_active ? 'active' : 'inactive';

    return {
      id:                     String(row.product_id),
      name:                   row.product_name,
      brand:                  row.brand_name  || '',
      category:               row.category    || '',
      description:            row.description || '',
      redemptionInstructions: row.how_exchange || '',
      price:                  parseFloat(row.price)      || 0,
      costPrice:              parseFloat(row.cost_price) || 0,
      discountPrice:          (row.cost_price && parseFloat(row.cost_price) < parseFloat(row.price))
                                ? parseFloat(row.cost_price) : undefined,
      images,
      status,
      source:                 row.source || 'internal',
      isSupplierProduct:      isSupplier,
      unlimitedStock,
      totalCodes:             isSupplier ? null : parseInt(row.total_codes)     || 0,
      availableCodes:         isSupplier ? null : parseInt(row.available_codes) || 0,
      soldCodes:              isSupplier ? null : parseInt(row.sold_codes)      || 0,
      supplierName:           row.supplier_name   || null,
      supplierRef:            row.supplier_ref    || null,
      supplierSkuRef:         row.supplier_sku_ref|| null,
      syncEnabled:            Boolean(row.sync_enabled),
      realtimePrice:          Boolean(row.realtime_price),
      lastSyncedAt:           row.last_synced_at  || null,
      createdAt:              row.created_at,
      updatedAt:              row.updated_at,
    };
  }

  _stockLevel(product) {
    if (!product.totalCodes || product.totalCodes === 0) return 'out_of_stock';
    const pct = (product.availableCodes / product.totalCodes) * 100;
    if (pct === 0) return 'out_of_stock';
    if (pct < 10)  return 'critical';
    if (pct < 25)  return 'low';
    if (pct < 60)  return 'medium';
    return 'high';
  }
}

module.exports = new ProductService();