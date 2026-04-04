// services/userProduct.service.js
'use strict';

const db     = require('../config/database');
const logger = require('../utils/logger');

// ─── SQL fragment: join products + access + pricing for one user ──────────────
// Logic:
//   visible = NOT EXISTS a 'deny' row in client_product_access for this user+product
//             (absence of row = allowed by default; 'deny' row = hidden)
//   customPrice = client_pricing.custom_price if a row exists, else NULL

const USER_PRODUCT_SELECT = (userId) => `
  SELECT
    p.product_id                                      AS id,
    p.product_name                                    AS name,
    p.category,
    p.brand_name                                      AS brand,
    p.source,
    p.is_active,
    MIN(ps.selling_price)                             AS regularPrice,
    MIN(ps.sku_id)                                    AS primary_sku_id,
    CASE WHEN cpa.access_type = 'deny' THEN 0 ELSE 1 END  AS visible,
    cp.custom_price                                   AS customPrice,
    CASE WHEN cp.custom_price IS NOT NULL THEN 1 ELSE 0 END AS useCustomPrice
  FROM products p
  LEFT JOIN product_skus ps  ON ps.product_id = p.product_id AND ps.is_active = 1
  LEFT JOIN client_product_access cpa
         ON cpa.product_id = p.product_id AND cpa.user_id = ${parseInt(userId)}
  LEFT JOIN client_pricing cp
         ON cp.sku_id = ps.sku_id AND cp.user_id = ${parseInt(userId)}
  WHERE p.is_active = 1
  GROUP BY p.product_id, cpa.access_type, cp.custom_price
  ORDER BY p.product_name ASC
`;

class UserProductService {

  // ══════════════════════════════════════════════════════════════════════════
  //  ADMIN — get product config for a specific user
  // ══════════════════════════════════════════════════════════════════════════

