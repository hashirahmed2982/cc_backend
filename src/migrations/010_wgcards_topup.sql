-- 010_wgcards_topup.sql
-- Incremental migration for Flow F (WgCards Direct Top-Up) on the already-
-- provisioned uat DB. wgcards_topup_orders itself already exists (Phase 0),
-- this only widens it for the dynamic attributeValues parameter model
-- discovered while implementing placeDirectOrder, and adds the webhook
-- 'processing' (status 2) state.

ALTER TABLE wgcards_topup_orders
    MODIFY COLUMN target_account VARCHAR(255) NOT NULL
        COMMENT 'Display value only — first attributeValues entry (e.g. player ID). Full param set is in attribute_values.',
    ADD COLUMN attribute_values JSON NULL
        COMMENT 'Full attributeValues[] sent to placeDirectOrder — a dynamic named list (per getDirectParam), not just one field'
        AFTER target_account,
    MODIFY COLUMN status ENUM('pending', 'processing', 'confirmed', 'failed', 'cancelled') NOT NULL DEFAULT 'pending'
        COMMENT 'processing = webhook status 2 (WgCards is recharging); pending = not yet resolved at all';
