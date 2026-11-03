-- =====================================================================
--  010_hostel_sessions_lifecycle_rollback.sql              *** FOR REVIEW - NOT RUN ***
--
--  Reverses 010. CONDITIONAL: it first PROVES from migration_ledger and the live
--  rows that nothing has changed since 010 and that nothing depends on it; if ANY
--  check fails it aborts without changing anything.
--
--  Run with the Node server stopped, WITHOUT --force, naming the database:
--      mysql -u root --table smart_hostel_p9_scratch < 010_hostel_sessions_lifecycle_rollback.sql
--  Roll back later stages (011-015) first: this script refuses while any
--  hostel_session_id column, any foreign key to hostel_sessions, or any applied ledger
--  entry of a later migration exists.
--
--  What it removes: the 4 CHECKs and 2 lifecycle triggers on hostel_sessions, and the
--  ONE row 010 created (id and label taken from the ledger and re-verified).
--  What it restores: 2025/2026 to open + current (only if it is still exactly as 010 left it).
--  What it KEEPS: migration_ledger, its two protection triggers and all its history
--  (rows are marked rolled_back, never deleted). No DROP TABLE, no TRUNCATE.
--  Note: AUTO_INCREMENT does not go back, so a reapply creates id 3, not 2. Harmless.
-- =====================================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS sp_010_assert$$
CREATE PROCEDURE sp_010_assert(IN p_ok TINYINT, IN p_msg VARCHAR(200))
BEGIN
  IF p_ok IS NULL OR p_ok <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = p_msg;
  END IF;
END$$

