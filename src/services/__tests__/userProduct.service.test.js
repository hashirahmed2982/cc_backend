'use strict';

jest.mock('../../config/database', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const db = require('../../config/database');
const userProductService = require('../userProduct.service');

// A supplier-linked internal product must not show a low/zero local code
// count to the customer — Master Plan §9's confirmLink attaches a supplier
// to an existing internal product without ever touching products.source,
// so gating on products.source alone (the old bug) still reported the raw
// local digital_codes count for these products.
describe('userProductService.getClientProducts — real-time stock for supplier-linked products', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.queryOne.mockResolvedValue({ n: 1 });
  });

  test('pure internal product with no supplier link: shows its real local code count', async () => {
    db.query.mockResolvedValueOnce([
      { id: 1, name: 'X', source: 'internal', price: 10, regularPrice: 10, hasCustomPrice: 0, availableCodes: 3, unlimitedStock: 0, hasSupplierLink: 0 },
    ]);
    const result = await userProductService.getClientProducts(1, {});
    expect(result.data[0].availableCodes).toBe(3);
    expect(result.data[0].unlimitedStock).toBe(false);
  });

  test('pure supplier product (source != internal): stock is real-time (null), regardless of link row', async () => {
    db.query.mockResolvedValueOnce([
      { id: 2, name: 'Y', source: 'wgcards', price: 10, regularPrice: 10, hasCustomPrice: 0, availableCodes: 0, unlimitedStock: 0, hasSupplierLink: 0 },
    ]);
    const result = await userProductService.getClientProducts(1, {});
    expect(result.data[0].availableCodes).toBeNull();
  });

  test('internal product WITH an active supplier link: treated as real-time, not low stock', async () => {
    db.query.mockResolvedValueOnce([
      { id: 3, name: 'Z', source: 'internal', price: 10, regularPrice: 10, hasCustomPrice: 0, availableCodes: 0, unlimitedStock: 0, hasSupplierLink: 1 },
    ]);
    const result = await userProductService.getClientProducts(1, {});
    expect(result.data[0].availableCodes).toBeNull();
    expect(result.data[0].unlimitedStock).toBe(true);
  });
});
