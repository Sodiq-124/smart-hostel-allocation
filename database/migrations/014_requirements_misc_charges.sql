-- PHASE 9 - MIGRATION 014
-- Requirements + Miscellaneous Charges
-- Target: MariaDB 10.4
-- NON-DESTRUCTIVE

SELECT DATABASE() AS connected_database, VERSION() AS server_version;

SELECT COUNT(*) AS current_session
FROM hostel_sessions
WHERE label = '2026/2027'
  AND status = 'open'
  AND is_current = 1;

CREATE TABLE hostel_requirements (
    id INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
    hostel_session_id INT(10) UNSIGNED NOT NULL,
    block_id INT(10) UNSIGNED DEFAULT NULL,
    title VARCHAR(150) NOT NULL,
    description TEXT DEFAULT NULL,
    is_required TINYINT(1) NOT NULL DEFAULT 1,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_by INT(10) UNSIGNED DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_requirements_session (hostel_session_id),
    KEY idx_requirements_block (block_id),
    KEY idx_requirements_active (hostel_session_id, is_active),
    KEY idx_requirements_creator (created_by),
    CONSTRAINT fk_requirements_session
        FOREIGN KEY (hostel_session_id)
        REFERENCES hostel_sessions (id)
        ON UPDATE CASCADE,
    CONSTRAINT fk_requirements_block
        FOREIGN KEY (block_id)
        REFERENCES blocks (id)
        ON DELETE SET NULL
        ON UPDATE CASCADE,
    CONSTRAINT fk_requirements_creator
        FOREIGN KEY (created_by)
        REFERENCES users (id)
        ON DELETE SET NULL
        ON UPDATE CASCADE
) ENGINE=InnoDB
DEFAULT CHARSET=utf8mb4
COLLATE=utf8mb4_unicode_ci;

CREATE TABLE hostel_misc_charges (
    id INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
    hostel_session_id INT(10) UNSIGNED NOT NULL,
    block_id INT(10) UNSIGNED DEFAULT NULL,
    name VARCHAR(150) NOT NULL,
    description TEXT DEFAULT NULL,
    amount DECIMAL(10,2) NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'NGN',
    is_required TINYINT(1) NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_by INT(10) UNSIGNED DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_misc_charges_session (hostel_session_id),
    KEY idx_misc_charges_block (block_id),
    KEY idx_misc_charges_active (hostel_session_id, is_active),
    KEY idx_misc_charges_creator (created_by),
    CONSTRAINT fk_misc_charges_session
        FOREIGN KEY (hostel_session_id)
        REFERENCES hostel_sessions (id)
        ON UPDATE CASCADE,
    CONSTRAINT fk_misc_charges_block
        FOREIGN KEY (block_id)
        REFERENCES blocks (id)
        ON DELETE SET NULL
        ON UPDATE CASCADE,
    CONSTRAINT fk_misc_charges_creator
        FOREIGN KEY (created_by)
        REFERENCES users (id)
        ON DELETE SET NULL
        ON UPDATE CASCADE,
    CONSTRAINT ck_misc_charges_amount
        CHECK (amount > 0)
) ENGINE=InnoDB
DEFAULT CHARSET=utf8mb4
COLLATE=utf8mb4_unicode_ci;

SELECT COUNT(*) AS requirements_total
FROM hostel_requirements;

SELECT COUNT(*) AS misc_charges_total
FROM hostel_misc_charges;

SELECT COUNT(*) AS requirements_without_session
FROM hostel_requirements
WHERE hostel_session_id IS NULL;

SELECT COUNT(*) AS misc_charges_without_session
FROM hostel_misc_charges
WHERE hostel_session_id IS NULL;

SELECT COUNT(*) AS current_session
FROM hostel_sessions
WHERE label = '2026/2027'
  AND status = 'open'
  AND is_current = 1;

SELECT '014 COMPLETE' AS migration_status;