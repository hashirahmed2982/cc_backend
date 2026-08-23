-- ============================================
-- Migration: 008_order_details_wgcards.sql
-- Phase 4 (Flow D — order placement). Run this ONCE against an
-- already-provisioned database (same situation as 007: 000_full_schema.sql
-- already has this for a fresh install, CREATE TABLE IF NOT EXISTS won't
-- touch an existing order_details table).
--
--   node src/migrations/migrate.js 008_order_details_wgcards.sql
--   (or: npm run migrate:order-details)
-- ============================================

USE cardcove_db;

ALTER TABLE order_details
  ADD COLUMN wgcards_service_order VARCHAR(100) NULL
    COMMENT 'Our idempotency key sent as serviceOrder — one per placeOrder attempt'
    AFTER delivery_status,
  ADD COLUMN wgcards_order_id VARCHAR(100) NULL
    COMMENT 'Supplier order id once placeOrder succeeds — presence means "already placed, do not re-order"'
    AFTER wgcards_service_order,
  ADD COLUMN pending_reason VARCHAR(50) NULL
    COMMENT 'insufficient_inventory | supplier_rejected | supplier_timeout | supplier_auth_failure | awaiting_supplier_delivery | custom_value_not_supported_yet | supplier_api_pending'
    AFTER wgcards_order_id;

ALTER TABLE order_details
  ADD INDEX idx_wgcards_order_id (wgcards_order_id);

SELECT 'Migration 008 (order_details WgCards columns) completed successfully!' AS status;
