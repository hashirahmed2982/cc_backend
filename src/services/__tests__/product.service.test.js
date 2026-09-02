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
});
