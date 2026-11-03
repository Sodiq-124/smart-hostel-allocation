-- =====================================================================
--  database/migrations/005_seed_block_rooms.sql
--  ---------------------------------------------------------------------
--  PHASE 9 PRE-WORK / STEP 5 (part 2 of 2) - seeds the 800 rooms
--  (R001-R100, restarting in each of the 8 block+gender sections).
--
--  REQUIRES 004_room_number_uniqueness.sql to have already run - this
--  script inserts the SAME room_number ("R001".."R100") into multiple
--  sections of the same block, which the old table-wide unique
--  constraint would reject.
--
--  DOES NOT touch the existing 23 legacy rooms (A101, B101, C101,
--  D101, ...) - their room_number values never collide with the new
--  "R0xx" scheme, so nothing about them needs to change. See Step 5's
--  planning inspection for why: every application/allocation
--  references a room by its numeric id, never by room_number.
--
--  IDEMPOTENT: a temporary stored procedure inserts each room only if
--  a room with that exact (block_id, gender, room_number) doesn't
--  already exist. Running this script twice inserts nothing the
--  second time - it is safe to re-run after a partial failure.
--
--  Portable to MySQL 5.7 (this project's stated minimum target,
--  noted in hostel.sql's header): generates the 100 room numbers via
--  a WHILE loop inside a stored procedure rather than a recursive CTE
--  (WITH RECURSIVE needs MySQL 8.0.1+, which this project does not
--  require).
--
--  Run with:
--      mysql -u root -p smart_hostel < database/migrations/005_seed_block_rooms.sql
-- =====================================================================

USE smart_hostel;

DELIMITER $$

DROP PROCEDURE IF EXISTS sp_seed_room_section$$

-- Inserts up to 100 rooms (R001..R100) into one block+gender section,
-- skipping any room_number that already exists in that exact section.
-- Looks the block up BY NAME rather than assuming a fixed id, since
-- nothing else in this project's migrations relies on block ids being
-- any particular value.
CREATE PROCEDURE sp_seed_room_section(
  IN p_block_name VARCHAR(50),
  IN p_gender     VARCHAR(10),
  IN p_room_type  VARCHAR(10),
  IN p_capacity   TINYINT UNSIGNED
)
BEGIN
  DECLARE v_block_id INT UNSIGNED;
  DECLARE v_n INT DEFAULT 1;
  DECLARE v_room_number VARCHAR(20);

  SELECT id INTO v_block_id FROM blocks WHERE name = p_block_name LIMIT 1;

  IF v_block_id IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'sp_seed_room_section: block name not found - seed aborted for this section.';
  END IF;

  WHILE v_n <= 100 DO
    SET v_room_number = CONCAT('R', LPAD(v_n, 3, '0'));

    INSERT INTO rooms (room_number, block_id, gender, room_type, capacity)
    SELECT v_room_number, v_block_id, p_gender, p_room_type, p_capacity
     WHERE NOT EXISTS (
       SELECT 1 FROM rooms
        WHERE block_id = v_block_id AND gender = p_gender AND room_number = v_room_number
     );

    SET v_n = v_n + 1;
  END WHILE;
END$$

DELIMITER ;

-- ---------------------------------------------------------------------
-- Block A: single rooms, capacity 1
-- Block B: shared rooms, capacity 2
-- Block C: shared rooms, capacity 3
-- Block D: shared rooms, capacity 4
-- Each block gets 100 male + 100 female = 200 rooms; 4 blocks = 800.
-- ---------------------------------------------------------------------
CALL sp_seed_room_section('Block A', 'male',   'single', 1);
CALL sp_seed_room_section('Block A', 'female', 'single', 1);
CALL sp_seed_room_section('Block B', 'male',   'shared', 2);
CALL sp_seed_room_section('Block B', 'female', 'shared', 2);
CALL sp_seed_room_section('Block C', 'male',   'shared', 3);
CALL sp_seed_room_section('Block C', 'female', 'shared', 3);
CALL sp_seed_room_section('Block D', 'male',   'shared', 4);
CALL sp_seed_room_section('Block D', 'female', 'shared', 4);

DROP PROCEDURE IF EXISTS sp_seed_room_section;

SELECT 'Step 5 (2/2) migration complete: 800-room seed applied (idempotent).' AS status;

-- Verification: 8 rows, each showing 100 rooms and the right bed count.
SELECT b.name AS block, r.gender, COUNT(*) AS room_count, SUM(r.capacity) AS bed_spaces
  FROM rooms r
  JOIN blocks b ON b.id = r.block_id
 WHERE r.room_number LIKE 'R%'
 GROUP BY b.name, r.gender
 ORDER BY b.name, r.gender;

-- Grand total across the whole rooms table (legacy 23 + new 800 = 823
-- rooms; new beds alone = 2000, legacy beds are additional).
SELECT COUNT(*) AS total_rooms, SUM(capacity) AS total_beds FROM rooms;
