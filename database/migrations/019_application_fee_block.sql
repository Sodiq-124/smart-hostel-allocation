/*
===============================================================================
MIGRATION 019
Name: 019_application_fee_block

Purpose (Payment-before-allocation):
  The hostel fee is priced by (hostel session, block). Before a room is
  allocated, an application's block is not otherwise known:
  applications.preferred_block_id is optional ("No preference"). An admin now
  CONFIRMS the block whose fee the student will pay, when approving the
  application, and that choice is stored here.

Adds (to `applications` only):
  - column  fee_block_id  INT UNSIGNED NULL  (after preferred_block_id)
  - key     idx_applications_fee_block (fee_block_id)
  - foreign key fk_applications_fee_block -> blocks(id)
                ON DELETE RESTRICT ON UPDATE CASCADE

Does NOT:
  - backfill, update, insert or delete ANY row (existing applications,
    allocations, payments, fees and sessions are untouched; every existing
    application simply has fee_block_id = NULL),
  - change any other table, view, trigger or constraint,
  - alter the existing pay-after-allocation flow (an application that already
    has an allocation is still priced from its allocated room's block).

How to run (you run it; nothing here runs itself):
  - DO NOT put a USE statement in this file. Choose the database on the command
    line, so the same file works for scratch and (when you authorise it) live:
        mysql.exe -u root --database=smart_hostel_scratch < 019_application_fee_block.sql
  - It is safe to run twice: if the column already exists the ALTER is skipped
    and nothing is recorded.
  - Requires MariaDB 10.4 (verified compatible syntax: plain ADD COLUMN, ADD KEY,
    ADD CONSTRAINT in one ALTER TABLE).

Ledger: if the table migration_ledger exists, run_started, three created_object
rows and run_completed are recorded. If it does not exist, that part is skipped
and reported; it never blocks the schema change.

Rollback: see 019_application_fee_block_rollback.sql (it drops the column, so it
discards any fee blocks admins have confirmed since; read its header first).
===============================================================================
*/

/* ============================================================================
   1. PRE-FLIGHT (read-only)
   ============================================================================ */

SELECT '019 PRE-FLIGHT' AS check_name, DATABASE() AS connected_database;
/* STOP unless connected_database is the database you intend (scratch first). */

SELECT TABLE_NAME FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('applications', 'blocks')
 ORDER BY TABLE_NAME;
/* Expected: two rows - applications, blocks. */

SET @fee_block_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'applications'
     AND COLUMN_NAME = 'fee_block_id'
);
SET @has_ledger = (
  SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'migration_ledger'
);
SELECT IF(@fee_block_exists = 0,
          'OK: fee_block_id is absent, the migration will add it',
          'SKIP: fee_block_id already exists, nothing will be changed') AS preflight_result,
       IF(@has_ledger = 1, 'migration_ledger present', 'migration_ledger absent (ledger step skipped)') AS ledger_status;

SELECT 'applications rows before (unchanged by this migration)' AS note, COUNT(*) AS applications_before
  FROM applications;

/* ============================================================================
   2. LEDGER: run_started (only when the column is about to be added)
   ============================================================================ */

SET @sql = IF(@fee_block_exists = 0 AND @has_ledger = 1,
  "INSERT INTO migration_ledger (migration_name, migration_version, entry_kind, applied_by)
   VALUES ('019_application_fee_block', 19, 'run_started', USER())",
  "SELECT 'ledger run_started not recorded' AS ledger_note");
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

/* ============================================================================
   3. THE SCHEMA CHANGE (single ALTER; skipped if the column exists)
   ============================================================================ */

SET @sql = IF(@fee_block_exists = 0,
  "ALTER TABLE applications
     ADD COLUMN fee_block_id INT UNSIGNED NULL DEFAULT NULL AFTER preferred_block_id,
     ADD KEY idx_applications_fee_block (fee_block_id),
     ADD CONSTRAINT fk_applications_fee_block
       FOREIGN KEY (fee_block_id) REFERENCES blocks (id)
       ON DELETE RESTRICT ON UPDATE CASCADE",
  "SELECT 'ALTER skipped: fee_block_id already exists' AS alter_note");
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

/* ============================================================================
   4. LEDGER: created objects + run_completed (only when we just added the column)
   ============================================================================ */

SET @sql = IF(@fee_block_exists = 0 AND @has_ledger = 1,
  "INSERT INTO migration_ledger
     (migration_name, migration_version, entry_kind, object_type, object_table, object_name, applied_by)
   VALUES
     ('019_application_fee_block', 19, 'created_object', 'column',      'applications', 'fee_block_id',              USER()),
     ('019_application_fee_block', 19, 'created_object', 'index',       'applications', 'idx_applications_fee_block', USER()),
     ('019_application_fee_block', 19, 'created_object', 'foreign_key', 'applications', 'fk_applications_fee_block',  USER()),
     ('019_application_fee_block', 19, 'run_completed',  NULL,          NULL,           NULL,                        USER())",
  "SELECT 'ledger completion not recorded' AS ledger_note");
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

/* ============================================================================
   5. POST-CHECK (read-only)
   ============================================================================ */

SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'applications' AND COLUMN_NAME = 'fee_block_id';
/* Expected: fee_block_id | int(10) unsigned | YES | NULL */

SELECT 'applications rows after' AS note, COUNT(*) AS applications_after,
       SUM(fee_block_id IS NOT NULL) AS rows_with_fee_block
  FROM applications;
/* Expected: applications_after = applications_before; rows_with_fee_block = 0 */

SELECT '019 COMPLETE' AS migration_status;
