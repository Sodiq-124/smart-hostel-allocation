-- =====================================================================
--  database/migrations/006_hostel_sessions_rollback.sql
--  ---------------------------------------------------------------------
--  Reverses 006_hostel_sessions.sql.
--
--  - Stop the Node server first. Run ONCE.
--  - Only safe BEFORE 9B starts writing session-linked data.
--  - No `USE`: name the database on the command line, e.g.
--        mysql -u root -p smart_hostel_scratch < 006_hostel_sessions_rollback.sql
--  - The ONLY DELETE is the removal of the 4 fee rows that 006 itself
--    created (block_id IS NOT NULL). No application, allocation, room,
--    user or payment row is deleted.
--  - Does NOT restore applications.session_year to '2025/2026' (that
--    label was a wrong column default); use the pre-migration backup if
--    you need the old value.
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. FIRST restore the original fee triggers. The 006 versions reference
--     NEW.block_id / NEW.session_id, so they must be gone BEFORE those
--     columns are dropped or before any later UPDATE on hostel_fees.
-- ---------------------------------------------------------------------
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
END$$

DELIMITER ;

-- ---------------------------------------------------------------------
--  2. allocations
-- ---------------------------------------------------------------------
ALTER TABLE allocations DROP FOREIGN KEY IF EXISTS fk_allocations_app_session;
ALTER TABLE allocations DROP FOREIGN KEY IF EXISTS fk_allocations_session;
ALTER TABLE allocations DROP INDEX IF EXISTS idx_allocations_app_session;
ALTER TABLE allocations DROP INDEX IF EXISTS idx_allocations_session;
ALTER TABLE allocations DROP COLUMN IF EXISTS session_id;

-- ---------------------------------------------------------------------
--  3. applications (after the allocations FK that referenced its key)
-- ---------------------------------------------------------------------
ALTER TABLE applications DROP FOREIGN KEY IF EXISTS fk_applications_session;
ALTER TABLE applications DROP INDEX IF EXISTS uq_applications_id_session;
ALTER TABLE applications DROP INDEX IF EXISTS idx_applications_session;
ALTER TABLE applications DROP COLUMN IF EXISTS session_id;

-- ---------------------------------------------------------------------
--  4. hostel_fees: remove the block fees 006 created, restore the
--     room_type design, reactivate the two legacy rows.
-- ---------------------------------------------------------------------
DELETE FROM hostel_fees WHERE block_id IS NOT NULL;

ALTER TABLE hostel_fees DROP FOREIGN KEY IF EXISTS fk_fees_block;
ALTER TABLE hostel_fees DROP FOREIGN KEY IF EXISTS fk_fees_session;
ALTER TABLE hostel_fees DROP INDEX IF EXISTS uq_active_fee_block_session;
ALTER TABLE hostel_fees DROP INDEX IF EXISTS idx_fees_block_session;
ALTER TABLE hostel_fees DROP COLUMN IF EXISTS fee_key;
ALTER TABLE hostel_fees DROP COLUMN IF EXISTS block_id;
ALTER TABLE hostel_fees DROP COLUMN IF EXISTS session_id;

ALTER TABLE hostel_fees MODIFY COLUMN room_type ENUM('single','shared') NOT NULL;
UPDATE hostel_fees SET active = 1 WHERE room_type IS NOT NULL;

ALTER TABLE hostel_fees ADD COLUMN IF NOT EXISTS active_key VARCHAR(20)
  AS (CASE WHEN active = 1 THEN room_type ELSE NULL END) STORED;
ALTER TABLE hostel_fees ADD UNIQUE INDEX IF NOT EXISTS uq_active_fee (active_key);

-- ---------------------------------------------------------------------
--  5. sessions (nothing references hostel_sessions any more)
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_hostel_sessions_before_insert;
DROP TRIGGER IF EXISTS trg_hostel_sessions_before_update;
DROP TABLE IF EXISTS hostel_sessions;

DROP PROCEDURE IF EXISTS sp_006_add_fk;
DROP PROCEDURE IF EXISTS sp_006_set_not_null;
