'use strict';

jest.mock('../../repositories/supplierConfig.repository');
jest.mock('../../repositories/supplierLinks.repository');
jest.mock('../../config/database');

const supplierConfigRepo = require('../../repositories/supplierConfig.repository');
const supplierLinksRepo = require('../../repositories/supplierLinks.repository');
const db = require('../../config/database');
const { run, mapFaceValue, computeDefaultSellingPrice, mapSkuForUpsert, buildMatchKey, syncOneItem } = require('../catalogSync');

describe('buildMatchKey', () => {
  beforeEach(() => jest.clearAllMocks());

  test('combines canonical brand, face value, and currency — using itemBrandName directly, no title-splitting needed', async () => {
    supplierLinksRepo.getCanonicalBrand.mockResolvedValueOnce('mobile legends');
    const key = await buildMatchKey(
      { itemBrandName: 'Mobile Legends', itemName: 'MLBB 11 Diamonds' },
      { faceValue: 11, priceCurrency: 'usd' }
    );
    expect(key).toBe('mobile legends|11.00|USD');
    expect(supplierLinksRepo.getCanonicalBrand).toHaveBeenCalledWith('Mobile Legends');
  });

  test('falls back to itemName when itemBrandName is missing', async () => {
    supplierLinksRepo.getCanonicalBrand.mockResolvedValueOnce('some game');
    await buildMatchKey({ itemBrandName: null, itemName: 'Some Game' }, { faceValue: 5, priceCurrency: 'USD' });
    expect(supplierLinksRepo.getCanonicalBrand).toHaveBeenCalledWith('Some Game');
  });

  test('a custom-value (range) sku with no single face value keys on "na"', async () => {
    supplierLinksRepo.getCanonicalBrand.mockResolvedValueOnce('topup game');
    const key = await buildMatchKey({ itemBrandName: 'Topup Game' }, { faceValue: null, priceCurrency: 'USD' });
    expect(key).toBe('topup game|na|USD');
  });
});

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

