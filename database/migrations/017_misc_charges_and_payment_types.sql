/*
===============================================================================
MIGRATION 017
Name: 017_misc_charges_and_payment_types

Purpose:
  Add deadline/fixed-fine support to hostel_misc_charges and extend payments
  to support both hostel-fee and miscellaneous-charge payments.

IMPORTANT:
  - P9B SCRATCH TEST ONLY.
  - DO NOT point this file at live smart_hostel yet.
  - Migrations 011-016 are authoritative and must not be recreated,
    rerun, modified, or rolled back by this migration.
  - No triggers are created.
===============================================================================
*/

USE smart_hostel_p9b_scratch;


/* ============================================================================
   1. PRE-FLIGHT
   ============================================================================ */

SELECT
    '017 PRE-FLIGHT' AS check_name,
    DATABASE() AS connected_database;

SELECT
    COUNT(*) AS existing_017_entries
FROM migration_ledger
WHERE migration_version = 17
  AND rollback_state = 'applied';

SELECT
    TABLE_NAME,
    COLUMN_NAME
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('hostel_misc_charges', 'payments')
  AND COLUMN_NAME IN (
      'deadline_at',
      'late_fine_amount',
      'payment_type',
      'hostel_misc_charge_id',
      'original_amount',
      'late_fine_applied',
      'paid_key',
      'hostel_paid_key',
      'misc_paid_key'
  )
ORDER BY TABLE_NAME, ORDINAL_POSITION;

SELECT COUNT(*) AS payment_rows
FROM payments;

SELECT COUNT(*) AS misc_charge_rows
FROM hostel_misc_charges;

/*
Expected on the clean P9B baseline:
  existing_017_entries = 0
  payment_rows = 0
  misc_charge_rows = 0
*/


/* ============================================================================
   2. RECORD MIGRATION START
   ============================================================================ */

INSERT INTO migration_ledger
(
    migration_name,
    migration_version,
    entry_kind,
    applied_by
)
VALUES
(
    '017_misc_charges_and_payment_types',
    17,
    'run_started',
    USER()
);


/* ============================================================================
   3. EXTEND HOSTEL MISC CHARGES
   ============================================================================ */

ALTER TABLE hostel_misc_charges
    ADD COLUMN deadline_at DATETIME NULL AFTER is_required,
    ADD COLUMN late_fine_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00
        AFTER deadline_at,
    ADD CONSTRAINT ck_misc_charges_fine
        CHECK (
            late_fine_amount >= 0
            AND (
                late_fine_amount = 0
                OR deadline_at IS NOT NULL
            )
        );


/* ============================================================================
   4. EXTEND PAYMENTS
   ============================================================================ */

ALTER TABLE payments
    ADD COLUMN payment_type ENUM('hostel','miscellaneous')
        NOT NULL DEFAULT 'hostel'
        AFTER hostel_fee_id,
    ADD COLUMN hostel_misc_charge_id INT(10) UNSIGNED NULL
        AFTER payment_type,
    ADD COLUMN original_amount DECIMAL(10,2)
        NOT NULL DEFAULT 0.00
        AFTER amount,
    ADD COLUMN late_fine_applied DECIMAL(10,2)
        NOT NULL DEFAULT 0.00
        AFTER original_amount;


/*
Existing payments, if any, are legacy hostel payments.
Preserve their original paid amount as original_amount and no fine.
*/
UPDATE payments
SET
    original_amount = amount,
    late_fine_applied = 0.00
WHERE payment_type = 'hostel';


/*
hostel_fee_id must be nullable for miscellaneous payments.
*/
ALTER TABLE payments
    MODIFY COLUMN hostel_fee_id INT(10) UNSIGNED NULL;


/* ============================================================================
   5. PAYMENT INVARIANT CHECKS
   ============================================================================ */

