-- =====================================================================
--  database/migrations/006_hostel_sessions.sql
--  ---------------------------------------------------------------------
--  PHASE 9A - SESSION FOUNDATION
--
--  *** RUN THIS MIGRATION ONCE. ***
--  It is resumable if interrupted (every step checks its own prior
--  effect), but it is NOT meant to be re-run after go-live: a re-run
--  could re-seed a fee that an admin has since deactivated.
--
--  *** STOP THE NODE SERVER BEFORE RUNNING. ***
--  ALTER TABLE on applications/allocations/hostel_fees takes metadata
--  locks, and the app must not create applications or allocations while
--  session_id is half-added. Restart it only after the 9A code change
--  is in place (see backend/services/hostelSessionService.js).
--
--  NO `USE` STATEMENT ON PURPOSE. Name the database on the command line
--  so the same file can be tested on a scratch copy without any chance
--  of touching the live database:
--      mysql -u root -p smart_hostel_scratch < 006_hostel_sessions.sql
--
--  Target: MariaDB 10.4.32 (XAMPP). The "IF NOT EXISTS / IF EXISTS"
--  ALTER forms are MariaDB-only (not valid MySQL 8).
--
--  PRE-FLIGHT (read-only; all expected results in brackets)
--    SHOW TABLES LIKE 'hostel_sessions';                      [empty]
--    SELECT COUNT(*) FROM applications;                       [11]
--    SELECT COUNT(*) FROM allocations;                        [1]
--    SELECT id, name FROM blocks ORDER BY id;     [Block A..Block D, exactly]
--
--  WHAT THIS DOES
--    1. Creates hostel_sessions (at most ONE active, enforced by a
--       unique key).
--    2. Seeds 2025/2026 (inactive, historical) and 2026/2027 (active).
--    3. applications : adds session_id, backfills every existing row to
--                      2026/2027 and corrects session_year to match,
--                      then NOT NULL + FK.
--    4. allocations  : adds session_id, backfills from the parent
--                      application, NOT NULL + FK, plus a composite FK
--                      forcing an allocation's session to equal its
--                      application's session.
--    5. hostel_fees  : becomes Block + Session based. Legacy single /
--                      shared rows are KEPT as INACTIVE history. Seeds
--                      2026/2027: A 300000, B 250000, C 200000, D 150000.
--                      room_type plays no part in the new fees.
--    6. Replaces the two hostel_fees triggers (the original
--       "amount > 0" rule is kept, one rule added: an ACTIVE fee must
--       have a block and a session).
--
--  WHAT THIS NEVER DOES
--    No DELETE, no TRUNCATE, no DROP TABLE, no DROP DATABASE.
--    users, rooms, payments, complaints, blocks are not modified.
--    No allocation status change. No room occupancy change.
--    payments is untouched (its session link belongs to 9B).
-- =====================================================================


-- ---------------------------------------------------------------------
--  Helpers (dropped again at the end)
-- ---------------------------------------------------------------------
DELIMITER $$

-- Add a foreign key only if a constraint of that name is absent.
DROP PROCEDURE IF EXISTS sp_006_add_fk$$
CREATE PROCEDURE sp_006_add_fk(
  IN p_table VARCHAR(64),
  IN p_name  VARCHAR(64),
  IN p_ddl   TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME        = p_table
       AND CONSTRAINT_NAME   = p_name
       AND CONSTRAINT_TYPE   = 'FOREIGN KEY'
  ) THEN
    SET @sql_006 = CONCAT('ALTER TABLE `', p_table, '` ADD CONSTRAINT `', p_name, '` ', p_ddl);
    PREPARE stmt_006 FROM @sql_006;
    EXECUTE stmt_006;
    DEALLOCATE PREPARE stmt_006;
  END IF;
END$$

-- Make an INT UNSIGNED column NOT NULL, but ONLY while it is still
-- nullable. If any NULL remains the backfill was incomplete, so stop
-- loudly instead of letting a non-strict server turn NULLs into 0.
DROP PROCEDURE IF EXISTS sp_006_set_not_null$$
CREATE PROCEDURE sp_006_set_not_null(
  IN p_table VARCHAR(64),
  IN p_col   VARCHAR(64)
)
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME   = p_table
       AND COLUMN_NAME  = p_col
       AND IS_NULLABLE  = 'YES'
  ) THEN
    SET @sql_006 = CONCAT('SELECT COUNT(*) INTO @n_null_006 FROM `', p_table,
                          '` WHERE `', p_col, '` IS NULL');
    PREPARE stmt_006 FROM @sql_006;
    EXECUTE stmt_006;
    DEALLOCATE PREPARE stmt_006;

    IF @n_null_006 > 0 THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = '006 aborted: session_id backfill incomplete - NULL rows remain.';
    END IF;

    SET @sql_006 = CONCAT('ALTER TABLE `', p_table, '` MODIFY COLUMN `', p_col,
                          '` INT UNSIGNED NOT NULL');
    PREPARE stmt_006 FROM @sql_006;
    EXECUTE stmt_006;
    DEALLOCATE PREPARE stmt_006;
  END IF;
