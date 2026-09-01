'use strict';

jest.mock('../../config/database');
jest.mock('../../services/wgcards.service');
jest.mock('../../repositories/supplierConfig.repository');

const db = require('../../config/database');
const wgcardsService = require('../../services/wgcards.service');
const supplierConfigRepo = require('../../repositories/supplierConfig.repository');
const { run, pickTrackedAccount } = require('../balanceMonitor');

describe('pickTrackedAccount', () => {
  test('picks the USD account out of several currencies', () => {
    const accounts = [
      { balance: 100, currency: 'CNY' },
      { balance: 50, currency: 'USD' },
      { balance: 10, currency: 'GBP' },
    ];
    expect(pickTrackedAccount(accounts)).toEqual({ balance: 50, currency: 'USD' });
  });

  test('returns null if no USD account exists', () => {
    expect(pickTrackedAccount([{ balance: 1, currency: 'CNY' }])).toBeNull();
  });

  test('returns null for a non-array input', () => {
    expect(pickTrackedAccount(undefined)).toBeNull();
    expect(pickTrackedAccount(null)).toBeNull();
  });
});

describe('balanceMonitor.run', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // First call inside run() is always the enable/disable gate check —
    // default it healthy/enabled here so each test below only needs to
    // queue the SECOND call (the threshold lookup) on top of this.
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ is_active: 1 });
  });

  test('supplier disabled by admin -> skips entirely, never calls getAccount', async () => {
    supplierConfigRepo.getBySupplierName.mockReset(); // override the beforeEach default for this one test
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ is_active: 0 });

    const result = await run();

    expect(result).toEqual({ skipped: true, reason: 'supplier_disabled' });
    expect(wgcardsService.getAccount).not.toHaveBeenCalled();
  });

  test('saves the USD balance and reports ok when above threshold', async () => {
    wgcardsService.getAccount.mockResolvedValueOnce({
      accounts: [{ balance: 5000, currency: 'USD', effective: true }],
    });
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ low_balance_threshold: 100 });

    const result = await run();

    expect(supplierConfigRepo.saveBalance).toHaveBeenCalledWith('wgcards', 5000, 'USD');
    expect(result).toEqual({ supplier: 'wgcards', ok: true, balance: 5000, currency: 'USD', threshold: 100, isLow: false, effective: true });
  });

  test('flags isLow when balance is below the configured threshold', async () => {
    wgcardsService.getAccount.mockResolvedValueOnce({
      accounts: [{ balance: 5, currency: 'USD', effective: true }],
    });
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ low_balance_threshold: 100 });

    const result = await run();

    expect(result.isLow).toBe(true);
  });

  test('no threshold configured -> never flags isLow', async () => {
    wgcardsService.getAccount.mockResolvedValueOnce({
      accounts: [{ balance: 0, currency: 'USD', effective: true }],
    });
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ low_balance_threshold: null });

    const result = await run();

    expect(result.isLow).toBe(false);
  });

  test('getAccount failure -> reports not ok, does not crash', async () => {
    wgcardsService.getAccount.mockRejectedValueOnce(new Error('timeout'));

    const result = await run();

    expect(result).toEqual({ supplier: 'wgcards', ok: false, error: 'timeout' });
    expect(supplierConfigRepo.saveBalance).not.toHaveBeenCalled();
  });

  test('no USD wallet in the response -> reports not ok without crashing', async () => {
    wgcardsService.getAccount.mockResolvedValueOnce({ accounts: [{ balance: 1, currency: 'CNY' }] });

    const result = await run();

    expect(result.ok).toBe(false);
    expect(supplierConfigRepo.saveBalance).not.toHaveBeenCalled();
  });
});
