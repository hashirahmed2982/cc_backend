'use strict';

jest.mock('../../config/database', () => ({ query: jest.fn(), queryOne: jest.fn() }));

const db = require('../../config/database');
const repo = require('../supplierLinks.repository');

describe('supplierLinks.repository', () => {
  beforeEach(() => jest.clearAllMocks());

  test('getActiveLinksForSku orders cheapest first', async () => {
    db.query.mockResolvedValueOnce([{ link_id: 1 }]);
    await repo.getActiveLinksForSku(5);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('ORDER BY cost_price_base_currency ASC'), [5]);
  });

  test('upsertLink inserts then re-reads the row', async () => {
    db.query.mockResolvedValueOnce(undefined);
    db.queryOne.mockResolvedValueOnce({ link_id: 1, supplier: 'wgcards' });

    const result = await repo.upsertLink({
      skuId: 5, supplier: 'wgcards', supplierRef: 'item-1', supplierSkuRef: 'sku-1', costPrice: 10,
    });

    expect(result).toEqual({ link_id: 1, supplier: 'wgcards' });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('ON DUPLICATE KEY UPDATE'), expect.any(Array));
  });

  test('setLinkActive toggles is_active', async () => {
    db.query.mockResolvedValueOnce(undefined);
    await repo.setLinkActive(1, false);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('SET is_active'), [0, 1]);
  });

  test('setPriorityOverride accepts null to clear an override', async () => {
    db.query.mockResolvedValueOnce(undefined);
    await repo.setPriorityOverride(1, null);
    expect(db.query).toHaveBeenCalledWith(expect.any(String), [null, 1]);
  });

  test('upsertStagingItem writes face_value_currency, falling back to currency when not given', async () => {
    db.query.mockResolvedValueOnce(undefined);
    await repo.upsertStagingItem({
      supplier: 'gift2games', supplierSkuRef: 'g2g-2', itemName: 'Apple UK Card', brandName: 'Apple',
      currency: 'USD', faceValueCurrency: 'GBP',
    });
    expect(db.query.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['USD', 'GBP'])
    );

    db.query.mockResolvedValueOnce(undefined);
    await repo.upsertStagingItem({
      supplier: 'wgcards', supplierSkuRef: 'wg-2', itemName: 'Xbox Card', brandName: 'Xbox',
      currency: 'USD', // no faceValueCurrency passed at all
    });
    // face_value_currency param falls back to currency (both 'USD') when the
    // caller doesn't have a separate value to give it.
    const params = db.query.mock.calls[1][1];
    expect(params.filter((p) => p === 'USD')).toHaveLength(2);
  });

  test('upsertStagingItem never resets status on a re-sync (comment/SQL says so, verify the SQL omits status from the UPDATE clause)', async () => {
    db.query.mockResolvedValueOnce(undefined);
    await repo.upsertStagingItem({
      supplier: 'gift2games', supplierSkuRef: 'g2g-1', itemName: 'Test Card', brandName: 'Steam',
    });
    const sql = db.query.mock.calls[0][0];
    // The ON DUPLICATE KEY UPDATE clause must not reassign `status`.
    const updateClause = sql.split('ON DUPLICATE KEY UPDATE')[1];
    expect(updateClause).not.toMatch(/\bstatus\s*=/);
  });

  test('getPendingReview filters to pending_review and an optional supplier', async () => {
    db.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);
    await repo.getPendingReview({ supplier: 'wgcards' });
    expect(db.query.mock.calls[0][0]).toContain("status = 'pending_review'");
    expect(db.query.mock.calls[0][0]).toContain('supplier = ?');
  });

  // Link Products page search bar — matches item_name OR brand_name.
  // brand_name is qualified sci.brand_name deliberately: products.brand_name
  // is also in this query's JOIN, so an unqualified column is genuinely
  // ambiguous to MySQL, not just inconsistent style.
  test('getPendingReview search matches item_name/brand_name, qualified against the sci alias on both the row query and the count query', async () => {
    db.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);
    await repo.getPendingReview({ search: 'apple' });

    const [rowSql, rowParams] = db.query.mock.calls[0];
    expect(rowSql).toContain('sci.item_name LIKE ?');
    expect(rowSql).toContain('sci.brand_name LIKE ?');
    expect(rowParams).toEqual(expect.arrayContaining(['%apple%', '%apple%']));

    const [countSql] = db.query.mock.calls[1];
    // The count query must alias supplier_catalog_items as sci too, or the
    // sci.-qualified WHERE clause above breaks it with an unknown alias.
    expect(countSql).toContain('FROM supplier_catalog_items sci');
  });

  test('markStagingStatus records who reviewed it and when', async () => {
    db.query.mockResolvedValueOnce(undefined);
    await repo.markStagingStatus(3, 'linked', 7);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('reviewed_by'), ['linked', 7, 3]);
  });

  test('getCanonicalBrand falls back to a normalized raw string when no alias is on file', async () => {
    db.queryOne.mockResolvedValueOnce(null);
    const result = await repo.getCanonicalBrand('Steam Wallet');
    expect(result).toBe('steam wallet');
  });

  test('getCanonicalBrand returns the aliased canonical brand when one exists', async () => {
    db.queryOne.mockResolvedValueOnce({ canonical_brand: 'steam' });
    const result = await repo.getCanonicalBrand('Steam Gift Card');
    expect(result).toBe('steam');
  });

  test('getLinksForProduct joins across every SKU of the product, cheapest first per SKU', async () => {
    db.query.mockResolvedValueOnce([{ link_id: 1, sku_id: 5, supplier: 'wgcards' }]);
    const result = await repo.getLinksForProduct(99);
    expect(result).toEqual([{ link_id: 1, sku_id: 5, supplier: 'wgcards' }]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('WHERE ps.product_id = ?'), [99]);
  });
});
