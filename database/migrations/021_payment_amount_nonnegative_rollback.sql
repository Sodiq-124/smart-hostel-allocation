/*
===============================================================================
ROLLBACK for MIGRATION 021 (021_payment_amount_nonnegative)

What it does
  Removes ONLY the CHECK constraints that migration 021 itself created on
  `payments`, and records the rollback in migration_ledger.

How it knows what 021 created
  It reads 021's own ledger entries: entry_kind 'created_object', object_type
  'constraint', object_table 'payments', rollback_state 'applied'. 021 writes
  such an entry only for a constraint it actually added. When a constraint was
  already there, 021 wrote NO entry, so this script never touches it.

Per constraint, the decision is:
  ledger entry + constraint exists + definition unchanged -> DROPPED
  ledger entry + constraint no longer exists               -> nothing to drop;
                                                              ledger can be
                                                              marked rolled back
  ledger entry + constraint exists + DIFFERENT definition  -> STOP
  no applied ledger entry                                  -> LEFT IN PLACE

Never touched: ck_payments_amount_breakdown, ck_payments_type_links, unique keys,
foreign keys, columns, and every row of every table. No table is dropped or
rebuilt.

Every decision is made before the first schema change. All constraints scheduled
for removal are dropped in one ALTER TABLE. The script verifies the resulting
schema before recording the rollback in the ledger.

How to run (you run it; nothing here runs itself). From the project root:
    C:\xampp\mysql\bin\mysql.exe -u root --database=smart_hostel < database\migrations\021_payment_amount_nonnegative_rollback.sql

Take a backup first. Do not use --force.
Compatibility: MariaDB 10.4.
===============================================================================
*/

/* ============================================================================
   1. DATABASE GUARD
   ============================================================================ */

SET @expected_database = 'smart_hostel';

SET @ok_db = 0,
    @ok_ledger = 0,
    @ok_conflict = 0,
    @safe_021 = 0,
    @ddl_success = 0;

SET @ok_db = IF(DATABASE() <=> @expected_database, 1, 0);

SET @guard = IF(@ok_db = 1,
    'SELECT ''guard passed: connected to smart_hostel'' AS database_guard',
    'SELECT * FROM `STOP_021_rollback_connected_database_is_not_smart_hostel`');

PREPARE guard_stmt FROM @guard;
EXECUTE guard_stmt;
DEALLOCATE PREPARE guard_stmt;

/* ============================================================================
   2. PRE-FLIGHT (read-only)
   ============================================================================ */

SELECT '021 ROLLBACK PRE-FLIGHT' AS check_name,
       DATABASE() AS connected_database,
       VERSION() AS mariadb_version;

SELECT (SELECT COUNT(*) FROM payments)            AS payment_rows,
       (SELECT COUNT(*) FROM applications)        AS application_rows,
       (SELECT COUNT(*) FROM hostel_misc_charges) AS misc_charge_rows;

SELECT id, object_name, row_key, after_value, applied_at, rollback_state
  FROM migration_ledger
 WHERE migration_name = '021_payment_amount_nonnegative'
   AND migration_version = 21
   AND entry_kind = 'created_object'
 ORDER BY id;

SELECT CONSTRAINT_NAME, CHECK_CLAUSE
  FROM information_schema.CHECK_CONSTRAINTS
 WHERE CONSTRAINT_SCHEMA = DATABASE()
   AND TABLE_NAME = 'payments'
 ORDER BY CONSTRAINT_NAME;

/* ============================================================================
   3. BASELINE GUARD: ledger columns
   ============================================================================ */

SET @ok_ledger = IF(
    (SELECT COUNT(*)
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'migration_ledger'
        AND COLUMN_NAME IN (
            'migration_name', 'migration_version', 'entry_kind',
            'object_type', 'object_table', 'object_name', 'applied_by',
            'rollback_state', 'rolled_back_at', 'rolled_back_by'
        )
    ) = 10,
    1, 0
);

SET @guard = IF(@ok_ledger = 1,
    'SELECT ''guard passed: migration_ledger has the expected columns'' AS ledger_guard',
    'SELECT * FROM `STOP_021_rollback_migration_ledger_missing_or_different`');

PREPARE guard_stmt FROM @guard;
EXECUTE guard_stmt;
DEALLOCATE PREPARE guard_stmt;

/* ============================================================================
   4. WHAT 021 CREATED, PER CONSTRAINT
   ============================================================================ */

/* ck_payments_amount_positive -> amount>0 */
SET @l1 = (
    SELECT COUNT(*)
      FROM migration_ledger
     WHERE migration_name = '021_payment_amount_nonnegative'
       AND migration_version = 21
       AND entry_kind = 'created_object'
       AND object_type = 'constraint'
       AND object_table = 'payments'
       AND object_name = 'ck_payments_amount_positive'
       AND rollback_state = 'applied'
);

