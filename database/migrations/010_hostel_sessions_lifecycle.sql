-- =====================================================================
--  010_hostel_sessions_lifecycle.sql                       *** FOR REVIEW - NOT RUN ***
--  PHASE 9 / STAGE 010 - hostel_sessions lifecycle hardening, migration_ledger,
--  and the one-time transition 2025/2026 -> 2026/2027.
--
--  Target: MariaDB 10.4.32.   Canonical session table: the existing live
--  hostel_sessions (id, label, status, starts_on, ends_on, is_current, current_key).
--
--  RUN ONCE, WITH THE NODE SERVER STOPPED.
--  NO "USE" STATEMENT ON PURPOSE - name the database on the command line, e.g.
--      mysql -u root --table smart_hostel_p9_scratch < 010_hostel_sessions_lifecycle.sql
--  Run it WITHOUT --force: the first failed check must stop the script.
--
--  WHAT IT DOES (in this order)
--    1. Pre-flight: refuses to run unless the schema and data are EXACTLY what the
--       live evidence showed. migration_ledger must not exist, or must exist with the
--       exact expected schema and no 'applied' rows (i.e. only a cleanly rolled-back
--       earlier run). Anything else aborts.
--    2. Creates migration_ledger (+ two protection triggers) and logs the run.
--    3. Adds four CHECK constraints and two lifecycle triggers to hostel_sessions.
--    4. In ONE transaction: inserts 2026/2027 as 'upcoming', closes 2025/2026,
--       opens 2026/2027 as the current session.
--    5. Post-checks the end state, then logs run_completed.
--
--  WHAT IT NEVER DOES
--    No DROP TABLE, no TRUNCATE, no DELETE, no change to applications, allocations,
--    hostel_fees, payments, rooms, users, complaints, blocks, the two views, or any
--    of the nine existing triggers. starts_on / ends_on stay NULL (no dates invented).
-- =====================================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS sp_010_assert$$
CREATE PROCEDURE sp_010_assert(IN p_ok TINYINT, IN p_msg VARCHAR(200))
BEGIN
  IF p_ok IS NULL OR p_ok <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = p_msg;
  END IF;
END$$

DROP PROCEDURE IF EXISTS sp_010_log$$
CREATE PROCEDURE sp_010_log(IN p_kind VARCHAR(30), IN p_type VARCHAR(30), IN p_table VARCHAR(64),
                            IN p_name VARCHAR(128), IN p_key VARCHAR(100), IN p_before TEXT, IN p_after TEXT)
BEGIN
  -- the ENUM would silently store '' for a bad value in non-strict mode, so validate first
  CALL sp_010_assert(p_kind IN ('run_started','run_completed','created_object','created_row','changed_row'),
                     '010 aborted: invalid ledger entry kind.');
  INSERT INTO migration_ledger
    (migration_name, migration_version, entry_kind, object_type, object_table, object_name, row_key,
     before_value, after_value, applied_by)
  VALUES
    ('010_hostel_sessions_lifecycle', 10, p_kind, p_type, p_table, p_name, p_key, p_before, p_after, CURRENT_USER());
END$$

