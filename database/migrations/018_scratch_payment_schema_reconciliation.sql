
USE smart_hostel_scratch;

-- 018: Consolidated payment schema reconciliation.
-- Scratch database only. Do not run against smart_hostel.
-- Preconditions: payments is empty; session 2026/2027 is current/open;
-- migration 014 has created hostel_misc_charges.

-- 1. Verify preconditions before proceeding.
SELECT
    DATABASE() AS connected_database,
    VERSION() AS server_version,
    (SELECT COUNT(*) FROM payments) AS payment_rows,
    (SELECT COUNT(*) FROM hostel_sessions
      WHERE label = '2026/2027'
        AND status = 'open'
        AND is_current = 1) AS current_session_count,
    (SELECT COUNT(*) FROM hostel_misc_charges) AS misc_charge_table_count;

-- STOP if database is not smart_hostel_scratch, payment_rows is not 0,
-- or current_session_count is not 1.

-- 2. Add session and fee relationships.
ALTER TABLE payments
    ADD COLUMN hostel_session_id INT(10) UNSIGNED NOT NULL
        AFTER application_id,
    ADD COLUMN hostel_fee_id INT(10) UNSIGNED NULL
        AFTER hostel_session_id;

-- 3. Add payment type and amount breakdown.
ALTER TABLE payments
    ADD COLUMN payment_type ENUM('hostel','miscellaneous')
        NOT NULL DEFAULT 'hostel' AFTER hostel_fee_id,
    ADD COLUMN hostel_misc_charge_id INT(10) UNSIGNED NULL
        AFTER payment_type,
    ADD COLUMN original_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00
        AFTER amount,
    ADD COLUMN late_fine_applied DECIMAL(10,2) NOT NULL DEFAULT 0.00
        AFTER original_amount;

-- 4. Add deadline and fixed-fine support.
ALTER TABLE hostel_misc_charges
    ADD COLUMN deadline_at DATETIME NULL AFTER is_required,
    ADD COLUMN late_fine_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00
        AFTER deadline_at,
    ADD CONSTRAINT ck_misc_charges_fine
        CHECK (
            late_fine_amount >= 0
            AND (late_fine_amount = 0 OR deadline_at IS NOT NULL)
        );

-- The payments table was verified empty before this migration.
-- Existing-payment backfill is therefore unnecessary.
ALTER TABLE payments
    ADD CONSTRAINT ck_payments_amount_breakdown
        CHECK (amount = original_amount + late_fine_applied),
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

-- 5. Add indexes and foreign keys.
ALTER TABLE payments
    ADD KEY idx_payments_hostel_session (hostel_session_id),
    ADD KEY idx_payments_hostel_fee (hostel_fee_id),
    ADD KEY idx_payments_application_session
        (application_id, hostel_session_id),
    ADD KEY idx_payments_misc_charge (hostel_misc_charge_id),
    ADD CONSTRAINT fk_payments_hostel_session
        FOREIGN KEY (hostel_session_id)
        REFERENCES hostel_sessions (id)
        ON UPDATE CASCADE,
    ADD CONSTRAINT fk_payments_hostel_fee
        FOREIGN KEY (hostel_fee_id)
        REFERENCES hostel_fees (id)
        ON UPDATE CASCADE,
    ADD CONSTRAINT fk_payments_application_session
        FOREIGN KEY (application_id, hostel_session_id)
        REFERENCES applications (id, hostel_session_id)
        ON UPDATE CASCADE,
    ADD CONSTRAINT fk_payments_misc_charge
        FOREIGN KEY (hostel_misc_charge_id)
        REFERENCES hostel_misc_charges (id)
        ON UPDATE CASCADE;

-- 6. Replace application-only uniqueness with session/type-aware keys.
ALTER TABLE payments
    DROP INDEX uq_paid_application,
    DROP COLUMN paid_key;

ALTER TABLE payments
    ADD COLUMN hostel_paid_key VARCHAR(255)
        GENERATED ALWAYS AS (
            CASE
                WHEN status = 'success' AND payment_type = 'hostel'
                THEN CONCAT(
                    'H:', CAST(application_id AS CHAR),
                    ':', CAST(hostel_session_id AS CHAR)
                )
                ELSE NULL
            END
        ) STORED AFTER paid_at,
    ADD COLUMN misc_paid_key VARCHAR(255)
        GENERATED ALWAYS AS (
            CASE
                WHEN status = 'success' AND payment_type = 'miscellaneous'
                THEN CONCAT(
                    'M:', CAST(application_id AS CHAR),
                    ':', CAST(hostel_session_id AS CHAR),
                    ':', CAST(hostel_misc_charge_id AS CHAR)
                )
                ELSE NULL
            END
        ) STORED AFTER hostel_paid_key,
    ADD UNIQUE KEY uq_successful_hostel_payment (hostel_paid_key),
    ADD UNIQUE KEY uq_successful_misc_payment (misc_paid_key);

-- 7. Verify the resulting schema.
SELECT
    DATABASE() AS connected_database,
    (SELECT COUNT(*) FROM payments) AS payment_count,
    (SELECT COUNT(*) FROM hostel_misc_charges) AS misc_charge_count;

SHOW CREATE TABLE payments;
SHOW CREATE TABLE hostel_misc_charges;
SHOW INDEX FROM payments;

SELECT
    CONSTRAINT_NAME,
    COLUMN_NAME,
    REFERENCED_TABLE_NAME,
    REFERENCED_COLUMN_NAME
FROM information_schema.KEY_COLUMN_USAGE
WHERE CONSTRAINT_SCHEMA = DATABASE()
  AND TABLE_NAME = 'payments'
  AND REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION;

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

SELECT '018 VERIFICATION QUERIES COMPLETE' AS result;