SET @e1 = (
    SELECT COUNT(*)
      FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'payments'
       AND CONSTRAINT_NAME = 'ck_payments_amount_positive'
);

SET @d1 = (
    SELECT COUNT(*)
      FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'payments'
       AND CONSTRAINT_NAME = 'ck_payments_amount_positive'
       AND REPLACE(REPLACE(REPLACE(REPLACE(LOWER(CHECK_CLAUSE), '`', ''), ' ', ''), '(', ''), ')', '') = 'amount>0'
);

SET @r1 = IF(
    @l1 = 0,
    'keep_not_created_by_021',
    IF(@e1 = 0, 'already_gone', IF(@d1 > 0, 'drop', 'conflict'))
);

/* ck_payments_original_nonnegative -> original_amount>=0 */
SET @l2 = (
    SELECT COUNT(*)
      FROM migration_ledger
     WHERE migration_name = '021_payment_amount_nonnegative'
       AND migration_version = 21
       AND entry_kind = 'created_object'
       AND object_type = 'constraint'
       AND object_table = 'payments'
       AND object_name = 'ck_payments_original_nonnegative'
       AND rollback_state = 'applied'
);

SET @e2 = (
    SELECT COUNT(*)
      FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'payments'
       AND CONSTRAINT_NAME = 'ck_payments_original_nonnegative'
);

SET @d2 = (
    SELECT COUNT(*)
      FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'payments'
       AND CONSTRAINT_NAME = 'ck_payments_original_nonnegative'
       AND REPLACE(REPLACE(REPLACE(REPLACE(LOWER(CHECK_CLAUSE), '`', ''), ' ', ''), '(', ''), ')', '') = 'original_amount>=0'
);

SET @r2 = IF(
    @l2 = 0,
    'keep_not_created_by_021',
    IF(@e2 = 0, 'already_gone', IF(@d2 > 0, 'drop', 'conflict'))
);

/* ck_payments_late_fine_nonnegative -> late_fine_applied>=0 */
SET @l3 = (
    SELECT COUNT(*)
      FROM migration_ledger
     WHERE migration_name = '021_payment_amount_nonnegative'
       AND migration_version = 21
       AND entry_kind = 'created_object'
       AND object_type = 'constraint'
       AND object_table = 'payments'
       AND object_name = 'ck_payments_late_fine_nonnegative'
       AND rollback_state = 'applied'
);

SET @e3 = (
    SELECT COUNT(*)
      FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'payments'
       AND CONSTRAINT_NAME = 'ck_payments_late_fine_nonnegative'
);

SET @d3 = (
    SELECT COUNT(*)
      FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'payments'
       AND CONSTRAINT_NAME = 'ck_payments_late_fine_nonnegative'
       AND REPLACE(REPLACE(REPLACE(REPLACE(LOWER(CHECK_CLAUSE), '`', ''), ' ', ''), '(', ''), ')', '') = 'late_fine_applied>=0'
);

SET @r3 = IF(
    @l3 = 0,
    'keep_not_created_by_021',
    IF(@e3 = 0, 'already_gone', IF(@d3 > 0, 'drop', 'conflict'))
);

SELECT 'ck_payments_amount_positive' AS constraint_name,
       @l1 AS created_by_021_per_ledger,
       @e1 AS exists_now,
       @r1 AS decision
UNION ALL
SELECT 'ck_payments_original_nonnegative', @l2, @e2, @r2
UNION ALL
SELECT 'ck_payments_late_fine_nonnegative', @l3, @e3, @r3;

/* A constraint created by 021 but subsequently changed must not be dropped. */
SET @ok_conflict = IF(
    @r1 <> 'conflict'
    AND @r2 <> 'conflict'
    AND @r3 <> 'conflict',
    1, 0
);

SET @guard = IF(@ok_conflict = 1,
    'SELECT ''guard passed: every constraint to drop retains its original definition'' AS conflict_guard',
    'SELECT * FROM `STOP_021_rollback_a_constraint_021_created_now_has_a_different_definition`');

PREPARE guard_stmt FROM @guard;
EXECUTE guard_stmt;
DEALLOCATE PREPARE guard_stmt;

/* All guards must pass before schema or ledger changes. */
SET @safe_021 = IF(
    @ok_db = 1
    AND @ok_ledger = 1
    AND @ok_conflict = 1,
    1, 0
);

SET @to_drop = IF(
    @safe_021 = 1,
    (@r1 = 'drop') + (@r2 = 'drop') + (@r3 = 'drop'),
    0
);

SET @act = IF(
    @safe_021 = 1 AND (@l1 + @l2 + @l3) > 0,
    1, 0
);

SELECT @safe_021 AS all_guards_passed,
       @to_drop AS constraints_to_drop,
       @act AS ledger_rollback_needed;

/* ============================================================================
   5. THE SCHEMA CHANGE
   ============================================================================ */

