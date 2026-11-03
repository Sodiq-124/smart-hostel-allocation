/*
===============================================================================
ROLLBACK for MIGRATION 019 (019_application_fee_block)

READ BEFORE RUNNING
  - This DROPS applications.fee_block_id. Every fee block an admin has
    confirmed since 019 ran is DISCARDED. Approved applications that were
    waiting to be paid would then have no fee block and could not start a
    payment until an admin confirmed one again.
  - It does NOT touch payments, allocations, fees or sessions, so a payment
    already made against a confirmed block keeps its own hostel_fee_id and
    remains valid.
  - Run it only if 019 must be undone, only with the application stopped, and
    only after a backup (see the Step 3 report for the backup command).
  - Choose the database on the command line (no USE statement here):
        mysql.exe -u root --database=smart_hostel_scratch < 019_application_fee_block_rollback.sql
  - Safe to run twice: each DROP is skipped when the object is already gone.
===============================================================================
*/

SELECT '019 ROLLBACK PRE-FLIGHT' AS check_name, DATABASE() AS connected_database;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
                    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'applications'
                      AND COLUMN_NAME = 'fee_block_id');
SELECT IF(@col_exists = 1, 'fee_block_id exists: it will be dropped', 'fee_block_id already absent: nothing to drop') AS rollback_preflight;
/* To see how many confirmed fee blocks would be lost, run this read-only query first:
     SELECT COUNT(*) AS confirmed_fee_blocks_that_will_be_lost FROM applications WHERE fee_block_id IS NOT NULL; */

SET @has_fk  = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
                 WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'applications'
                   AND CONSTRAINT_NAME = 'fk_applications_fee_block');
SET @has_key = (SELECT COUNT(*) FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'applications'
                   AND INDEX_NAME = 'idx_applications_fee_block');
SET @has_col = (SELECT COUNT(*) FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'applications'
                   AND COLUMN_NAME = 'fee_block_id');

SET @sql = IF(@has_fk = 1, 'ALTER TABLE applications DROP FOREIGN KEY fk_applications_fee_block', 'SELECT ''fk already absent'' AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(@has_key = 1, 'ALTER TABLE applications DROP KEY idx_applications_fee_block', 'SELECT ''index already absent'' AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(@has_col = 1, 'ALTER TABLE applications DROP COLUMN fee_block_id', 'SELECT ''column already absent'' AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

/* The migration_ledger is append-only (it has no-delete/update guard triggers),
   so the 019 ledger rows are left in place; record the rollback manually if you
   want it noted (INSERT ... entry_kind 'run_rolled_back'). */

SELECT COUNT(*) AS fee_block_column_remaining
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'applications' AND COLUMN_NAME = 'fee_block_id';
/* Expected: 0 */
