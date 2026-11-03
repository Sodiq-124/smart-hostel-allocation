-- ============================================================
-- PHASE 9 - MIGRATION 012
-- Convert hostel fees to session + block based fees
-- Target: MariaDB 10.4
-- Database supplied by mysql command; NO USE statement.
-- NON-DESTRUCTIVE: existing fee rows are preserved.
-- ============================================================

SET @migration_name := '012_hostel_fees_sessions_blocks';

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
    COUNT(*) AS fee_rows_before
FROM hostel_fees;

SELECT
    COUNT(*) AS block_count
FROM blocks
WHERE name IN ('A','B','C','D');

SELECT
    id,
    room_type,
    amount,
    session_year,
    active
FROM hostel_fees
ORDER BY id;

-- ------------------------------------------------------------
-- ADD SESSION + BLOCK COLUMNS
-- ------------------------------------------------------------

ALTER TABLE hostel_fees
    ADD COLUMN hostel_session_id INT(10) UNSIGNED NULL
    AFTER session_year;

ALTER TABLE hostel_fees
    ADD COLUMN block_id INT(10) UNSIGNED NULL
    AFTER hostel_session_id;

-- ------------------------------------------------------------
-- BACKFILL EXISTING LEGACY FEES
-- ------------------------------------------------------------

UPDATE hostel_fees hf
JOIN hostel_sessions hs
    ON hs.label = hf.session_year
SET hf.hostel_session_id = hs.id
WHERE hf.hostel_session_id IS NULL;

-- Existing legacy room-type fees intentionally remain without
-- a block because they belong to the old fee model.

-- ------------------------------------------------------------
-- MAKE NEW FEE MODEL COLUMNS USABLE
-- ------------------------------------------------------------

ALTER TABLE hostel_fees
    MODIFY COLUMN room_type ENUM('single','shared') NULL;

ALTER TABLE hostel_fees
    ADD KEY idx_fees_hostel_session (hostel_session_id);

ALTER TABLE hostel_fees
    ADD KEY idx_fees_block (block_id);

-- ------------------------------------------------------------
-- REBUILD ACTIVE FEE UNIQUENESS
-- ------------------------------------------------------------

ALTER TABLE hostel_fees
    DROP INDEX uq_active_fee,
    DROP COLUMN active_key;

ALTER TABLE hostel_fees
    ADD COLUMN active_key VARCHAR(50)
    GENERATED ALWAYS AS (
        CASE
            WHEN active = 1 AND block_id IS NOT NULL
                THEN CONCAT(
                    'B:',
                    CAST(hostel_session_id AS CHAR),
                    ':',
                    CAST(block_id AS CHAR)
                )
            WHEN active = 1
                THEN CONCAT(
                    'L:',
                    room_type
                )
            ELSE NULL
        END
    ) STORED,
    ADD UNIQUE KEY uq_active_fee (active_key);

-- ------------------------------------------------------------
-- FOREIGN KEYS
-- ------------------------------------------------------------

ALTER TABLE hostel_fees
    ADD CONSTRAINT fk_fees_hostel_session
    FOREIGN KEY (hostel_session_id)
    REFERENCES hostel_sessions (id)
    ON UPDATE CASCADE;

ALTER TABLE hostel_fees
    ADD CONSTRAINT fk_fees_block
    FOREIGN KEY (block_id)
    REFERENCES blocks (id)
    ON DELETE SET NULL
    ON UPDATE CASCADE;

-- ------------------------------------------------------------
-- INSERT 2026/2027 BLOCK FEES
-- ------------------------------------------------------------

INSERT INTO hostel_fees
    (
        room_type,
        amount,
        currency,
        session_year,
        hostel_session_id,
        block_id,
        active,
        updated_by
    )
SELECT
    NULL,
    300000.00,
    'NGN',
    '2026/2027',
    hs.id,
    b.id,
    1,
    NULL
FROM hostel_sessions hs
JOIN blocks b
    ON b.name = 'A'
WHERE hs.label = '2026/2027'
  AND hs.status = 'open'
  AND hs.is_current = 1;

INSERT INTO hostel_fees
    (
        room_type,
        amount,
        currency,
        session_year,
        hostel_session_id,
        block_id,
        active,
        updated_by
    )
SELECT
    NULL,
    250000.00,
    'NGN',
    '2026/2027',
    hs.id,
    b.id,
    1,
    NULL
FROM hostel_sessions hs
JOIN blocks b
    ON b.name = 'B'
WHERE hs.label = '2026/2027'
  AND hs.status = 'open'
  AND hs.is_current = 1;

INSERT INTO hostel_fees
    (
        room_type,
        amount,
        currency,
        session_year,
        hostel_session_id,
        block_id,
        active,
        updated_by
    )
SELECT
    NULL,
    200000.00,
    'NGN',
    '2026/2027',
    hs.id,
    b.id,
    1,
    NULL
FROM hostel_sessions hs
JOIN blocks b
    ON b.name = 'C'
WHERE hs.label = '2026/2027'
  AND hs.status = 'open'
  AND hs.is_current = 1;

INSERT INTO hostel_fees
    (
        room_type,
        amount,
        currency,
        session_year,
        hostel_session_id,
        block_id,
        active,
        updated_by
    )
SELECT
    NULL,
    150000.00,
    'NGN',
    '2026/2027',
    hs.id,
    b.id,
    1,
    NULL
FROM hostel_sessions hs
JOIN blocks b
    ON b.name = 'D'
WHERE hs.label = '2026/2027'
  AND hs.status = 'open'
  AND hs.is_current = 1;

-- ------------------------------------------------------------
-- FINAL VERIFICATION
-- ------------------------------------------------------------

SELECT
    id,
    room_type,
    amount,
    currency,
    session_year,
    hostel_session_id,
    block_id,
    active
FROM hostel_fees
ORDER BY hostel_session_id, block_id, id;

SELECT
    COUNT(*) AS total_fee_rows
FROM hostel_fees;

SELECT
    COUNT(*) AS legacy_fee_rows_preserved
FROM hostel_fees
WHERE session_year = '2025/2026'
  AND block_id IS NULL;

SELECT
    COUNT(*) AS current_block_fees
FROM hostel_fees
WHERE session_year = '2026/2027'
  AND hostel_session_id = (
      SELECT id
      FROM hostel_sessions
      WHERE label = '2026/2027'
        AND is_current = 1
      LIMIT 1
  )
  AND block_id IS NOT NULL
  AND active = 1;

SELECT
    b.name AS block_name,
    hf.amount
FROM hostel_fees hf
JOIN blocks b
    ON b.id = hf.block_id
WHERE hf.session_year = '2026/2027'
  AND hf.active = 1
ORDER BY b.name;

SELECT
    COUNT(*) AS fees_without_session
FROM hostel_fees
WHERE hostel_session_id IS NULL;

SELECT
    COUNT(*) AS duplicate_active_block_fees
FROM (
    SELECT
        hostel_session_id,
        block_id,
        COUNT(*) AS n
    FROM hostel_fees
    WHERE active = 1
      AND block_id IS NOT NULL
    GROUP BY hostel_session_id, block_id
    HAVING COUNT(*) > 1
) x;

SELECT
    '012 COMPLETE' AS migration_status;