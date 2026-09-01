'use strict';

jest.mock('../../repositories/supplierConfig.repository');

const supplierConfigRepo = require('../../repositories/supplierConfig.repository');
const { run, mapFaceValue, computeDefaultSellingPrice, mapSkuForUpsert } = require('../catalogSync');

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
    test('maps a real live-sandbox sku record end to end', () => {
      // Straight from the live getItem response captured during testing.
      const sku = {
        maxFaceValue: 10,
        maxPrice: 41.39,
        minFaceValue: 10,
        minPrice: 41.39,
        skuId: '12182768136',
        skuName: 'MLBB',
        skuPrice: 41.39,
        skuPriceCurrency: 'CNY',
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
        priceCurrency: 'CNY',
        defaultSellingPrice: 49.67,
      });
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