END$$

DELIMITER ;


-- =====================================================================
--  STEP 1: hostel_sessions
-- =====================================================================
CREATE TABLE IF NOT EXISTS hostel_sessions (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(9)   NOT NULL,              -- '2026/2027'
  start_date  DATE DEFAULT NULL,                  -- unknown today; admin sets later
  end_date    DATE DEFAULT NULL,
  is_active   TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- Same pattern as applications/allocations: 1 while active, NULL
  -- otherwise. A UNIQUE index ignores NULLs, so any number of inactive
  -- sessions can exist but a second active one is rejected by the DB.
  active_key  TINYINT AS (CASE WHEN is_active = 1 THEN 1 ELSE NULL END) STORED,

  PRIMARY KEY (id),
  UNIQUE KEY uq_hostel_sessions_name   (name),
  UNIQUE KEY uq_hostel_sessions_active (active_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

DROP TRIGGER IF EXISTS trg_hostel_sessions_before_insert$$
CREATE TRIGGER trg_hostel_sessions_before_insert
BEFORE INSERT ON hostel_sessions
FOR EACH ROW
BEGIN
  IF NEW.name NOT REGEXP '^[0-9]{4}/[0-9]{4}$'
     OR CAST(SUBSTRING(NEW.name, 6, 4) AS UNSIGNED) <> CAST(SUBSTRING(NEW.name, 1, 4) AS UNSIGNED) + 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Session name must look like 2026/2027 (consecutive years).';
  END IF;
  IF NEW.start_date IS NOT NULL AND NEW.end_date IS NOT NULL AND NEW.end_date < NEW.start_date THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Session end date cannot be before its start date.';
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_hostel_sessions_before_update$$
CREATE TRIGGER trg_hostel_sessions_before_update
BEFORE UPDATE ON hostel_sessions
FOR EACH ROW
BEGIN
  IF NEW.name NOT REGEXP '^[0-9]{4}/[0-9]{4}$'
     OR CAST(SUBSTRING(NEW.name, 6, 4) AS UNSIGNED) <> CAST(SUBSTRING(NEW.name, 1, 4) AS UNSIGNED) + 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Session name must look like 2026/2027 (consecutive years).';
  END IF;
  IF NEW.start_date IS NOT NULL AND NEW.end_date IS NOT NULL AND NEW.end_date < NEW.start_date THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Session end date cannot be before its start date.';
  END IF;
END$$

DELIMITER ;


-- =====================================================================
--  STEP 2: seed the sessions DETERMINISTICALLY
--
--  End state, on a clean first run AND on a resumed partial run:
--      2025/2026  exists, INACTIVE   (historical)
--      2026/2027  exists, ACTIVE     (current)
--      exactly one active session    (uq_hostel_sessions_active guarantees
--                                     it; a conflict fails loudly)
--  Only these two named sessions are ever modified here.
-- =====================================================================

-- 2a. Create each session if it is missing. (2026/2027 is created
--     inactive here; 2b is the single place that makes it active.)
INSERT INTO hostel_sessions (name, is_active)
SELECT '2025/2026', 0 FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM hostel_sessions WHERE name = '2025/2026');

INSERT INTO hostel_sessions (name, is_active)
SELECT '2026/2027', 0 FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM hostel_sessions WHERE name = '2026/2027');

-- 2b. Historical first, then current - in this order, so the unique
--     "one active session" key is never violated by this script itself.
--     If some OTHER session were active, step 2b-ii fails with a
--     duplicate-key error instead of silently leaving 2026/2027 inactive.
UPDATE hostel_sessions SET is_active = 0 WHERE name = '2025/2026' AND is_active = 1;
UPDATE hostel_sessions SET is_active = 1 WHERE name = '2026/2027' AND is_active = 0;

SET @s_curr = (SELECT id FROM hostel_sessions WHERE name = '2026/2027');

-- 2c. Assert the end state; abort the whole migration if it is wrong.
DELIMITER $$