DROP PROCEDURE IF EXISTS sp_010_rb_verify$$
CREATE PROCEDURE sp_010_rb_verify()
BEGIN
  DECLARE v_sig TEXT;
  DECLARE v_rows INT;
  DECLARE v_key VARCHAR(100);
  DECLARE v_after TEXT;

  CALL sp_010_assert((SELECT COUNT(*) FROM information_schema.TABLES
                       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'migration_ledger') = 1,
                     'Rollback refused: migration_ledger does not exist, so there is no proof of what 010 created.');
  SELECT GROUP_CONCAT(CONCAT(COLUMN_NAME, ':', COLUMN_TYPE) ORDER BY ORDINAL_POSITION SEPARATOR '|') INTO v_sig
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'migration_ledger';
  CALL sp_010_assert(v_sig = 'id:int(10) unsigned|migration_name:varchar(80)|migration_version:smallint(5) unsigned|entry_kind:enum(''run_started'',''run_completed'',''run_rolled_back'',''created_object'',''created_row'',''changed_row'')|object_type:varchar(30)|object_table:varchar(64)|object_name:varchar(128)|row_key:varchar(100)|before_value:text|after_value:text|applied_by:varchar(100)|applied_at:timestamp|rollback_state:enum(''applied'',''rolled_back'')|rolled_back_at:datetime|rolled_back_by:varchar(100)', 'Rollback refused: migration_ledger has an unexpected schema.');
  CALL sp_010_assert((SELECT COUNT(*) FROM migration_ledger
                       WHERE migration_name = '010_hostel_sessions_lifecycle' AND entry_kind = 'run_started' AND rollback_state = 'applied') = 1,
                     'Rollback refused: there is not exactly one applied 010 run in the ledger.');
  CALL sp_010_assert((SELECT COUNT(*) FROM migration_ledger
                       WHERE migration_version > 10 AND rollback_state = 'applied') = 0,
                     'Rollback refused: a later migration is still applied. Roll those back first.');
  CALL sp_010_assert((SELECT COUNT(*) FROM information_schema.COLUMNS
                       WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'hostel_session_id') = 0,
                     'Rollback refused: a hostel_session_id column exists, so something depends on hostel_sessions.');
  CALL sp_010_assert((SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS
                       WHERE CONSTRAINT_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'hostel_sessions') = 0,
                     'Rollback refused: a foreign key references hostel_sessions.');

  SELECT COUNT(*) INTO v_rows FROM migration_ledger
   WHERE migration_name = '010_hostel_sessions_lifecycle' AND entry_kind = 'created_row' AND rollback_state = 'applied';
  CALL sp_010_assert(v_rows IN (0, 1), 'Rollback refused: unexpected number of created_row ledger entries.');
  CALL sp_010_assert((SELECT COUNT(*) FROM migration_ledger
                       WHERE migration_name = '010_hostel_sessions_lifecycle' AND entry_kind = 'changed_row' AND rollback_state = 'applied') = v_rows,
                     'Rollback refused: created_row and changed_row ledger entries do not match.');
  SET @rb010_has_rows = v_rows;

  IF v_rows = 1 THEN
    -- the transition was committed: both rows must still be EXACTLY as 010 left them
    SELECT row_key, after_value INTO v_key, v_after FROM migration_ledger
     WHERE migration_name = '010_hostel_sessions_lifecycle' AND entry_kind = 'created_row' AND rollback_state = 'applied';
    SET @rb010_new_id = CAST(SUBSTRING(v_key, 4) AS UNSIGNED);
    CALL sp_010_assert((SELECT COUNT(*) FROM hostel_sessions
                         WHERE id = @rb010_new_id AND label = '2026/2027' AND CONCAT('label=', label, ';status=', status, ';is_current=', is_current, ';starts_on=', IFNULL(starts_on, 'NULL'), ';ends_on=', IFNULL(ends_on, 'NULL')) = v_after) = 1,
                       'Rollback refused: the 2026/2027 row differs from what 010 created (it has been changed since).');
    SELECT row_key, after_value INTO v_key, v_after FROM migration_ledger
     WHERE migration_name = '010_hostel_sessions_lifecycle' AND entry_kind = 'changed_row' AND rollback_state = 'applied';
    SET @rb010_old_id = CAST(SUBSTRING(v_key, 4) AS UNSIGNED);
    CALL sp_010_assert((SELECT COUNT(*) FROM hostel_sessions
                         WHERE id = @rb010_old_id AND label = '2025/2026' AND CONCAT('label=', label, ';status=', status, ';is_current=', is_current, ';starts_on=', IFNULL(starts_on, 'NULL'), ';ends_on=', IFNULL(ends_on, 'NULL')) = v_after) = 1,
                       'Rollback refused: the 2025/2026 row differs from what 010 left (it has been changed since).');
    CALL sp_010_assert((SELECT COUNT(*) FROM hostel_sessions) = 2,
                       'Rollback refused: hostel_sessions contains rows other than the two 010 handled.');
  ELSE
    -- the transition never committed: hostel_sessions must still be the original single row
    CALL sp_010_assert((SELECT COUNT(*) FROM hostel_sessions) = 1
                       AND (SELECT COUNT(*) FROM hostel_sessions WHERE CONCAT('label=', label, ';status=', status, ';is_current=', is_current, ';starts_on=', IFNULL(starts_on, 'NULL'), ';ends_on=', IFNULL(ends_on, 'NULL')) = 'label=2025/2026;status=open;is_current=1;starts_on=NULL;ends_on=NULL') = 1,
                       'Rollback refused: hostel_sessions is not in its original single-row state.');
  END IF;
END$$

DROP PROCEDURE IF EXISTS sp_010_rb_rows$$
CREATE PROCEDURE sp_010_rb_rows()
BEGIN
  DECLARE v_rc INT;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;
  START TRANSACTION;
  IF @rb010_has_rows = 1 THEN
    -- delete ONLY the row 010 created, matched by its ledger id AND label AND state
    DELETE FROM hostel_sessions
     WHERE id = @rb010_new_id AND label = '2026/2027' AND status = 'open' AND is_current = 1;
    SET v_rc = ROW_COUNT();
    CALL sp_010_assert(v_rc = 1, 'Rollback aborted: could not remove the 2026/2027 row.');
    -- then restore 2025/2026 (the unique current key requires the delete to come first)
    UPDATE hostel_sessions SET status = 'open', is_current = 1
     WHERE id = @rb010_old_id AND label = '2025/2026' AND status = 'closed' AND is_current = 0;
    SET v_rc = ROW_COUNT();
    CALL sp_010_assert(v_rc = 1, 'Rollback aborted: could not restore 2025/2026.');
  END IF;
  CALL sp_010_assert((SELECT COUNT(*) FROM hostel_sessions) = 1
                     AND (SELECT COUNT(*) FROM hostel_sessions WHERE CONCAT('label=', label, ';status=', status, ';is_current=', is_current, ';starts_on=', IFNULL(starts_on, 'NULL'), ';ends_on=', IFNULL(ends_on, 'NULL')) = 'label=2025/2026;status=open;is_current=1;starts_on=NULL;ends_on=NULL') = 1,
                     'Rollback aborted: hostel_sessions is not back to its original single row.');
  COMMIT;