  async getUserProductConfig(userId) {
    try {
      const rows = await db.query(USER_PRODUCT_SELECT(userId));
      return rows.map(this._format);
    } catch (err) {
      logger.error('UserProductService.getUserProductConfig:', err);
      throw err;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  ADMIN — save product config for a user (bulk upsert)
  //  Accepts array of { id, visible, customPrice, useCustomPrice }
  // ══════════════════════════════════════════════════════════════════════════

  async saveUserProductConfig(userId, configs, savedBy) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      for (const cfg of configs) {
        const productId = parseInt(cfg.id);

        // ── Visibility ──────────────────────────────────────────────────────
        if (cfg.visible === false || cfg.visible === 0) {
          // Upsert a 'deny' row
          await conn.execute(`
            INSERT INTO client_product_access (user_id, product_id, access_type, created_by)
            VALUES (?, ?, 'deny', ?)
            ON DUPLICATE KEY UPDATE access_type = 'deny', created_by = ?
          `, [userId, productId, savedBy, savedBy]);
        } else {
          // Remove any deny row → product is visible by default
          await conn.execute(
            'DELETE FROM client_product_access WHERE user_id = ? AND product_id = ?',
            [userId, productId]
          );
        }

        // ── Custom pricing ───────────────────────────────────────────────────
        // Get primary SKU id for this product
        const [skuRows] = await conn.execute(
          'SELECT sku_id FROM product_skus WHERE product_id = ? AND is_active = 1 ORDER BY sku_id LIMIT 1',
          [productId]
        );
        if (!skuRows.length) continue;
        const skuId = skuRows[0].sku_id;

        if (cfg.useCustomPrice && cfg.customPrice != null && parseFloat(cfg.customPrice) > 0) {
          const price = Math.round(parseFloat(cfg.customPrice) * 100) / 100;
          await conn.execute(`
            INSERT INTO client_pricing (user_id, sku_id, custom_price, created_by, updated_at)
            VALUES (?, ?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE custom_price = ?, created_by = ?, updated_at = NOW()
          `, [userId, skuId, price, savedBy, price, savedBy]);
        } else {
          // Remove custom pricing → falls back to regular price
          await conn.execute(
            'DELETE FROM client_pricing WHERE user_id = ? AND sku_id = ?',
            [userId, skuId]
          );
        }
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      logger.error('UserProductService.saveUserProductConfig:', err);
      throw err;
    } finally {
      conn.release();
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  CLIENT PORTAL — get products visible to this user with their prices
  //  Only returns active products that are NOT denied for this user.
  //  Applies custom price if set, otherwise returns regular selling_price.
  // ══════════════════════════════════════════════════════════════════════════

//   async getClientProducts(userId, { search, category, page = 1, limit = 50 } = {}) {
//     try {
//       const offset = (page - 1) * limit;
//       const conds  = [
//         'p.is_active = 1',
//         `NOT EXISTS (
//           SELECT 1 FROM client_product_access cpa2
//           WHERE cpa2.product_id = p.product_id
//             AND cpa2.user_id = ?
//             AND cpa2.access_type = 'deny'
//         )`,
//       ];
//       const params = [parseInt(userId)];
 
//       if (search) {
//         conds.push('(p.product_name LIKE ? OR p.brand_name LIKE ? OR p.category LIKE ?)');
//         params.push(`%${search}%`, `%${search}%`, `%${search}%`);
//       }
//       if (category) {
//         conds.push('p.category = ?');
//         params.push(category);
//       }
 
//       const where = `WHERE ${conds.join(' AND ')}`;
 
//       const sql = `
//         SELECT
//           p.product_id                                        AS id,
//           p.product_name                                      AS name,
//           p.brand_name                                        AS brand,
//           p.category,
//           p.description,
//           p.how_exchange                                      AS redemptionInstructions,
//           p.image_url                                         AS imageUrl,
//           p.source,
//           MIN(ps.selling_price)                               AS regularPrice,
//           MIN(ps.face_value)                                  AS faceValue,
//           COALESCE(MIN(cp.custom_price), MIN(ps.selling_price)) AS price,
//           CASE WHEN MIN(cp.custom_price) IS NOT NULL THEN 1 ELSE 0 END AS hasCustomPrice,
//           COALESCE(MAX(inv.available_qty), 0)                AS availableCodes,
//           MAX(inv.unlimited_stock)                           AS unlimitedStock
//         FROM products p
//         LEFT JOIN product_skus ps ON ps.product_id = p.product_id AND ps.is_active = 1
//         LEFT JOIN client_pricing cp
//                ON cp.sku_id = ps.sku_id AND cp.user_id = ?
//         LEFT JOIN inventory inv ON inv.sku_id = ps.sku_id
//         ${where}
//         GROUP BY p.product_id
//         HAVING (unlimitedStock = 1 OR availableCodes > 0 OR p.source != 'internal')
//         ORDER BY p.product_name ASC
//         LIMIT ? OFFSET ?
//       `;
 
//       // Count query (no HAVING needed — just accessible products)
//       const countSql = `
//         SELECT COUNT(DISTINCT p.product_id) AS n
//         FROM products p
//         ${where}
//       `;
 
//       const rows     = await db.query(sql,      [parseInt(userId), ...params, parseInt(limit), offset]);
//       const countRow = await db.queryOne(countSql, params);
 
//       return {
//         data: rows.map(r => this._formatClient(r)),
//         pagination: {
//           page:       parseInt(page),
//           limit:      parseInt(limit),
//           total:      countRow.n,
//           totalPages: Math.ceil(countRow.n / limit),
//         },
//       };
//     } catch (err) {
//       logger.error('UserProductService.getClientProducts:', err);
//       throw err;
//     }
//   }
async getClientProducts(userId, { search, category, page = 1, limit = 50 } = {}) {
    try {
      const uid    = parseInt(userId);
      const offset = (page - 1) * limit;
 
      // Build WHERE conditions — params must match ? placeholders in order
      const conds  = ['p.is_active = 1'];
      const params = [];
 
      // NOT EXISTS deny check — 1st ?
      conds.push(`NOT EXISTS (
          SELECT 1 FROM client_product_access cpa2
          WHERE cpa2.product_id = p.product_id
            AND cpa2.user_id = ?
            AND cpa2.access_type = 'deny'
        )`);
      params.push(uid);
 
      if (search) {
        conds.push('(p.product_name LIKE ? OR p.brand_name LIKE ? OR p.category LIKE ?)');
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }
      if (category) {
        conds.push('p.category = ?');
        params.push(category);
      }
 
      const where = `WHERE ${conds.join(' AND ')}`;
 
      const sql = `
        SELECT
          p.product_id                                          AS id,
          p.product_name                                        AS name,
          p.brand_name                                          AS brand,
          p.category,
          p.description,
          p.how_exchange                                        AS redemptionInstructions,
          p.image_url                                           AS imageUrl,
          p.source,
          MIN(ps.selling_price)                                 AS regularPrice,
          MIN(ps.face_value)                                    AS faceValue,
          COALESCE(MIN(cp.custom_price), MIN(ps.selling_price)) AS price,
          CASE WHEN MIN(cp.custom_price) IS NOT NULL THEN 1 ELSE 0 END AS hasCustomPrice,
          COALESCE(MAX(inv.available_qty), 0)                  AS availableCodes,
          MAX(inv.unlimited_stock)                             AS unlimitedStock
        FROM products p
        LEFT JOIN product_skus ps ON ps.product_id = p.product_id AND ps.is_active = 1
        LEFT JOIN client_pricing cp ON cp.sku_id = ps.sku_id AND cp.user_id = ?
        LEFT JOIN inventory inv ON inv.sku_id = ps.sku_id
        ${where}
        GROUP BY p.product_id
        ORDER BY p.product_name ASC
        LIMIT ? OFFSET ?
      `;
 
      // client_pricing join ? comes after the WHERE params
      const sqlParams = [uid, ...params, parseInt(limit), offset];
 
      const countSql = `
        SELECT COUNT(DISTINCT p.product_id) AS n
        FROM products p
        ${where}
      `;
 
      const rows     = await db.query(sql, sqlParams);
      const countRow = await db.queryOne(countSql, params);
 
      return {
        data: rows.map(r => this._formatClient(r)),
        pagination: {
          page:       parseInt(page),
          limit:      parseInt(limit),
          total:      countRow.n,
          totalPages: Math.ceil(countRow.n / limit),
        },
      };
    } catch (err) {
      logger.error('UserProductService.getClientProducts:', err);
      throw err;
    }
  }clear

  // ─── Private formatters ───────────────────────────────────────────────────

  _format(row) {
    return {
      id:             String(row.id),
      name:           row.name           || '',
      category:       row.category       || '',
      brand:          row.brand          || '',
      source:         row.source         || 'internal',
      regularPrice:   parseFloat(row.regularPrice) || 0,
      visible:        row.visible === 1 || row.visible === true,
      customPrice:    row.customPrice != null ? parseFloat(row.customPrice) : undefined,
      useCustomPrice: row.useCustomPrice === 1 || row.useCustomPrice === true,
    };
  }

  _formatClient(row) {
    let images = [];
    if (row.imageUrl) {
      try { images = JSON.parse(row.imageUrl); } catch { images = [row.imageUrl]; }
    }
    return {
      id:                     String(row.id),
      name:                   row.name || '',
      brand:                  row.brand || '',
      category:               row.category || '',
      description:            row.description || '',
      redemptionInstructions: row.redemptionInstructions || '',
      images,
      price:                  parseFloat(row.price)        || 0,
      regularPrice:           parseFloat(row.regularPrice) || 0,
      hasCustomPrice:         row.hasCustomPrice === 1,
      source:                 row.source || 'internal',
      availableCodes:         row.source === 'internal' ? parseInt(row.availableCodes) || 0 : null,
      unlimitedStock:         Boolean(row.unlimitedStock),
    };
  }
}

module.exports = new UserProductService();