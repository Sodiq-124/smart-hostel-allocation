-- =====================================================================
--  database/migrations/007_allocation_sessions.sql
--  ---------------------------------------------------------------------
--  PHASE 9A - SESSION FOUNDATION (step 2 of 2)
--
--  Requires 006_hostel_sessions.sql to have already run - this
--  migration's backfill (step 2 below) reads from hostel_sessions.
--
--  WHAT THIS CHANGES, AND WHY, IN THE ORDER IT HAPPENS:
--
--  1. Adds allocations.hostel_session_id, NULLABLE at first - a NOT
--     NULL column cannot be added to a table that already has rows
--     without a default, and backfilling (step 2) needs the column to
--     exist and accept NULL while it's being filled in.
--
--  2. Backfills every EXISTING allocation row to the hostel_sessions
--     row that is currently marked is_current = 1 (the 2025/2026 row
--     migration 006 seeded). This is safe specifically because every
--     allocation in this database today was made under the session
--     that row represents - nothing is being guessed; it is recording
--     a fact that was already implicitly true.
--
--  3. Only once every row has a value does the column become NOT NULL
--     - done in this order so the ALTER never fails and never has to
--     invent a value for a row the backfill missed.
--
--  4. Adds the foreign key to hostel_sessions, now that every row
--     genuinely points at a session that exists.
--
--  5. Adds 'forfeited' to the status ENUM - ADDITIVE ONLY. 'active' and
--     'released' keep their exact existing meaning; every row that is
--     currently 'active' or 'released' stays exactly as it is. This
--     purely widens what a FUTURE row is allowed to be.
--
--  6. Adds forfeited_at / forfeit_reason - nullable, mirroring
--     released_at / release_reason's own shape. NULL on every existing
--     row, which is correct: no existing allocation has been forfeited.
--
--  7. LAST: drops the OLD active_key / uq_active_allocation (which
--     enforced "one active allocation per STUDENT, ever") and replaces
--     it with active_session_key / uq_active_allocation_per_session
--     (which enforces "one active allocation per student PER SESSION").
--     This step is deliberately ORDERED LAST, after the backfill in
--     step 2-3 is already complete: if the new session-scoped key were
--     defined before hostel_session_id had real values, it would be
--     built from a column that was still NULL on every row, and a key
--     built from NULL never collides with anything - the uniqueness
--     guarantee would silently stop enforcing while looking exactly
--     like it still worked.
--
--  DOES NOT delete any application, allocation, room, or user row.
--  DOES NOT change the meaning of any existing 'active' or 'released'
--  allocation. DOES NOT touch hostel_fees, payments, or complaints -
--  those are explicitly out of Phase 9A's scope.
--
--  Run with:
--      mysql -u root -p smart_hostel < database/migrations/007_allocation_sessions.sql
--
--  Safe to run more than once - every step checks information_schema
--  (or the data itself) for its own prior effect before applying.
-- =====================================================================

USE smart_hostel;

-- ---------------------------------------------------------------------
-- 1. Add allocations.hostel_session_id - nullable first.
-- ---------------------------------------------------------------------
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'allocations' AND COLUMN_NAME = 'hostel_session_id'
);
SET @add_col_sql := IF(@col_exists = 0,
  'ALTER TABLE allocations ADD COLUMN hostel_session_id INT UNSIGNED NULL AFTER room_id',
  'SELECT ''allocations.hostel_session_id already exists - skipped.'' AS note'
);
PREPARE stmt FROM @add_col_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------
-- 2. Backfill every existing row from the session currently marked
--    is_current = 1. Only touches rows that are still NULL, so running
--    this migration again after new (correctly-session-stamped) rows
--    exist leaves those rows untouched.
-- ---------------------------------------------------------------------
UPDATE allocations a
  JOIN hostel_sessions hs ON hs.is_current = 1
   SET a.hostel_session_id = hs.id
 WHERE a.hostel_session_id IS NULL;

