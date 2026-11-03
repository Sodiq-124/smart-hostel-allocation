/*
===============================================================================
MIGRATION 021
Name: 021_payment_amount_nonnegative

Purpose:
  Database-level protection against negative or zero payment amounts.
  Migration 020's ck_payments_amount_breakdown (amount = original_amount +
  late_fine_applied) is satisfied by negative values such as -5 = -5 + 0, and
  nothing else stops them. Application code already rejects such values; this
  makes the database refuse them too.

Adds three CHECK constraints to `payments` (nothing else):
  ck_payments_amount_positive        CHECK (amount > 0)
  ck_payments_original_nonnegative   CHECK (original_amount >= 0)
  ck_payments_late_fine_nonnegative  CHECK (late_fine_applied >= 0)

Retained untouched: ck_payments_amount_breakdown, ck_payments_type_links, the
unique keys, foreign keys, every column, and every row. No table is dropped or
rebuilt by this file, and no application, allocation, payment, fee or
miscellaneous-charge row is modified.

SAFETY DESIGN
  - Database guard: the script STOPS unless connected to `smart_hostel`.
  - Baseline guards: it STOPS unless migration_ledger, the three payment columns
    (which must be NOT NULL, so a NULL cannot slip past a CHECK) and the two
    retained 020 constraints exist WITH THEIR EXPECTED DEFINITIONS, and unless
    no existing payment row would violate the new checks.
  - Defence in depth: every write below is conditional on @safe_021 = 1, set
    only when ALL guards passed.
  - Idempotent: each constraint is checked by NAME and DEFINITION.
        same name + same definition  -> already present, skipped
        same definition, other name  -> equivalent exists, skipped
        same name, DIFFERENT definition -> STOP
        neither                      -> added
  - One ALTER TABLE adds all missing constraints atomically.
  - After ALTER TABLE, the script verifies the resulting schema BEFORE writing
    created_object or run_completed ledger entries. If the ALTER fails or the
    resulting schema is not as expected, those success entries are not written.
  - Ledger: run_started, created_object entries and run_completed use the
    existing migration_ledger columns. A no-op rerun writes no ledger rows.

HOW A STOP WORKS
  A failed guard deliberately runs a statement against a table named
  STOP_021_<reason>, which does not exist. Do not use the --force option.

HOW TO RUN (you run it; nothing here runs itself):
  From the project root, in Command Prompt, after taking a backup:
      C:\xampp\mysql\bin\mysql.exe -u root --database=smart_hostel < database\migrations\021_payment_amount_nonnegative.sql

COMPATIBILITY: MariaDB 10.4.

ROLLBACK (not executed by this file):
  Use 021_payment_amount_nonnegative_rollback.sql. It removes ONLY constraints
  that migration 021 itself created, identified by this migration's own ledger
  entries. Read the rollback file's header before running it.
===============================================================================
*/

/* ============================================================================
   1. DATABASE GUARD
   ============================================================================ */

SET @expected_database = 'smart_hostel';

SET @ok_db = 0,
    @ok_ledger = 0,
    @ok_cols = 0,
    @ok_retained = 0,
    @ok_data = 0,
    @ok_conflict = 0,
    @safe_021 = 0,
    @ddl_success = 0;

SET @ok_db = IF(DATABASE() <=> @expected_database, 1, 0);

SET @guard = IF(@ok_db = 1,
    'SELECT ''guard passed: connected to smart_hostel'' AS database_guard',
    'SELECT * FROM `STOP_021_connected_database_is_not_smart_hostel`');

PREPARE guard_stmt FROM @guard;
EXECUTE guard_stmt;
DEALLOCATE PREPARE guard_stmt;

/* ============================================================================
   2. PRE-FLIGHT (read-only)
   ============================================================================ */

SELECT '021 PRE-FLIGHT' AS check_name,
       DATABASE() AS connected_database,
       VERSION() AS mariadb_version;

SELECT (SELECT COUNT(*) FROM payments)            AS payment_rows,
       (SELECT COUNT(*) FROM applications)        AS application_rows,
       (SELECT COUNT(*) FROM hostel_misc_charges) AS misc_charge_rows;

/* ============================================================================
   3. BASELINE GUARDS
   ============================================================================ */

/* 3a. migration_ledger exists with the columns this file writes. */
SET @ok_ledger = IF(
    (SELECT COUNT(*)
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'migration_ledger'
        AND COLUMN_NAME IN (
            'migration_name', 'migration_version', 'entry_kind',
            'object_type', 'object_table', 'object_name',
            'row_key', 'after_value', 'applied_by'
        )
    ) = 9,
    1, 0
);

