-- 018_widen_sku_prices.sql
-- cost_price/selling_price were DECIMAL(10,2) (max ~100 million) across
-- product_skus, sku_supplier_links, and supplier_catalog_items — confirmed
-- too narrow live (2026-11-12): a real WgCards sku during a full catalog
-- refetch threw "Out of range value for column 'cost_price'" on INSERT
-- into sku_supplier_links. Handled gracefully (caught per-SKU, logged,
-- rest of the sync continued) rather than crashing anything, but that
-- SKU's link silently never got saved. Widened to DECIMAL(14,2) (max
-- ~1 trillion) — generous headroom against whatever garbled/outlier price
-- a supplier's live catalog can produce, without this needing revisiting
-- again for the same reason.

ALTER TABLE product_skus
    MODIFY COLUMN cost_price DECIMAL(14,2) NOT NULL COMMENT 'Supplier cost',
    MODIFY COLUMN selling_price DECIMAL(14,2) NOT NULL COMMENT 'Default selling price';

ALTER TABLE sku_supplier_links
    MODIFY COLUMN cost_price DECIMAL(14,2) NOT NULL,
    MODIFY COLUMN cost_price_base_currency DECIMAL(14,2) NULL COMMENT 'cost_price converted to the base reporting currency (USD) — what cheapest-supplier comparison actually sorts on';

ALTER TABLE supplier_catalog_items
    MODIFY COLUMN cost_price DECIMAL(14,2) NULL;
