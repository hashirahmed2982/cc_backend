-- 015_gift2games_delivery.sql
-- Closes the Gift2Games delivery gap: gift2gamesFulfillment.js placed
-- orders successfully but never persisted anything to order_details, so
-- there was nothing for a poller (which also didn't exist) to ever find
-- again — a successful Gift2Games order would sit "pending" forever.
--
-- Mirrors WgCards' wgcards_service_order/wgcards_order_id pair. Also adds
-- a raw-response column: Gift2Games' create_order/orders/details response
-- shape for the actual delivered code has never been confirmed live (see
-- gift2games.service.js's header), so utils/gift2gamesDelivery.js's field
-- extraction is best-effort — this column is the fallback so a shape we
-- didn't anticipate is still visible to a human in the admin panel instead
-- of silently discarded.

ALTER TABLE order_details
    ADD COLUMN gift2games_reference_number VARCHAR(100) NULL
        COMMENT 'Our idempotency key sent as referenceNumber — one per createOrder attempt, reused across retries of the SAME attempt (Flow H)'
        AFTER wgcards_order_id,
    ADD COLUMN gift2games_order_id VARCHAR(100) NULL
        COMMENT 'Supplier order id once createOrder succeeds — presence means "already placed, do not re-order"'
        AFTER gift2games_reference_number,
    ADD COLUMN gift2games_raw_response TEXT NULL
        COMMENT 'Encrypted raw createOrder/getOrderDetails response — fallback for admin review when the delivered-code extractor (utils/gift2gamesDelivery.js) can''t confidently identify a code/pin field in an unconfirmed response shape'
        AFTER gift2games_order_id,
    ADD INDEX idx_gift2games_order_id (gift2games_order_id);
