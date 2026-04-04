// controllers/product.controller.js
'use strict';

const productService = require('../services/product.service');
const auditService   = require('../services/audit.service');
const logger         = require('../utils/logger');
const XLSX           = require('xlsx');

class ProductController {

  // ─── GET /products ─────────────────────────────────────────────────────────
  async getAll(req, res, next) {
    try {
      const { page = 1, limit = 20, search, category, brand, status, source } = req.query;
      const result = await productService.getAll({
        page: parseInt(page), limit: parseInt(limit),
        search, category, brand, status, source,
      });
      res.json({ success: true, ...result });
    } catch (err) { next(err); }
  }

  // ─── GET /products/meta ────────────────────────────────────────────────────
  async getMeta(req, res, next) {
    try {
      const [categories, brands] = await Promise.all([
        productService.getCategories(),
        productService.getBrands(),
      ]);
      res.json({ success: true, data: { categories, brands } });
    } catch (err) { next(err); }
  }

  // ─── GET /products/:id ─────────────────────────────────────────────────────
  async getById(req, res, next) {
    try {
      const product = await productService.getById(parseInt(req.params.id));
      if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
      res.json({ success: true, data: product });
    } catch (err) { next(err); }
  }

  // ─── POST /products/internal ───────────────────────────────────────────────
  // Creates an internal product — manually managed codes
  async createInternal(req, res, next) {
    try {
      const product = await productService.createInternal(req.body, req.user.user_id);

      await auditService.log({
        user_id:     req.user.user_id,
        action:      'product_created',
        entity_type: 'product',
        entity_id:   product.id,
        new_values:  { name: product.name, source: 'internal', category: product.category },
        ip_address:  req.ip,
        user_agent:  req.get('User-Agent'),
      });

      res.status(201).json({ success: true, data: product, message: 'Internal product created successfully' });
    } catch (err) { next(err); }
  }

  // ─── POST /products/supplier ───────────────────────────────────────────────
  // Creates a supplier product — codes fulfilled in real-time via supplier API
  async createSupplier(req, res, next) {
    try {
      const product = await productService.createSupplier(req.body, req.user.user_id);

      await auditService.log({
        user_id:     req.user.user_id,
        action:      'product_created',
        entity_type: 'product',
        entity_id:   product.id,
        new_values:  {
          name:         product.name,
          source:       product.source,
          supplierName: product.supplierName,
          supplierRef:  product.supplierRef,
        },
        ip_address:  req.ip,
        user_agent:  req.get('User-Agent'),
      });

      res.status(201).json({ success: true, data: product, message: 'Supplier product created successfully' });
    } catch (err) { next(err); }
  }

  // ─── PUT /products/:id ────────────────────────────────────────────────────
  async update(req, res, next) {
    try {
      const existing = await productService.getById(parseInt(req.params.id));
      if (!existing) return res.status(404).json({ success: false, message: 'Product not found' });

      const updated = await productService.update(parseInt(req.params.id), req.body, req.user.user_id);

      await auditService.log({
        user_id:     req.user.user_id,
        action:      'product_updated',
        entity_type: 'product',
        entity_id:   req.params.id,
        old_values:  { name: existing.name, price: existing.price },
        new_values:  { name: updated.name,  price: updated.price  },
        ip_address:  req.ip,
        user_agent:  req.get('User-Agent'),
      });

      res.json({ success: true, data: updated, message: 'Product updated successfully' });
    } catch (err) { next(err); }
  }

  // ─── PATCH /products/:id/toggle-status ────────────────────────────────────
  async toggleStatus(req, res, next) {
    try {
      const existing = await productService.getById(parseInt(req.params.id));
      if (!existing) return res.status(404).json({ success: false, message: 'Product not found' });

      const updated = await productService.toggleStatus(parseInt(req.params.id), req.user.user_id);

      await auditService.log({
        user_id:     req.user.user_id,
        action:      'product_status_toggled',
        entity_type: 'product',
        entity_id:   req.params.id,
        old_values:  { status: existing.status },
        new_values:  { status: updated.status  },
        ip_address:  req.ip,
        user_agent:  req.get('User-Agent'),
      });

      res.json({ success: true, data: updated, message: `Product ${updated.status === 'active' ? 'activated' : 'deactivated'}` });
    } catch (err) { next(err); }
  }

  // ─── DELETE /products/:id ─────────────────────────────────────────────────
  async delete(req, res, next) {
    try {
      const existing = await productService.getById(parseInt(req.params.id));
      if (!existing) return res.status(404).json({ success: false, message: 'Product not found' });

      await productService.delete(parseInt(req.params.id));

      await auditService.log({
        user_id:     req.user.user_id,
        action:      'product_deleted',
        entity_type: 'product',
        entity_id:   req.params.id,
        old_values:  { name: existing.name, source: existing.source },
        ip_address:  req.ip,
        user_agent:  req.get('User-Agent'),
      });

      res.json({ success: true, message: 'Product deleted successfully' });
    } catch (err) { next(err); }
  }

