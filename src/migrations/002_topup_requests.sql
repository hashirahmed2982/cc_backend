-- ============================================
-- Migration 002: Add topup_requests table
-- ============================================

USE cardcove_db;

CREATE TABLE IF NOT EXISTS topup_requests (
    request_id    INT PRIMARY KEY AUTO_INCREMENT,
    user_id       INT NOT NULL,
    wallet_id     INT NOT NULL,
    amount        DECIMAL(15,2) NOT NULL,
    currency      VARCHAR(3) NOT NULL DEFAULT 'USD',
    receipt_url   VARCHAR(1000) NULL COMMENT 'Uploaded receipt image/PDF URL',
    status        ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    rejection_reason TEXT NULL,
    reviewed_by   INT NULL,
    reviewed_at   DATETIME NULL,
    notes         TEXT NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id)    REFERENCES users(user_id)   ON DELETE CASCADE,
    FOREIGN KEY (wallet_id)  REFERENCES wallets(wallet_id) ON DELETE CASCADE,
    FOREIGN KEY (reviewed_by) REFERENCES users(user_id)  ON DELETE SET NULL,

    INDEX idx_user_id   (user_id),
    INDEX idx_wallet_id (wallet_id),
    INDEX idx_status    (status),
    INDEX idx_created_at(created_at),
    CONSTRAINT chk_topup_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT 'topup_requests table created successfully' AS status;
