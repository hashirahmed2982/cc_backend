-- Migration: 005_support_tickets.sql
USE cardcove_db;

CREATE TABLE IF NOT EXISTS support_tickets (
    ticket_id       INT PRIMARY KEY AUTO_INCREMENT,
    user_id         INT NOT NULL,
    ticket_number   VARCHAR(20) NOT NULL UNIQUE,
    title           VARCHAR(255) NOT NULL,
    description     TEXT NOT NULL,
    attachment_name VARCHAR(255) NULL,
    attachment_url  VARCHAR(500) NULL,
    status          ENUM('pending', 'in_progress', 'resolved') NOT NULL DEFAULT 'pending',
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    INDEX idx_user_id  (user_id),
    INDEX idx_status   (status),
    INDEX idx_created  (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT 'Migration 005 completed successfully!' AS status;
