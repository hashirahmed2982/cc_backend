'use strict';

jest.mock('../../repositories/supplierConfig.repository');
jest.mock('../../repositories/supplierLinks.repository');
jest.mock('../../config/database');

const supplierConfigRepo = require('../../repositories/supplierConfig.repository');
const supplierLinksRepo = require('../../repositories/supplierLinks.repository');
const db = require('../../config/database');
const { run, mapFaceValue, computeDefaultSellingPrice, mapSkuForUpsert, syncOneItem } = require('../catalogSync');

describe('catalogSync pure mapping', () => {
  describe('mapFaceValue', () => {
    test('fixed-value card: min === max -> not custom, faceValue set', () => {
      const result = mapFaceValue({ minFaceValue: 10, maxFaceValue: 10 });
      expect(result).toEqual({ faceValue: 10, isCustomValue: false, minFaceValue: 10, maxFaceValue: 10 });
    });

    test('range/custom-value card: min !== max -> custom, faceValue null', () => {
      const result = mapFaceValue({ minFaceValue: 5, maxFaceValue: 100 });
      expect(result.isCustomValue).toBe(true);
      expect(result.faceValue).toBeNull();
    });

    test('missing min/max -> treated as not custom (no false positive)', () => {
      const result = mapFaceValue({});
      expect(result.isCustomValue).toBe(false);
      expect(result.faceValue).toBeNull();
    });
  });

  describe('computeDefaultSellingPrice', () => {
    test('applies the given margin percent and rounds to 2 decimals', () => {
      expect(computeDefaultSellingPrice(41.39, 20)).toBe(49.67); // 41.39 * 1.2 = 49.668 -> 49.67
    });

    test('0% margin returns cost price unchanged', () => {
      expect(computeDefaultSellingPrice(6.07, 0)).toBe(6.07);
    });

    test('missing/NaN margin defaults to 0% rather than crashing or NaN-ing', () => {
      expect(computeDefaultSellingPrice(10, undefined)).toBe(10);
      expect(computeDefaultSellingPrice(10, 'not-a-number')).toBe(10);
    });
  });

  describe('mapSkuForUpsert', () => {
    test('maps a real live-sandbox sku record end to end (USD — the normal case)', () => {
      const sku = {
        maxFaceValue: 10,
        maxPrice: 41.39,
        minFaceValue: 10,
        minPrice: 41.39,
        skuId: '12182768136',
        skuName: 'MLBB',
        skuPrice: 41.39,
        skuPriceCurrency: 'USD',
      };

      const result = mapSkuForUpsert(sku, 20);

      expect(result).toEqual({
        wgcardsSkuId: '12182768136',
        skuName: 'MLBB',
        faceValue: 10,
        isCustomValue: false,
        minFaceValue: 10,
        maxFaceValue: 10,
        costPrice: 41.39,
        priceCurrency: 'USD',
        defaultSellingPrice: 49.67,
      });
    });

    test('non-USD currency (confirmed live anomaly — requesting USD is not always honored): no margin applied, defaultSellingPrice left equal to raw cost', () => {
      // Straight from the live getItem response captured during testing —
      // WgCards returned CNY despite the request explicitly asking for
      // currencyCode:'USD'. Applying a 20% margin to 41.39 as if it were
      // USD would produce a confidently-wrong $49.67 "USD" price (the real
      // USD value of 41.39 CNY is roughly $5.70) — this portal only sells
      // in USD (see utils/priceGuard.js), so that number must never be
      // treated as a real USD price. See catalogSync.js's own comment on
      // mapSkuForUpsert for the full rationale.
      const sku = {
        maxFaceValue: 10, minFaceValue: 10,
        skuId: '12182768136', skuName: 'MLBB',
        skuPrice: 41.39, skuPriceCurrency: 'CNY',
      };

      const result = mapSkuForUpsert(sku, 20);

      expect(result.priceCurrency).toBe('CNY');
      expect(result.defaultSellingPrice).toBe(41.39); // == costPrice, NOT margin-inflated
    });

    test('missing skuPriceCurrency falls back to USD', () => {
      const result = mapSkuForUpsert({ skuId: '1', skuName: 'x', minFaceValue: 1, maxFaceValue: 1, skuPrice: 1 }, 0);
      expect(result.priceCurrency).toBe('USD');
    });
  });
});