DROP PROCEDURE IF EXISTS sp_006_assert_sessions$$
CREATE PROCEDURE sp_006_assert_sessions()
BEGIN
  IF (SELECT COUNT(*) FROM hostel_sessions WHERE is_active = 1) <> 1
     OR NOT EXISTS (SELECT 1 FROM hostel_sessions WHERE name = '2026/2027' AND is_active = 1)
     OR NOT EXISTS (SELECT 1 FROM hostel_sessions WHERE name = '2025/2026' AND is_active = 0) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = '006 aborted: expected 2025/2026 inactive and 2026/2027 as the single active session.';
  END IF;
END$$

DELIMITER ;

CALL sp_006_assert_sessions();
DROP PROCEDURE IF EXISTS sp_006_assert_sessions;


-- =====================================================================
--  STEP 3: applications.session_id
-- =====================================================================
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS session_id INT UNSIGNED DEFAULT NULL AFTER session_year;

-- Backfill (Option A): every application without a session was created
-- during the 2026/2027 build, so it is 2026/2027. The legacy
-- session_year label ('2025/2026' came from a column DEFAULT, never from
-- the code) is corrected in the same statement so the columns agree.
-- "updated_at = updated_at" stops MariaDB bumping the last-updated time.
-- "@s_curr IS NOT NULL" means a failed session lookup can never write NULL.
UPDATE applications
   SET session_id   = @s_curr,
       session_year = '2026/2027',
       updated_at   = updated_at
 WHERE session_id IS NULL
   AND @s_curr IS NOT NULL;

CALL sp_006_set_not_null('applications', 'session_id');

ALTER TABLE applications ADD INDEX IF NOT EXISTS idx_applications_session (session_id, status);

-- Parent key for the composite FK from allocations (step 4).
ALTER TABLE applications ADD UNIQUE INDEX IF NOT EXISTS uq_applications_id_session (id, session_id);

CALL sp_006_add_fk('applications', 'fk_applications_session',
  'FOREIGN KEY (session_id) REFERENCES hostel_sessions (id) ON DELETE RESTRICT ON UPDATE RESTRICT');


-- =====================================================================
--  STEP 4: allocations.session_id
-- =====================================================================
ALTER TABLE allocations
  ADD COLUMN IF NOT EXISTS session_id INT UNSIGNED DEFAULT NULL AFTER room_id;

-- Backfill from the parent application (allocation #5 -> application #12
-- -> 2026/2027). status, released_at, release_reason and
-- rooms.occupied_spaces are NOT touched: a released allocation stays
-- released and occupancy stays as it is.
UPDATE allocations al
  JOIN applications ap ON ap.id = al.application_id
   SET al.session_id = ap.session_id
 WHERE al.session_id IS NULL;

CALL sp_006_set_not_null('allocations', 'session_id');

ALTER TABLE allocations ADD INDEX IF NOT EXISTS idx_allocations_session     (session_id, status);
ALTER TABLE allocations ADD INDEX IF NOT EXISTS idx_allocations_app_session (application_id, session_id);

CALL sp_006_add_fk('allocations', 'fk_allocations_session',
  'FOREIGN KEY (session_id) REFERENCES hostel_sessions (id) ON DELETE RESTRICT ON UPDATE RESTRICT');

-- An allocation can never carry a different session from its application,
-- and an application's session cannot be changed while allocations exist.
CALL sp_006_add_fk('allocations', 'fk_allocations_app_session',
  'FOREIGN KEY (application_id, session_id) REFERENCES applications (id, session_id) ON DELETE CASCADE ON UPDATE RESTRICT');


-- =====================================================================
--  STEP 5: hostel_fees -> Block + Session
-- =====================================================================
ALTER TABLE hostel_fees
  ADD COLUMN IF NOT EXISTS block_id   INT UNSIGNED DEFAULT NULL AFTER id,
  ADD COLUMN IF NOT EXISTS session_id INT UNSIGNED DEFAULT NULL AFTER block_id;

-- Retire the room_type-based "one active fee" machinery (derived data
-- only - no fee amount or history is lost).
ALTER TABLE hostel_fees DROP INDEX IF EXISTS uq_active_fee;
ALTER TABLE hostel_fees DROP COLUMN IF EXISTS active_key;

-- room_type is no longer the fee basis: new rows leave it NULL.
ALTER TABLE hostel_fees MODIFY COLUMN room_type ENUM('single','shared') DEFAULT NULL;

-- Preserve the legacy single/shared rows as INACTIVE history, linked to
-- the session their label already names (2025/2026). block_id stays NULL:
-- they were never block-specific, and they can never match a
-- (block, session) fee lookup.
UPDATE hostel_fees f
  LEFT JOIN hostel_sessions s ON s.name = f.session_year
   SET f.active     = 0,
       f.session_id = s.id
 WHERE f.block_id IS NULL
   AND f.room_type IS NOT NULL;

