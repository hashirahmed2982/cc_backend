'use strict';

jest.mock('../../repositories/supplierConfig.repository');
jest.mock('../../repositories/supplierLinks.repository');
jest.mock('../../config/database');
jest.mock('../../services/wgcards.service');

const supplierConfigRepo = require('../../repositories/supplierConfig.repository');
const supplierLinksRepo = require('../../repositories/supplierLinks.repository');
const db = require('../../config/database');
const wgcardsService = require('../../services/wgcards.service');
const { run, mapFaceValue, computeDefaultSellingPrice, mapSkuForUpsert, composeProductName, buildMatchKey, syncOneItem } = require('../catalogSync');

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

  describe('composeProductName — one product per SKU, so the denomination must be in the name', () => {
    test('fixed face value -> item name + face value + currency', () => {
      const name = composeProductName(
        { itemName: 'Nintendo Japan' },
        { faceValue: 50, priceCurrency: 'JPY', skuName: '50 JPY' }
      );
      expect(name).toBe('Nintendo Japan - 50 JPY');
    });

    test('no face value but a distinct sku name -> item name + sku name', () => {
      const name = composeProductName(
        { itemName: 'WebMoney' },
        { faceValue: null, priceCurrency: 'USD', skuName: 'WMZ Voucher' }
      );
      expect(name).toBe('WebMoney - WMZ Voucher');
    });

    test('no face value and sku name matches item name -> item name alone, not duplicated', () => {
      const name = composeProductName(
        { itemName: 'Some Item' },
        { faceValue: null, priceCurrency: 'USD', skuName: 'Some Item' }
      );
      expect(name).toBe('Some Item');
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

  test('a later page fetch failing does not abort the rest of the catalog — remaining pages still get tried', async () => {
    // Confirmed live (2026-11-12): WgCards rejected one page outright with
    // a business error (catalog.sku_price.unavailable) and the whole sync
    // died, leaving every later page unprocessed.
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ is_active: 1 });
    db.queryOne.mockResolvedValueOnce({ setting_value: '20' }); // getDefaultMarginPercent
    wgcardsService.getItem
      .mockResolvedValueOnce({ pages: 3, records: [] })
      .mockRejectedValueOnce(new Error('WgCards getItemAndStock failed: HTTP 400 (catalog.sku_price.unavailable)'))
      .mockResolvedValueOnce({ pages: 3, records: [] });

    jest.useFakeTimers();
    const runPromise = run();
    await jest.runAllTimersAsync();
    const result = await runPromise;
    jest.useRealTimers();

    expect(wgcardsService.getItem).toHaveBeenCalledTimes(3); // page 2's failure didn't stop page 3 from being fetched
    expect(result.errors).toEqual([{ page: 2, error: expect.stringContaining('catalog.sku_price.unavailable') }]);
  });

  test('the very first page failing stops the sync rather than looping forever (total page count is genuinely unknown)', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ is_active: 1 });
    db.queryOne.mockResolvedValueOnce({ setting_value: '20' });
    wgcardsService.getItem.mockRejectedValueOnce(new Error('timeout of 15000ms exceeded'));

    const result = await run();

    expect(wgcardsService.getItem).toHaveBeenCalledTimes(1); // no runaway retry loop
    expect(result.errors).toEqual([{ page: 1, error: 'timeout of 15000ms exceeded' }]);
  });
});

