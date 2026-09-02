-- 014_widen_api_logs.sql
-- request_body/response_body/supplier_request/supplier_response were TEXT
-- (64KB max) — confirmed live: a full Gift2Games /products catalog
-- response (1903 items) encrypted+hex-encoded blew past that, logged as
-- "Data too long for column 'supplier_response'". supplierApiLog.service.js
-- catches its own logging errors so this didn't abort the sync job
-- itself, but it did mean that one large call's entry silently never got
-- written to api_logs — no Integration Activity Log visibility into it.
-- Widened to MEDIUMTEXT (16MB) — generous headroom without going all the
-- way to LONGTEXT for what should stay a bounded per-call payload.
ALTER TABLE api_logs
    MODIFY COLUMN request_body MEDIUMTEXT NULL COMMENT 'ENCRYPTED',
    MODIFY COLUMN response_body MEDIUMTEXT NULL COMMENT 'ENCRYPTED',
    MODIFY COLUMN supplier_request MEDIUMTEXT NULL COMMENT 'ENCRYPTED — raw request payload sent to supplier',
    MODIFY COLUMN supplier_response MEDIUMTEXT NULL COMMENT 'ENCRYPTED — raw response payload received from supplier';
