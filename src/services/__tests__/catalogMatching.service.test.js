'use strict';

jest.mock('../../config/database', () => ({ query: jest.fn(), queryOne: jest.fn(), getConnection: jest.fn() }));
jest.mock('../../repositories/supplierLinks.repository');

const db = require('../../config/database');
const supplierLinksRepo = require('../../repositories/supplierLinks.repository');
const {
  buildCanonicalMatchKey, findSuggestedMatches, getStagingItemWithSuggestions,
  confirmLink, createNewFromStaging, ignoreStaging,
} = require('../catalogMatching.service');

function fakeConn(results) {
  const execute = jest.fn();
  results.forEach((r) => execute.mockResolvedValueOnce(r));
  return { execute, beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() };
}

const stagingItem = {
  staging_id: 5, status: 'pending_review', supplier: 'gift2games', supplier_ref: '69', supplier_sku_ref: '1048',
  item_name: 'MOBILE LEGENDS - 11 DIAMONDS', brand_name: 'MOBILE LEGENDS', face_value: 0.2, currency: 'USD', cost_price: 0.21,
  match_key: 'mobile legends|0.20|USD',
};

describe('buildCanonicalMatchKey', () => {
  test('combines canonical brand, face value, and currency', async () => {
    supplierLinksRepo.getCanonicalBrand.mockResolvedValueOnce('mobile legends');
    const key = await buildCanonicalMatchKey({ brandName: 'Mobile Legends', faceValue: 0.2, currency: 'usd' });
    expect(key).toBe('mobile legends|0.20|USD');
  });
});

describe('findSuggestedMatches', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns candidates whose computed key matches the staged item\'s own key', async () => {
    db.query.mockResolvedValueOnce([
      { sku_id: 1, face_value: 0.2, price_currency: 'USD', brand_name: 'MOBILE LEGENDS', product_name: 'ML' },
      { sku_id: 2, face_value: 5, price_currency: 'USD', brand_name: 'STEAM', product_name: 'Steam' },
    ]);
    supplierLinksRepo.getCanonicalBrand
      .mockResolvedValueOnce('mobile legends')
      .mockResolvedValueOnce('steam');

    const { matchKey, matches } = await findSuggestedMatches(stagingItem);

    expect(matchKey).toBe('mobile legends|0.20|USD');
    expect(matches).toEqual([expect.objectContaining({ sku_id: 1 })]);
  });

  test('no candidates match -> empty array, not an error', async () => {
    db.query.mockResolvedValueOnce([{ sku_id: 2, face_value: 5, price_currency: 'USD', brand_name: 'STEAM' }]);
    supplierLinksRepo.getCanonicalBrand.mockResolvedValueOnce('steam');

    const { matches } = await findSuggestedMatches(stagingItem);
    expect(matches).toEqual([]);
  });
});

describe('getStagingItemWithSuggestions', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns null when the staging item does not exist', async () => {
    supplierLinksRepo.getStagingItem.mockResolvedValueOnce(null);
    expect(await getStagingItemWithSuggestions(999)).toBeNull();
  });

  test('returns the item with suggestedMatches attached', async () => {
    supplierLinksRepo.getStagingItem.mockResolvedValueOnce(stagingItem);
    db.query.mockResolvedValueOnce([]);

    const result = await getStagingItemWithSuggestions(5);
    expect(result.staging_id).toBe(5);
    expect(result.suggestedMatches).toEqual([]);
  });
});

describe('confirmLink', () => {
  beforeEach(() => jest.clearAllMocks());

  test('throws when the staging item does not exist', async () => {
    supplierLinksRepo.getStagingItem.mockResolvedValueOnce(null);
    await expect(confirmLink({ stagingId: 999, skuId: 1, reviewedBy: 7 })).rejects.toThrow(/not found/);
  });

  test('throws when the staging item was already reviewed', async () => {
    supplierLinksRepo.getStagingItem.mockResolvedValueOnce({ ...stagingItem, status: 'linked' });
    await expect(confirmLink({ stagingId: 5, skuId: 1, reviewedBy: 7 })).rejects.toThrow(/already linked/);
  });

  test('happy path: creates the link and marks the staging item linked', async () => {
    supplierLinksRepo.getStagingItem.mockResolvedValueOnce(stagingItem);

    const result = await confirmLink({ stagingId: 5, skuId: 42, reviewedBy: 7 });

    expect(result).toEqual({ skuId: 42 });
    expect(supplierLinksRepo.upsertLink).toHaveBeenCalledWith(expect.objectContaining({
      skuId: 42, supplier: 'gift2games', supplierSkuRef: '1048', costPrice: 0.21, costCurrency: 'USD', costPriceBaseCurrency: 0.21,
    }));
    expect(supplierLinksRepo.markStagingStatus).toHaveBeenCalledWith(5, 'linked', 7);
  });
});

