-- ============================================================
-- PHASE 9D - MIGRATION 022
-- Renewal deadline + one-live-renewal-per-student-per-session
-- Target: MariaDB 10.4
-- Database is supplied by the mysql command; NO USE statement.
--
-- YOU RUN THIS. Nothing in the application runs it.
--   mysql.exe -u root --database=smart_hostel < 022_renewal_deadline_and_uniqueness.sql
--
-- WHAT IT DOES (two additive changes, no rows are touched):
--   1. hostel_sessions.renewal_deadline_at  DATETIME NULL
--        The configurable renewal deadline. NULL = no deadline set: students may
--        request renewal, and the system will NOT forfeit anything automatically.
--   2. hostel_renewals.active_key  (generated, STORED) + UNIQUE KEY uq_renewals_active
--        = student_id * 2^32 + new_session_id while status is 'pending' or 'approved',
--        else NULL. The database itself then refuses a second live renewal for the
--        same student and session (same technique as applications/allocations).
--        Rejected, cancelled and forfeited rows are NOT affected: history is unlimited.
--
-- WHAT IT DOES NOT DO:
--   - It does not modify, delete or backfill any existing row.
--   - It does not create hostel_renewals (that is migration 015). If 015 is not
--     applied, step 2 is skipped and a message says so; the application then
--     answers 503 for renewal features instead of guessing.
--   - It does not change allocations.status (see docs/phase9d-renewal-forfeiture.md:
--     forfeiture is recorded as status 'released' + a "Forfeited:" release_reason +
--     hostel_renewals.status = 'forfeited').
--
-- SAFE TO RUN TWICE: each ALTER is skipped when the object already exists.
-- ROLLBACK (manual, only if ever needed):
--   ALTER TABLE hostel_renewals DROP INDEX uq_renewals_active, DROP COLUMN active_key;
--   ALTER TABLE hostel_sessions DROP COLUMN renewal_deadline_at;
-- ============================================================

SELECT DATABASE() AS connected_database, VERSION() AS server_version;

-- PRECHECKS (read-only)
SELECT COUNT(*) AS hostel_sessions_before FROM hostel_sessions;
SELECT COUNT(*) AS hostel_renewals_before
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hostel_renewals';

-- ------------------------------------------------------------
-- 1. hostel_sessions.renewal_deadline_at
-- ------------------------------------------------------------
SET @has_deadline := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hostel_sessions'
     AND COLUMN_NAME = 'renewal_deadline_at'
);
SET @sql := IF(@has_deadline = 0,
  'ALTER TABLE hostel_sessions ADD COLUMN renewal_deadline_at DATETIME NULL DEFAULT NULL AFTER ends_on',
  'SELECT ''hostel_sessions.renewal_deadline_at already exists - skipped.'' AS note');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ------------------------------------------------------------
-- 2. hostel_renewals.active_key + unique key
-- ------------------------------------------------------------
SET @has_table := (
  SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hostel_renewals'
);
SET @has_key := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hostel_renewals'
     AND COLUMN_NAME = 'active_key'
);
SET @sql := IF(@has_table = 0,
  'SELECT ''hostel_renewals does not exist - run migration 015 first. Step 2 skipped.'' AS note',
  IF(@has_key = 0,
    'ALTER TABLE hostel_renewals ADD COLUMN active_key BIGINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN status IN (''pending'',''approved'') THEN (CAST(student_id AS UNSIGNED) * 4294967296) + CAST(new_session_id AS UNSIGNED) ELSE NULL END) STORED, ADD UNIQUE KEY uq_renewals_active (active_key)',
    'SELECT ''hostel_renewals.active_key already exists - skipped.'' AS note'));
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ------------------------------------------------------------
-- VERIFICATION (read-only)
-- ------------------------------------------------------------
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND ((TABLE_NAME = 'hostel_sessions' AND COLUMN_NAME = 'renewal_deadline_at')
     OR (TABLE_NAME = 'hostel_renewals' AND COLUMN_NAME = 'active_key'));

SELECT id, label, status, is_current, renewal_deadline_at FROM hostel_sessions ORDER BY id;

SELECT COUNT(*) AS hostel_sessions_after FROM hostel_sessions;

SELECT '022 COMPLETE' AS migration_status;
