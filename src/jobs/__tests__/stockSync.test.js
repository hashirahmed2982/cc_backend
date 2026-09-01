'use strict';

jest.mock('../../config/database');
jest.mock('../../services/wgcards.service');
jest.mock('../../repositories/supplierConfig.repository');

const db = require('../../config/database');
const wgcardsService = require('../../services/wgcards.service');
const supplierConfigRepo = require('../../repositories/supplierConfig.repository');
const { run, chunk, deriveInventoryUpdate } = require('../stockSync');

describe('stockSync pure helpers', () => {
  describe('chunk', () => {
    test('splits evenly', () => {
      expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
    });

    test('splits with a smaller final chunk', () => {
      expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    });

    test('empty array -> no chunks', () => {
      expect(chunk([], 50)).toEqual([]);
    });

    test('array smaller than chunk size -> one chunk', () => {
      expect(chunk([1, 2], 50)).toEqual([[1, 2]]);
    });
  });

  describe('deriveInventoryUpdate', () => {
    test('number: -1 -> unlimited stock, quantity written as 0', () => {
      expect(deriveInventoryUpdate({ skuId: 'a', number: -1 })).toEqual({
        wgcardsSkuId: 'a', stockQuantity: 0, unlimitedStock: true,
      });
    });

    test('a real positive quantity is passed through', () => {
      expect(deriveInventoryUpdate({ skuId: 'b', number: 37 })).toEqual({
        wgcardsSkuId: 'b', stockQuantity: 37, unlimitedStock: false,
      });
    });

    test('zero stock is not confused with unlimited', () => {
      expect(deriveInventoryUpdate({ skuId: 'c', number: 0 })).toEqual({
        wgcardsSkuId: 'c', stockQuantity: 0, unlimitedStock: false,
      });
    });

    test('skuId is coerced to string (DB columns are VARCHAR)', () => {
      const result = deriveInventoryUpdate({ skuId: 123456, number: 5 });
      expect(result.wgcardsSkuId).toBe('123456');
    });
  });
});

describe('stockSync.run', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    supplierConfigRepo.getBySupplierName.mockResolvedValue({ is_active: 1, integration_status: 'healthy' });
  });

  test('supplier disabled by admin -> skips entirely, no DB/network calls', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ is_active: 0 });
    const result = await run();
    expect(result).toEqual({ skipped: true, reason: 'supplier_disabled' });
    expect(db.query).not.toHaveBeenCalled();
    expect(wgcardsService.getStock).not.toHaveBeenCalled();
  });

  test('batches SKUs, applies updates, and reports a stale count', async () => {
    db.query
      .mockResolvedValueOnce([{ wgcards_sku_id: 'a' }, { wgcards_sku_id: 'b' }, { wgcards_sku_id: 'c' }]) // getActiveWgCardsSkuIds
      .mockResolvedValueOnce(undefined) // applyStockUpdate for entry a
      .mockResolvedValueOnce(undefined) // applyStockUpdate for entry b
      .mockResolvedValueOnce(undefined); // applyStockUpdate for entry c
    db.queryOne.mockResolvedValueOnce({ n: 2 }); // countStaleInventory

    wgcardsService.getStock
      .mockResolvedValueOnce([{ skuId: 'a', number: 10 }, { skuId: 'b', number: -1 }]) // batch 1 (size 2)
      .mockResolvedValueOnce([{ skuId: 'c', number: 0 }]); // batch 2

    const summary = await run({ batchSize: 2, batchDelayMs: 0 });

    expect(wgcardsService.getStock).toHaveBeenCalledTimes(2);
    expect(wgcardsService.getStock).toHaveBeenNthCalledWith(1, ['a', 'b']);
    expect(wgcardsService.getStock).toHaveBeenNthCalledWith(2, ['c']);
    expect(summary).toMatchObject({
      totalSkus: 3, batches: 2, updated: 3, failedBatches: [], staleCount: 2,
    });
  });

  test('a failing batch is skipped, not retried, and does not abort the run', async () => {
    db.query
      .mockResolvedValueOnce([{ wgcards_sku_id: 'a' }, { wgcards_sku_id: 'b' }])
      .mockResolvedValueOnce(undefined); // applyStockUpdate for the surviving batch's entry
    db.queryOne.mockResolvedValueOnce({ n: 0 });

    wgcardsService.getStock
      .mockRejectedValueOnce(new Error('network timeout'))       // batch 1 fails
      .mockResolvedValueOnce([{ skuId: 'b', number: 5 }]);        // batch 2 succeeds

    const summary = await run({ batchSize: 1, batchDelayMs: 0 });

    expect(summary.updated).toBe(1);
    expect(summary.failedBatches).toEqual([
      { batchIndex: 0, skuIds: ['a'], error: 'network timeout' },
    ]);
    expect(summary.staleCount).toBe(0);
  });

  test('no active WgCards SKUs -> no-op, no getStock calls', async () => {
    db.query.mockResolvedValueOnce([]);
    db.queryOne.mockResolvedValueOnce({ n: 0 });

    const summary = await run();

    expect(wgcardsService.getStock).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ totalSkus: 0, batches: 0, updated: 0 });
  });
});
