'use strict';

jest.mock('../../config/database');
jest.mock('../../services/gift2games.service', () => ({ checkBalance: jest.fn() }));
jest.mock('../../repositories/supplierConfig.repository');

const gift2gamesService = require('../../services/gift2games.service');
const supplierConfigRepo = require('../../repositories/supplierConfig.repository');
const { run } = require('../gift2gamesBalanceMonitor');

describe('gift2gamesBalanceMonitor.run', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // First call inside run() is always the enable/disable gate check —
    // default it healthy/enabled here so each test below only needs to
    // queue the SECOND call (the threshold lookup) on top of this.
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ is_active: 1 });
  });

  test('supplier disabled by admin -> skips entirely, never calls checkBalance', async () => {
    supplierConfigRepo.getBySupplierName.mockReset();
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ is_active: 0 });

    const result = await run();

    expect(result).toEqual({ skipped: true, reason: 'supplier_disabled' });
    expect(gift2gamesService.checkBalance).not.toHaveBeenCalled();
  });

  test('saves the balance and reports ok when above threshold', async () => {
    gift2gamesService.checkBalance.mockResolvedValueOnce({ userId: '9633', userBalance: '5000', userCurrency: 'USD' });
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ low_balance_threshold: 100 });

    const result = await run();

    expect(supplierConfigRepo.saveBalance).toHaveBeenCalledWith('gift2games', 5000, 'USD');
    expect(result).toEqual({ supplier: 'gift2games', ok: true, balance: 5000, currency: 'USD', threshold: 100, isLow: false });
  });

  test('flags isLow when balance is below the configured threshold', async () => {
    gift2gamesService.checkBalance.mockResolvedValueOnce({ userBalance: '5', userCurrency: 'USD' });
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ low_balance_threshold: 100 });

    const result = await run();

    expect(result.isLow).toBe(true);
  });

  test('no threshold configured -> never flags isLow', async () => {
    gift2gamesService.checkBalance.mockResolvedValueOnce({ userBalance: '0', userCurrency: 'USD' });
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ low_balance_threshold: null });

    const result = await run();

    expect(result.isLow).toBe(false);
  });

  test('checkBalance failure -> reports not ok, does not crash', async () => {
    gift2gamesService.checkBalance.mockRejectedValueOnce(new Error('timeout'));

    const result = await run();

    expect(result).toEqual({ supplier: 'gift2games', ok: false, error: 'timeout' });
    expect(supplierConfigRepo.saveBalance).not.toHaveBeenCalled();
  });

  test('no userBalance in the response -> reports not ok without crashing', async () => {
    gift2gamesService.checkBalance.mockResolvedValueOnce({ userId: '9633' });

    const result = await run();

    expect(result.ok).toBe(false);
    expect(supplierConfigRepo.saveBalance).not.toHaveBeenCalled();
  });
});