ALTER TABLE payments
    ADD CONSTRAINT ck_payments_amount_breakdown
        CHECK (
            amount = original_amount + late_fine_applied
        ),
    ADD CONSTRAINT ck_payments_type_links
        CHECK (
            (
                payment_type = 'hostel'
                AND hostel_fee_id IS NOT NULL
                AND hostel_misc_charge_id IS NULL
                AND late_fine_applied = 0
            )
            OR
            (
                payment_type = 'miscellaneous'
                AND hostel_fee_id IS NULL
                AND hostel_misc_charge_id IS NOT NULL
            )
        );


/* ============================================================================
   6. MISCELLANEOUS CHARGE FOREIGN KEY / INDEX
   ============================================================================ */

ALTER TABLE payments
    ADD KEY idx_payments_misc_charge (hostel_misc_charge_id),
    ADD CONSTRAINT fk_payments_misc_charge
        FOREIGN KEY (hostel_misc_charge_id)
        REFERENCES hostel_misc_charges (id)
        ON UPDATE CASCADE;


/* ============================================================================
   7. REPLACE OLD SUCCESSFUL-PAYMENT UNIQUENESS KEY
   ============================================================================ */

ALTER TABLE payments
    DROP INDEX uq_paid_application,
    DROP COLUMN paid_key;


/*
Successful hostel payment:
  H:<application_id>:<hostel_session_id>

Successful miscellaneous payment:
  M:<application_id>:<hostel_session_id>:<hostel_misc_charge_id>

The generated keys remain NULL for non-successful payments.
*/
ALTER TABLE payments
    ADD COLUMN hostel_paid_key VARCHAR(255)
        GENERATED ALWAYS AS (
            CASE
                WHEN status = 'success'
                     AND payment_type = 'hostel'
                THEN CONCAT(
                    'H:',
                    CAST(application_id AS CHAR),
                    ':',
                    CAST(hostel_session_id AS CHAR)
                )
                ELSE NULL
            END
        ) STORED
        AFTER paid_at,
    ADD COLUMN misc_paid_key VARCHAR(255)
        GENERATED ALWAYS AS (
            CASE
                WHEN status = 'success'
                     AND payment_type = 'miscellaneous'
                THEN CONCAT(
                    'M:',
                    CAST(application_id AS CHAR),
                    ':',
                    CAST(hostel_session_id AS CHAR),
                    ':',
                    CAST(hostel_misc_charge_id AS CHAR)
                )
                ELSE NULL
            END
        ) STORED
        AFTER hostel_paid_key;


/* ============================================================================
   8. UNIQUE INDEXES
   ============================================================================ */

ALTER TABLE payments
    ADD UNIQUE KEY uq_successful_hostel_payment (hostel_paid_key),
    ADD UNIQUE KEY uq_successful_misc_payment (misc_paid_key);


/* ============================================================================
   9. RECORD MIGRATION OBJECTS
   ============================================================================ */

INSERT INTO migration_ledger
(
    migration_name,
    migration_version,
    entry_kind,
    object_type,
    object_table,
    object_name,
    row_key,
    applied_by
)
VALUES
(
    '017_misc_charges_and_payment_types',
    17,
    'created_object',
    'constraint',
    'hostel_misc_charges',
    'ck_misc_charges_fine',
    'definition',
    USER()
),
(
    '017_misc_charges_and_payment_types',
    17,
    'created_object',
    'constraint',
    'payments',
    'ck_payments_amount_breakdown',
    'definition',
    USER()
),
(
    '017_misc_charges_and_payment_types',
    17,
    'created_object',
    'constraint',
    'payments',
    'ck_payments_type_links',
    'definition',
    USER()
),
(
    '017_misc_charges_and_payment_types',
    17,
    'created_object',
    'foreign_key',
    'payments',
    'fk_payments_misc_charge',
    'definition',
    USER()
),
(
    '017_misc_charges_and_payment_types',
    17,
    'created_object',
    'index',
    'payments',
    'idx_payments_misc_charge',
    'definition',
    USER()
),
(
    '017_misc_charges_and_payment_types',
    17,
    'created_object',
    'index',
    'payments',
    'uq_successful_hostel_payment',
    'definition',
    USER()
),
(
    '017_misc_charges_and_payment_types',
    17,
    'created_object',
    'index',
    'payments',
    'uq_successful_misc_payment',
    'definition',
    USER()
);