  // ─── GET /products/:id/codes ──────────────────────────────────────────────
  // Only available for internal products
  async getCodes(req, res, next) {
    try {
      const product = await productService.getById(parseInt(req.params.id));
      if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
      if (product.isSupplierProduct) {
        return res.status(400).json({
          success: false,
          message: 'This is a supplier product. Codes are fulfilled in real-time — no stored codes.',
          isSupplierProduct: true,
        });
      }

      const { page = 1, limit = 50, status } = req.query;
      const result = await productService.getCodes(parseInt(req.params.id), {
        page: parseInt(page), limit: parseInt(limit), status,
      });
      res.json({ success: true, ...result });
    } catch (err) { next(err); }
  }
// ─── POST /products/:id/upload-codes-json ─────────────────────────────────
  // Accepts pre-parsed [{code, status}] array from the frontend.
  // No file upload — no file size limit.
  async uploadCodesJson(req, res, next) {
    try {
      const product = await productService.getById(parseInt(req.params.id));
      if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
      if (product.isSupplierProduct) {
        return res.status(400).json({
          success: false,
          message: 'Cannot upload codes to a supplier product — codes are fulfilled in real-time.',
          isSupplierProduct: true,
        });
      }
 
      const { entries, fileName } = req.body;
      if (!Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ success: false, message: 'entries array is required' });
      }
 
      const batchName = `BATCH-${Date.now()}-${(fileName || 'upload').replace(/\s/g, '_')}`;
      const summary   = await productService.uploadCodes(
        parseInt(req.params.id), entries, req.user.user_id, batchName
      );
 
      await auditService.log({
        user_id:     req.user.user_id,
        action:      'codes_uploaded',
        entity_type: 'product',
        entity_id:   req.params.id,
        new_values:  { ...summary, fileName: fileName || 'upload' },
        ip_address:  req.ip,
        user_agent:  req.get('User-Agent'),
      });
 
      res.json({
        success: true,
        data:    { ...summary, fileName: fileName || 'upload' },
        message: `Successfully uploaded ${summary.uploadedCodes} codes`,
      });
    } catch (err) { next(err); }
  }
  // ─── POST /products/:id/upload-codes ──────────────────────────────────────
  // Only available for internal products
  async uploadCodes(req, res, next) {
    try {
      // Pre-check product type before touching the file
      const product = await productService.getById(parseInt(req.params.id));
      if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
      if (product.isSupplierProduct) {
        return res.status(400).json({
          success: false,
          message: 'Cannot upload codes to a supplier product — codes are fulfilled in real-time via the supplier API.',
          isSupplierProduct: true,
        });
      }

      if (!req.file) return res.status(400).json({ success: false, message: 'Excel file is required' });

      const workbook  = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet     = workbook.Sheets[workbook.SheetNames[0]];
      const rows      = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      const codes     = rows
        .map(r => Array.isArray(r) ? r[0] : r)
        .filter(v => v !== null && v !== undefined && String(v).trim() !== '');

      if (!codes.length) {
        return res.status(400).json({ success: false, message: 'No valid codes found in the Excel file' });
      }

      const batchName = `BATCH-${Date.now()}-${req.file.originalname.replace(/\s/g, '_')}`;
      const summary   = await productService.uploadCodes(
        parseInt(req.params.id), codes, req.user.user_id, batchName
      );

      await auditService.log({
        user_id:     req.user.user_id,
        action:      'codes_uploaded',
        entity_type: 'product',
        entity_id:   req.params.id,
        new_values:  { ...summary, fileName: req.file.originalname },
        ip_address:  req.ip,
        user_agent:  req.get('User-Agent'),
      });

      res.json({
        success: true,
        data:    { ...summary, fileName: req.file.originalname, processingTime: 0 },
        message: `Successfully uploaded ${summary.uploadedCodes} codes`,
      });
    } catch (err) { next(err); }
  }