describe('catalogSync.syncOneItem — one product per SKU (migration 019), routed through Master Plan §9.2 staging', () => {
  function fakeConn() {
    return {
      execute: jest.fn(async (sql) => {
        if (/UPDATE product_skus SET/.test(sql)) return [{}];
        if (/UPDATE products SET/.test(sql)) return [{}];
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

  test('genuinely new sku -> staged for review, product/sku tables never touched', async () => {
    db.queryOne.mockResolvedValueOnce(null); // no product_skus row for this wgcards_sku_id
    supplierLinksRepo.getStagingItemBySupplierRef.mockResolvedValueOnce(null);

    const result = await syncOneItem(itemRaw, 20);

    expect(result.outcomes).toMatchObject({ newly_staged: 1, link_refreshed: 0, topup_skipped: 0, custom_value_skipped: 0 });
    expect(supplierLinksRepo.upsertStagingItem).toHaveBeenCalledWith(
      // faceValueCurrency mirrors currency for WgCards — it has no separate
      // face-value-currency field the way Gift2Games does (see migration 016).
      expect.objectContaining({ supplier: 'wgcards', supplierRef: '77', supplierSkuRef: '12345', itemName: 'Test Item', costPrice: 8, currency: 'USD', faceValueCurrency: 'USD' })
    );
    expect(db.transaction).not.toHaveBeenCalled();
    expect(supplierLinksRepo.upsertLink).not.toHaveBeenCalled();
    expect(supplierLinksRepo.getLinkBySupplierRef).not.toHaveBeenCalled(); // never-seen sku short-circuits before the link check
  });

  test('genuinely new sku that is Direct Top-Up -> skipped entirely, never staged (client decision: never sold)', async () => {
    db.queryOne.mockResolvedValueOnce(null);

    const result = await syncOneItem({ ...itemRaw, spuType: 5 }, 20);

    expect(result.outcomes).toMatchObject({ topup_skipped: 1, newly_staged: 0 });
    expect(supplierLinksRepo.upsertStagingItem).not.toHaveBeenCalled();
  });

  test('genuinely new sku that is floating/custom-value (min !== max) -> skipped entirely, never staged (no amount-entry flow in checkout)', async () => {
    const customValueItem = {
      ...itemRaw,
      skus: [{ skuId: '999', skuName: 'Custom Topup', minFaceValue: 5, maxFaceValue: 500, skuPrice: 1, skuPriceCurrency: 'USD' }],
    };
    db.queryOne.mockResolvedValueOnce(null);

    const result = await syncOneItem(customValueItem, 20);

    expect(result.outcomes).toMatchObject({ custom_value_skipped: 1, newly_staged: 0, topup_skipped: 0 });
    expect(supplierLinksRepo.upsertStagingItem).not.toHaveBeenCalled();
  });

  test('a new denomination on an already-known ITEM is still a brand-new SKU -> staged, not auto-added (denominations are independent, not variants)', async () => {
    // Confirmed directly by WgCards (2026-11-15): sibling denominations of
    // the same item are sold/ordered independently — "already known item"
    // no longer shortcuts a new sku straight into product_skus.
    db.queryOne.mockResolvedValueOnce(null); // this exact wgcards_sku_id has never been catalogued

    const result = await syncOneItem(itemRaw, 20);

    expect(result.outcomes).toMatchObject({ newly_staged: 1 });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(supplierLinksRepo.upsertStagingItem).toHaveBeenCalled();
  });

  test('already catalogued and linked -> refreshes product_skus + its one product + the link, no staging at all', async () => {
    db.queryOne.mockResolvedValueOnce({ sku_id: 9001, product_id: 501 });
    supplierLinksRepo.getLinkBySupplierRef.mockResolvedValueOnce({ sku_id: 9001 });

    const result = await syncOneItem(itemRaw, 20);

    expect(result.outcomes).toMatchObject({ link_refreshed: 1 });
    expect(db.transaction).toHaveBeenCalledTimes(1); // product + sku + inventory-ensure, one transaction
    expect(supplierLinksRepo.upsertLink).toHaveBeenCalledWith(expect.objectContaining({ skuId: 9001, supplier: 'wgcards' }));
    expect(supplierLinksRepo.upsertStagingItem).not.toHaveBeenCalled();
  });

  test('already catalogued, but live cost rose above the existing selling_price -> auto-bumps selling_price (default margin) and flags needs_review instead of violating chk_prices', async () => {
    // Confirmed live on UAT (2026-10-17): a real WgCards SKU's cost went
    // up past its already-set selling_price and the plain UPDATE in
    // refreshSku threw "Check constraint 'chk_prices' is violated."
    db.queryOne.mockResolvedValueOnce({ sku_id: 9001, product_id: 501 });
    supplierLinksRepo.getLinkBySupplierRef.mockResolvedValueOnce({ sku_id: 9001 });
    const execute = jest.fn(async (sql) => {
      if (/SELECT selling_price FROM product_skus/.test(sql)) return [[{ selling_price: 7 }]]; // existing price: $7, below the incoming cost of $8
      if (/UPDATE product_skus SET/.test(sql)) return [{}];
      if (/UPDATE products SET/.test(sql)) return [{}];
      if (/SELECT inventory_id FROM inventory/.test(sql)) return [[]];
      if (/INSERT INTO inventory/.test(sql)) return [{}];
      return [{}];
    });
    db.transaction.mockImplementation(async (cb) => cb({ execute }));

    const result = await syncOneItem(itemRaw, 20); // margin 20% -> computeDefaultSellingPrice(8, 20) = 9.6

    expect(result.outcomes).toMatchObject({ link_refreshed: 1 });
    const updateCall = execute.mock.calls.find(([sql]) => /UPDATE product_skus SET/.test(sql));
    expect(updateCall[0]).toContain('needs_review = 1');
    expect(updateCall[1]).toEqual(expect.arrayContaining([9.6])); // bumped selling_price
  });

  test('product_sku already exists but its link row is missing -> backfills the link, does NOT stage (avoids a duplicate product)', async () => {
    db.queryOne.mockResolvedValueOnce({ sku_id: 9001, product_id: 501 }); // the product_sku itself already exists
    supplierLinksRepo.getLinkBySupplierRef.mockResolvedValueOnce(null); // but its link row is a pre-existing data gap

    const result = await syncOneItem(itemRaw, 20);

    expect(result.outcomes).toMatchObject({ link_backfilled: 1, newly_staged: 0 });
    expect(supplierLinksRepo.upsertLink).toHaveBeenCalledWith(expect.objectContaining({ skuId: 9001 }));
    expect(supplierLinksRepo.upsertStagingItem).not.toHaveBeenCalled();
  });

  test('a non-USD sku still syncs (no margin-inflated price) when staged, recorded in its real currency', async () => {
    const cnyItem = { ...itemRaw, skus: [{ ...itemRaw.skus[0], skuPrice: 41.39, skuPriceCurrency: 'CNY' }] };
    db.queryOne.mockResolvedValueOnce(null);

    const result = await syncOneItem(cnyItem, 20);

    expect(result.outcomes.newly_staged).toBe(1);
    expect(supplierLinksRepo.upsertStagingItem).toHaveBeenCalledWith(
      expect.objectContaining({ costPrice: 41.39, currency: 'CNY' })
    );
  });

  test('a SKU with no skuPrice is skipped entirely — never reaches the DB or staging', async () => {
    const result = await syncOneItem({ itemId: '77', skus: [{ skuId: '999' }] }, 20);

    expect(result.outcomes.skipped_no_price).toBe(1);
    expect(db.queryOne).not.toHaveBeenCalled();
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
    db.queryOne
      .mockResolvedValueOnce({ sku_id: 111, product_id: 501 }) // sku 1: already catalogued
      .mockResolvedValueOnce({ sku_id: 222, product_id: 501 }); // sku 2: already catalogued
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
