-- ============================================================
-- PHASE 9 - MIGRATION 011
-- Add hostel_session_id to applications and allocations
-- Target: MariaDB 10.4
-- Database is supplied by the mysql command; NO USE statement.
-- NON-DESTRUCTIVE: existing rows are preserved.
-- ============================================================

SET @migration_name := '011_application_allocation_sessions';

-- ------------------------------------------------------------
-- PRECHECKS
-- ------------------------------------------------------------

SELECT
    DATABASE() AS connected_database,
    VERSION() AS server_version;

SELECT
    COUNT(*) AS session_2026_2027
FROM hostel_sessions
WHERE label = '2026/2027'
  AND status = 'open'
  AND is_current = 1;

SELECT
    COUNT(*) AS applications_before
FROM applications;

SELECT
    COUNT(*) AS allocations_before
FROM allocations;

SELECT
    COUNT(*) AS released_alloc_5
FROM allocations
WHERE id = 5
  AND status = 'released';

-- ------------------------------------------------------------
-- APPLICATIONS
-- ------------------------------------------------------------

ALTER TABLE applications
    ADD COLUMN hostel_session_id INT(10) UNSIGNED NULL
    AFTER session_year;

-- Backfill every existing application to the current 2026/2027 session.
UPDATE applications
SET hostel_session_id = (
    SELECT id
    FROM hostel_sessions
    WHERE label = '2026/2027'
      AND status = 'open'
      AND is_current = 1
    LIMIT 1
)
WHERE hostel_session_id IS NULL;

-- Keep the existing legacy session_year column in sync.
UPDATE applications a
JOIN hostel_sessions hs
    ON hs.id = a.hostel_session_id
SET a.session_year = hs.label
WHERE a.hostel_session_id IS NOT NULL;

-- Make the new relationship mandatory.
ALTER TABLE applications
    MODIFY COLUMN hostel_session_id INT(10) UNSIGNED NOT NULL;

-- Add index required for FK/composite relationships.
ALTER TABLE applications
    ADD KEY idx_applications_hostel_session (hostel_session_id);

-- Add composite key so allocations can reference
-- (application_id, hostel_session_id).
ALTER TABLE applications
    ADD UNIQUE KEY uq_applications_id_hostel_session
        (id, hostel_session_id);

-- Replace old student-wide active uniqueness with
-- session-scoped uniqueness.
ALTER TABLE applications
    DROP INDEX uq_active_application,
    DROP COLUMN active_key;

ALTER TABLE applications
    ADD COLUMN active_key BIGINT UNSIGNED
    GENERATED ALWAYS AS (
        CASE
            WHEN status IN ('pending','approved')
            THEN (CAST(student_id AS UNSIGNED) * 4294967296)
                 + CAST(hostel_session_id AS UNSIGNED)
            ELSE NULL
        END
    ) STORED,
    ADD UNIQUE KEY uq_active_application (active_key);

-- FK to hostel_sessions.
ALTER TABLE applications
    ADD CONSTRAINT fk_applications_hostel_session
    FOREIGN KEY (hostel_session_id)
    REFERENCES hostel_sessions (id)
    ON UPDATE CASCADE;

-- ------------------------------------------------------------
-- ALLOCATIONS
-- ------------------------------------------------------------

ALTER TABLE allocations
    ADD COLUMN hostel_session_id INT(10) UNSIGNED NULL
    AFTER room_id;

-- Backfill from the application's session.
UPDATE allocations al
JOIN applications a
    ON a.id = al.application_id
SET al.hostel_session_id = a.hostel_session_id
WHERE al.hostel_session_id IS NULL;

-- Make mandatory.
ALTER TABLE allocations
    MODIFY COLUMN hostel_session_id INT(10) UNSIGNED NOT NULL;

ALTER TABLE allocations
    ADD KEY idx_allocations_hostel_session (hostel_session_id);

-- Composite application/session relationship.
ALTER TABLE allocations
    ADD KEY idx_allocations_application_session
        (application_id, hostel_session_id);

-- Re-scope active allocation uniqueness to the session.
ALTER TABLE allocations
    DROP INDEX uq_active_allocation,
    DROP COLUMN active_key;

ALTER TABLE allocations
    ADD COLUMN active_key BIGINT UNSIGNED
    GENERATED ALWAYS AS (
        CASE
            WHEN status = 'active'
            THEN (CAST(student_id AS UNSIGNED) * 4294967296)
                 + CAST(hostel_session_id AS UNSIGNED)
            ELSE NULL
        END
    ) STORED,
    ADD UNIQUE KEY uq_active_allocation (active_key);

-- FK to hostel_sessions.
ALTER TABLE allocations
    ADD CONSTRAINT fk_allocations_hostel_session
    FOREIGN KEY (hostel_session_id)
    REFERENCES hostel_sessions (id)
    ON UPDATE CASCADE;

-- Critical integrity rule:
-- allocation application and hostel session must match.
ALTER TABLE allocations
    ADD CONSTRAINT fk_allocations_application_session
    FOREIGN KEY (application_id, hostel_session_id)
    REFERENCES applications (id, hostel_session_id)
    ON DELETE CASCADE
    ON UPDATE CASCADE;

-- ------------------------------------------------------------
-- FINAL VERIFICATION
-- ------------------------------------------------------------

SELECT
    id,
    label,
    status,
    is_current
FROM hostel_sessions
ORDER BY id;

SELECT
    COUNT(*) AS applications_total,
    COUNT(hostel_session_id) AS applications_with_session,
    SUM(session_year <> '2026/2027') AS wrong_session_year
FROM applications;

SELECT
    id,
    application_id,
    student_id,
    room_id,
    status,
    hostel_session_id,
    released_at,
    release_reason
FROM allocations
ORDER BY id;

SELECT
    COUNT(*) AS applications_without_session
FROM applications
WHERE hostel_session_id IS NULL;

SELECT
    COUNT(*) AS allocations_without_session
FROM allocations
WHERE hostel_session_id IS NULL;

SELECT
    COUNT(*) AS allocation_session_mismatches
FROM allocations al
JOIN applications a
    ON a.id = al.application_id
WHERE al.hostel_session_id <> a.hostel_session_id;

SELECT
    COUNT(*) AS released_allocation_5_preserved
FROM allocations
WHERE id = 5
  AND status = 'released';

SELECT
    COUNT(*) AS active_application_duplicates
FROM (
    SELECT student_id, hostel_session_id, COUNT(*) AS n
    FROM applications
    WHERE status IN ('pending','approved')
    GROUP BY student_id, hostel_session_id
    HAVING COUNT(*) > 1
) x;

SELECT
    COUNT(*) AS active_allocation_duplicates
FROM (
    SELECT student_id, hostel_session_id, COUNT(*) AS n
    FROM allocations
    WHERE status = 'active'
    GROUP BY student_id, hostel_session_id
    HAVING COUNT(*) > 1
) x;

SELECT
    '011 COMPLETE' AS migration_status;