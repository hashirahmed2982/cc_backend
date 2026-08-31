// repositories/cronJobRuns.repository.js
// Backs the admin panel's Cron Health widget — jobs/index.js's guarded()
// wrapper calls recordRun() after every job execution (success or
// failure), so the admin panel can show "last run: 3 min ago, ok" per job
// without grepping server logs.
'use strict';

const db = require('../config/database');

/** Upsert one job's latest run outcome. */
async function recordRun(jobName, { status, summary, error }) {
  await db.query(
    `INSERT INTO cron_job_runs (job_name, last_run_at, last_status, last_summary, last_error)
     VALUES (?, NOW(), ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       last_run_at = NOW(), last_status = VALUES(last_status),
       last_summary = VALUES(last_summary), last_error = VALUES(last_error)`,
    [jobName, status, summary ? JSON.stringify(summary) : null, error || null]
  );
}

/** All jobs that have ever run, most recently updated first. */
async function getAll() {
  return db.query('SELECT * FROM cron_job_runs ORDER BY job_name ASC');
}

module.exports = { recordRun, getAll };
