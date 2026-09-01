'use strict';

jest.mock('../../services/gift2games.service', () => ({ getProducts: jest.fn() }));
jest.mock('../../repositories/supplierLinks.repository');
jest.mock('../../repositories/supplierConfig.repository');

const gift2gamesService = require('../../services/gift2games.service');
const supplierLinksRepo = require('../../repositories/supplierLinks.repository');
const supplierConfigRepo = require('../../repositories/supplierConfig.repository');
const { run, deriveBrandFromTitle, buildMatchKey, syncOneProduct } = require('../gift2gamesCatalogSync');

describe('deriveBrandFromTitle', () => {
  test('splits on the first " - "', () => {
    expect(deriveBrandFromTitle('MOBILE LEGENDS - 11 DIAMONDS')).toBe('MOBILE LEGENDS');
  });
  test('a title with multiple " - " only splits on the first', () => {
    expect(deriveBrandFromTitle('RAZER GOLD - 500 CL - BONUS')).toBe('RAZER GOLD');
  });
  test('no separator -> whole title is the "brand"', () => {
    expect(deriveBrandFromTitle('STEAM WALLET')).toBe('STEAM WALLET');
  });
  test('empty/null title -> empty string, no crash', () => {
    expect(deriveBrandFromTitle('')).toBe('');
    expect(deriveBrandFromTitle(null)).toBe('');
  });
});

describe('buildMatchKey', () => {
  beforeEach(() => jest.clearAllMocks());

  test('combines the canonical brand, face value, and currency', async () => {
    supplierLinksRepo.getCanonicalBrand.mockResolvedValueOnce('mobile legends');
    const key = await buildMatchKey({ title: 'MOBILE LEGENDS - 11 DIAMONDS', productFaceValue: 0.2, productFaceValueCurrency: 'USD' });
    expect(key).toBe('mobile legends|0.20|USD');
  });

  test('falls back to currency when productFaceValueCurrency is empty (confirmed live: some products have this blank)', async () => {
    supplierLinksRepo.getCanonicalBrand.mockResolvedValueOnce('razer gold');
    const key = await buildMatchKey({ title: 'RAZER GOLD - 500 CL', productFaceValue: 500, productFaceValueCurrency: '', currency: 'USD' });
    expect(key).toBe('razer gold|500.00|USD');
  });
});

describe('gift2gamesCatalogSync.run', () => {
  beforeEach(() => jest.clearAllMocks());

  test('supplier disabled by admin -> skips entirely, never calls getProducts', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ is_active: 0 });

    const result = await run();

    expect(result).toEqual({ skipped: true, reason: 'supplier_disabled' });
    expect(gift2gamesService.getProducts).not.toHaveBeenCalled();
  });

  test('a new unlinked product is staged for review, no link created', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ is_active: 1 });
    gift2gamesService.getProducts.mockResolvedValueOnce([
      { id: '1048', categoryId: '69', title: 'MOBILE LEGENDS - 11 DIAMONDS', price: 0.21, currency: 'USD', inStock: true, productFaceValue: 0.2, productFaceValueCurrency: 'USD' },
    ]);
    supplierLinksRepo.getLinkBySupplierRef.mockResolvedValueOnce(null);
    supplierLinksRepo.getStagingItemBySupplierRef.mockResolvedValueOnce(null);
    supplierLinksRepo.getCanonicalBrand.mockResolvedValueOnce('mobile legends');

    const result = await run();

    expect(result).toMatchObject({ totalProducts: 1, newlyStaged: 1, linksRefreshed: 0, stagingRefreshed: 0 });
    expect(supplierLinksRepo.upsertLink).not.toHaveBeenCalled();
    expect(supplierLinksRepo.upsertStagingItem).toHaveBeenCalledWith(
      expect.objectContaining({ supplier: 'gift2games', supplierSkuRef: '1048', itemName: 'MOBILE LEGENDS - 11 DIAMONDS', brandName: 'MOBILE LEGENDS', region: null })
    );
  });

  test('an already-linked product only refreshes cost/stock on the existing link, never re-stages', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ is_active: 1 });
    gift2gamesService.getProducts.mockResolvedValueOnce([
      { id: '1048', categoryId: '69', title: 'MOBILE LEGENDS - 11 DIAMONDS', price: 0.25, currency: 'USD', inStock: false },
    ]);
    supplierLinksRepo.getLinkBySupplierRef.mockResolvedValueOnce({ sku_id: 42, link_id: 1 });

    const result = await run();

    expect(result).toMatchObject({ linksRefreshed: 1, newlyStaged: 0 });
    expect(supplierLinksRepo.upsertStagingItem).not.toHaveBeenCalled();
    expect(supplierLinksRepo.upsertLink).toHaveBeenCalledWith(
      expect.objectContaining({ skuId: 42, supplier: 'gift2games', supplierSkuRef: '1048', costPrice: 0.25, stockStatus: 'out_of_stock' })
    );
  });

  test('re-syncing an item already staged (not yet reviewed) counts as refreshed, not newly staged', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ is_active: 1 });
    gift2gamesService.getProducts.mockResolvedValueOnce([
      { id: '1048', title: 'MOBILE LEGENDS - 11 DIAMONDS', price: 0.21, currency: 'USD', inStock: true },
    ]);
    supplierLinksRepo.getLinkBySupplierRef.mockResolvedValueOnce(null);
    supplierLinksRepo.getStagingItemBySupplierRef.mockResolvedValueOnce({ staging_id: 5, status: 'pending_review' });
    supplierLinksRepo.getCanonicalBrand.mockResolvedValueOnce('mobile legends');

    const result = await run();

    expect(result).toMatchObject({ newlyStaged: 0, stagingRefreshed: 1 });
  });

  test('one product failing does not abort the rest of the batch', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ is_active: 1 });
    gift2gamesService.getProducts.mockResolvedValueOnce([
      { id: '1', title: 'A', price: 1, currency: 'USD', inStock: true },
      { id: '2', title: 'B', price: 2, currency: 'USD', inStock: true },
    ]);
    supplierLinksRepo.getLinkBySupplierRef
      .mockRejectedValueOnce(new Error('db blip'))
      .mockResolvedValueOnce(null);
    supplierLinksRepo.getStagingItemBySupplierRef.mockResolvedValueOnce(null);
    supplierLinksRepo.getCanonicalBrand.mockResolvedValue('b');

    const result = await run();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ productId: '1' });
    expect(result.newlyStaged).toBe(1); // product 2 still succeeded
  });
});
