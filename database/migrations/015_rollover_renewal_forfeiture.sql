-- PHASE 9 - MIGRATION 015
-- Renewal / Rollover / Forfeiture foundation
-- Target: MariaDB 10.4
-- NON-DESTRUCTIVE

SELECT DATABASE() AS connected_database, VERSION() AS server_version;

SELECT COUNT(*) AS current_session
FROM hostel_sessions
WHERE label = '2026/2027'
  AND status = 'open'
  AND is_current = 1;

SELECT COUNT(*) AS allocations_before
FROM allocations;

SELECT COUNT(*) AS released_allocations
FROM allocations
WHERE status = 'released';

-- ============================================================
-- RENEWAL / ROLLOVER RECORDS
-- ============================================================

CREATE TABLE hostel_renewals (
    id INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
    student_id INT(10) UNSIGNED NOT NULL,
    previous_allocation_id INT(10) UNSIGNED DEFAULT NULL,
    previous_session_id INT(10) UNSIGNED NOT NULL,
    new_session_id INT(10) UNSIGNED NOT NULL,
    new_application_id INT(10) UNSIGNED DEFAULT NULL,
    type ENUM('renewal','rollover') NOT NULL DEFAULT 'renewal',
    status ENUM('pending','approved','rejected','cancelled','forfeited')
        NOT NULL DEFAULT 'pending',
    reason VARCHAR(255) DEFAULT NULL,
    processed_by INT(10) UNSIGNED DEFAULT NULL,
    processed_at DATETIME DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),

    KEY idx_renewals_student (student_id),
    KEY idx_renewals_previous_session (previous_session_id),
    KEY idx_renewals_new_session (new_session_id),
    KEY idx_renewals_previous_allocation (previous_allocation_id),
    KEY idx_renewals_new_application (new_application_id),
    KEY idx_renewals_status (status),
    KEY idx_renewals_processor (processed_by),

    CONSTRAINT fk_renewals_student
        FOREIGN KEY (student_id)
        REFERENCES users (id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,

    CONSTRAINT fk_renewals_previous_allocation
        FOREIGN KEY (previous_allocation_id)
        REFERENCES allocations (id)
        ON DELETE SET NULL
        ON UPDATE CASCADE,

    CONSTRAINT fk_renewals_previous_session
        FOREIGN KEY (previous_session_id)
        REFERENCES hostel_sessions (id)
        ON UPDATE CASCADE,

    CONSTRAINT fk_renewals_new_session
        FOREIGN KEY (new_session_id)
        REFERENCES hostel_sessions (id)
        ON UPDATE CASCADE,

    CONSTRAINT fk_renewals_new_application
        FOREIGN KEY (new_application_id)
        REFERENCES applications (id)
        ON DELETE SET NULL
        ON UPDATE CASCADE,

    CONSTRAINT fk_renewals_processor
        FOREIGN KEY (processed_by)
        REFERENCES users (id)
        ON DELETE SET NULL
        ON UPDATE CASCADE
) ENGINE=InnoDB
DEFAULT CHARSET=utf8mb4
COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- VERIFICATION
-- ============================================================

SELECT COUNT(*) AS renewals_total
FROM hostel_renewals;

SELECT COUNT(*) AS allocations_after
FROM allocations;

SELECT COUNT(*) AS released_allocations_after
FROM allocations
WHERE status = 'released';

SELECT
    COUNT(*) AS current_session
FROM hostel_sessions
WHERE label = '2026/2027'
  AND status = 'open'
  AND is_current = 1;

SELECT
    COUNT(*) AS renewal_records_without_student
FROM hostel_renewals
WHERE student_id IS NULL;

SELECT
    COUNT(*) AS renewal_records_without_previous_session
FROM hostel_renewals
WHERE previous_session_id IS NULL;

SELECT
    '015 COMPLETE' AS migration_status;