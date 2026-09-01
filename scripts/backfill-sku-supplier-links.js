#!/usr/bin/env node
/**
 * One-time backfill for the §9/§10 multi-supplier framework: gives every
 * existing WgCards-linked SKU (product_skus.wgcards_sku_id) a matching
 * sku_supplier_links row, so the new supplierSelection dispatcher has
 * something to select from immediately — with only one active link per
 * SKU, selection is trivial ("use the only option"), but the data model
 * is now in its final multi-supplier shape.
 *
 * Idempotent — re-running just no-ops on rows that already have a link
 * (ON DUPLICATE KEY on (supplier, supplier_sku_ref)).
 *
 * Usage: node scripts/backfill-sku-supplier-links.js
 */
'use strict';

require('dotenv').config();

const db = require('../src/config/database');

async function run() {
  const rows = await db.query(
    `SELECT ps.sku_id, ps.wgcards_sku_id, ps.cost_price, ps.price_currency, p.supplier_ref
       FROM product_skus ps
       JOIN products p ON p.product_id = ps.product_id
      WHERE ps.wgcards_sku_id IS NOT NULL AND p.source = 'wgcards'`
  );

  console.log(`Found ${rows.length} WgCards-linked SKU(s) to backfill.`);

  let inserted = 0;
  let skipped = 0;

  for (const row of rows) {
    const currency = row.price_currency || 'USD';
    // catalogSync always requests currencyCode: 'USD' from WgCards, so no
    // real FX conversion is needed yet — cost_price_base_currency just
    // mirrors cost_price for a USD link. Revisit once a non-USD supplier
    // link exists.
    const costPriceBaseCurrency = currency === 'USD' ? row.cost_price : null;

    const result = await db.query(
      `INSERT INTO sku_supplier_links
         (sku_id, supplier, supplier_ref, supplier_sku_ref, cost_price, cost_currency,
          cost_price_base_currency, fx_rate_used, fx_rate_at, stock_status, is_active, last_synced_at)
       VALUES (?, 'wgcards', ?, ?, ?, ?, ?, ?, ?, 'unknown', 1, NOW())
       ON DUPLICATE KEY UPDATE sku_id = sku_id`, // no-op on re-run, never overwrite an existing link
      [
        row.sku_id, row.supplier_ref || null, String(row.wgcards_sku_id),
        row.cost_price, currency, costPriceBaseCurrency,
        currency === 'USD' ? 1 : null, currency === 'USD' ? new Date() : null,
      ]
    );
    if (result.affectedRows === 1) inserted++; // 1 = real insert; 0 or 2 = duplicate no-op
    else skipped++;
  }

  console.log(`Backfill complete: ${inserted} link(s) created, ${skipped} already existed.`);
}

run()
  .then(() => db.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  });
