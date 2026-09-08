-- 016_supplier_catalog_face_value_currency.sql
-- Fixes a real mislabeling bug found via live Gift2Games data: a card like
-- "APPLE UK - 2 GBP" has productFaceValue:2/productFaceValueCurrency:'GBP'
-- (what the card is worth in its home market) but price:2.632/currency:'USD'
-- (what we actually pay Gift2Games, always USD — confirmed live). Before
-- this migration, supplier_catalog_items had exactly one `currency` column,
-- and gift2gamesCatalogSync.js filled it with the FACE VALUE currency (GBP)
-- so the Link Products review UI would show "2 GBP" correctly — but
-- catalogMatching.service.js then also reads that same column as the
-- CURRENCY OF cost_price, so a $2.632 USD cost got tagged 'GBP' downstream:
-- price_currency ended up wrong on the created SKU, cost_price_base_currency
-- was wrongly nulled out (treated as "unconvertible" when it was already
-- USD), and createNewFromStaging would even refuse to auto-price the item
-- ("cost is recorded in GBP, not USD") despite the cost being USD all along.
--
-- Fix: split the one overloaded column into two. `currency` now means ONLY
-- "what currency is cost_price in" (matches WgCards' existing correct
-- behavior, where the single currency field always meant this). The new
-- `face_value_currency` carries the card's own denomination currency for
-- display and for match-key region disambiguation (UK vs US Apple cards
-- must not collide just because they share a face-value number).

ALTER TABLE supplier_catalog_items
    ADD COLUMN face_value_currency VARCHAR(3) NULL
        COMMENT 'Currency the face_value itself is denominated in (e.g. GBP for a UK card) — separate from `currency`, which is always the currency cost_price is in. Falls back to `currency` when a supplier does not expose a distinct one (e.g. WgCards).'
        AFTER currency;
