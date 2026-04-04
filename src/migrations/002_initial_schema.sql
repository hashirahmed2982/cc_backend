-- ============================================
-- Card Cove B2B Portal - Database Migration
-- Complete SQL Schema from PDF Requirements
-- ============================================

-- Drop existing database if exists (CAUTION: Use only in development)
-- DROP DATABASE IF EXISTS cardcove_db;

-- Create database
CREATE DATABASE IF NOT EXISTS cardcove_db 
CHARACTER SET utf8mb4 
COLLATE utf8mb4_unicode_ci;

USE cardcove_db;

-- 002_viewer_accounts.sql
CREATE TABLE IF NOT EXISTS viewer_accounts (
    id INT PRIMARY KEY AUTO_INCREMENT,
    viewer_user_id INT NOT NULL,        -- the viewer user
    b2b_client_id INT NOT NULL,         -- the b2b account they belong to
    permissions JSON NULL,              -- optional granular permissions
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
-- COMPLETED
-- ============================================

SELECT 'Database migration completed successfully!' as status;
SELECT COUNT(*) as total_tables FROM information_schema.tables WHERE table_schema = 'cardcove_db';
