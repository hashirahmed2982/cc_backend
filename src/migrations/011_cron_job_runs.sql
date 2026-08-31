-- 011_cron_job_runs.sql
-- Incremental migration for the already-provisioned uat DB — adds the
-- cron_job_runs table backing the admin panel's Cron Health widget.

CREATE TABLE IF NOT EXISTS cron_job_runs (
    job_name VARCHAR(100) PRIMARY KEY,
    last_run_at DATETIME NULL,
    last_status ENUM('success', 'failed') NULL,
    last_summary JSON NULL,
    last_error TEXT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