SET @guard = IF(@ok_ledger = 1,
    'SELECT ''guard passed: migration_ledger has the expected columns'' AS ledger_guard',
    'SELECT * FROM `STOP_021_migration_ledger_missing_or_different`');

PREPARE guard_stmt FROM @guard;
EXECUTE guard_stmt;
DEALLOCATE PREPARE guard_stmt;

/* 3b. The three payment columns exist and are NOT NULL. */
SET @ok_cols = IF(
    (SELECT COUNT(*)
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'payments'
        AND COLUMN_NAME IN (
            'amount', 'original_amount', 'late_fine_applied'
        )
        AND IS_NULLABLE = 'NO'
    ) = 3,
    1, 0
);

SET @guard = IF(@ok_cols = 1,
    'SELECT ''guard passed: payment amount columns exist and are NOT NULL'' AS column_guard',
    'SELECT * FROM `STOP_021_payments_columns_missing_or_nullable_migration_020_not_applied`');

PREPARE guard_stmt FROM @guard;
EXECUTE guard_stmt;
DEALLOCATE PREPARE guard_stmt;

/*
3c. The two 020 constraints this migration retains must exist with their
expected definitions. Parentheses are retained for this comparison so a
wrongly grouped clause is refused.
*/

SET @bd_clause = (
    SELECT REPLACE(
             REPLACE(
               REPLACE(
                 REPLACE(
                   REPLACE(LOWER(CHECK_CLAUSE), '`', ''),
                   ' ', ''
                 ),
                 CHAR(9), ''
               ),
               CHAR(10), ''
             ),
             CHAR(13), ''
           )
      FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'payments'
       AND CONSTRAINT_NAME = 'ck_payments_amount_breakdown'
);

SET @tl_clause = (
    SELECT REPLACE(
             REPLACE(
               REPLACE(
                 REPLACE(
                   REPLACE(LOWER(CHECK_CLAUSE), '`', ''),
                   ' ', ''
                 ),
                 CHAR(9), ''
               ),
               CHAR(10), ''
             ),
             CHAR(13), ''
           )
      FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'payments'
       AND CONSTRAINT_NAME = 'ck_payments_type_links'
);

SET @bd_ok = IF(
    @bd_clause IN (
        'amount=original_amount+late_fine_applied',
        '(amount=original_amount+late_fine_applied)'
    ),
    1, 0
);

SET @tl_ok = IF(
    @tl_clause IN (
        '(payment_type=''hostel''andhostel_fee_idisnotnullandhostel_misc_charge_idisnullandlate_fine_applied=0)or(payment_type=''miscellaneous''andhostel_fee_idisnullandhostel_misc_charge_idisnotnull)',
        'payment_type=''hostel''andhostel_fee_idisnotnullandhostel_misc_charge_idisnullandlate_fine_applied=0orpayment_type=''miscellaneous''andhostel_fee_idisnullandhostel_misc_charge_idisnotnull',
        '((payment_type=''hostel''andhostel_fee_idisnotnullandhostel_misc_charge_idisnullandlate_fine_applied=0)or(payment_type=''miscellaneous''andhostel_fee_idisnullandhostel_misc_charge_idisnotnull))',
        '(payment_type=''hostel''andhostel_fee_idisnotnullandhostel_misc_charge_idisnullandlate_fine_applied=0orpayment_type=''miscellaneous''andhostel_fee_idisnullandhostel_misc_charge_idisnotnull)'
    ),
    1, 0
);

SELECT 'ck_payments_amount_breakdown' AS retained_constraint,
       (
           SELECT CHECK_CLAUSE
             FROM information_schema.CHECK_CONSTRAINTS
            WHERE CONSTRAINT_SCHEMA = DATABASE()
              AND TABLE_NAME = 'payments'
              AND CONSTRAINT_NAME = 'ck_payments_amount_breakdown'
       ) AS actual_clause,
       @bd_ok AS definition_as_expected
UNION ALL
SELECT 'ck_payments_type_links',
       (
           SELECT CHECK_CLAUSE
             FROM information_schema.CHECK_CONSTRAINTS
            WHERE CONSTRAINT_SCHEMA = DATABASE()
              AND TABLE_NAME = 'payments'
              AND CONSTRAINT_NAME = 'ck_payments_type_links'
       ),
       @tl_ok;

SET @ok_retained = IF(@bd_ok = 1 AND @tl_ok = 1, 1, 0);

SET @guard = IF(@ok_retained = 1,
    'SELECT ''guard passed: retained 020 constraints have their expected definitions'' AS baseline_guard',
    'SELECT * FROM `STOP_021_retained_020_constraint_missing_or_its_definition_differs`');