DROP PROCEDURE IF EXISTS sp_010_preflight$$
CREATE PROCEDURE sp_010_preflight()
BEGIN
  DECLARE v_sig TEXT;
  DECLARE v_n   INT;

  -- hostel_sessions: exact columns, exact indexes
  CALL sp_010_assert((SELECT COUNT(*) FROM information_schema.TABLES
                       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hostel_sessions') = 1,
                     '010 aborted: hostel_sessions does not exist.');
  SELECT GROUP_CONCAT(CONCAT(COLUMN_NAME, ':', COLUMN_TYPE) ORDER BY ORDINAL_POSITION SEPARATOR '|') INTO v_sig
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hostel_sessions';
  CALL sp_010_assert(v_sig = 'id:int(10) unsigned|label:varchar(9)|status:enum(''upcoming'',''open'',''closed'',''archived'')|starts_on:date|ends_on:date|is_current:tinyint(1)|created_at:timestamp|updated_at:timestamp|current_key:tinyint(3) unsigned',
                     '010 aborted: hostel_sessions columns differ from the live evidence.');
  SELECT GROUP_CONCAT(CONCAT(INDEX_NAME, ':', NON_UNIQUE, ':', SEQ_IN_INDEX, ':', COLUMN_NAME)
                      ORDER BY INDEX_NAME, SEQ_IN_INDEX SEPARATOR '|') INTO v_sig
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hostel_sessions';
  CALL sp_010_assert(v_sig = 'PRIMARY:0:1:id|uq_hostel_sessions_current:0:1:current_key|uq_hostel_sessions_label:0:1:label',
                     '010 aborted: hostel_sessions indexes differ from the live evidence.');

  -- nothing of 010 may already exist on hostel_sessions
  CALL sp_010_assert((SELECT COUNT(*) FROM information_schema.TRIGGERS
                       WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = 'hostel_sessions') = 0,
                     '010 aborted: hostel_sessions already has triggers.');
  CALL sp_010_assert((SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
                       WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'hostel_sessions') = 0,
                     '010 aborted: hostel_sessions already has CHECK constraints.');

  -- data: exactly the one live row, and no 2026/2027
  CALL sp_010_assert((SELECT COUNT(*) FROM hostel_sessions) = 1,
                     '010 aborted: hostel_sessions does not contain exactly one row.');
  CALL sp_010_assert((SELECT COUNT(*) FROM hostel_sessions WHERE CONCAT('label=', label, ';status=', status, ';is_current=', is_current, ';starts_on=', IFNULL(starts_on, 'NULL'), ';ends_on=', IFNULL(ends_on, 'NULL')) = 'label=2025/2026;status=open;is_current=1;starts_on=NULL;ends_on=NULL') = 1,
                     '010 aborted: the hostel_sessions row is not 2025/2026, open, current, dates NULL.');
  CALL sp_010_assert((SELECT COUNT(*) FROM hostel_sessions WHERE label = '2026/2027') = 0,
                     '010 aborted: a 2026/2027 session already exists.');

  -- the nine existing triggers must all be present
  CALL sp_010_assert((SELECT COUNT(*) FROM information_schema.TRIGGERS
                       WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME IN ('trg_allocations_before_insert', 'trg_applications_before_insert', 'trg_fees_before_insert', 'trg_fees_before_update', 'trg_payments_before_insert', 'trg_payments_before_update', 'trg_rooms_before_insert', 'trg_rooms_before_update', 'trg_users_before_insert')) = 9,
                     '010 aborted: the nine existing triggers are not all present.');

  -- migration_ledger: absent, or present ONLY as a cleanly rolled-back earlier run
  SELECT COUNT(*) INTO v_n FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'migration_ledger';
  IF v_n = 1 THEN
  SELECT GROUP_CONCAT(CONCAT(COLUMN_NAME, ':', COLUMN_TYPE) ORDER BY ORDINAL_POSITION SEPARATOR '|') INTO v_sig
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'migration_ledger';
    CALL sp_010_assert(v_sig = 'id:int(10) unsigned|migration_name:varchar(80)|migration_version:smallint(5) unsigned|entry_kind:enum(''run_started'',''run_completed'',''run_rolled_back'',''created_object'',''created_row'',''changed_row'')|object_type:varchar(30)|object_table:varchar(64)|object_name:varchar(128)|row_key:varchar(100)|before_value:text|after_value:text|applied_by:varchar(100)|applied_at:timestamp|rollback_state:enum(''applied'',''rolled_back'')|rolled_back_at:datetime|rolled_back_by:varchar(100)',
                       '010 aborted: migration_ledger exists with an unexpected schema.');
    CALL sp_010_assert((SELECT COUNT(*) FROM migration_ledger WHERE rollback_state = 'applied') = 0,
                       '010 aborted: migration_ledger shows an applied or partially applied run. Run the rollback first.');
  END IF;
END$$

DROP PROCEDURE IF EXISTS sp_010_create_ledger$$
CREATE PROCEDURE sp_010_create_ledger()
BEGIN
  -- plain CREATE TABLE (no IF NOT EXISTS): only reached when the pre-flight found no ledger
  IF (SELECT COUNT(*) FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'migration_ledger') = 0 THEN
    CREATE TABLE migration_ledger (
      id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
      migration_name    VARCHAR(80)  NOT NULL,
      migration_version SMALLINT UNSIGNED NOT NULL,
      entry_kind        ENUM('run_started','run_completed','run_rolled_back','created_object','created_row','changed_row') NOT NULL,
      object_type       VARCHAR(30)  DEFAULT NULL,
      object_table      VARCHAR(64)  DEFAULT NULL,
      object_name       VARCHAR(128) DEFAULT NULL,
      row_key           VARCHAR(100) DEFAULT NULL,
      before_value      TEXT         DEFAULT NULL,
      after_value       TEXT         DEFAULT NULL,
      applied_by        VARCHAR(100) NOT NULL,
      applied_at        TIMESTAMP    NOT NULL DEFAULT current_timestamp(),
      rollback_state    ENUM('applied','rolled_back') NOT NULL DEFAULT 'applied',
      rolled_back_at    DATETIME     DEFAULT NULL,
      rolled_back_by    VARCHAR(100) DEFAULT NULL,
      PRIMARY KEY (id),
      KEY idx_ledger_migration (migration_name, entry_kind, rollback_state)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    SET @ledger_created_by_010 = 1;
  ELSE
    SET @ledger_created_by_010 = 0;
  END IF;
END$$

DROP PROCEDURE IF EXISTS sp_010_transition$$
CREATE PROCEDURE sp_010_transition()
BEGIN
  DECLARE v_old_id INT UNSIGNED;
  DECLARE v_new_id INT UNSIGNED;
  DECLARE v_rc     INT;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  START TRANSACTION;

  SELECT id INTO v_old_id FROM hostel_sessions
   WHERE label = '2025/2026' AND status = 'open' AND is_current = 1 FOR UPDATE;
  CALL sp_010_assert(v_old_id IS NOT NULL, '010 aborted: 2025/2026 is not the open current session.');
  CALL sp_010_assert((SELECT COUNT(*) FROM hostel_sessions WHERE label = '2026/2027') = 0,
                     '010 aborted: a 2026/2027 session already exists.');

  -- (1) create 2026/2027 as upcoming, NOT current (dates stay NULL)
  INSERT INTO hostel_sessions (label, status, is_current, starts_on, ends_on)
  VALUES ('2026/2027', 'upcoming', 0, NULL, NULL);
  SET v_new_id = LAST_INSERT_ID();

  -- (2) demote 2025/2026 FIRST: uq_hostel_sessions_current allows only one current row
  UPDATE hostel_sessions SET status = 'closed', is_current = 0
   WHERE id = v_old_id AND label = '2025/2026' AND status = 'open' AND is_current = 1;
  SET v_rc = ROW_COUNT();
  CALL sp_010_assert(v_rc = 1, '010 aborted: could not close 2025/2026.');

  -- (3) open 2026/2027 and make it current
  UPDATE hostel_sessions SET status = 'open', is_current = 1
   WHERE id = v_new_id AND label = '2026/2027' AND status = 'upcoming' AND is_current = 0;
  SET v_rc = ROW_COUNT();
  CALL sp_010_assert(v_rc = 1, '010 aborted: could not open 2026/2027.');

  -- end state, still inside the transaction
  CALL sp_010_assert((SELECT COUNT(*) FROM hostel_sessions) = 2, '010 aborted: expected exactly two sessions.');
  CALL sp_010_assert((SELECT COUNT(*) FROM hostel_sessions WHERE is_current = 1) = 1, '010 aborted: expected exactly one current session.');
  CALL sp_010_assert((SELECT COUNT(*) FROM hostel_sessions WHERE id = v_new_id AND CONCAT('label=', label, ';status=', status, ';is_current=', is_current, ';starts_on=', IFNULL(starts_on, 'NULL'), ';ends_on=', IFNULL(ends_on, 'NULL')) = 'label=2026/2027;status=open;is_current=1;starts_on=NULL;ends_on=NULL') = 1,
                     '010 aborted: 2026/2027 is not open and current.');
  CALL sp_010_assert((SELECT COUNT(*) FROM hostel_sessions WHERE id = v_old_id AND CONCAT('label=', label, ';status=', status, ';is_current=', is_current, ';starts_on=', IFNULL(starts_on, 'NULL'), ';ends_on=', IFNULL(ends_on, 'NULL')) = 'label=2025/2026;status=closed;is_current=0;starts_on=NULL;ends_on=NULL') = 1,
                     '010 aborted: 2025/2026 is not closed.');

  -- ledger: the row this run created and the row it changed (rolled back with the transaction on failure)
  CALL sp_010_log('created_row', 'row', 'hostel_sessions', '2026/2027', CONCAT('id=', v_new_id), NULL, 'label=2026/2027;status=open;is_current=1;starts_on=NULL;ends_on=NULL');
  CALL sp_010_log('changed_row', 'row', 'hostel_sessions', '2025/2026', CONCAT('id=', v_old_id),
                  'label=2025/2026;status=open;is_current=1;starts_on=NULL;ends_on=NULL', 'label=2025/2026;status=closed;is_current=0;starts_on=NULL;ends_on=NULL');
  COMMIT;
END$$

DROP PROCEDURE IF EXISTS sp_010_postcheck$$
CREATE PROCEDURE sp_010_postcheck()
BEGIN
  CALL sp_010_assert((SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
                       WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'hostel_sessions'
                         AND CONSTRAINT_NAME IN ('ck_hs_label_format','ck_hs_label_consecutive','ck_hs_current_iff_open','ck_hs_dates')) = 4,
                     '010 post-check failed: the four CHECK constraints are not all present.');
  CALL sp_010_assert((SELECT COUNT(*) FROM information_schema.TRIGGERS
                       WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME IN ('trg_hs_lifecycle_update','trg_hs_lifecycle_delete')) = 2,
                     '010 post-check failed: the two lifecycle triggers are not both present.');
  CALL sp_010_assert((SELECT COUNT(*) FROM information_schema.TRIGGERS
                       WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME IN ('trg_migration_ledger_no_delete','trg_migration_ledger_update_guard')) = 2,
                     '010 post-check failed: the two ledger triggers are not both present.');
  CALL sp_010_assert((SELECT COUNT(*) FROM information_schema.TRIGGERS
                       WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME IN ('trg_allocations_before_insert', 'trg_applications_before_insert', 'trg_fees_before_insert', 'trg_fees_before_update', 'trg_payments_before_insert', 'trg_payments_before_update', 'trg_rooms_before_insert', 'trg_rooms_before_update', 'trg_users_before_insert')) = 9,
                     '010 post-check failed: an existing trigger is missing.');
  CALL sp_010_assert((SELECT COUNT(*) FROM information_schema.COLUMNS
                       WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'hostel_session_id') = 0,
                     '010 post-check failed: 010 must not add hostel_session_id columns.');
  CALL sp_010_assert((SELECT COUNT(*) FROM migration_ledger
                       WHERE migration_name = '010_hostel_sessions_lifecycle' AND rollback_state = 'applied' AND entry_kind = 'run_started') = 1,
                     '010 post-check failed: expected exactly one applied run_started entry.');
  CALL sp_010_assert((SELECT COUNT(*) FROM migration_ledger
                       WHERE migration_name = '010_hostel_sessions_lifecycle' AND rollback_state = 'applied'
                         AND entry_kind IN ('created_row','changed_row')) = 2,
                     '010 post-check failed: expected one created_row and one changed_row entry.');
END$$

DELIMITER ;


-- ---------------------------------------------------------------------
--  1. PRE-FLIGHT (read-only; aborts the script on any surprise)
-- ---------------------------------------------------------------------
CALL sp_010_preflight();

-- ---------------------------------------------------------------------
--  2. migration_ledger and its protection triggers
-- ---------------------------------------------------------------------
CALL sp_010_create_ledger();

DELIMITER $$
DROP TRIGGER IF EXISTS trg_migration_ledger_no_delete$$
CREATE TRIGGER trg_migration_ledger_no_delete
BEFORE DELETE ON migration_ledger
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'migration_ledger is append-only: rows cannot be deleted.';
END$$

DROP TRIGGER IF EXISTS trg_migration_ledger_update_guard$$
CREATE TRIGGER trg_migration_ledger_update_guard
BEFORE UPDATE ON migration_ledger
FOR EACH ROW
BEGIN
  IF OLD.rollback_state = 'rolled_back' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'A rolled-back migration_ledger row cannot be changed.';
  END IF;
  IF NEW.rollback_state <> 'rolled_back' OR NEW.rolled_back_at IS NULL OR NEW.rolled_back_by IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'A migration_ledger row may only be updated to mark it rolled back.';
  END IF;
  IF NOT (NEW.id <=> OLD.id
      AND NEW.migration_name <=> OLD.migration_name
      AND NEW.migration_version <=> OLD.migration_version
      AND NEW.entry_kind <=> OLD.entry_kind
      AND NEW.object_type <=> OLD.object_type
      AND NEW.object_table <=> OLD.object_table
      AND NEW.object_name <=> OLD.object_name
      AND NEW.row_key <=> OLD.row_key
      AND NEW.before_value <=> OLD.before_value
      AND NEW.after_value <=> OLD.after_value
      AND NEW.applied_by <=> OLD.applied_by
      AND NEW.applied_at <=> OLD.applied_at) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Only the rollback columns of a migration_ledger row may change.';
  END IF;
END$$
DELIMITER ;

CALL sp_010_log('run_started', NULL, NULL, NULL, NULL, NULL, 'migration 010 started');
CALL sp_010_log('created_object', 'table', 'migration_ledger', 'migration_ledger', NULL, NULL,
                IF(@ledger_created_by_010 = 1, 'created by this run', 'pre-existing from a rolled-back run; validated and reused'));
CALL sp_010_log('created_object', 'trigger', 'migration_ledger', 'trg_migration_ledger_no_delete', NULL, NULL, 'BEFORE DELETE: always rejects');
CALL sp_010_log('created_object', 'trigger', 'migration_ledger', 'trg_migration_ledger_update_guard', NULL, NULL, 'BEFORE UPDATE: only applied -> rolled_back marking');

-- ---------------------------------------------------------------------
--  3. CHECK constraints and lifecycle triggers on hostel_sessions
-- ---------------------------------------------------------------------
ALTER TABLE hostel_sessions
  ADD CONSTRAINT ck_hs_label_format      CHECK (label REGEXP '^[0-9]{4}/[0-9]{4}$'),
  ADD CONSTRAINT ck_hs_label_consecutive CHECK (CAST(SUBSTRING(label, 6, 4) AS UNSIGNED) = CAST(SUBSTRING(label, 1, 4) AS UNSIGNED) + 1),
  ADD CONSTRAINT ck_hs_current_iff_open  CHECK (is_current = (status = 'open')),
  ADD CONSTRAINT ck_hs_dates             CHECK (starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on);

CALL sp_010_log('created_object', 'check', 'hostel_sessions', 'ck_hs_label_format', NULL, NULL, 'label REGEXP ^[0-9]{4}/[0-9]{4}$');
CALL sp_010_log('created_object', 'check', 'hostel_sessions', 'ck_hs_label_consecutive', NULL, NULL, 'second year = first year + 1');
CALL sp_010_log('created_object', 'check', 'hostel_sessions', 'ck_hs_current_iff_open', NULL, NULL, 'is_current = (status = open)');
CALL sp_010_log('created_object', 'check', 'hostel_sessions', 'ck_hs_dates', NULL, NULL, 'dates NULL or ends_on >= starts_on');

DELIMITER $$
CREATE TRIGGER trg_hs_lifecycle_update
BEFORE UPDATE ON hostel_sessions
FOR EACH ROW
BEGIN
  -- archived sessions are immutable
  IF OLD.status = 'archived' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'An archived hostel session cannot be changed.';
  END IF;
  -- forward-only lifecycle: upcoming -> open -> closed -> archived
  IF NEW.status <> OLD.status AND NOT (
         (OLD.status = 'upcoming' AND NEW.status = 'open')
      OR (OLD.status = 'open'     AND NEW.status = 'closed')
      OR (OLD.status = 'closed'   AND NEW.status = 'archived')) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Hostel sessions move forward only: upcoming, open, closed, archived.';
  END IF;
  -- the label is part of a session's identity once it has left the upcoming state
  IF (OLD.status <> 'upcoming' OR NEW.status <> 'upcoming') AND NOT (NEW.label <=> OLD.label) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'The label of a hostel session that has left the upcoming state cannot be changed.';
  END IF;
END$$

CREATE TRIGGER trg_hs_lifecycle_delete
BEFORE DELETE ON hostel_sessions
FOR EACH ROW
BEGIN
  -- only an upcoming session may be deleted; references to it are blocked by foreign keys added from 011 on
  IF OLD.status <> 'upcoming' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Only an upcoming hostel session can be deleted.';
  END IF;
END$$
DELIMITER ;

CALL sp_010_log('created_object', 'trigger', 'hostel_sessions', 'trg_hs_lifecycle_update', NULL, NULL, 'forward-only, archived immutable, label frozen after upcoming');
CALL sp_010_log('created_object', 'trigger', 'hostel_sessions', 'trg_hs_lifecycle_delete', NULL, NULL, 'only upcoming sessions deletable');

-- ---------------------------------------------------------------------
--  4. THE ONE-TIME TRANSITION (single transaction inside the procedure)
-- ---------------------------------------------------------------------
CALL sp_010_transition();

-- ---------------------------------------------------------------------
--  5. POST-CHECK, completion record, helper cleanup
-- ---------------------------------------------------------------------
CALL sp_010_postcheck();
CALL sp_010_log('run_completed', NULL, NULL, NULL, NULL, NULL, 'migration 010 completed');

DROP PROCEDURE IF EXISTS sp_010_postcheck;
DROP PROCEDURE IF EXISTS sp_010_transition;
DROP PROCEDURE IF EXISTS sp_010_create_ledger;
DROP PROCEDURE IF EXISTS sp_010_preflight;
DROP PROCEDURE IF EXISTS sp_010_log;
DROP PROCEDURE IF EXISTS sp_010_assert;

-- result summary (read-only)
SELECT id, label, status, starts_on, ends_on, is_current FROM hostel_sessions ORDER BY id;
SELECT id, entry_kind, object_type, object_table, object_name, row_key, rollback_state FROM migration_ledger
 WHERE migration_name = '010_hostel_sessions_lifecycle' AND rollback_state = 'applied' ORDER BY id;
