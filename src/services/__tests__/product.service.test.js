'use strict';

jest.mock('../../config/database', () => ({
  getConnection: jest.fn(),
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const db = require('../../config/database');
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
  beforeEach(() => jest.clearAllMocks());

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
});