PREPARE guard_stmt FROM @guard;
EXECUTE guard_stmt;
DEALLOCATE PREPARE guard_stmt;

/* 3d. No existing payment row would violate the new checks. */
SET @ok_data = IF(
    (SELECT COUNT(*)
       FROM payments
      WHERE amount <= 0
         OR original_amount < 0
         OR late_fine_applied < 0
    ) = 0,
    1, 0
);

SET @guard = IF(@ok_data = 1,
    'SELECT ''guard passed: no existing payment row violates the new checks'' AS data_guard',
    'SELECT * FROM `STOP_021_existing_payment_rows_violate_the_new_checks`');

PREPARE guard_stmt FROM @guard;
EXECUTE guard_stmt;
DEALLOCATE PREPARE guard_stmt;

/* ============================================================================
   4. STATE OF EACH CONSTRAINT (by name AND definition)
   ============================================================================ */

/* ck_payments_amount_positive -> amount>0 */
SET @n1_name = (
    SELECT COUNT(*)
      FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'payments'
       AND CONSTRAINT_NAME = 'ck_payments_amount_positive'
);

SET @n1_same = (
    SELECT COUNT(*)
      FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'payments'
       AND CONSTRAINT_NAME = 'ck_payments_amount_positive'
       AND REPLACE(REPLACE(REPLACE(REPLACE(LOWER(CHECK_CLAUSE), '`', ''), ' ', ''), '(', ''), ')', '') = 'amount>0'
);

SET @n1_equiv = (
    SELECT COUNT(*)
      FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'payments'
       AND CONSTRAINT_NAME <> 'ck_payments_amount_positive'
       AND REPLACE(REPLACE(REPLACE(REPLACE(LOWER(CHECK_CLAUSE), '`', ''), ' ', ''), '(', ''), ')', '') = 'amount>0'
);

SET @s1 = IF(
    @n1_name > 0,
    IF(@n1_same > 0, 'present', 'conflict'),
    IF(@n1_equiv > 0, 'equivalent', 'missing')
);

/* ck_payments_original_nonnegative -> original_amount>=0 */
SET @n2_name = (
    SELECT COUNT(*)
      FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'payments'
       AND CONSTRAINT_NAME = 'ck_payments_original_nonnegative'
);

SET @n2_same = (
    SELECT COUNT(*)
      FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'payments'
       AND CONSTRAINT_NAME = 'ck_payments_original_nonnegative'
       AND REPLACE(REPLACE(REPLACE(REPLACE(LOWER(CHECK_CLAUSE), '`', ''), ' ', ''), '(', ''), ')', '') = 'original_amount>=0'
);

SET @n2_equiv = (
    SELECT COUNT(*)
      FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'payments'
       AND CONSTRAINT_NAME <> 'ck_payments_original_nonnegative'
       AND REPLACE(REPLACE(REPLACE(REPLACE(LOWER(CHECK_CLAUSE), '`', ''), ' ', ''), '(', ''), ')', '') = 'original_amount>=0'
);

SET @s2 = IF(
    @n2_name > 0,
    IF(@n2_same > 0, 'present', 'conflict'),
    IF(@n2_equiv > 0, 'equivalent', 'missing')
);

/* ck_payments_late_fine_nonnegative -> late_fine_applied>=0 */
SET @n3_name = (
    SELECT COUNT(*)
      FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'payments'
       AND CONSTRAINT_NAME = 'ck_payments_late_fine_nonnegative'
);

SET @n3_same = (
    SELECT COUNT(*)
      FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'payments'
       AND CONSTRAINT_NAME = 'ck_payments_late_fine_nonnegative'
       AND REPLACE(REPLACE(REPLACE(REPLACE(LOWER(CHECK_CLAUSE), '`', ''), ' ', ''), '(', ''), ')', '') = 'late_fine_applied>=0'
);

SET @n3_equiv = (
    SELECT COUNT(*)
      FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'payments'
       AND CONSTRAINT_NAME <> 'ck_payments_late_fine_nonnegative'
       AND REPLACE(REPLACE(REPLACE(REPLACE(LOWER(CHECK_CLAUSE), '`', ''), ' ', ''), '(', ''), ')', '') = 'late_fine_applied>=0'
);

SET @s3 = IF(
    @n3_name > 0,
    IF(@n3_same > 0, 'present', 'conflict'),
    IF(@n3_equiv > 0, 'equivalent', 'missing')
);

SELECT 'ck_payments_amount_positive' AS constraint_name,
       'amount > 0' AS expected_definition,
       @s1 AS state
