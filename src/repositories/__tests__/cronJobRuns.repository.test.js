'use strict';

jest.mock('../../config/database', () => ({ query: jest.fn() }));

const db = require('../../config/database');
const { recordRun, getAll } = require('../cronJobRuns.repository');

describe('cronJobRuns.repository', () => {
  beforeEach(() => jest.clearAllMocks());

  test('recordRun upserts a success row with a JSON summary', async () => {
    db.query.mockResolvedValueOnce(undefined);
    await recordRun('catalogSync', { status: 'success', summary: { synced: 5 } });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO cron_job_runs'),
      ['catalogSync', 'success', JSON.stringify({ synced: 5 }), null]
    );
  });

  test('recordRun upserts a failed row with an error message, no summary', async () => {
    db.query.mockResolvedValueOnce(undefined);
    await recordRun('healthCheck', { status: 'failed', error: 'ECONNRESET' });

    expect(db.query).toHaveBeenCalledWith(
      expect.any(String),
      ['healthCheck', 'failed', null, 'ECONNRESET']
    );
  });

  test('getAll returns every tracked job ordered by name', async () => {
    db.query.mockResolvedValueOnce([{ job_name: 'catalogSync' }, { job_name: 'healthCheck' }]);
    const result = await getAll();
    expect(result).toHaveLength(2);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('ORDER BY job_name ASC'));
  });
});
