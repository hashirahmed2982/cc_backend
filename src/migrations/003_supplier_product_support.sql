-- ============================================
-- Migration: 003_supplier_product_support.sql
-- Adds supplier product fields to support
-- internal (code upload) vs supplier (real-time API) products
-- ============================================

USE cardcove_db;

-- ─── 1. Add supplier fields to products table ─────────────────────────────────
ALTER TABLE products
  ADD COLUMN supplier_name   VARCHAR(100)  NULL  COMMENT 'e.g. carrypin'              AFTER source,
  ADD COLUMN supplier_ref    VARCHAR(100)  NULL  COMMENT 'Supplier SPU/product ID'    AFTER supplier_name,
  ADD COLUMN sync_enabled    BOOLEAN       NOT NULL DEFAULT FALSE
                                                   COMMENT 'Auto-sync price/stock'    AFTER supplier_ref,
  ADD COLUMN last_synced_at  DATETIME      NULL   COMMENT 'Last supplier sync'        AFTER sync_enabled;

-- ─── 2. Add supplier fields to product_skus table ────────────────────────────
ALTER TABLE product_skus
  ADD COLUMN supplier_sku_ref   VARCHAR(100) NULL COMMENT 'Supplier SKU/denomination ID' AFTER carrypin_sku_id,
  ADD COLUMN realtime_price     BOOLEAN      NOT NULL DEFAULT FALSE
                                                      COMMENT 'Fetch price live from supplier' AFTER supplier_sku_ref,
  ADD COLUMN face_value_display VARCHAR(50)  NULL COMMENT 'Display label e.g. $50'    AFTER realtime_price;

-- ─── 3. Add source flag to digital_codes (already has source col) ─────────────
-- digital_codes.source already supports: 'manual','excel_upload','carrypin_api' ✓

-- ─── 4. inventory.unlimited_stock already exists ──────────────────────────────
-- When source='carrypin': unlimited_stock=TRUE, stock_quantity not tracked ✓

-- ─── 5. Add index for supplier lookups ────────────────────────────────────────
ALTER TABLE products
  ADD INDEX idx_source         (source),
  ADD INDEX idx_supplier_name  (supplier_name),
  ADD INDEX idx_supplier_ref   (supplier_ref);

ALTER TABLE product_skus
  ADD INDEX idx_supplier_sku_ref (supplier_sku_ref);

SELECT 'Migration 003 completed successfully!' AS status;