UNION ALL
SELECT 'ck_payments_original_nonnegative',
       'original_amount >= 0',
       @s2
UNION ALL
SELECT 'ck_payments_late_fine_nonnegative',
       'late_fine_applied >= 0',
       @s3;

/* A same-name constraint with a different definition is never replaced. */
SET @ok_conflict = IF(
    @s1 <> 'conflict'
    AND @s2 <> 'conflict'
    AND @s3 <> 'conflict',
    1, 0
);

SET @guard = IF(@ok_conflict = 1,
    'SELECT ''guard passed: no constraint with one of these names has a different definition'' AS conflict_guard',
    'SELECT * FROM `STOP_021_a_constraint_with_this_name_exists_with_a_different_definition`');

PREPARE guard_stmt FROM @guard;
EXECUTE guard_stmt;
DEALLOCATE PREPARE guard_stmt;

/* Master flag: every guard must pass before any migration write. */
SET @safe_021 = IF(
    @ok_db = 1
    AND @ok_ledger = 1
    AND @ok_cols = 1
    AND @ok_retained = 1
    AND @ok_data = 1
    AND @ok_conflict = 1,
    1, 0
);

SET @to_add = IF(
    @safe_021 = 1,
    (@s1 = 'missing') + (@s2 = 'missing') + (@s3 = 'missing'),
    0
);

SELECT @safe_021 AS all_guards_passed,
       @to_add AS constraints_to_add;

/* ============================================================================
   5. LEDGER: run_started (only when something will be added)
   ============================================================================ */

INSERT INTO migration_ledger
    (migration_name, migration_version, entry_kind, applied_by)
SELECT '021_payment_amount_nonnegative', 21, 'run_started', USER()
  FROM DUAL
 WHERE @to_add > 0
   AND @safe_021 = 1;

/* ============================================================================
   6. THE SCHEMA CHANGE (one ALTER adding only missing constraints)
   ============================================================================ */

SET @alter_sql = CONCAT_WS(' ',
    'ALTER TABLE payments',
    CONCAT_WS(', ',
        IF(
            @s1 = 'missing',
            'ADD CONSTRAINT ck_payments_amount_positive CHECK (amount > 0)',
            NULL
        ),
        IF(
            @s2 = 'missing',
            'ADD CONSTRAINT ck_payments_original_nonnegative CHECK (original_amount >= 0)',
            NULL
        ),
        IF(
            @s3 = 'missing',
            'ADD CONSTRAINT ck_payments_late_fine_nonnegative CHECK (late_fine_applied >= 0)',
            NULL
        )
    )
);

SET @run_sql = IF(
    @to_add > 0 AND @safe_021 = 1,
    @alter_sql,
    'SELECT ''nothing to add: no missing constraints under the passed guards'' AS alter_note'
);

PREPARE alter_stmt FROM @run_sql;
EXECUTE alter_stmt;
DEALLOCATE PREPARE alter_stmt;

/* ============================================================================
   7. POST-DDL VERIFICATION
      Do not record created_object or run_completed until this passes.
   ============================================================================ */

SET @n1_after = (
    SELECT COUNT(*)
      FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'payments'
       AND CONSTRAINT_NAME = 'ck_payments_amount_positive'
       AND REPLACE(REPLACE(REPLACE(REPLACE(LOWER(CHECK_CLAUSE), '`', ''), ' ', ''), '(', ''), ')', '') = 'amount>0'
);

SET @n2_after = (
    SELECT COUNT(*)
      FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'payments'
       AND CONSTRAINT_NAME = 'ck_payments_original_nonnegative'
       AND REPLACE(REPLACE(REPLACE(REPLACE(LOWER(CHECK_CLAUSE), '`', ''), ' ', ''), '(', ''), ')', '') = 'original_amount>=0'
);

SET @n3_after = (
    SELECT COUNT(*)
      FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = 'payments'
       AND CONSTRAINT_NAME = 'ck_payments_late_fine_nonnegative'
       AND REPLACE(REPLACE(REPLACE(REPLACE(LOWER(CHECK_CLAUSE), '`', ''), ' ', ''), '(', ''), ')', '') = 'late_fine_applied>=0'
);

/*
A constraint originally marked present or equivalent does not need to be
created under this migration's name. Every constraint originally marked
missing must now exist under the expected name with the expected definition.
*/
SET @ddl_success = IF(
    @safe_021 = 1
    AND (@s1 <> 'missing' OR @n1_after = 1)
    AND (@s2 <> 'missing' OR @n2_after = 1)
    AND (@s3 <> 'missing' OR @n3_after = 1),
    1, 0
);

