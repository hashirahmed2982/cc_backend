'use strict';

jest.mock('../../config/database', () => ({ query: jest.fn() }));
jest.mock('../../utils/dataCrypto', () => ({
  encrypt: jest.fn((v) => `enc(${v})`),
  decrypt: jest.fn((v) => v.replace(/^enc\(/, '').replace(/\)$/, '')),
}));

const db = require('../../config/database');
const supplierApiLog = require('../supplierApiLog.service');

describe('supplierApiLog.service.list', () => {
  beforeEach(() => jest.clearAllMocks());

  test('decrypts supplier_request/supplier_response and returns pagination', async () => {
    db.query
      .mockResolvedValueOnce([
        {
          api_log_id: 1, endpoint: '/api/placeOrder', method: 'POST', status_code: 200,
          response_time: 120, supplier_request: 'enc({"skuId":"1"})', supplier_response: 'enc({"code":200})',
          supplier_name: 'wgcards', error_message: null, created_at: '2026-01-01',
        },
      ])
      .mockResolvedValueOnce([{ total: 1 }]);

    const result = await supplierApiLog.list({ supplierName: 'wgcards', page: 1, limit: 50 });

    expect(result.rows[0].supplier_request).toEqual({ skuId: '1' });
    expect(result.rows[0].supplier_response).toEqual({ code: 200 });
    expect(result.pagination).toEqual({ page: 1, limit: 50, total: 1 });
    expect(db.query.mock.calls[0][0]).toContain('supplier_name = ?');
  });

  test('errorsOnly filter adds the status/error condition', async () => {
    db.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);
    await supplierApiLog.list({ errorsOnly: true });
    expect(db.query.mock.calls[0][0]).toContain('status_code <> 200');
  });

  test('a corrupted/undecryptable payload becomes null instead of throwing', async () => {
    db.query
      .mockResolvedValueOnce([
        { api_log_id: 2, endpoint: '/x', method: 'POST', status_code: 200, response_time: 1, supplier_request: 'not-json', supplier_response: null, supplier_name: 'wgcards', error_message: null, created_at: '2026-01-01' },
      ])
      .mockResolvedValueOnce([{ total: 1 }]);

    const result = await supplierApiLog.list({});
    expect(result.rows[0].supplier_request).toBeNull();
    expect(result.rows[0].supplier_response).toBeNull();
  });

  test('limit is capped at 200', async () => {
    db.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);
    await supplierApiLog.list({ limit: 9999 });
    const lastArgs = db.query.mock.calls[0][1];
    expect(lastArgs[lastArgs.length - 2]).toBe(200); // LIMIT param
  });
});
