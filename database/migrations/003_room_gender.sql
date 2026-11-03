-- =====================================================================
--  database/migrations/003_room_gender.sql
--  ---------------------------------------------------------------------
--  PHASE 9 PRE-WORK / STEP 4 - moves gender from `blocks` to `rooms`.
--
--  WHY: hostel.sql's own original design note says "Gender is a
--  property of the block... Block A is the male hostel, and every
--  room inside it is therefore a male room." The new hostel-block
--  structure needs each of Block A/B/C/D to hold BOTH a male section
--  and a female section (100 rooms each), which is impossible while
--  gender is a single value on the block row - one block cannot be
--  both genders at once. This migration adds gender directly to
--  rooms instead, and repoints the two triggers that used to enforce
--  gender through the block.
--
--  DOES NOT touch users, applications, allocations, hostel_fees,
--  payments, complaints, or any existing row's data (except adding
--  the new gender VALUE to each existing room, backfilled from its
--  current block - see step 2 below; no room's actual gender changes).
--  Does NOT drop or rename the blocks table, blocks.gender column, or
--  any existing block or room row. blocks.gender becomes unused after
--  this - the 4 existing "Block A".."Block D" rows are reused as-is,
--  now holding mixed-gender rooms - it is left in place rather than
--  dropped, since removing it has no benefit and only adds risk.
--
--  DOES NOT insert the ~778 new rooms needed to reach 100-per-section,
--  and does NOT change room_number's uniqueness scope. Both of those
--  belong to Step 5 (room numbering) - this migration only lays the
--  gender-per-room foundation Step 5's seed will populate.
--
--  Run with:
--      mysql -u root -p smart_hostel < database/migrations/003_room_gender.sql
--
--  Safe to run more than once: every step checks for its own prior
--  effect before applying (conditional column/index add) except the
--  trigger DROP+CREATE pair, which is naturally idempotent
--  (DROP TRIGGER IF EXISTS).
-- =====================================================================

USE smart_hostel;

-- ---------------------------------------------------------------------
-- 1. Add rooms.gender - nullable first so the backfill in step 2 can
--    run, NOT NULL once every existing row has a value (step 3).
-- ---------------------------------------------------------------------
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rooms' AND COLUMN_NAME = 'gender'
);

SET @add_gender_sql := IF(@col_exists = 0,
  'ALTER TABLE rooms ADD COLUMN gender ENUM(''male'',''female'') NULL AFTER block_id',
  'SELECT ''rooms.gender already exists - skipped.'' AS note'
);
PREPARE stmt FROM @add_gender_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------
-- 2. Backfill: every existing room inherits its CURRENT block's
--    gender. This preserves today's actual segregation exactly
--    (Block A/B rooms stay male, Block C/D rooms stay female) -
--    nothing about who lives where changes; only the reason "room X
--    is male" is now recorded on the room, not inferred from the
--    block it happens to sit in.
-- ---------------------------------------------------------------------
UPDATE rooms r
  JOIN blocks b ON b.id = r.block_id
   SET r.gender = b.gender
 WHERE r.gender IS NULL;

-- ---------------------------------------------------------------------
-- 3. Now that every existing row has a value, make it required for
--    all FUTURE rows too (Step 5's bulk insert included).
-- ---------------------------------------------------------------------
SET @col_nullable := (
  SELECT IS_NULLABLE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rooms' AND COLUMN_NAME = 'gender'
);
SET @modify_sql := IF(@col_nullable = 'YES',
  'ALTER TABLE rooms MODIFY COLUMN gender ENUM(''male'',''female'') NOT NULL',
  'SELECT ''rooms.gender already NOT NULL - skipped.'' AS note'
);
PREPARE stmt FROM @modify_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------
-- 4. Index gender the same way block_id already is, and add a
--    composite index covering the allocation query's new filter
--    (gender, then block, then type, then availability) so a
--    gender-filtered room search stays a single indexed scan instead
--    of a table scan. The OLD idx_rooms_allocation index is left in
--    place untouched, in case anything else still relies on its
--    exact column order.
-- ---------------------------------------------------------------------
SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rooms' AND INDEX_NAME = 'idx_rooms_gender_alloc'
);
SET @add_idx_sql := IF(@idx_exists = 0,
  'ALTER TABLE rooms ADD KEY idx_rooms_gender_alloc (gender, block_id, room_type, available_spaces)',
  'SELECT ''idx_rooms_gender_alloc already exists - skipped.'' AS note'
);
PREPARE stmt FROM @add_idx_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------
-- 5. Repoint the two triggers that used to read gender through
--    blocks. DROP + CREATE is the only way MySQL lets you change a
--    trigger body - this does not touch any table row.
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_applications_before_insert;
DROP TRIGGER IF EXISTS trg_allocations_before_insert;

DELIMITER $$

-- Gender is no longer checked at APPLICATION time: a "preferred
-- block" (A/B/C/D) is now just a capacity preference, not a gender
-- choice - every block holds both genders. Gender is enforced once,
-- at ALLOCATION time (below), which is the point it actually
-- matters - the same principle Step 7 already relied on, just moved
-- to the one place gender is now actually stored.
CREATE TRIGGER trg_applications_before_insert
BEFORE INSERT ON applications
FOR EACH ROW
BEGIN
  DECLARE v_role ENUM('student','admin');

  SELECT role INTO v_role FROM users WHERE id = NEW.student_id;

  IF v_role <> 'student' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Only student accounts can submit hostel applications.';
  END IF;
END$$

CREATE TRIGGER trg_allocations_before_insert
BEFORE INSERT ON allocations
FOR EACH ROW
BEGIN
  DECLARE v_student_gender ENUM('male','female');
  DECLARE v_room_gender    ENUM('male','female');
  DECLARE v_capacity       TINYINT UNSIGNED;
  DECLARE v_occupied       TINYINT UNSIGNED;

  SELECT gender INTO v_student_gender FROM users WHERE id = NEW.student_id;

  SELECT gender, capacity, occupied_spaces
    INTO v_room_gender, v_capacity, v_occupied
    FROM rooms
   WHERE id = NEW.room_id;

  -- A male student can never end up in a female room, whatever the
  -- application code does - now checked against the ROOM directly.
  IF v_room_gender <> v_student_gender THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'A student cannot be allocated to a room of a different gender.';
  END IF;

  -- Unchanged from before (still reads occupied_spaces BEFORE the
  -- counter is incremented - see allocationService.js's transaction
  -- ordering comment).
  IF v_occupied >= v_capacity THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'This room is already full.';
  END IF;
END$$

DELIMITER ;

-- ---------------------------------------------------------------------
-- 6. v_room_details (a reporting view, not read by any backend code
--    today - confirmed via grep) previously exposed b.gender as
--    block_gender. Repointed to the room's own gender. CREATE OR
--    REPLACE is non-destructive - it only redefines the view, not any
--    underlying data.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_room_details AS
SELECT
  r.id,
  r.room_number,
  r.room_type,
  r.gender  AS room_gender,
  r.capacity,
  r.occupied_spaces,
  r.available_spaces,
  r.status,
  r.floor,
  r.is_active,
  b.id      AS block_id,
  b.name    AS block_name
FROM rooms r
JOIN blocks b ON b.id = r.block_id;

SELECT 'Step 4 migration complete.' AS status;
SELECT id, room_number, block_id, gender, room_type, capacity, occupied_spaces
  FROM rooms
 ORDER BY block_id, gender, room_number;