/* ============================================================================
   10. VERIFY MISC CHARGE COLUMNS
   ============================================================================ */

SELECT
    COLUMN_NAME,
    COLUMN_TYPE,
    IS_NULLABLE,
    COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'hostel_misc_charges'
  AND COLUMN_NAME IN ('deadline_at', 'late_fine_amount')
ORDER BY ORDINAL_POSITION;


/* ============================================================================
   11. VERIFY PAYMENT COLUMNS
   ============================================================================ */

SELECT
    COLUMN_NAME,
    COLUMN_TYPE,
    IS_NULLABLE,
    COLUMN_DEFAULT,
    EXTRA
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'payments'
  AND COLUMN_NAME IN (
      'payment_type',
      'hostel_misc_charge_id',
      'hostel_fee_id',
      'original_amount',
      'late_fine_applied',
      'hostel_paid_key',
      'misc_paid_key'
  )
ORDER BY ORDINAL_POSITION;


/* ============================================================================
   12. VERIFY PAYMENT INDEXES
   ============================================================================ */

SHOW INDEX FROM payments;


/* ============================================================================
   13. VERIFY FOREIGN KEY
   ============================================================================ */

SELECT
    CONSTRAINT_NAME,
    TABLE_NAME,
    COLUMN_NAME,
    REFERENCED_TABLE_NAME,
    REFERENCED_COLUMN_NAME
FROM information_schema.KEY_COLUMN_USAGE
WHERE CONSTRAINT_SCHEMA = DATABASE()
  AND TABLE_NAME = 'payments'
  AND CONSTRAINT_NAME = 'fk_payments_misc_charge';


/* ============================================================================
   14. VERIFY CHECK CONSTRAINTS
   ============================================================================ */

SELECT
    CONSTRAINT_NAME,
    CHECK_CLAUSE
FROM information_schema.CHECK_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE()
  AND CONSTRAINT_NAME IN (
      'ck_misc_charges_fine',
      'ck_payments_amount_breakdown',
      'ck_payments_type_links'
  )
ORDER BY CONSTRAINT_NAME;


/* ============================================================================
   15. VERIFY GENERATED KEY DEFINITIONS
   ============================================================================ */

SELECT
    TABLE_NAME,
    COLUMN_NAME,
    GENERATION_EXPRESSION
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'payments'
  AND COLUMN_NAME IN ('hostel_paid_key', 'misc_paid_key');


/* ============================================================================
   16. VERIFY NO TRIGGERS WERE CREATED
   ============================================================================ */

SELECT
    TRIGGER_NAME,
    EVENT_MANIPULATION,
    EVENT_OBJECT_TABLE
FROM information_schema.TRIGGERS
WHERE TRIGGER_SCHEMA = DATABASE()
  AND EVENT_OBJECT_TABLE IN ('payments', 'hostel_misc_charges')
ORDER BY TRIGGER_NAME;


/* ============================================================================
   17. VERIFY DATA COUNTS
   ============================================================================ */

SELECT
    (SELECT COUNT(*) FROM payments) AS payment_count,
    (SELECT COUNT(*) FROM hostel_misc_charges) AS misc_charge_count;


/* ============================================================================
   18. RECORD MIGRATION COMPLETION
   ============================================================================ */

INSERT INTO migration_ledger
(
    migration_name,
    migration_version,
    entry_kind,
    applied_by
)
VALUES
(
    '017_misc_charges_and_payment_types',
    17,
    'run_completed',
    USER()
);


/* ============================================================================
   19. FINAL LEDGER CHECK
   ============================================================================ */

SELECT
    id,
    migration_name,
    migration_version,
    entry_kind,
    object_type,
    object_table,
    object_name,
    row_key,
    rollback_state
FROM migration_ledger
WHERE migration_version = 17
ORDER BY id;