describe('catalogSync.run', () => {
  beforeEach(() => jest.clearAllMocks());

  test('supplier disabled by admin -> skips entirely, never touches the catalog', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ is_active: 0 });
    const result = await run();
    expect(result).toEqual({ skipped: true, reason: 'supplier_disabled' });
  });
});

describe('catalogSync.syncOneItem — sku_supplier_links wiring (Master Plan §9/§10)', () => {
  // A fake connection that answers whichever query upsertProduct/upsertSku/
  // ensureInventoryRow happen to run, keyed on the SQL text rather than
  // call order — robust to those functions' own internal query order
  // changing without this test needing to track it.
  function fakeConn() {
    return {
      execute: jest.fn(async (sql) => {
        if (/SELECT product_id FROM products/.test(sql)) return [[]]; // no existing product -> INSERT path
        if (/INSERT INTO products/.test(sql)) return [{ insertId: 501 }];
        if (/UPDATE products SET/.test(sql)) return [{}];
        if (/SELECT sku_id, selling_price FROM product_skus/.test(sql)) return [[]]; // no existing sku -> INSERT path
        if (/INSERT INTO product_skus/.test(sql)) return [{ insertId: 9001 }];
        if (/UPDATE product_skus SET/.test(sql)) return [{}];
        if (/SELECT inventory_id FROM inventory/.test(sql)) return [[]];
        if (/INSERT INTO inventory/.test(sql)) return [{}];
        return [{}];
      }),
    };
  }

  const itemRaw = {
    itemId: '77',
    itemName: 'Test Item',
    skus: [{ skuId: '12345', skuName: 'Test SKU', minFaceValue: 10, maxFaceValue: 10, skuPrice: 8, skuPriceCurrency: 'USD' }],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    db.transaction.mockImplementation(async (cb) => cb(fakeConn()));
  });

  test('a newly-synced SKU gets a sku_supplier_links row — the gap this fix closes (WgCards used to bypass it entirely)', async () => {
    const result = await syncOneItem(itemRaw, 20);

    expect(result).toMatchObject({ productId: 501, created: 1, updated: 0, totalSkus: 1 });
    expect(supplierLinksRepo.upsertLink).toHaveBeenCalledTimes(1);
    expect(supplierLinksRepo.upsertLink).toHaveBeenCalledWith(
      expect.objectContaining({
        skuId: 9001,
        supplier: 'wgcards',
        supplierSkuRef: '12345',
        costPrice: 8,
        costCurrency: 'USD',
        stockStatus: 'unknown',
      })
    );
  });

  test('a non-USD sku still syncs (no margin-inflated price) and its link is recorded in its real currency', async () => {
    const cnyItem = {
      itemId: '77',
      itemName: 'Test Item',
      skus: [{ skuId: '12345', skuName: 'Test SKU', minFaceValue: 10, maxFaceValue: 10, skuPrice: 41.39, skuPriceCurrency: 'CNY' }],
    };

    const result = await syncOneItem(cnyItem, 20);

    expect(result).toMatchObject({ productId: 501, created: 1 });
    expect(supplierLinksRepo.upsertLink).toHaveBeenCalledWith(
      expect.objectContaining({ costPrice: 41.39, costCurrency: 'CNY', costPriceBaseCurrency: null })
    );
  });

  test('a link-sync failure is logged but does not fail the sync — the product/SKU data is already safely committed', async () => {
    supplierLinksRepo.upsertLink.mockRejectedValueOnce(new Error('db blip'));

    const result = await syncOneItem(itemRaw, 20);

    expect(result).toMatchObject({ productId: 501, created: 1 });
  });

  test('a SKU with no skuPrice is skipped entirely — never reaches sku_supplier_links either', async () => {
    const result = await syncOneItem({ itemId: '77', skus: [{ skuId: '999' }] }, 20);

    expect(result.totalSkus).toBe(1);
    expect(result.created).toBe(0);
    expect(supplierLinksRepo.upsertLink).not.toHaveBeenCalled();
  });
});
