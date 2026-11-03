-- =====================================================================
--  database/migrations/004_room_number_uniqueness.sql
--  ---------------------------------------------------------------------
--  PHASE 9 PRE-WORK / STEP 5 (part 1 of 2) - room-number uniqueness
--  becomes scoped to (block_id, gender) instead of the whole table.
--
--  WHY: the current UNIQUE KEY uq_rooms_room_number (room_number) is a
--  single, table-wide constraint - it would make "Block B Male R001"
--  and "Block B Female R001" mutually exclusive, when the required
--  structure needs both to exist as distinct rooms. Every existing
--  room_number value (A101, B101, C101, D101, ...) is already
--  globally unique today, so this change cannot conflict with any of
--  them - it only WIDENS what's allowed; it narrows nothing that
--  already exists.
--
--  DOES NOT touch any row's data or delete any room - this only
--  redefines an index.
--
--  Must run BEFORE 005_seed_block_rooms.sql - that migration inserts
--  the same room_number ("R001".."R100") into multiple sections of
--  the same block, which the OLD global constraint would reject.
--
--  Run with:
--      mysql -u root -p smart_hostel < database/migrations/004_room_number_uniqueness.sql
--
--  Safe to run more than once - checks information_schema first.
-- =====================================================================

USE smart_hostel;

-- ---------------------------------------------------------------------
-- 1. Drop the old global unique key, if it's still there.
-- ---------------------------------------------------------------------
SET @old_idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rooms' AND INDEX_NAME = 'uq_rooms_room_number'
);
SET @drop_old_sql := IF(@old_idx_exists > 0,
  'ALTER TABLE rooms DROP INDEX uq_rooms_room_number',
  'SELECT ''uq_rooms_room_number already absent - skipped.'' AS note'
);
PREPARE stmt FROM @drop_old_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------
-- 2. Add the new composite unique key, if it isn't already there.
-- ---------------------------------------------------------------------
SET @new_idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rooms' AND INDEX_NAME = 'uq_rooms_section_number'
);
SET @add_new_sql := IF(@new_idx_exists = 0,
  'ALTER TABLE rooms ADD UNIQUE KEY uq_rooms_section_number (block_id, gender, room_number)',
  'SELECT ''uq_rooms_section_number already exists - skipped.'' AS note'
);
PREPARE stmt FROM @add_new_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SELECT 'Step 5 (1/2) migration complete: room_number is now unique per block+gender section.' AS status;

SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rooms' AND INDEX_NAME = 'uq_rooms_section_number'
 ORDER BY SEQ_IN_INDEX;
