-- ============================================
-- Migration: 009_order_poller.sql
-- Phase 5 (Flow E — order completion poller). Run this ONCE against an
-- already-provisioned database (same situation as 007/008).
--
--   node src/migrations/migrate.js 009_order_poller.sql
-- ============================================

USE cardcove_db;

ALTER TABLE order_details
  ADD COLUMN last_polled_at DATETIME NULL
    COMMENT 'Flow E poller — last getOrderInfoAndDetail check, drives the tiered poll cadence'
    AFTER pending_reason,
  MODIFY COLUMN pending_reason VARCHAR(50) NULL
    COMMENT 'insufficient_inventory | supplier_rejected | supplier_timeout | supplier_auth_failure | awaiting_supplier_delivery | custom_value_not_supported_yet | supplier_api_pending | requires_direct_topup_flow | delayed | delayed_needs_admin_decision | supplier_cancelled';

SELECT 'Migration 009 (order poller) completed successfully!' AS status;