// ─── POST /products/import-excel ──────────────────────────────────────────
  // Parses uploaded Excel file, returns structured preview rows — no DB writes.
  async importExcelPreview(req, res, next) {
    try {
      if (!req.file) return res.status(400).json({ success: false, message: 'Excel file is required' });
 
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const ws       = workbook.Sheets[workbook.SheetNames[0]];
      const raw      = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
 
      if (raw.length < 2) {
        return res.status(400).json({ success: false, message: 'File appears to be empty or has no data rows' });
      }
 
      // Auto-detect header row (first row containing "product name")
      let headerIdx = 0;
      for (let i = 0; i < Math.min(5, raw.length); i++) {
        if (raw[i].some(c => String(c).trim().toLowerCase() === 'product name')) {
          headerIdx = i; break;
        }
      }
 
      const headers = raw[headerIdx].map(h => String(h).trim().toLowerCase());
      const col = (...names) => {
        for (const n of names) {
          const i = headers.findIndex(h => h.includes(n));
          if (i !== -1) return i;
        }
        return -1;
      };
 
      const nameCol     = col('product name');
      const typeCol     = col('product type', 'type');
      const categoryCol = col('category');
      const currencyCol = col('currency');
      const brandCol    = col('brand');
      const priceCol    = col('price');
      const descCol     = col('description', 'desc');
 
      if (nameCol === -1) {
        return res.status(400).json({ success: false, message: "Could not find a 'Product Name' column in the file" });
      }
 
      const rows = [];
      for (let r = headerIdx + 1; r < raw.length; r++) {
        const row  = raw[r];
        const name = String(row[nameCol] ?? '').trim();
        if (!name) continue;
 
        const rawPrice   = priceCol !== -1 ? row[priceCol] : '';
        const parsedPrice = parseFloat(String(rawPrice).replace(/[^0-9.]/g, ''));
 
        rows.push({
          name,
          productType:            typeCol     !== -1 ? String(row[typeCol]     ?? '').trim() : '',
          category:               categoryCol !== -1 ? String(row[categoryCol] ?? '').trim() : '',
          currency:               currencyCol !== -1 ? String(row[currencyCol] ?? '').trim() : '',
          brand:                  brandCol    !== -1 ? String(row[brandCol]    ?? '').trim() : '',
          price:                  isNaN(parsedPrice)  ? 0 : Math.round(parsedPrice * 100) / 100,
          description:            descCol     !== -1 ? String(row[descCol]     ?? '').trim() : '',
          redemptionInstructions: '',
          images:                 [],
        });
      }
 
      if (!rows.length) {
        return res.status(400).json({ success: false, message: 'No valid product rows found in the file' });
      }
 
      res.json({ success: true, data: rows, total: rows.length, fileName: req.file.originalname });
    } catch (err) { next(err); }
  }
 
  // ─── POST /products/import-bulk ────────────────────────────────────────────
  // Accepts parsed row array, creates each as an internal inactive product.
  // Returns per-row results so the frontend can show which succeeded/failed.
  async importBulk(req, res, next) {
    try {
      const { rows } = req.body;
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ success: false, message: 'rows array is required' });
      }
 
      const results = [];
      for (const row of rows) {
        try {
          const product = await productService.createInternal({
            name:                   String(row.name   || '').trim(),
            category:               String(row.category    || '').trim() || 'Uncategorized',
            brand:                  String(row.brand       || row.productType || '').trim(),
            description:            String(row.description || '').trim(),
            redemptionInstructions: '',
            price:                  typeof row.price === 'number' ? row.price : 0,
            images:                 [],
          }, req.user.user_id);
          results.push({ name: row.name, ok: true, id: product.id });
        } catch (err) {
          results.push({ name: row.name, ok: false, error: err.message || 'Failed to create product' });
        }
      }
 
      const imported = results.filter(r => r.ok).length;
      const failed   = results.filter(r => !r.ok).length;
 
      await auditService.log({
        user_id:     req.user.user_id,
        action:      'products_bulk_imported',
        entity_type: 'product',
        entity_id:   null,
        new_values:  { imported, failed, total: rows.length },
        ip_address:  req.ip,
        user_agent:  req.get('User-Agent'),
      });
 
      res.json({ success: true, data: { results, imported, failed, total: rows.length } });
    } catch (err) { next(err); }
  }
 
 
  // Only available for internal products
  async getCodes(req, res, next) {
    try {
      const product = await productService.getById(parseInt(req.params.id));
      if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
      if (product.isSupplierProduct) {
        return res.status(400).json({
          success: false,
          message: 'This is a supplier product. Codes are fulfilled in real-time — no stored codes.',
          isSupplierProduct: true,
        });
      }
 
      const { page = 1, limit = 50, status } = req.query;
      const result = await productService.getCodes(parseInt(req.params.id), {
        page: parseInt(page), limit: parseInt(limit), status,
      });
      res.json({ success: true, ...result });
    } catch (err) { next(err); }
  }
  // ─── GET /products/:id/stock-check ────────────────────────────────────────
  // For supplier products: returns real-time availability (stub for now)
  // For internal products: returns local inventory status
  async stockCheck(req, res, next) {
    try {
      const result = await productService.checkSupplierStock(parseInt(req.params.id));
      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  }
}

module.exports = new ProductController();