describe('createNewFromStaging', () => {
  beforeEach(() => jest.clearAllMocks());

  test('throws when the staging item was already reviewed', async () => {
    supplierLinksRepo.getStagingItem.mockResolvedValueOnce({ ...stagingItem, status: 'created_new' });
    await expect(createNewFromStaging({ stagingId: 5, reviewedBy: 7 })).rejects.toThrow(/already created_new/);
  });

  test('happy path: creates product+sku+inventory, applies default margin when no sellingPrice given, links, marks staging', async () => {
    supplierLinksRepo.getStagingItem.mockResolvedValueOnce(stagingItem);
    db.queryOne.mockResolvedValueOnce({ setting_value: '20' }); // default_margin_percent
    const conn = fakeConn([
      [{ insertId: 100 }], // INSERT products
      [{ insertId: 200 }], // INSERT product_skus
      [{}],                 // INSERT inventory
    ]);
    db.getConnection.mockResolvedValueOnce(conn);

    const result = await createNewFromStaging({ stagingId: 5, reviewedBy: 7 });

    expect(result).toEqual({ productId: 100, skuId: 200 });
    expect(conn.commit).toHaveBeenCalled();
    expect(conn.rollback).not.toHaveBeenCalled();
    // needs_review=1 (last-but-one placeholder before is_active) since no explicit sellingPrice was given
    const skuInsertArgs = conn.execute.mock.calls[1][1];
    expect(skuInsertArgs).toContain(1); // needs_review flag present somewhere in the bound params
    expect(supplierLinksRepo.upsertLink).toHaveBeenCalledWith(expect.objectContaining({ skuId: 200, supplierSkuRef: '1048' }));
    expect(supplierLinksRepo.markStagingStatus).toHaveBeenCalledWith(5, 'created_new', 7);
  });

  test('an explicit sellingPrice skips the default-margin lookup entirely', async () => {
    supplierLinksRepo.getStagingItem.mockResolvedValueOnce(stagingItem);
    const conn = fakeConn([[{ insertId: 100 }], [{ insertId: 200 }], [{}]]);
    db.getConnection.mockResolvedValueOnce(conn);

    await createNewFromStaging({ stagingId: 5, reviewedBy: 7, sellingPrice: 0.5 });

    expect(db.queryOne).not.toHaveBeenCalled();
  });

  test('a DB failure mid-transaction rolls back and never creates the link', async () => {
    supplierLinksRepo.getStagingItem.mockResolvedValueOnce(stagingItem);
    db.queryOne.mockResolvedValueOnce({ setting_value: '20' });
    const conn = {
      execute: jest.fn()
        .mockResolvedValueOnce([{ insertId: 100 }])
        .mockRejectedValueOnce(new Error('constraint violation')),
      beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    };
    db.getConnection.mockResolvedValueOnce(conn);

    await expect(createNewFromStaging({ stagingId: 5, reviewedBy: 7 })).rejects.toThrow(/constraint violation/);
    expect(conn.rollback).toHaveBeenCalled();
    expect(supplierLinksRepo.upsertLink).not.toHaveBeenCalled();
    expect(supplierLinksRepo.markStagingStatus).not.toHaveBeenCalled();
  });

  test('an explicit sellingPrice below cost is rejected (the margin floor guard)', async () => {
    supplierLinksRepo.getStagingItem.mockResolvedValueOnce(stagingItem); // cost_price: 0.21, currency: USD
    const conn = fakeConn([[{ insertId: 100 }]]);
    db.getConnection.mockResolvedValueOnce(conn);

    await expect(createNewFromStaging({ stagingId: 5, reviewedBy: 7, sellingPrice: 0.1 }))
      .rejects.toThrow(/cannot be lower than cost price/);
    expect(conn.rollback).toHaveBeenCalled();
    expect(supplierLinksRepo.upsertLink).not.toHaveBeenCalled();
  });

  test('a non-USD cost with NO explicit sellingPrice refuses to auto-compute a margin, never inserts anything', async () => {
    supplierLinksRepo.getStagingItem.mockResolvedValueOnce({ ...stagingItem, currency: 'CNY', cost_price: 41.39 });
    const conn = fakeConn([[{ insertId: 100 }]]);
    db.getConnection.mockResolvedValueOnce(conn);

    await expect(createNewFromStaging({ stagingId: 5, reviewedBy: 7 }))
      .rejects.toThrow(/not USD.*default margin/);
    expect(conn.rollback).toHaveBeenCalled();
    expect(db.queryOne).not.toHaveBeenCalled(); // never even looked up default_margin_percent
    expect(supplierLinksRepo.upsertLink).not.toHaveBeenCalled();
  });

  test('a non-USD cost WITH an explicit sellingPrice is allowed through (admin\'s call) but forced needs_review', async () => {
    supplierLinksRepo.getStagingItem.mockResolvedValueOnce({ ...stagingItem, currency: 'CNY', cost_price: 41.39 });
    const conn = fakeConn([[{ insertId: 100 }], [{ insertId: 200 }], [{}]]);
    db.getConnection.mockResolvedValueOnce(conn);

    const result = await createNewFromStaging({ stagingId: 5, reviewedBy: 7, sellingPrice: 5 });

    expect(result).toEqual({ productId: 100, skuId: 200 });
    const skuInsertArgs = conn.execute.mock.calls[1][1];
    expect(skuInsertArgs).toContain(1); // needs_review forced true despite an explicit price
  });

  test('a wgcards-sourced staged item gets spu_id/wgcards_sku_id backfilled — otherwise catalogSync.js would re-stage it forever and wgcardsFulfillment.js could never place an order for it', async () => {
    supplierLinksRepo.getStagingItem.mockResolvedValueOnce({
      ...stagingItem, supplier: 'wgcards', supplier_ref: '9001', supplier_sku_ref: '12182768136',
    });
    const conn = fakeConn([[{ insertId: 100 }], [{ insertId: 200 }], [{}]]);
    db.getConnection.mockResolvedValueOnce(conn);

    await createNewFromStaging({ stagingId: 5, reviewedBy: 7, sellingPrice: 5 });

    const productInsertArgs = conn.execute.mock.calls[0][1];
    expect(productInsertArgs).toContain('9001'); // spu_id
    const skuInsertArgs = conn.execute.mock.calls[1][1];
    expect(skuInsertArgs).toContain('12182768136'); // wgcards_sku_id
  });

  test('a gift2games-sourced staged item leaves spu_id/wgcards_sku_id NULL', async () => {
    supplierLinksRepo.getStagingItem.mockResolvedValueOnce(stagingItem); // supplier: 'gift2games'
    const conn = fakeConn([[{ insertId: 100 }], [{ insertId: 200 }], [{}]]);
    db.getConnection.mockResolvedValueOnce(conn);

    await createNewFromStaging({ stagingId: 5, reviewedBy: 7, sellingPrice: 5 });

    const productInsertArgs = conn.execute.mock.calls[0][1];
    expect(productInsertArgs[productInsertArgs.length - 1]).toBeNull(); // spu_id is the last bound param, NOT item.supplier_ref
    const skuInsertArgs = conn.execute.mock.calls[1][1];
    expect(skuInsertArgs[3]).toBeNull(); // wgcards_sku_id is the 4th bound param (after productId, sku_name, supplier_sku_ref)
  });
});

describe('ignoreStaging', () => {
  beforeEach(() => jest.clearAllMocks());

  test('throws when the staging item does not exist', async () => {
    supplierLinksRepo.getStagingItem.mockResolvedValueOnce(null);
    await expect(ignoreStaging({ stagingId: 999, reviewedBy: 7 })).rejects.toThrow(/not found/);
  });

  test('happy path marks the item ignored', async () => {
    supplierLinksRepo.getStagingItem.mockResolvedValueOnce(stagingItem);
    await ignoreStaging({ stagingId: 5, reviewedBy: 7 });
    expect(supplierLinksRepo.markStagingStatus).toHaveBeenCalledWith(5, 'ignored', 7);
  });
});