describe('catalogSync.syncOneItem — routed through Master Plan §9.2 staging (no more bypassing it)', () => {
  function fakeConn() {
    return {
      execute: jest.fn(async (sql) => {
        if (/UPDATE product_skus SET/.test(sql)) return [{}];
        if (/INSERT INTO product_skus/.test(sql)) return [{ insertId: 9001 }];
        if (/SELECT inventory_id FROM inventory/.test(sql)) return [[]];
        if (/INSERT INTO inventory/.test(sql)) return [{}];
        return [{}];
      }),
    };
  }

  const itemRaw = {
    itemId: '77',
    itemName: 'Test Item',
    itemBrandName: 'Test Brand',
    skus: [{ skuId: '12345', skuName: 'Test SKU', minFaceValue: 10, maxFaceValue: 10, skuPrice: 8, skuPriceCurrency: 'USD' }],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    db.transaction.mockImplementation(async (cb) => cb(fakeConn()));
    supplierLinksRepo.getCanonicalBrand.mockImplementation(async (b) => (b || '').toLowerCase());
  });

  test('genuinely new item, unlinked sku -> staged for review, product/sku tables never touched', async () => {
    db.queryOne.mockResolvedValueOnce(null); // findAndRefreshProduct: no existing product
    supplierLinksRepo.getLinkBySupplierRef.mockResolvedValueOnce(null);
    db.queryOne.mockResolvedValueOnce(null); // no product_sku by wgcards_sku_id either
    supplierLinksRepo.getStagingItemBySupplierRef.mockResolvedValueOnce(null);

    const result = await syncOneItem(itemRaw, 20);

    expect(result.outcomes).toMatchObject({ newly_staged: 1, link_refreshed: 0, sku_added: 0, topup_skipped: 0 });
    expect(supplierLinksRepo.upsertStagingItem).toHaveBeenCalledWith(
      expect.objectContaining({ supplier: 'wgcards', supplierRef: '77', supplierSkuRef: '12345', itemName: 'Test Item', costPrice: 8 })
    );
    expect(db.transaction).not.toHaveBeenCalled();
    expect(supplierLinksRepo.upsertLink).not.toHaveBeenCalled();
  });

  test('genuinely new item that is Direct Top-Up -> skipped entirely, never staged (client decision: never sold)', async () => {
    db.queryOne.mockResolvedValueOnce(null);
    supplierLinksRepo.getLinkBySupplierRef.mockResolvedValueOnce(null);
    db.queryOne.mockResolvedValueOnce(null);

    const result = await syncOneItem({ ...itemRaw, spuType: 5 }, 20);

    expect(result.outcomes).toMatchObject({ topup_skipped: 1, newly_staged: 0 });
    expect(supplierLinksRepo.upsertStagingItem).not.toHaveBeenCalled();
  });

  test('already linked -> refreshes product_skus + the link, no staging at all', async () => {
    db.queryOne.mockResolvedValueOnce({ product_id: 501 }); // findAndRefreshProduct finds it
    supplierLinksRepo.getLinkBySupplierRef.mockResolvedValueOnce({ sku_id: 9001 });

    const result = await syncOneItem(itemRaw, 20);

    expect(result.outcomes).toMatchObject({ link_refreshed: 1 });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE products SET'), expect.any(Array));
    expect(db.transaction).toHaveBeenCalledTimes(1); // the UPDATE product_skus + inventory-ensure transaction
    expect(supplierLinksRepo.upsertLink).toHaveBeenCalledWith(expect.objectContaining({ skuId: 9001, supplier: 'wgcards' }));
    expect(supplierLinksRepo.upsertStagingItem).not.toHaveBeenCalled();
  });

  test('product_sku already exists but its link row is missing -> backfills the link, does NOT stage (avoids a duplicate product)', async () => {
    db.queryOne.mockResolvedValueOnce(null); // no product found by spu_id (a pre-existing data gap)
    supplierLinksRepo.getLinkBySupplierRef.mockResolvedValueOnce(null);
    db.queryOne.mockResolvedValueOnce({ sku_id: 9001 }); // but the product_sku itself already exists

    const result = await syncOneItem(itemRaw, 20);

    expect(result.outcomes).toMatchObject({ link_backfilled: 1, newly_staged: 0 });
    expect(supplierLinksRepo.upsertLink).toHaveBeenCalledWith(expect.objectContaining({ skuId: 9001 }));
    expect(supplierLinksRepo.upsertStagingItem).not.toHaveBeenCalled();
  });

  test('a new denomination on an already-known item -> added directly, no review needed', async () => {
    db.queryOne.mockResolvedValueOnce({ product_id: 501 }); // the ITEM is already known
    supplierLinksRepo.getLinkBySupplierRef.mockResolvedValueOnce(null);
    db.queryOne.mockResolvedValueOnce(null); // but THIS sku hasn't been seen before

    const result = await syncOneItem(itemRaw, 20);

    expect(result.outcomes).toMatchObject({ sku_added: 1, newly_staged: 0 });
    expect(db.transaction).toHaveBeenCalledTimes(1); // the INSERT product_skus + inventory-ensure transaction
    expect(supplierLinksRepo.upsertLink).toHaveBeenCalledWith(expect.objectContaining({ skuId: 9001 }));
    expect(supplierLinksRepo.upsertStagingItem).not.toHaveBeenCalled();
  });

  test('a non-USD sku still syncs (no margin-inflated price) when staged, recorded in its real currency', async () => {
    const cnyItem = { ...itemRaw, skus: [{ ...itemRaw.skus[0], skuPrice: 41.39, skuPriceCurrency: 'CNY' }] };
    db.queryOne.mockResolvedValueOnce(null);
    supplierLinksRepo.getLinkBySupplierRef.mockResolvedValueOnce(null);
    db.queryOne.mockResolvedValueOnce(null);

    const result = await syncOneItem(cnyItem, 20);

    expect(result.outcomes.newly_staged).toBe(1);
    expect(supplierLinksRepo.upsertStagingItem).toHaveBeenCalledWith(
      expect.objectContaining({ costPrice: 41.39, currency: 'CNY' })
    );
  });

  test('a SKU with no skuPrice is skipped entirely — never reaches the DB or staging', async () => {
    db.queryOne.mockResolvedValueOnce(null); // findAndRefreshProduct

    const result = await syncOneItem({ itemId: '77', skus: [{ skuId: '999' }] }, 20);

    expect(result.outcomes.skipped_no_price).toBe(1);
    expect(supplierLinksRepo.upsertLink).not.toHaveBeenCalled();
    expect(supplierLinksRepo.upsertStagingItem).not.toHaveBeenCalled();
  });

  test('one bad sku does not take down its siblings — recorded per-sku in errors, everything else still syncs', async () => {
    const twoSkuItem = {
      ...itemRaw,
      skus: [
        { skuId: '1', skuName: 'A', minFaceValue: 1, maxFaceValue: 1, skuPrice: 1, skuPriceCurrency: 'USD' },
        { skuId: '2', skuName: 'B', minFaceValue: 2, maxFaceValue: 2, skuPrice: 2, skuPriceCurrency: 'USD' },
      ],
    };
    db.queryOne.mockResolvedValueOnce({ product_id: 501 }); // item already known
    supplierLinksRepo.getLinkBySupplierRef
      .mockResolvedValueOnce({ sku_id: 111 }) // sku 1: already linked
      .mockResolvedValueOnce({ sku_id: 222 }); // sku 2: already linked
    supplierLinksRepo.upsertLink
      .mockRejectedValueOnce(new Error('db blip')) // sku 1's link write fails
      .mockResolvedValueOnce(undefined); // sku 2 succeeds

    const result = await syncOneItem(twoSkuItem, 20);

    expect(result.errors).toEqual([{ skuId: '1', error: 'db blip' }]);
    expect(result.outcomes.link_refreshed).toBe(1); // only sku 2 counted as successful
  });
});
