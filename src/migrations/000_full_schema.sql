-- ============================================
-- Card Cove B2B Portal — Full Database Schema
-- Single-file migration (001 → 005 combined)
-- ============================================

-- Drop existing database if exists (CAUTION: development only)
-- DROP DATABASE IF EXISTS cardcove_db;

CREATE DATABASE IF NOT EXISTS cardcove_db
CHARACTER SET utf8mb4
COLLATE utf8mb4_unicode_ci;

USE cardcove_db;

-- ============================================
-- 1. ROLES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS roles (
    role_id INT PRIMARY KEY AUTO_INCREMENT,
    role_name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT NULL,
    permissions JSON NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_role_name (role_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 2. USERS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS users (
    user_id INT PRIMARY KEY AUTO_INCREMENT,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    phone VARCHAR(20) NULL,
    company_name VARCHAR(255) NULL,
    role_id INT NOT NULL DEFAULT 3,
    user_type ENUM('super_admin','admin','b2b_client','viewer') NOT NULL DEFAULT 'b2b_client',
    status ENUM('active','inactive','locked','permanently_blocked','deleted') NOT NULL DEFAULT 'active',
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    mfa_secret VARCHAR(255) NULL,
    failed_login_attempts INT NOT NULL DEFAULT 0,
    locked_until DATETIME NULL,
    lock_reason TEXT NULL,
    last_login DATETIME NULL,
    password_reset_token VARCHAR(255) NULL,
    password_reset_expires DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (role_id) REFERENCES roles(role_id),
    INDEX idx_email (email),
    INDEX idx_role_id (role_id),
    INDEX idx_user_type (user_type),
    INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 3. VIEWER ACCOUNTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS viewer_accounts (
    id INT PRIMARY KEY AUTO_INCREMENT,
    viewer_user_id INT NOT NULL,
    b2b_client_id INT NOT NULL,
    permissions JSON NULL,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (viewer_user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (b2b_client_id) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL,
    UNIQUE KEY unique_viewer_client (viewer_user_id, b2b_client_id),
    INDEX idx_viewer_user_id (viewer_user_id),
    INDEX idx_b2b_client_id (b2b_client_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 4. SESSIONS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS sessions (
    session_id VARCHAR(255) PRIMARY KEY,
    user_id INT NOT NULL,
    token_hash VARCHAR(255) NOT NULL,
    refresh_token_hash VARCHAR(255) NULL,
    ip_address VARCHAR(45) NULL,
    user_agent TEXT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    INDEX idx_user_id (user_id),
    INDEX idx_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 5. WALLETS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS wallets (
    wallet_id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL UNIQUE,
    balance DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    status ENUM('active','frozen','closed') NOT NULL DEFAULT 'active',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    INDEX idx_user_id (user_id),
    CONSTRAINT chk_balance CHECK (balance >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 6. TOPUP REQUESTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS topup_requests (
    request_id    INT PRIMARY KEY AUTO_INCREMENT,
    user_id       INT NOT NULL,
    wallet_id     INT NOT NULL,
    amount        DECIMAL(15,2) NOT NULL,
    currency      VARCHAR(3) NOT NULL DEFAULT 'USD',
    receipt_url   VARCHAR(1000) NULL COMMENT 'Uploaded receipt image/PDF',
    status        ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    rejection_reason TEXT NULL,
    reviewed_by   INT NULL,
    reviewed_at   DATETIME NULL,
    notes         TEXT NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id)     REFERENCES users(user_id)    ON DELETE CASCADE,
    FOREIGN KEY (wallet_id)   REFERENCES wallets(wallet_id) ON DELETE CASCADE,
    FOREIGN KEY (reviewed_by) REFERENCES users(user_id)    ON DELETE SET NULL,
    INDEX idx_user_id    (user_id),
    INDEX idx_wallet_id  (wallet_id),
    INDEX idx_status     (status),
    INDEX idx_created_at (created_at),
    CONSTRAINT chk_topup_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 7. WALLET TRANSACTIONS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS wallet_transactions (
    transaction_id INT PRIMARY KEY AUTO_INCREMENT,
    wallet_id INT NOT NULL,
    user_id INT NOT NULL,
    transaction_type ENUM('credit','debit') NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    balance_before DECIMAL(15,2) NOT NULL,
    balance_after DECIMAL(15,2) NOT NULL,
    description TEXT NULL,
    reference_type VARCHAR(50) NULL,
    reference_id VARCHAR(100) NULL,
    payment_method VARCHAR(50) NULL,
    payment_ref VARCHAR(255) NULL,
    processed_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (wallet_id)    REFERENCES wallets(wallet_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)      REFERENCES users(user_id)     ON DELETE CASCADE,
    FOREIGN KEY (processed_by) REFERENCES users(user_id)     ON DELETE SET NULL,
    INDEX idx_wallet_id      (wallet_id),
    INDEX idx_user_id        (user_id),
    INDEX idx_reference_type (reference_type),
    INDEX idx_created_at     (created_at),
    CONSTRAINT chk_txn_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 8. PRODUCTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS products (
    product_id INT PRIMARY KEY AUTO_INCREMENT,
    spu_id VARCHAR(100) NULL COMMENT 'CarryPin SPU ID',
    product_name VARCHAR(255) NOT NULL,
    brand_name VARCHAR(255) NULL,
    description TEXT NULL,
    category VARCHAR(100) NULL,
    product_type ENUM('game','gift_card','subscription','other') NOT NULL DEFAULT 'gift_card',
    spu_type INT NULL,
    region VARCHAR(50) NULL,
    currency_code VARCHAR(3) NOT NULL DEFAULT 'USD',
    image_url VARCHAR(500) NULL,
    how_exchange TEXT NULL COMMENT 'Redemption instructions',
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    source ENUM('internal','carrypin') NOT NULL DEFAULT 'internal',
    supplier_name   VARCHAR(100) NULL  COMMENT 'e.g. carrypin',
    supplier_ref    VARCHAR(100) NULL  COMMENT 'Supplier SPU/product ID',
    sync_enabled    BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Auto-sync price/stock',
    last_synced_at  DATETIME NULL COMMENT 'Last supplier sync',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_by INT NULL,
    updated_by INT NULL,
    FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES users(user_id) ON DELETE SET NULL,
    INDEX idx_spu_id       (spu_id),
    INDEX idx_category     (category),
    INDEX idx_is_active    (is_active),
    INDEX idx_product_name (product_name),
    INDEX idx_brand_name   (brand_name),
    INDEX idx_source       (source),
    INDEX idx_supplier_name(supplier_name),
    INDEX idx_supplier_ref (supplier_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 9. PRODUCT SKUS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS product_skus (
    sku_id INT PRIMARY KEY AUTO_INCREMENT,
    product_id INT NOT NULL,
    carrypin_sku_id VARCHAR(100) NULL COMMENT 'CarryPin SKU ID',
    supplier_sku_ref VARCHAR(100) NULL COMMENT 'Supplier SKU/denomination ID',
    realtime_price BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Fetch price live from supplier',
    face_value_display VARCHAR(50) NULL COMMENT 'Display label e.g. $50',
    sku_name VARCHAR(255) NOT NULL,
    face_value DECIMAL(10,2) NULL COMMENT 'Denomination',
    is_custom_value BOOLEAN NOT NULL DEFAULT FALSE,
    min_face_value DECIMAL(10,2) NULL,
    max_face_value DECIMAL(10,2) NULL,
    cost_price DECIMAL(10,2) NOT NULL COMMENT 'Supplier cost',
    selling_price DECIMAL(10,2) NOT NULL COMMENT 'Default selling price',
    price_currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    margin_percent DECIMAL(5,2) NULL COMMENT 'Calculated margin',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE,
    INDEX idx_product_id       (product_id),
    INDEX idx_carrypin_sku_id  (carrypin_sku_id),
    INDEX idx_supplier_sku_ref (supplier_sku_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 10. INVENTORY TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS inventory (
    inventory_id INT PRIMARY KEY AUTO_INCREMENT,
    sku_id INT NOT NULL UNIQUE,
    stock_quantity INT NOT NULL DEFAULT 0,
    reserved_qty INT NOT NULL DEFAULT 0,
    available_qty INT GENERATED ALWAYS AS (stock_quantity - reserved_qty) STORED,
    unlimited_stock BOOLEAN NOT NULL DEFAULT FALSE,
    reorder_level INT NULL,
    last_sync DATETIME NULL COMMENT 'Last CarryPin sync',
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (sku_id) REFERENCES product_skus(sku_id) ON DELETE CASCADE,
    INDEX idx_sku_id (sku_id),
    CONSTRAINT chk_quantity CHECK (stock_quantity >= 0 AND reserved_qty >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 11. DIGITAL CODES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS digital_codes (
    code_id INT PRIMARY KEY AUTO_INCREMENT,
    sku_id INT NOT NULL,
    code VARCHAR(500) NOT NULL COMMENT 'ENCRYPTED',
    pin_code VARCHAR(255) NULL COMMENT 'ENCRYPTED',
    sn_code VARCHAR(255) NULL COMMENT 'ENCRYPTED',
    status ENUM('available','reserved','sold','invalid') NOT NULL DEFAULT 'available',
    order_id INT NULL,
    reserved_at DATETIME NULL,
    sold_at DATETIME NULL,
    source ENUM('manual','excel_upload','carrypin_api') NOT NULL DEFAULT 'manual',
    upload_batch VARCHAR(100) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by INT NULL,
    FOREIGN KEY (sku_id) REFERENCES product_skus(sku_id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL,
    UNIQUE KEY uq_sku_code (sku_id, code(255)),
    INDEX idx_sku_id       (sku_id),
    INDEX idx_status       (status),
    INDEX idx_upload_batch (upload_batch)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 12. ORDERS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS orders (
    order_id INT PRIMARY KEY AUTO_INCREMENT,
    order_number VARCHAR(50) NOT NULL UNIQUE,
    user_id INT NOT NULL,
    service_order VARCHAR(100) NULL COMMENT 'Client reference',
    carrypin_order_id VARCHAR(100) NULL COMMENT 'Supplier reference',
    order_status ENUM('pending','processing','completed','failed','cancelled') NOT NULL DEFAULT 'pending',
    delivery_status ENUM('pending','partial','completed','failed') NOT NULL DEFAULT 'pending',
    total_amount DECIMAL(15,2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    payment_method VARCHAR(50) NOT NULL DEFAULT 'wallet',
    order_source ENUM('portal','api') NOT NULL DEFAULT 'portal',
    notes TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    completed_at DATETIME NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    INDEX idx_order_number    (order_number),
    INDEX idx_user_id         (user_id),
    INDEX idx_order_status    (order_status),
    INDEX idx_carrypin_order  (carrypin_order_id),
    INDEX idx_created_at      (created_at),
    CONSTRAINT chk_amount CHECK (total_amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 13. ORDER DETAILS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS order_details (
    order_detail_id INT PRIMARY KEY AUTO_INCREMENT,
    order_id INT NOT NULL,
    product_id INT NOT NULL,
    sku_id INT NOT NULL,
    quantity INT NOT NULL,
    face_value DECIMAL(10,2) NULL COMMENT 'For custom value',
    unit_cost DECIMAL(10,2) NOT NULL,
    unit_price DECIMAL(10,2) NOT NULL,
    total_cost DECIMAL(15,2) GENERATED ALWAYS AS (quantity * unit_cost) STORED,
    total_price DECIMAL(15,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
    margin_amount DECIMAL(15,2) GENERATED ALWAYS AS ((quantity * unit_price) - (quantity * unit_cost)) STORED,
    discount_percent DECIMAL(5,2) NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    delivered_qty INT NOT NULL DEFAULT 0,
    delivery_status ENUM('pending','partial','completed','failed') NOT NULL DEFAULT 'pending',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id)   REFERENCES orders(order_id)       ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(product_id),
    FOREIGN KEY (sku_id)     REFERENCES product_skus(sku_id),
    INDEX idx_order_id   (order_id),
    INDEX idx_product_id (product_id),
    INDEX idx_sku_id     (sku_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 14. CLIENT PRICING TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS client_pricing (
    pricing_id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    sku_id INT NOT NULL,
    custom_price DECIMAL(10,2) NOT NULL,
    margin_percent DECIMAL(5,2) NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_by INT NULL COMMENT 'Admin user',
    FOREIGN KEY (user_id)     REFERENCES users(user_id)        ON DELETE CASCADE,
    FOREIGN KEY (sku_id)      REFERENCES product_skus(sku_id)  ON DELETE CASCADE,
    FOREIGN KEY (created_by)  REFERENCES users(user_id)        ON DELETE SET NULL,
    UNIQUE KEY unique_user_sku (user_id, sku_id),
    INDEX idx_user_id   (user_id),
    INDEX idx_sku_id    (sku_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 15. CLIENT PRODUCT ACCESS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS client_product_access (
    access_id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    product_id INT NOT NULL,
    access_type ENUM('allow','deny') NOT NULL DEFAULT 'allow',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by INT NULL COMMENT 'Admin user',
    FOREIGN KEY (user_id)    REFERENCES users(user_id)    ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(user_id)    ON DELETE SET NULL,
    UNIQUE KEY unique_user_product (user_id, product_id),
    INDEX idx_user_id    (user_id),
    INDEX idx_product_id (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 16. SUPPLIER CONFIG TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS supplier_config (
    config_id INT PRIMARY KEY AUTO_INCREMENT,
    supplier_name VARCHAR(100) NOT NULL,
    app_id VARCHAR(100) NOT NULL COMMENT 'ENCRYPTED',
    account_id VARCHAR(100) NOT NULL COMMENT 'ENCRYPTED',
    app_key VARCHAR(255) NOT NULL COMMENT 'ENCRYPTED',
    api_base_url VARCHAR(255) NOT NULL,
    token TEXT NULL COMMENT 'Current authentication token',
    token_expires DATETIME NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    rate_limits JSON NULL,
    last_sync DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_supplier_name (supplier_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 17. AUDIT LOGS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS audit_logs (
    log_id BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NULL,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50) NULL,
    entity_id VARCHAR(100) NULL,
    old_values JSON NULL,
    new_values JSON NULL,
    ip_address VARCHAR(45) NULL,
    user_agent TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    INDEX idx_user_id     (user_id),
    INDEX idx_action      (action),
    INDEX idx_entity_type (entity_type),
    INDEX idx_created_at  (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 18. API LOGS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS api_logs (
    log_id BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NULL,
    method VARCHAR(10) NOT NULL,
    endpoint VARCHAR(255) NOT NULL,
    status_code INT NULL,
    response_time INT NULL COMMENT 'Milliseconds',
    request_body JSON NULL,
    error_message TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    INDEX idx_user_id     (user_id),
    INDEX idx_endpoint    (endpoint),
    INDEX idx_status_code (status_code),
    INDEX idx_created_at  (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 19. SUPPORT TICKETS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS support_tickets (
    ticket_id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    ticket_number VARCHAR(20) NOT NULL UNIQUE,
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    attachment_name VARCHAR(255) NULL,
    attachment_url VARCHAR(500) NULL,
    status ENUM('pending','in_progress','resolved') NOT NULL DEFAULT 'pending',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    INDEX idx_user_id  (user_id),
    INDEX idx_status   (status),
    INDEX idx_created  (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 4. EMAIL VERIFICATION TOKENS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    token VARCHAR(255) NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    UNIQUE INDEX idx_token (token),
    INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 5. PASSWORD RESET TOKENS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    token VARCHAR(255) NOT NULL,
    expires_at DATETIME NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    UNIQUE INDEX idx_token (token),
    INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- INITIAL DATA
-- ============================================

INSERT INTO roles (role_name, description, permissions) VALUES
('super_admin', 'Super Administrator with full access',          '{"all": true}'),
('admin',       'Administrator with admin portal access',        '{"user_management": true, "product_management": true, "wallet_management": true, "reports": true}'),
('b2b_client',  'B2B Client with client portal access',         '{"view_products": true, "place_orders": true, "view_wallet": true}'),
('viewer',      'Viewer account with limited access',            '{"view_products": true, "view_orders": true}');

-- Super admin user (password: Admin@123)
INSERT INTO users (email, password_hash, full_name, role_id, user_type, status, email_verified)
VALUES (
    'admin@cardcove.com',
    '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5lXkB.8RkF2tS',
    'Super Admin',
    1,
    'super_admin',
    'active',
    TRUE
);

INSERT INTO wallets (user_id, balance, currency, status)
VALUES (1, 0.00, 'USD', 'active');

-- ============================================
-- COMPLETED
-- ============================================

SELECT 'Full schema migration completed successfully!' AS status;
SELECT COUNT(*) AS total_tables
FROM information_schema.tables
WHERE table_schema = 'cardcove_db';