END$$

DROP PROCEDURE IF EXISTS sp_010_rb_final$$
CREATE PROCEDURE sp_010_rb_final()
BEGIN
  CALL sp_010_assert((SELECT COUNT(*) FROM information_schema.TRIGGERS
                       WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME IN ('trg_hs_lifecycle_update','trg_hs_lifecycle_delete')) = 0,
                     'Rollback check failed: a lifecycle trigger is still present.');
  CALL sp_010_assert((SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
                       WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'hostel_sessions') = 0,
                     'Rollback check failed: a CHECK constraint is still present.');
  CALL sp_010_assert((SELECT COUNT(*) FROM migration_ledger
                       WHERE migration_name = '010_hostel_sessions_lifecycle' AND rollback_state = 'applied') = 0,
                     'Rollback check failed: 010 ledger entries are still marked applied.');
  CALL sp_010_assert((SELECT COUNT(*) FROM information_schema.TRIGGERS
                       WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME IN ('trg_allocations_before_insert', 'trg_applications_before_insert', 'trg_fees_before_insert', 'trg_fees_before_update', 'trg_payments_before_insert', 'trg_payments_before_update', 'trg_rooms_before_insert', 'trg_rooms_before_update', 'trg_users_before_insert')) = 9,
                     'Rollback check failed: an existing trigger is missing.');
END$$

DELIMITER ;

-- 1. prove it is safe (read-only; aborts the script otherwise)
CALL sp_010_rb_verify();

-- 2. remove the constraints and triggers 010 added (they would block the row restore)
DROP TRIGGER IF EXISTS trg_hs_lifecycle_update;
DROP TRIGGER IF EXISTS trg_hs_lifecycle_delete;
ALTER TABLE hostel_sessions DROP CONSTRAINT IF EXISTS ck_hs_label_format;
ALTER TABLE hostel_sessions DROP CONSTRAINT IF EXISTS ck_hs_label_consecutive;
ALTER TABLE hostel_sessions DROP CONSTRAINT IF EXISTS ck_hs_current_iff_open;
ALTER TABLE hostel_sessions DROP CONSTRAINT IF EXISTS ck_hs_dates;

-- 3. the two row operations, in one transaction, each scoped to a ledger-verified id
CALL sp_010_rb_rows();

-- 4. ledger: mark (never delete) this run's entries, then append the rollback event
UPDATE migration_ledger
   SET rollback_state = 'rolled_back', rolled_back_at = NOW(), rolled_back_by = CURRENT_USER()
 WHERE migration_name = '010_hostel_sessions_lifecycle' AND rollback_state = 'applied';

INSERT INTO migration_ledger
  (migration_name, migration_version, entry_kind, after_value, applied_by, rollback_state, rolled_back_at, rolled_back_by)
VALUES
  ('010_hostel_sessions_lifecycle', 10, 'run_rolled_back', 'migration 010 rolled back', CURRENT_USER(), 'rolled_back', NOW(), CURRENT_USER());

-- 5. final proof and cleanup
CALL sp_010_rb_final();
DROP PROCEDURE IF EXISTS sp_010_rb_final;
DROP PROCEDURE IF EXISTS sp_010_rb_rows;
DROP PROCEDURE IF EXISTS sp_010_rb_verify;
DROP PROCEDURE IF EXISTS sp_010_assert;

SELECT id, label, status, starts_on, ends_on, is_current FROM hostel_sessions ORDER BY id;
SELECT id, entry_kind, object_name, rollback_state, rolled_back_at FROM migration_ledger WHERE migration_name = '010_hostel_sessions_lifecycle' ORDER BY id;
