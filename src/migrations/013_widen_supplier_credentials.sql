-- 013_widen_supplier_credentials.sql
-- app_key was VARCHAR(255), which fit WgCards' short numeric app_key fine
-- but is too narrow once a JWT is encrypted+hex-encoded (iv:ciphertext —
-- roughly 2.3x the plaintext length): a 169-char Gift2Games JWT encrypts
-- to 385 chars, over the 255 limit -> "Data too long for column 'app_key'".
-- Also widening app_id/account_id, which are now sometimes holding an
-- email (Gift2Games has no WgCards-style two-part numeric-ID auth) —
-- VARCHAR(100) is uncomfortably close to its own limit for that case too.
ALTER TABLE supplier_config
    MODIFY COLUMN app_id TEXT NOT NULL COMMENT 'ENCRYPTED',
    MODIFY COLUMN account_id TEXT NOT NULL COMMENT 'ENCRYPTED',
    MODIFY COLUMN app_key TEXT NOT NULL COMMENT 'ENCRYPTED — widened from VARCHAR(255), too narrow once a JWT is encrypted+hex-encoded';