-- New "one active fee" rule: one per (session, block).
ALTER TABLE hostel_fees
  ADD COLUMN IF NOT EXISTS fee_key VARCHAR(20) AS (
    CASE WHEN active = 1 AND block_id IS NOT NULL AND session_id IS NOT NULL
         THEN CONCAT(session_id, '-', block_id) ELSE NULL END
  ) STORED;

ALTER TABLE hostel_fees ADD UNIQUE INDEX IF NOT EXISTS uq_active_fee_block_session (fee_key);
ALTER TABLE hostel_fees ADD INDEX IF NOT EXISTS idx_fees_block_session (block_id, session_id, active);

CALL sp_006_add_fk('hostel_fees', 'fk_fees_block',
  'FOREIGN KEY (block_id) REFERENCES blocks (id) ON DELETE RESTRICT ON UPDATE RESTRICT');
CALL sp_006_add_fk('hostel_fees', 'fk_fees_session',
  'FOREIGN KEY (session_id) REFERENCES hostel_sessions (id) ON DELETE RESTRICT ON UPDATE RESTRICT');

-- Triggers: the original "amount > 0" rule is KEPT verbatim; the second
-- rule is new. Only ACTIVE fees must be block+session based, which is
-- what lets the deactivated legacy rows (block_id NULL) stay as history
-- while making it impossible to reactivate them.
DELIMITER $$

DROP TRIGGER IF EXISTS trg_fees_before_insert$$
CREATE TRIGGER trg_fees_before_insert
BEFORE INSERT ON hostel_fees
FOR EACH ROW
BEGIN
  IF NEW.amount <= 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Hostel fee must be greater than zero.';
  END IF;
  IF NEW.active = 1 AND (NEW.block_id IS NULL OR NEW.session_id IS NULL) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'An active hostel fee must belong to a block and a session.';
  END IF;
END$$

DROP TRIGGER IF EXISTS trg_fees_before_update$$
CREATE TRIGGER trg_fees_before_update
BEFORE UPDATE ON hostel_fees
FOR EACH ROW
BEGIN
  IF NEW.amount <= 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Hostel fee must be greater than zero.';
  END IF;
  IF NEW.active = 1 AND (NEW.block_id IS NULL OR NEW.session_id IS NULL) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'An active hostel fee must belong to a block and a session.';
  END IF;
END$$

DELIMITER ;

-- Seed the 2026/2027 schedule BY BLOCK ONLY (room_type is not supplied,
-- so it stays NULL). Skips any block that already has an active
-- 2026/2027 fee.
INSERT INTO hostel_fees (block_id, session_id, amount, currency, session_year, active)
SELECT b.id, @s_curr, v.amt, 'NGN', '2026/2027', 1
  FROM blocks b
  JOIN (SELECT 'Block A' AS bname, 300000.00 AS amt
        UNION ALL SELECT 'Block B', 250000.00
        UNION ALL SELECT 'Block C', 200000.00
        UNION ALL SELECT 'Block D', 150000.00) v ON v.bname = b.name
 WHERE NOT EXISTS (
         SELECT 1 FROM hostel_fees f
          WHERE f.block_id = b.id AND f.session_id = @s_curr AND f.active = 1);


-- ---------------------------------------------------------------------
--  Clean up the helpers
-- ---------------------------------------------------------------------
DROP PROCEDURE IF EXISTS sp_006_add_fk;
DROP PROCEDURE IF EXISTS sp_006_set_not_null;


-- =====================================================================
--  VERIFICATION (read-only) - expected results in the comments
-- =====================================================================
-- 2 rows: 2025/2026 inactive, 2026/2027 active
SELECT id, name, is_active FROM hostel_sessions ORDER BY id;

-- applications: 11 rows, all 2026/2027, 0 label mismatches
SELECT s.name AS session, COUNT(*) AS applications, SUM(a.session_year <> s.name) AS label_mismatch
  FROM applications a JOIN hostel_sessions s ON s.id = a.session_id GROUP BY s.name;

-- allocations: 1 row (#5), 2026/2027, status 'released'
SELECT al.id, al.application_id, s.name AS session, al.status, al.released_at
  FROM allocations al JOIN hostel_sessions s ON s.id = al.session_id;

-- hostel_fees: 4 active (Blocks A-D, 2026/2027, room_type NULL)
--              + 2 inactive legacy rows (2025/2026, no block)
SELECT f.id, COALESCE(b.name, CONCAT('(legacy ', f.room_type, ')')) AS block_or_legacy,
       f.room_type, f.amount, s.name AS session, f.active, f.fee_key
  FROM hostel_fees f
  LEFT JOIN blocks b ON b.id = f.block_id
  LEFT JOIN hostel_sessions s ON s.id = f.session_id
 ORDER BY f.active DESC, f.id;
