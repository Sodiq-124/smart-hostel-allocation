-- ============================================================
-- PHASE 9 - MIGRATION 013
-- Session + fee scoping for hostel payments
-- Target: MariaDB 10.4
-- Database supplied by mysql command; NO USE statement.
-- NON-DESTRUCTIVE: existing payment rows are preserved.
-- ============================================================

SET @migration_name := '013_payments_sessions_fees';

-- ------------------------------------------------------------
-- PRECHECKS
-- ------------------------------------------------------------

SELECT
    DATABASE() AS connected_database,
    VERSION() AS server_version;

SELECT
    COUNT(*) AS current_session
FROM hostel_sessions
WHERE label = '2026/2027'
  AND status = 'open'
  AND is_current = 1;

SELECT
    COUNT(*) AS payments_before
FROM payments;

SELECT
    COUNT(*) AS current_block_fees
FROM hostel_fees
WHERE session_year = '2026/2027'
  AND hostel_session_id = (
      SELECT id
      FROM hostel_sessions
      WHERE label = '2026/2027'
        AND status = 'open'
        AND is_current = 1
      LIMIT 1
  )
  AND block_id IS NOT NULL
  AND active = 1;

-- ------------------------------------------------------------
-- ADD SESSION + FEE RELATIONSHIPS
-- ------------------------------------------------------------

ALTER TABLE payments
    ADD COLUMN hostel_session_id INT(10) UNSIGNED NULL
    AFTER application_id;

ALTER TABLE payments
    ADD COLUMN hostel_fee_id INT(10) UNSIGNED NULL
    AFTER hostel_session_id;

-- Existing payment rows, if any, would be backfilled from
-- their application. Current database has zero payment rows.

UPDATE payments p
JOIN applications a
    ON a.id = p.application_id
SET p.hostel_session_id = a.hostel_session_id
WHERE p.hostel_session_id IS NULL;

-- For existing payments, match the fee from the student's
-- application allocation block where possible.
UPDATE payments p
JOIN applications a
    ON a.id = p.application_id
JOIN allocations al
    ON al.application_id = a.id
   AND al.hostel_session_id = a.hostel_session_id
JOIN hostel_fees hf
    ON hf.hostel_session_id = a.hostel_session_id
   AND hf.block_id = (
       SELECT r.block_id
       FROM rooms r
       WHERE r.id = al.room_id
       LIMIT 1
   )
SET p.hostel_fee_id = hf.id
WHERE p.hostel_fee_id IS NULL;

-- Current database has zero payment rows, so both new
-- relationships can now be mandatory.
ALTER TABLE payments
    MODIFY COLUMN hostel_session_id INT(10) UNSIGNED NOT NULL;

ALTER TABLE payments
    MODIFY COLUMN hostel_fee_id INT(10) UNSIGNED NOT NULL;

-- ------------------------------------------------------------
-- INDEXES
-- ------------------------------------------------------------

ALTER TABLE payments
    ADD KEY idx_payments_hostel_session (hostel_session_id);

ALTER TABLE payments
    ADD KEY idx_payments_hostel_fee (hostel_fee_id);

ALTER TABLE payments
    ADD KEY idx_payments_application_session
        (application_id, hostel_session_id);

-- ------------------------------------------------------------
-- RE-SCOPE SUCCESSFUL PAYMENT UNIQUENESS
-- ------------------------------------------------------------

ALTER TABLE payments
    DROP INDEX uq_paid_application,
    DROP COLUMN paid_key;

ALTER TABLE payments
    ADD COLUMN paid_key BIGINT UNSIGNED
    GENERATED ALWAYS AS (
        CASE
            WHEN status = 'success'
            THEN (CAST(application_id AS UNSIGNED) * 4294967296)
                 + CAST(hostel_session_id AS UNSIGNED)
            ELSE NULL
        END
    ) STORED,
    ADD UNIQUE KEY uq_paid_application (paid_key);

-- ------------------------------------------------------------
-- FOREIGN KEYS
-- ------------------------------------------------------------

ALTER TABLE payments
    ADD CONSTRAINT fk_payments_hostel_session
    FOREIGN KEY (hostel_session_id)
    REFERENCES hostel_sessions (id)
    ON UPDATE CASCADE;

ALTER TABLE payments
    ADD CONSTRAINT fk_payments_hostel_fee
    FOREIGN KEY (hostel_fee_id)
    REFERENCES hostel_fees (id)
    ON UPDATE CASCADE;

-- Ensure payment application belongs to the same session.
ALTER TABLE payments
    ADD KEY idx_payments_application_session_fk
        (application_id, hostel_session_id);

ALTER TABLE payments
    ADD CONSTRAINT fk_payments_application_session
    FOREIGN KEY (application_id, hostel_session_id)
    REFERENCES applications (id, hostel_session_id)
    ON UPDATE CASCADE;

-- ------------------------------------------------------------
-- FINAL VERIFICATION
-- ------------------------------------------------------------

SELECT
    COUNT(*) AS payments_total,
    COUNT(hostel_session_id) AS payments_with_session,
    COUNT(hostel_fee_id) AS payments_with_fee
FROM payments;

SELECT
    id,
    label,
    status,
    is_current
FROM hostel_sessions
ORDER BY id;

SELECT
    id,
    application_id,
    student_id,
    amount,
    currency,
    payment_reference,
    status,
    hostel_session_id,
    hostel_fee_id
FROM payments
ORDER BY id;

SELECT
    COUNT(*) AS payments_without_session
FROM payments
WHERE hostel_session_id IS NULL;

SELECT
    COUNT(*) AS payments_without_fee
FROM payments
WHERE hostel_fee_id IS NULL;

SELECT
    COUNT(*) AS payment_session_mismatches
FROM payments p
JOIN applications a
    ON a.id = p.application_id
WHERE p.hostel_session_id <> a.hostel_session_id;

SELECT
    COUNT(*) AS successful_payment_duplicates
FROM (
    SELECT
        application_id,
        hostel_session_id,
        COUNT(*) AS n
    FROM payments
    WHERE status = 'success'
    GROUP BY application_id, hostel_session_id
    HAVING COUNT(*) > 1
) x;

SELECT
    '013 COMPLETE' AS migration_status;