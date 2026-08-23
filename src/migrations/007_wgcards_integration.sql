-- ============================================
-- Migration: 007_wgcards_integration.sql
-- Run this ONCE against an already-provisioned database (one that already
-- ran 000_full_schema.sql before this migration existed — e.g. uat/prod).
-- A brand-new database created from the current 000_full_schema.sql already
-- has all of this and does not need this file.
--
-- What it does:
--   1. Renames the "carrypin" naming (an earlier internal name for the same
--      vendor) to "wgcards" across columns/enums, preserving existing data.
--   2. Adds gift2games as a future enum value (inactive — no live calls yet).
--   3. Adds circuit-breaker / balance columns to supplier_config (Flow A/G).
--   4. Adds product_skus.needs_review (default-margin pricing flag).
--   5. Creates wgcards_topup_orders (Flow F) and system_settings.
-- ============================================

USE cardcove_db;

-- ─── 1. products.source enum + existing data ──────────────────────────────
ALTER TABLE products
  MODIFY COLUMN source ENUM('internal', 'carrypin', 'wgcards', 'gift2games') NOT NULL DEFAULT 'internal';
UPDATE products SET source = 'wgcards' WHERE source = 'carrypin';
ALTER TABLE products
  MODIFY COLUMN source ENUM('internal', 'wgcards', 'gift2games') NOT NULL DEFAULT 'internal';

-- ─── 2. product_skus: rename carrypin_sku_id -> wgcards_sku_id ─────────────
ALTER TABLE product_skus
  CHANGE COLUMN carrypin_sku_id wgcards_sku_id VARCHAR(100) NULL COMMENT 'WgCards SKU ID (itemId/skuId)';
ALTER TABLE product_skus
  DROP INDEX idx_carrypin_sku_id,
  ADD INDEX idx_wgcards_sku_id (wgcards_sku_id);
ALTER TABLE product_skus
  ADD COLUMN needs_review BOOLEAN NOT NULL DEFAULT FALSE
    COMMENT 'selling_price was auto-set via default margin on first sync — admin has not confirmed it yet'
    AFTER margin_percent;

-- ─── 3. digital_codes.source enum + existing data ──────────────────────────
ALTER TABLE digital_codes
  MODIFY COLUMN source ENUM('manual', 'excel_upload', 'carrypin_api', 'wgcards_api', 'gift2games_api') NOT NULL DEFAULT 'manual';
UPDATE digital_codes SET source = 'wgcards_api' WHERE source = 'carrypin_api';
ALTER TABLE digital_codes
  MODIFY COLUMN source ENUM('manual', 'excel_upload', 'wgcards_api', 'gift2games_api') NOT NULL DEFAULT 'manual';

-- ─── 4. orders: rename carrypin_order_id -> wgcards_order_id ───────────────
ALTER TABLE orders
  CHANGE COLUMN carrypin_order_id wgcards_order_id VARCHAR(100) NULL COMMENT 'Supplier order reference (serviceOrder/orderId)';
ALTER TABLE orders
  DROP INDEX idx_carrypin_order_id,
  ADD INDEX idx_wgcards_order_id (wgcards_order_id);

-- ─── 5. api_logs: rename carrypin_request/response, add supplier_name ──────
ALTER TABLE api_logs
  CHANGE COLUMN carrypin_request  supplier_request  TEXT NULL COMMENT 'ENCRYPTED — raw request payload sent to supplier',
  CHANGE COLUMN carrypin_response supplier_response TEXT NULL COMMENT 'ENCRYPTED — raw response payload received from supplier',
  ADD COLUMN supplier_name VARCHAR(50) NULL COMMENT 'wgcards | gift2games' AFTER response_time,
  ADD INDEX idx_supplier_name (supplier_name);

-- ─── 6. supplier_config: circuit breaker + balance columns ─────────────────
ALTER TABLE supplier_config
  ADD COLUMN consecutive_failures INT NOT NULL DEFAULT 0
    COMMENT 'Flow A/G circuit breaker — resets on any success' AFTER last_sync,
  ADD COLUMN integration_status ENUM('healthy', 'down') NOT NULL DEFAULT 'healthy'
    COMMENT 'down = 3 consecutive auth/balance failures; products from this supplier show temporarily unavailable'
    AFTER consecutive_failures,
  ADD COLUMN down_since DATETIME NULL AFTER integration_status,
  ADD COLUMN balance DECIMAL(15,2) NULL COMMENT 'Last known balance from Flow G getAccount/check_balance' AFTER down_since,
  ADD COLUMN balance_currency VARCHAR(3) NULL AFTER balance,
  ADD COLUMN balance_checked_at DATETIME NULL AFTER balance_currency,
  ADD COLUMN low_balance_threshold DECIMAL(15,2) NULL COMMENT 'Alert admin when balance drops below this' AFTER balance_checked_at;

ALTER TABLE supplier_config
  ADD UNIQUE INDEX idx_supplier_name_uq (supplier_name);

-- ─── 7. New tables ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wgcards_topup_orders (
    topup_order_id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL COMMENT 'Client who placed the top-up',
    sku_id INT NOT NULL,
    order_reference VARCHAR(100) NOT NULL COMMENT 'Our UUID — WgCards echoes it back',
    wgcards_order_id VARCHAR(100) NULL COMMENT 'Supplier orderId once placeDirectOrder responds',
    target_account VARCHAR(255) NOT NULL COMMENT 'Phone/account number being topped up',
    amount DECIMAL(15,2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    status ENUM('pending', 'confirmed', 'failed', 'cancelled') NOT NULL DEFAULT 'pending',
    webhook_status TINYINT NULL COMMENT 'Raw 0/1/2 from WgCards webhook payload, if received',
    webhook_received_at DATETIME NULL,
    webhook_attempts INT NOT NULL DEFAULT 0 COMMENT 'WgCards retries up to 5x within 30 min',
    resolved_via ENUM('webhook', 'reconciler') NULL,
    last_payload JSON NULL COMMENT 'Most recent webhook or reconciler poll payload, for support debugging',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    resolved_at DATETIME NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (sku_id) REFERENCES product_skus(sku_id),
    UNIQUE INDEX idx_order_reference (order_reference),
    INDEX idx_wgcards_order_id (wgcards_order_id),
    INDEX idx_status (status),
    INDEX idx_user_id (user_id),
    INDEX idx_status_created (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS system_settings (
    setting_key VARCHAR(100) PRIMARY KEY,
    setting_value VARCHAR(500) NOT NULL,
    description VARCHAR(255) NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by INT NULL,
    FOREIGN KEY (updated_by) REFERENCES users(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO system_settings (setting_key, setting_value, description) VALUES
('default_margin_percent', '20', 'Applied to cost_price for a newly-synced SKU with no selling_price yet')
ON DUPLICATE KEY UPDATE setting_key = setting_key;

SELECT 'Migration 007 (WgCards rename + Flow F) completed successfully!' AS status;
