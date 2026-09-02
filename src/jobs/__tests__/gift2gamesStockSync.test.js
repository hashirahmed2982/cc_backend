'use strict';

jest.mock('../../config/database');
jest.mock('../../services/gift2games.service', () => ({ getProducts: jest.fn() }));
jest.mock('../../repositories/supplierLinks.repository');
jest.mock('../../repositories/supplierConfig.repository');

const gift2gamesService = require('../../services/gift2games.service');
const supplierLinksRepo = require('../../repositories/supplierLinks.repository');
const supplierConfigRepo = require('../../repositories/supplierConfig.repository');
const { run } = require('../gift2gamesStockSync');

describe('gift2gamesStockSync.run', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    supplierConfigRepo.getBySupplierName.mockResolvedValue({ is_active: 1 });
  });

  test('supplier disabled by admin -> skips entirely, never calls getProducts', async () => {
    supplierConfigRepo.getBySupplierName.mockReset();
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ is_active: 0 });

    const result = await run();

    expect(result).toEqual({ skipped: true, reason: 'supplier_disabled' });
    expect(gift2gamesService.getProducts).not.toHaveBeenCalled();
  });

  test('an already-linked product gets its cost_price/stock_status refreshed', async () => {
    gift2gamesService.getProducts.mockResolvedValueOnce([
      { id: 111, price: 4.5, currency: 'USD', inStock: true, categoryId: 9 },
    ]);
    supplierLinksRepo.getLinkBySupplierRef.mockResolvedValueOnce({ sku_id: 42 });

    const summary = await run();

    expect(summary).toEqual({ totalProducts: 1, linksRefreshed: 1, notLinked: 0, errors: [] });
    expect(supplierLinksRepo.upsertLink).toHaveBeenCalledWith(
      expect.objectContaining({ skuId: 42, supplier: 'gift2games', supplierSkuRef: '111', costPrice: 4.5, stockStatus: 'in_stock' })
    );
  });

  test('an unlinked product is skipped — never upserted, never touches staging', async () => {
    gift2gamesService.getProducts.mockResolvedValueOnce([{ id: 222, price: 1, currency: 'USD', inStock: false }]);
    supplierLinksRepo.getLinkBySupplierRef.mockResolvedValueOnce(null);

    const summary = await run();

    expect(summary).toEqual({ totalProducts: 1, linksRefreshed: 0, notLinked: 1, errors: [] });
    expect(supplierLinksRepo.upsertLink).not.toHaveBeenCalled();
  });

  test('out of stock is reflected correctly', async () => {
    gift2gamesService.getProducts.mockResolvedValueOnce([{ id: 111, price: 4.5, currency: 'USD', inStock: false }]);
    supplierLinksRepo.getLinkBySupplierRef.mockResolvedValueOnce({ sku_id: 42 });

    await run();

    expect(supplierLinksRepo.upsertLink).toHaveBeenCalledWith(expect.objectContaining({ stockStatus: 'out_of_stock' }));
  });

  test('a per-product failure is logged and does not abort the rest of the run', async () => {
    gift2gamesService.getProducts.mockResolvedValueOnce([
      { id: 111, price: 4.5, currency: 'USD', inStock: true },
      { id: 222, price: 1, currency: 'USD', inStock: true },
    ]);
    supplierLinksRepo.getLinkBySupplierRef
      .mockResolvedValueOnce({ sku_id: 42 })
      .mockResolvedValueOnce({ sku_id: 43 });
    supplierLinksRepo.upsertLink
      .mockRejectedValueOnce(new Error('db blip'))
      .mockResolvedValueOnce(undefined);

    const summary = await run();

    expect(summary.linksRefreshed).toBe(1);
    expect(summary.errors).toEqual([{ productId: 111, error: 'db blip' }]);
  });
});
