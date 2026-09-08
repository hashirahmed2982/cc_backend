'use strict';

jest.mock('../../config/database', () => ({
  getConnection: jest.fn(),
  query: jest.fn(),
  queryOne: jest.fn(),
}));
jest.mock('../../repositories/supplierLinks.repository');
jest.mock('../wgcards.service');
jest.mock('../gift2games.service');

const db = require('../../config/database');
const supplierLinksRepo = require('../../repositories/supplierLinks.repository');
const wgcardsService = require('../wgcards.service');
const gift2gamesService = require('../gift2games.service');
const productService = require('../product.service');

function fakeConn() {
  return {
    execute: jest.fn().mockResolvedValue([{ insertId: 1 }]),
    beginTransaction: jest.fn(),
    commit: jest.fn(),
    rollback: jest.fn(),
    release: jest.fn(),
  };
}

describe('product.service price guard (admin cannot undercut supplier/internal cost)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no linked suppliers — most tests here don't care about the
    // linked-supplier price guard, only individual tests below override it.
    supplierLinksRepo.getActiveLinksForSku.mockResolvedValue([]);
  });

  describe('createInternal', () => {
    test('rejects a selling price below the given discountPrice (cost)', async () => {
      db.getConnection.mockResolvedValueOnce(fakeConn());
      await expect(
        productService.createInternal({ name: 'X', price: 5, discountPrice: 10 }, 1)
      ).rejects.toThrow(/cannot be lower than cost price/);
    });

    test('allows a selling price at or above cost', async () => {
      const conn = fakeConn();
      db.getConnection.mockResolvedValueOnce(conn);
      db.query.mockResolvedValueOnce([{ product_id: 1 }]); // getById -> PRODUCT_SELECT
      await productService.createInternal({ name: 'X', price: 10, discountPrice: 5 }, 1);
      expect(conn.commit).toHaveBeenCalled();
      expect(conn.rollback).not.toHaveBeenCalled();
    });
  });

  describe('createSupplier', () => {
    test('rejects a selling price below the given costPrice', async () => {
      db.getConnection.mockResolvedValueOnce(fakeConn());
      await expect(
        productService.createSupplier(
          { name: 'X', price: 5, costPrice: 10, supplierName: 'wgcards', supplierRef: 'r1' }, 1
        )
      ).rejects.toThrow(/cannot be lower than cost price/);
    });
  });

  describe('update', () => {
    test('internal product: rejects lowering price below the (also admin-editable) cost', async () => {
      db.queryOne
        .mockResolvedValueOnce({ source: 'internal' })
        .mockResolvedValueOnce({ sku_id: 9, cost_price: 8, price_currency: 'USD' });

      await expect(
        productService.update(1, { price: 5, discountPrice: 8 }, 1)
      ).rejects.toThrow(/cannot be lower than cost price/);
    });

    test('supplier product: an admin-submitted costPrice in the request is IGNORED — guard uses the DB-authoritative cost', async () => {
      db.queryOne
        .mockResolvedValueOnce({ source: 'wgcards' })
        .mockResolvedValueOnce({ sku_id: 9, cost_price: 8, price_currency: 'USD' });
      db.query.mockResolvedValueOnce([{ product_id: 1 }]); // getById

      // Admin tries to sneak costPrice down to 1 alongside a $5 price —
      // without the fix this would pass (5 >= 1); with it, the DB's real
      // cost_price (8) is what's checked, and 5 < 8 must still fail.
      await expect(
        productService.update(1, { price: 5, costPrice: 1 }, 1)
      ).rejects.toThrow(/cannot be lower than cost price \(\$8\.00\)/);
    });

    test('supplier product: a legitimately profitable price is still accepted, and the UPDATE never touches cost_price', async () => {
      db.queryOne
        .mockResolvedValueOnce({ source: 'wgcards' })
        .mockResolvedValueOnce({ sku_id: 9, cost_price: 8, price_currency: 'USD' });
      db.query.mockResolvedValueOnce([{ product_id: 1 }]); // getById

      await productService.update(1, { price: 12 }, 1);

      const updateCall = db.query.mock.calls.find(([sql]) => sql.includes('UPDATE product_skus'));
      expect(updateCall[0]).not.toMatch(/cost_price\s*=/);
    });

    test('supplier product with a non-USD recorded cost: refuses to compare, clear error', async () => {
      db.queryOne
        .mockResolvedValueOnce({ source: 'wgcards' })
        .mockResolvedValueOnce({ sku_id: 9, cost_price: 41.39, price_currency: 'CNY' });

      await expect(
        productService.update(1, { price: 100 }, 1)
      ).rejects.toThrow(/not USD/);
    });

    // Real report: "when i edit a product price from products page i am
    // able to set a lower price than the cost price if any supplier
    // product is linked." The guard above only ever checked
    // product_skus.cost_price (this SKU's own recorded cost) — an
    // internal product that later had a $550-cost supplier linked via
    // confirmLink kept whatever low cost_price/discountPrice it already
    // had, completely blind to the linked supplier's real cost.
    test("internal product with a linked supplier whose cost is HIGHER than the SKU's own recorded cost -> still blocked, even though the own-basis check alone would pass", async () => {
      db.queryOne
        .mockResolvedValueOnce({ source: 'internal' })
        .mockResolvedValueOnce({ sku_id: 9, cost_price: 8, price_currency: 'USD' });
      // Own-basis check (5 >= discountPrice 3) would pass on its own —
      // the linked supplier's real cost (550) is the one that must block it.
      supplierLinksRepo.getActiveLinksForSku.mockResolvedValueOnce([
        { supplier: 'gift2games', cost_price: 550, cost_currency: 'USD' },
      ]);

      await expect(
        productService.update(1, { price: 5, discountPrice: 3 }, 1)
      ).rejects.toThrow(/Linked gift2games supplier: Selling price \(\$5\.00\) cannot be lower than cost price \(\$550\.00\)/);
    });

    test('multiple linked suppliers -> checked against EVERY one, not just the cheapest', async () => {
      db.queryOne
        .mockResolvedValueOnce({ source: 'internal' })
        .mockResolvedValueOnce({ sku_id: 9, cost_price: 8, price_currency: 'USD' });
      supplierLinksRepo.getActiveLinksForSku.mockResolvedValueOnce([
        { supplier: 'wgcards', cost_price: 10, cost_currency: 'USD' },   // cheaper, would pass alone
        { supplier: 'gift2games', cost_price: 550, cost_currency: 'USD' }, // pricier, must still block
      ]);

      await expect(
        productService.update(1, { price: 20, discountPrice: 8 }, 1)
      ).rejects.toThrow(/Linked gift2games supplier/);
    });

    test('a linked supplier cost recorded in a non-USD currency -> blocked outright, not silently skipped', async () => {
      db.queryOne
        .mockResolvedValueOnce({ source: 'internal' })
        .mockResolvedValueOnce({ sku_id: 9, cost_price: 8, price_currency: 'USD' });
      supplierLinksRepo.getActiveLinksForSku.mockResolvedValueOnce([
        { supplier: 'wgcards', cost_price: 41.39, cost_currency: 'CNY' },
      ]);

      await expect(
        productService.update(1, { price: 100, discountPrice: 8 }, 1)
      ).rejects.toThrow(/Linked wgcards supplier:.*not USD/);
    });

    test('a price that clears every linked supplier AND the own cost basis -> accepted', async () => {
      db.queryOne
        .mockResolvedValueOnce({ source: 'internal' })
        .mockResolvedValueOnce({ sku_id: 9, cost_price: 8, price_currency: 'USD' });
      db.query.mockResolvedValueOnce([{ product_id: 1 }]); // getById
      supplierLinksRepo.getActiveLinksForSku.mockResolvedValueOnce([
        { supplier: 'wgcards', cost_price: 10, cost_currency: 'USD' },
      ]);

      await expect(productService.update(1, { price: 15, discountPrice: 8 }, 1)).resolves.toBeDefined();
    });
  });

  // Real production error: "productService.bulkSetStatus is not a function"
  // when selecting all products on a page and activating/deactivating —
  // product.controller.js#bulkSetStatus calls this for the plain
  // productIds path (as opposed to bulkSetStatusByFilter's
  // selectAllMatching path), and it simply didn't exist.
  describe('bulkSetStatus', () => {
    // mockReset (not just clearAllMocks — earlier describe blocks in this
    // file leave unconsumed queued mockResolvedValueOnce values on
    // db.query/db.queryOne, which clearAllMocks alone doesn't drop) so
    // this block starts from a genuinely clean slate every test.
    beforeEach(() => { db.query.mockReset(); db.queryOne.mockReset(); });

    test('updates exactly the given product ids, returns the real affected-row count', async () => {
      db.query.mockResolvedValueOnce({ affectedRows: 3 });

      const result = await productService.bulkSetStatus(['1', '2', '3'], true, 7);

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE product_id IN (?,?,?)'),
        [1, 7, 1, 2, 3]
      );
      expect(result).toEqual({ updated: 3, status: 'active' });
    });

    test('deactivating sets is_active = 0', async () => {
      db.query.mockResolvedValueOnce({ affectedRows: 1 });
      const result = await productService.bulkSetStatus([5], false, 7);
      expect(db.query).toHaveBeenCalledWith(expect.any(String), [0, 7, 5]);
      expect(result.status).toBe('inactive');
    });

    test('empty/invalid id list -> no query at all, zero updated', async () => {
      const result = await productService.bulkSetStatus([], true, 7);
      expect(db.query).not.toHaveBeenCalled();
      expect(result).toEqual({ updated: 0, status: 'active' });
    });

    test('a stale id that no longer matches any row is reflected in the real affectedRows, not the input length', async () => {
      db.query.mockResolvedValueOnce({ affectedRows: 1 }); // only 1 of 2 ids still existed
      const result = await productService.bulkSetStatus([1, 999], true, 7);
      expect(result.updated).toBe(1);
    });
  });

  // Real request: "when products are linked... in type column I want to
  // see all types the product has... since they are linked" — a product
  // can pick up sku_supplier_links from Link Products confirmLink without
  // products.source ever changing, so the Type column needs every source,
  // not just the one column.
  describe('_format: linkedSources', () => {
    test('internal product with no supplier links -> just [internal]', () => {
      const result = productService._format({ product_id: 1, product_name: 'X', source: null, linked_suppliers: null });
      expect(result.linkedSources).toEqual(['internal']);
    });

    test('internal product that later got a wgcards + gift2games link via confirmLink -> all three, no duplicates', () => {
      const result = productService._format({
        product_id: 1, product_name: 'X', source: 'internal', linked_suppliers: 'gift2games,wgcards',
      });
      expect(result.linkedSources).toEqual(['internal', 'gift2games', 'wgcards']);
    });

    test('pure supplier product whose own source already matches its only link -> no duplicate entry', () => {
      const result = productService._format({
        product_id: 1, product_name: 'X', source: 'wgcards', linked_suppliers: 'wgcards',
      });
      expect(result.linkedSources).toEqual(['wgcards']);
    });

    test('wgcards-sourced product that also picked up a gift2games link -> both, own source first', () => {
      const result = productService._format({
        product_id: 1, product_name: 'X', source: 'wgcards', linked_suppliers: 'gift2games,wgcards',
      });
      expect(result.linkedSources).toEqual(['wgcards', 'gift2games']);
    });
  });

  // Real gap this closes (audit finding #8): this used to be a stub that
  // always returned available:true for any supplier-sourced product
  // regardless of real stock. Now actually asks the supplier.
  describe('checkSupplierStock', () => {
    beforeEach(() => jest.clearAllMocks());

    test('internal product: unchanged, uses local availableCodes/stockLevel, no supplier call', async () => {
      jest.spyOn(productService, 'getById').mockResolvedValueOnce({
        source: 'internal', availableCodes: 5, totalCodes: 10, price: 9.99,
      });

      const result = await productService.checkSupplierStock(1);

      expect(result).toMatchObject({ available: true, price: 9.99 });
      expect(wgcardsService.getStock).not.toHaveBeenCalled();
      expect(gift2gamesService.getProducts).not.toHaveBeenCalled();
    });

    test('wgcards product: a real positive quantity from getStock -> available, live, with the remote count', async () => {
      jest.spyOn(productService, 'getById').mockResolvedValueOnce({
        source: 'wgcards', supplierSkuRef: '12345', price: 4.5,
      });
      wgcardsService.getStock.mockResolvedValueOnce([{ skuId: '12345', number: 7 }]);

      const result = await productService.checkSupplierStock(1);

      expect(wgcardsService.getStock).toHaveBeenCalledWith(['12345']);
      expect(result).toEqual({ available: true, stockLevel: 'live', price: 4.5, remoteQuantity: 7 });
    });

    test('wgcards product: number -1 is the unlimited sentinel, not "-1 in stock"', async () => {
      jest.spyOn(productService, 'getById').mockResolvedValueOnce({ source: 'wgcards', supplierSkuRef: '12345', price: 4.5 });
      wgcardsService.getStock.mockResolvedValueOnce([{ skuId: '12345', number: -1 }]);

      const result = await productService.checkSupplierStock(1);

      expect(result).toEqual({ available: true, stockLevel: 'unlimited', price: 4.5, remoteQuantity: null });
    });

    test('wgcards product: zero stock -> available:false, out_of_stock, never claims true', async () => {
      jest.spyOn(productService, 'getById').mockResolvedValueOnce({ source: 'wgcards', supplierSkuRef: '12345', price: 4.5 });
      wgcardsService.getStock.mockResolvedValueOnce([{ skuId: '12345', number: 0 }]);

      const result = await productService.checkSupplierStock(1);

      expect(result).toEqual({ available: false, stockLevel: 'out_of_stock', price: 4.5, remoteQuantity: 0 });
    });

    test('wgcards product: getStock returns no matching entry -> honest "unknown", not a lie', async () => {
      jest.spyOn(productService, 'getById').mockResolvedValueOnce({ source: 'wgcards', supplierSkuRef: '12345', price: 4.5 });
      wgcardsService.getStock.mockResolvedValueOnce([]);

      const result = await productService.checkSupplierStock(1);

      expect(result).toMatchObject({ available: false, stockLevel: 'unknown' });
    });

    test('gift2games product: inStock true/false is read straight from getProducts', async () => {
      jest.spyOn(productService, 'getById')
        .mockResolvedValueOnce({ source: 'gift2games', supplierSkuRef: '999', price: 2.5 })
        .mockResolvedValueOnce({ source: 'gift2games', supplierSkuRef: '999', price: 2.5 });
      gift2gamesService.getProducts
        .mockResolvedValueOnce([{ id: '999', inStock: true }])
        .mockResolvedValueOnce([{ id: '999', inStock: false }]);

      const inStockResult = await productService.checkSupplierStock(1);
      expect(gift2gamesService.getProducts).toHaveBeenCalledWith({ ids: ['999'] });
      expect(inStockResult).toMatchObject({ available: true, stockLevel: 'live' });

      const outOfStockResult = await productService.checkSupplierStock(1);
      expect(outOfStockResult).toMatchObject({ available: false, stockLevel: 'out_of_stock' });
    });

    test('no supplierSkuRef recorded -> refuses to check rather than guessing', async () => {
      jest.spyOn(productService, 'getById').mockResolvedValueOnce({ source: 'wgcards', supplierSkuRef: null, price: 4.5 });

      const result = await productService.checkSupplierStock(1);

      expect(result).toMatchObject({ available: false, stockLevel: 'unknown' });
      expect(wgcardsService.getStock).not.toHaveBeenCalled();
    });
  });
});