SET @alter_sql = CONCAT_WS(' ',
    'ALTER TABLE payments',
    CONCAT_WS(', ',
        IF(
            @r1 = 'drop',
            'DROP CONSTRAINT ck_payments_amount_positive',
            NULL
        ),
        IF(
            @r2 = 'drop',
            'DROP CONSTRAINT ck_payments_original_nonnegative',
            NULL
        ),
        IF(
            @r3 = 'drop',
            'DROP CONSTRAINT ck_payments_late_fine_nonnegative',
            NULL
        )
    )
);

SET @run_sql = IF(
    @to_drop > 0 AND @safe_021 = 1,
    @alter_sql,
    'SELECT ''nothing to drop: no constraint created by 021 remains'' AS alter_note'
);

PREPARE alter_stmt FROM @run_sql;
EXECUTE alter_stmt;
DEALLOCATE PREPARE alter_stmt;

/* ============================================================================
   6. POST-DDL VERIFICATION
      The rollback ledger is not updated until this verification passes.
   ============================================================================ */

SET @e1_after = (
    SELECT COUNT(*)
      FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'payments'
       AND CONSTRAINT_NAME = 'ck_payments_amount_positive'
);

SET @e2_after = (
    SELECT COUNT(*)
      FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'payments'
       AND CONSTRAINT_NAME = 'ck_payments_original_nonnegative'
);

SET @e3_after = (
    SELECT COUNT(*)
      FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'payments'
       AND CONSTRAINT_NAME = 'ck_payments_late_fine_nonnegative'
);

/*
For each constraint scheduled for DROP, verify that it is now absent.
Constraints already gone are acceptable. Constraints not created by 021 are
not scheduled for removal and are not required to be absent.
*/
SET @ddl_success = IF(
    @safe_021 = 1
    AND (@r1 <> 'drop' OR @e1_after = 0)
    AND (@r2 <> 'drop' OR @e2_after = 0)
    AND (@r3 <> 'drop' OR @e3_after = 0),
    1, 0
);

SELECT @ddl_success AS rollback_schema_verified,
       @e1_after AS amount_positive_remaining,
       @e2_after AS original_nonnegative_remaining,
       @e3_after AS late_fine_nonnegative_remaining;

/* ============================================================================
   7. LEDGER: record rollback only after verified schema state
   ============================================================================ */

UPDATE migration_ledger
   SET rollback_state = 'rolled_back',
       rolled_back_at = CURRENT_TIMESTAMP,
       rolled_back_by = USER()
 WHERE migration_name = '021_payment_amount_nonnegative'
   AND migration_version = 21
   AND rollback_state = 'applied'
   AND @act = 1
   AND @safe_021 = 1
   AND @ddl_success = 1;

INSERT INTO migration_ledger
    (migration_name, migration_version, entry_kind,
     applied_by, rollback_state, rolled_back_at, rolled_back_by)
SELECT '021_payment_amount_nonnegative',
       21,
       'run_rolled_back',
       USER(),
       'rolled_back',
       CURRENT_TIMESTAMP,
       USER()
  FROM DUAL
 WHERE @act = 1
   AND @safe_021 = 1
   AND @ddl_success = 1;

/* ============================================================================
   8. POST-CHECK (read-only)
   ============================================================================ */

/* 8a. CHECKs left on payments. */
SELECT CONSTRAINT_NAME, CHECK_CLAUSE
  FROM information_schema.CHECK_CONSTRAINTS
 WHERE CONSTRAINT_SCHEMA = DATABASE()
   AND TABLE_NAME = 'payments'
 ORDER BY CONSTRAINT_NAME;

/* 8b. The two retained 020 constraints should remain. */
SELECT COUNT(*) AS retained_020_constraints
  FROM information_schema.CHECK_CONSTRAINTS
 WHERE CONSTRAINT_SCHEMA = DATABASE()
   AND TABLE_NAME = 'payments'
   AND CONSTRAINT_NAME IN (
       'ck_payments_amount_breakdown',
       'ck_payments_type_links'
   );

/* 8c. Data row counts should be unchanged. */
SELECT (SELECT COUNT(*) FROM payments)            AS payment_rows,
       (SELECT COUNT(*) FROM applications)        AS application_rows,
       (SELECT COUNT(*) FROM hostel_misc_charges) AS misc_charge_rows;

/* 8d. Ledger entries for version 21. */
SELECT id, entry_kind, object_type, object_name, applied_by,
       rollback_state, rolled_back_at, rolled_back_by
  FROM migration_ledger
 WHERE migration_version = 21
 ORDER BY id;

SELECT IF(
    @ddl_success = 1,
    '021 ROLLBACK VERIFICATION PASSED',
    '021 ROLLBACK NOT VERIFIED: DO NOT TREAT AS COMPLETE'
) AS rollback_status;