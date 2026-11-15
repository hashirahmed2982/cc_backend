-- 019_one_product_per_sku.sql
-- Supports the move from "one product per WgCards item (SPU), many SKUs
-- under it" to "one product per WgCards SKU" (confirmed directly by
-- WgCards 2026-11-15: each SKU under an item is independent, sold and
-- ordered independently — e.g. Nintendo Japan's 50/100/150 JPY SKUs are
-- three unrelated products to them, not three variants of one product).
--
-- 1. products.is_custom_value — denormalized from a product's one-and-only
--    SKU once catalogSync.js is keyed per-SKU. Floating-denomination cards
--    (a min/max range, no fixed face value — e.g. "load any amount
--    $5-$500") have no fixed price to charge, and nothing in checkout or
--    the storefront lets a customer enter a custom amount. Rather than
--    delete/never-sync these, they're synced but flagged, then excluded at
--    the same two choke points Direct Top-Up already uses
--    (userProduct.service.js#getClientProducts, order.service.js#placeOrder).
--
-- 2. product_skus.wgcards_sku_id's index becomes UNIQUE. Under the old
--    one-product-per-item model, (source, spu_id) was the natural identity
--    key but was never actually enforced unique — confirmed live
--    (2026-11-12) as two separate product rows both claiming WgCards SPU
--    18822924808. Under one-product-per-SKU, spu_id is expected to repeat
--    across several products (same item, different denominations), so the
--    real identity key moves down to the SKU itself — wgcards_sku_id is
--    globally unique on WgCards' side, so a DB-level UNIQUE index here
--    structurally prevents the same duplicate-identity bug from recurring,
--    at the grain that's now actually meaningful. NULL-safe: non-wgcards
--    product_skus rows leave this column NULL, and InnoDB treats every
--    NULL as distinct under a UNIQUE index, so they're unaffected.

ALTER TABLE products
    ADD COLUMN is_custom_value TINYINT(1) NOT NULL DEFAULT 0
        COMMENT 'Floating/custom-amount SKU (min/max range, no fixed face value) — excluded from customer listing + checkout; never deleted so re-including later needs no re-sync'
        AFTER spu_type;

ALTER TABLE product_skus
    DROP INDEX idx_wgcards_sku_id,
    ADD UNIQUE INDEX idx_wgcards_sku_id (wgcards_sku_id);
