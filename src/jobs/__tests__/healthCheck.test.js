'use strict';

jest.mock('../../config/database');
jest.mock('../../services/wgcards.service');
jest.mock('../../repositories/supplierConfig.repository');

const db = require('../../config/database');
const wgcardsService = require('../../services/wgcards.service');
const supplierConfigRepo = require('../../repositories/supplierConfig.repository');
const { run } = require('../healthCheck');

describe('healthCheck.run', () => {
  beforeEach(() => jest.clearAllMocks());

  test('healthy before and after -> just reports status, no special logging path', async () => {
    supplierConfigRepo.getBySupplierName
      .mockResolvedValueOnce({ is_active: 1, integration_status: 'healthy', consecutive_failures: 0 })
      .mockResolvedValueOnce({ is_active: 1, integration_status: 'healthy', consecutive_failures: 0 });
    wgcardsService.getAccount.mockResolvedValueOnce({ accounts: [] });

    const result = await run();

    expect(result).toEqual({ supplier: 'wgcards', status: 'healthy', consecutiveFailures: 0 });
  });

  test('getAccount failure -> reports down status and the failure', async () => {
    supplierConfigRepo.getBySupplierName
      .mockResolvedValueOnce({ is_active: 1, integration_status: 'healthy', consecutive_failures: 2 }) // before
      .mockResolvedValueOnce({ is_active: 1, integration_status: 'down', consecutive_failures: 3 });    // after
    wgcardsService.getAccount.mockRejectedValueOnce(new Error('still failing'));

    const result = await run();

    expect(result).toEqual({ supplier: 'wgcards', status: 'down', error: 'still failing', consecutiveFailures: 3 });
  });

  test('recovery: was down, getAccount succeeds -> back to healthy', async () => {
    supplierConfigRepo.getBySupplierName
      .mockResolvedValueOnce({ is_active: 1, integration_status: 'down', consecutive_failures: 3 })
      .mockResolvedValueOnce({ is_active: 1, integration_status: 'healthy', consecutive_failures: 0 });
    wgcardsService.getAccount.mockResolvedValueOnce({ accounts: [] });

    const result = await run();

    expect(result).toEqual({ supplier: 'wgcards', status: 'healthy', consecutiveFailures: 0 });
  });

  test('supplier disabled by admin -> skips entirely, never calls getAccount', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ is_active: 0, integration_status: 'healthy' });

    const result = await run();

    expect(result).toEqual({ skipped: true, reason: 'supplier_disabled' });
    expect(wgcardsService.getAccount).not.toHaveBeenCalled();
  });
});
