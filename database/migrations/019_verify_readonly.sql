/*
===============================================================================
019 VERIFICATION - READ ONLY (no INSERT/UPDATE/DELETE/DDL)
Run after migration 019 against the SAME database you migrated:
    mysql.exe -u root --database=smart_hostel_scratch < 019_verify_readonly.sql
Paste the output back; nothing here is assumed to have passed until you do.
===============================================================================
*/

SELECT DATABASE() AS connected_database, VERSION() AS mariadb_version;

/* 1. Column shape. Expected: fee_block_id | int(10) unsigned | YES | NULL */
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, ORDINAL_POSITION
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'applications'
   AND COLUMN_NAME IN ('preferred_block_id', 'fee_block_id');
/* Expected: fee_block_id directly after preferred_block_id. */

/* 2. Foreign key. Expected: fk_applications_fee_block -> blocks.id, RESTRICT / CASCADE */
SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
       r.DELETE_RULE, r.UPDATE_RULE
  FROM information_schema.KEY_COLUMN_USAGE k
  JOIN information_schema.REFERENTIAL_CONSTRAINTS r
    ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
 WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = 'applications' AND k.COLUMN_NAME = 'fee_block_id';

/* 3. Index. Expected: idx_applications_fee_block on fee_block_id */
SELECT INDEX_NAME, COLUMN_NAME FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'applications' AND INDEX_NAME = 'idx_applications_fee_block';

/* 4. Nothing was backfilled. Expected: rows_with_fee_block = 0 immediately after
      migrating (later it only counts blocks admins have confirmed). */
SELECT COUNT(*) AS applications_total, SUM(fee_block_id IS NOT NULL) AS rows_with_fee_block FROM applications;

/* 5. Existing data untouched - these totals must equal what you saw before migrating. */
SELECT (SELECT COUNT(*) FROM allocations) AS allocations_total,
       (SELECT COUNT(*) FROM payments)    AS payments_total,
       (SELECT COUNT(*) FROM hostel_fees) AS hostel_fees_total;

/* 6. Ledger rows for 019 (only if migration_ledger exists; an error here just means it does not). */
SELECT id, entry_kind, object_type, object_name, applied_by, applied_at
  FROM migration_ledger WHERE migration_name = '019_application_fee_block' ORDER BY id;
/* Expected: run_started, 3 x created_object, run_completed. */

/* 7. Integrity sanity for the payment gate (read-only). Expected: 0 rows each. */
SELECT 'application fee block with no active fee for its session' AS check_name, a.id AS application_id, a.fee_block_id
  FROM applications a
  LEFT JOIN hostel_fees f ON f.hostel_session_id = a.hostel_session_id AND f.block_id = a.fee_block_id AND f.active = 1
 WHERE a.fee_block_id IS NOT NULL AND f.id IS NULL;

SELECT 'application with more than one successful payment' AS check_name, application_id, COUNT(*) AS n
  FROM payments WHERE status = 'success' GROUP BY application_id HAVING COUNT(*) > 1;

SELECT 'successful payment missing verification evidence' AS check_name, id AS payment_id, application_id
  FROM payments
 WHERE status = 'success' AND (verified_at IS NULL OR paid_at IS NULL OR gateway_reference IS NULL);
/* The last query matters: the allocation gate refuses any success payment that
   lacks verified_at / paid_at / gateway_reference. Rows here would be blocked. */
