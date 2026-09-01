-- 012_multi_supplier_framework.sql
-- Incremental migration for the already-provisioned uat DB — Master Plan
-- §9/§10 multi-supplier normalization framework, ahead of Gift2Games.
-- Purely additive: nothing here changes how WgCards currently behaves —
-- see scripts/backfill-sku-supplier-links.js for the one-time backfill
-- that gives every existing WgCards-linked SKU its sku_supplier_links row.

ALTER TABLE order_details
    ADD COLUMN fulfillment_supplier VARCHAR(50) NULL
        COMMENT 'Which supplier ultimately fulfilled (or is currently attempting) this line — wgcards | gift2games | internal'
        AFTER wgcards_order_id,
    ADD COLUMN fulfillment_attempts JSON NULL
        COMMENT 'Master Plan §10.7 — full cross-supplier attempt history: [{supplier, serviceOrder, attemptedAt, result, reason}], oldest first'
        AFTER fulfillment_supplier;

CREATE TABLE IF NOT EXISTS sku_supplier_links (
    link_id INT PRIMARY KEY AUTO_INCREMENT,
    sku_id INT NOT NULL,
    supplier VARCHAR(50) NOT NULL,
    supplier_ref VARCHAR(100) NULL,
    supplier_sku_ref VARCHAR(100) NOT NULL,
    cost_price DECIMAL(10,2) NOT NULL,
    cost_currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    cost_price_base_currency DECIMAL(10,2) NULL,
    fx_rate_used DECIMAL(12,6) NULL,
    fx_rate_at DATETIME NULL,
    stock_status ENUM('in_stock', 'out_of_stock', 'unknown') NOT NULL DEFAULT 'unknown',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    admin_priority_override ENUM('always_prefer', 'never_use') NULL,
    last_synced_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (sku_id) REFERENCES product_skus(sku_id) ON DELETE CASCADE,
    UNIQUE INDEX idx_supplier_sku_ref (supplier, supplier_sku_ref),
    INDEX idx_sku_id (sku_id),
    INDEX idx_supplier (supplier),
    INDEX idx_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS brand_aliases (
    alias_id INT PRIMARY KEY AUTO_INCREMENT,
    alias VARCHAR(255) NOT NULL,
    canonical_brand VARCHAR(255) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE INDEX idx_alias (alias)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS supplier_catalog_items (
    staging_id INT PRIMARY KEY AUTO_INCREMENT,
    supplier VARCHAR(50) NOT NULL,
    supplier_ref VARCHAR(100) NULL,
    supplier_sku_ref VARCHAR(100) NOT NULL,
    item_name VARCHAR(255) NOT NULL,
    brand_name VARCHAR(255) NULL,
    face_value DECIMAL(10,2) NULL,
    currency VARCHAR(3) NULL,
    region VARCHAR(50) NULL,
    cost_price DECIMAL(10,2) NULL,
    match_key VARCHAR(255) NULL,
    suggested_sku_id INT NULL,
    status ENUM('pending_review', 'linked', 'created_new', 'rejected', 'ignored') NOT NULL DEFAULT 'pending_review',
    reviewed_by INT NULL,
    reviewed_at DATETIME NULL,
    raw_payload JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (suggested_sku_id) REFERENCES product_skus(sku_id) ON DELETE SET NULL,
    FOREIGN KEY (reviewed_by) REFERENCES users(user_id) ON DELETE SET NULL,
    UNIQUE INDEX idx_supplier_item (supplier, supplier_sku_ref),
    INDEX idx_status (status),
    INDEX idx_match_key (match_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
