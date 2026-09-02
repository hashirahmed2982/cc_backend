'use strict';

jest.mock('../../config/database');
jest.mock('../../services/gift2games.service', () => ({ checkBalance: jest.fn() }));
jest.mock('../../repositories/supplierConfig.repository');

const gift2gamesService = require('../../services/gift2games.service');
const supplierConfigRepo = require('../../repositories/supplierConfig.repository');
const { run } = require('../gift2gamesHealthCheck');

describe('gift2gamesHealthCheck.run', () => {
  beforeEach(() => jest.clearAllMocks());

  test('healthy before and after -> just reports status, no special logging path', async () => {
    supplierConfigRepo.getBySupplierName
      .mockResolvedValueOnce({ is_active: 1, integration_status: 'healthy', consecutive_failures: 0 })
      .mockResolvedValueOnce({ is_active: 1, integration_status: 'healthy', consecutive_failures: 0 });
    gift2gamesService.checkBalance.mockResolvedValueOnce({ userBalance: '300', userCurrency: 'USD' });

    const result = await run();

    expect(result).toEqual({ supplier: 'gift2games', status: 'healthy', consecutiveFailures: 0 });
  });

  test('checkBalance failure -> reports down status and the failure', async () => {
    supplierConfigRepo.getBySupplierName
      .mockResolvedValueOnce({ is_active: 1, integration_status: 'healthy', consecutive_failures: 2 })
      .mockResolvedValueOnce({ is_active: 1, integration_status: 'down', consecutive_failures: 3 });
    gift2gamesService.checkBalance.mockRejectedValueOnce(new Error('still failing'));

    const result = await run();

    expect(result).toEqual({ supplier: 'gift2games', status: 'down', error: 'still failing', consecutiveFailures: 3 });
  });

  test('recovery: was down, checkBalance succeeds -> back to healthy', async () => {
    supplierConfigRepo.getBySupplierName
      .mockResolvedValueOnce({ is_active: 1, integration_status: 'down', consecutive_failures: 3 })
      .mockResolvedValueOnce({ is_active: 1, integration_status: 'healthy', consecutive_failures: 0 });
    gift2gamesService.checkBalance.mockResolvedValueOnce({ userBalance: '300', userCurrency: 'USD' });

    const result = await run();

    expect(result).toEqual({ supplier: 'gift2games', status: 'healthy', consecutiveFailures: 0 });
  });

  test('supplier disabled by admin -> skips entirely, never calls checkBalance', async () => {
    supplierConfigRepo.getBySupplierName.mockResolvedValueOnce({ is_active: 0, integration_status: 'healthy' });

    const result = await run();

    expect(result).toEqual({ skipped: true, reason: 'supplier_disabled' });
    expect(gift2gamesService.checkBalance).not.toHaveBeenCalled();
  });
});