SELECT @ddl_success AS schema_change_verified,
       @n1_after AS amount_positive_verified,
       @n2_after AS original_nonnegative_verified,
       @n3_after AS late_fine_nonnegative_verified;

/* ============================================================================
   8. LEDGER: created objects + run_completed
      These success entries are written only after post-DDL verification.
   ============================================================================ */

INSERT INTO migration_ledger
    (migration_name, migration_version, entry_kind, object_type,
     object_table, object_name, row_key, after_value, applied_by)
SELECT '021_payment_amount_nonnegative', 21, 'created_object',
       'constraint', 'payments', 'ck_payments_amount_positive',
       'definition', 'CHECK (amount > 0)', USER()
  FROM DUAL
 WHERE @s1 = 'missing'
   AND @safe_021 = 1
   AND @ddl_success = 1;

INSERT INTO migration_ledger
    (migration_name, migration_version, entry_kind, object_type,
     object_table, object_name, row_key, after_value, applied_by)
SELECT '021_payment_amount_nonnegative', 21, 'created_object',
       'constraint', 'payments', 'ck_payments_original_nonnegative',
       'definition', 'CHECK (original_amount >= 0)', USER()
  FROM DUAL
 WHERE @s2 = 'missing'
   AND @safe_021 = 1
   AND @ddl_success = 1;

INSERT INTO migration_ledger
    (migration_name, migration_version, entry_kind, object_type,
     object_table, object_name, row_key, after_value, applied_by)
SELECT '021_payment_amount_nonnegative', 21, 'created_object',
       'constraint', 'payments', 'ck_payments_late_fine_nonnegative',
       'definition', 'CHECK (late_fine_applied >= 0)', USER()
  FROM DUAL
 WHERE @s3 = 'missing'
   AND @safe_021 = 1
   AND @ddl_success = 1;

INSERT INTO migration_ledger
    (migration_name, migration_version, entry_kind, applied_by)
SELECT '021_payment_amount_nonnegative', 21, 'run_completed', USER()
  FROM DUAL
 WHERE @to_add > 0
   AND @safe_021 = 1
   AND @ddl_success = 1;

/* ============================================================================
   9. POST-CHECK (read-only)
   ============================================================================ */

SELECT CONSTRAINT_NAME, CHECK_CLAUSE
  FROM information_schema.CHECK_CONSTRAINTS
 WHERE CONSTRAINT_SCHEMA = DATABASE()
   AND TABLE_NAME = 'payments'
 ORDER BY CONSTRAINT_NAME;

SELECT 'amount > 0' AS rule,
       (
           SELECT COUNT(*)
             FROM information_schema.CHECK_CONSTRAINTS
            WHERE CONSTRAINT_SCHEMA = DATABASE()
              AND TABLE_NAME = 'payments'
              AND REPLACE(REPLACE(REPLACE(REPLACE(LOWER(CHECK_CLAUSE), '`', ''), ' ', ''), '(', ''), ')', '') = 'amount>0'
       ) AS protected_by
UNION ALL
SELECT 'original_amount >= 0',
       (
           SELECT COUNT(*)
             FROM information_schema.CHECK_CONSTRAINTS
            WHERE CONSTRAINT_SCHEMA = DATABASE()
              AND TABLE_NAME = 'payments'
              AND REPLACE(REPLACE(REPLACE(REPLACE(LOWER(CHECK_CLAUSE), '`', ''), ' ', ''), '(', ''), ')', '') = 'original_amount>=0'
       )
UNION ALL
SELECT 'late_fine_applied >= 0',
       (
           SELECT COUNT(*)
             FROM information_schema.CHECK_CONSTRAINTS
            WHERE CONSTRAINT_SCHEMA = DATABASE()
              AND TABLE_NAME = 'payments'
              AND REPLACE(REPLACE(REPLACE(REPLACE(LOWER(CHECK_CLAUSE), '`', ''), ' ', ''), '(', ''), ')', '') = 'late_fine_applied>=0'
       );

SELECT (SELECT COUNT(*) FROM payments)            AS payment_rows,
       (SELECT COUNT(*) FROM applications)        AS application_rows,
       (SELECT COUNT(*) FROM hostel_misc_charges) AS misc_charge_rows;

SELECT id, entry_kind, object_type, object_table, object_name,
       row_key, after_value, applied_by, rollback_state
  FROM migration_ledger
 WHERE migration_version = 21
 ORDER BY id;

SELECT IF(@ddl_success = 1, '021 VERIFICATION PASSED',
          '021 NOT VERIFIED: DO NOT TREAT AS COMPLETE') AS migration_status;