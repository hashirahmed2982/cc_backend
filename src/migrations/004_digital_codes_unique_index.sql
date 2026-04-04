-- Migration: 004_digital_codes_unique_index.sql
-- Required for batch INSERT IGNORE deduplication in uploadCodes service.
-- Without this index, INSERT IGNORE has nothing to check against and all rows insert.

USE cardcove_db;

ALTER TABLE digital_codes
  ADD UNIQUE KEY uq_sku_code (sku_id, code(255));

SELECT 'Migration 004 completed successfully!' AS status;