-- ---------------------------------------------------------------------
-- 3. Now that every existing row has a value, make it required.
-- ---------------------------------------------------------------------
SET @col_nullable := (
  SELECT IS_NULLABLE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'allocations' AND COLUMN_NAME = 'hostel_session_id'
);
SET @modify_sql := IF(@col_nullable = 'YES',
  'ALTER TABLE allocations MODIFY COLUMN hostel_session_id INT UNSIGNED NOT NULL',
  'SELECT ''allocations.hostel_session_id already NOT NULL - skipped.'' AS note'
);
PREPARE stmt FROM @modify_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------
-- 4. Foreign key + supporting index.
-- ---------------------------------------------------------------------
SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'allocations' AND CONSTRAINT_NAME = 'fk_allocations_session'
);
SET @add_fk_sql := IF(@fk_exists = 0,
  'ALTER TABLE allocations ADD CONSTRAINT fk_allocations_session
     FOREIGN KEY (hostel_session_id) REFERENCES hostel_sessions (id)
     ON DELETE RESTRICT ON UPDATE CASCADE',
  'SELECT ''fk_allocations_session already exists - skipped.'' AS note'
);
PREPARE stmt FROM @add_fk_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'allocations' AND INDEX_NAME = 'idx_allocations_session'
);
SET @add_idx_sql := IF(@idx_exists = 0,
  'ALTER TABLE allocations ADD INDEX idx_allocations_session (hostel_session_id, status)',
  'SELECT ''idx_allocations_session already exists - skipped.'' AS note'
);
PREPARE stmt FROM @add_idx_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------
-- 5. Add 'forfeited' to the status ENUM - additive only.
-- ---------------------------------------------------------------------
SET @status_type := (
  SELECT COLUMN_TYPE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'allocations' AND COLUMN_NAME = 'status'
);
SET @modify_enum_sql := IF(@status_type NOT LIKE '%forfeited%',
  'ALTER TABLE allocations MODIFY COLUMN status ENUM(''active'',''released'',''forfeited'') NOT NULL DEFAULT ''active''',
  'SELECT ''allocations.status already includes forfeited - skipped.'' AS note'
);
PREPARE stmt FROM @modify_enum_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------
-- 6. Add forfeited_at / forfeit_reason - nullable, same shape as the
--    existing released_at / release_reason.
-- ---------------------------------------------------------------------
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'allocations' AND COLUMN_NAME = 'forfeited_at'
);
SET @add_col_sql := IF(@col_exists = 0,
  'ALTER TABLE allocations ADD COLUMN forfeited_at DATETIME DEFAULT NULL AFTER release_reason',
  'SELECT ''allocations.forfeited_at already exists - skipped.'' AS note'
);
PREPARE stmt FROM @add_col_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'allocations' AND COLUMN_NAME = 'forfeit_reason'
);
SET @add_col_sql := IF(@col_exists = 0,
  'ALTER TABLE allocations ADD COLUMN forfeit_reason VARCHAR(255) DEFAULT NULL AFTER forfeited_at',
  'SELECT ''allocations.forfeit_reason already exists - skipped.'' AS note'
);
PREPARE stmt FROM @add_col_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------
-- 7. LAST: replace the student-wide active_key with the session-scoped
--    active_session_key. See this file's header comment for why this
--    must run after steps 1-3 have already backfilled every row.
-- ---------------------------------------------------------------------
SET @old_idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'allocations' AND INDEX_NAME = 'uq_active_allocation'
);
SET @drop_idx_sql := IF(@old_idx_exists > 0,
  'ALTER TABLE allocations DROP INDEX uq_active_allocation',
  'SELECT ''uq_active_allocation already absent - skipped.'' AS note'
);
PREPARE stmt FROM @drop_idx_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @old_col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'allocations' AND COLUMN_NAME = 'active_key'
);
SET @drop_col_sql := IF(@old_col_exists > 0,
  'ALTER TABLE allocations DROP COLUMN active_key',
  'SELECT ''allocations.active_key already absent - skipped.'' AS note'
);
PREPARE stmt FROM @drop_col_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @new_col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'allocations' AND COLUMN_NAME = 'active_session_key'
);
SET @add_col_sql := IF(@new_col_exists = 0,
  'ALTER TABLE allocations ADD COLUMN active_session_key VARCHAR(30) AS (
     CASE WHEN status = ''active'' THEN CONCAT(student_id, ''-'', hostel_session_id) ELSE NULL END
   ) STORED',
  'SELECT ''allocations.active_session_key already exists - skipped.'' AS note'
);
PREPARE stmt FROM @add_col_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @new_idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'allocations' AND INDEX_NAME = 'uq_active_allocation_per_session'
);
SET @add_idx_sql := IF(@new_idx_exists = 0,
  'ALTER TABLE allocations ADD UNIQUE KEY uq_active_allocation_per_session (active_session_key)',
  'SELECT ''uq_active_allocation_per_session already exists - skipped.'' AS note'
);
PREPARE stmt FROM @add_idx_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SELECT 'Migration 007 complete - allocations is now session-scoped.' AS result;
