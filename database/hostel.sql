-- =====================================================================
--  SMART HOSTEL ROOM ALLOCATION SYSTEM
--  database/hostel.sql
--  ---------------------------------------------------------------------
--  Target: MySQL 5.7.6 or newer  (also runs on MySQL 8.x and MariaDB 10.2+)
--  Engine: InnoDB          Charset: utf8mb4
--
--  Run with:
--      mysql -u root -p < database/hostel.sql
--
--  ---------------------------------------------------------------------
--  TWO AMENDMENTS TO THE PHASE 1 DESIGN
--
--  (1) GENDER SEGREGATION
--      Hostel blocks are male or female. Rather than adding a loose
--      `gender` column to rooms, this schema introduces a `blocks`
--      table. Gender is a property of the block, which is how the
--      real hostel works: Block A is the male hostel, and every room
--      inside it is therefore a male room.
--
--      This also fixes something the Phase 1 design left weak - the
--      block was only a VARCHAR typed into each room row, so "Block A",
--      "block a" and "Blk A" could all coexist. A foreign key makes
--      that impossible and lets the student's dropdown be populated
--      from the database, as section 10 of the brief asked.
--
--  (2) NO CHECK CONSTRAINTS
--      MySQL 5.7 PARSES `CHECK (...)` and then SILENTLY IGNORES IT.
--      This is worse than an error: the constraint appears in the
--      schema, looks like it is protecting the data, and does nothing.
--      Every rule that Phase 1 assigned to a CHECK is implemented here
--      as a BEFORE INSERT / BEFORE UPDATE trigger that raises an error
--      with SIGNAL SQLSTATE '45000'.
--
--      Generated columns are kept - those ARE supported from 5.7.6, and
--      they are what enforce "one active application per student" and
--      "one successful payment per application".
-- =====================================================================

DROP DATABASE IF EXISTS smart_hostel;

CREATE DATABASE smart_hostel
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE smart_hostel;

SET FOREIGN_KEY_CHECKS = 1;


-- =====================================================================
--  TABLE 1: users
--  Students and administrators share one table, separated by `role`.
--
--  Why one table and not `students` + `admins`?
--    Both log in the same way, both need a hashed password, and both
--    are referenced by other tables (a student applies; an admin
--    reviews). Splitting them would mean two login queries, two
--    password-reset paths, and a foreign key on `applications.reviewed_by`
--    that could point at either table - which SQL cannot express.
-- =====================================================================
CREATE TABLE users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  full_name     VARCHAR(120) NOT NULL,

  -- Matriculation number. NULL for admins, who have none.
  -- A UNIQUE index in MySQL permits many NULLs, so several admins can
  -- coexist while student IDs stay unique among students.
  student_id    VARCHAR(30) DEFAULT NULL,

  email         VARCHAR(150) NOT NULL,

  -- bcrypt output is 60 characters. 255 leaves room to migrate to a
  -- different algorithm later without altering the table.
  password      VARCHAR(255) NOT NULL,

  role          ENUM('student','admin') NOT NULL DEFAULT 'student',

  -- Required for students (enforced by trigger), NULL for admins.
  -- Drives which blocks a student may be allocated to.
  gender        ENUM('male','female') DEFAULT NULL,

  phone         VARCHAR(20) DEFAULT NULL,
  department    VARCHAR(120) DEFAULT NULL,
  level         VARCHAR(10) DEFAULT NULL,

  -- Soft disable. We never DELETE a user who has payment history,
  -- because the financial record must survive.
  is_active     TINYINT(1) NOT NULL DEFAULT 1,

  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email      (email),
  UNIQUE KEY uq_users_student_id (student_id),
  KEY idx_users_role             (role),
  KEY idx_users_gender           (gender)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- =====================================================================
--  TABLE 2: blocks
--  A hostel building. Gender lives here.
-- =====================================================================
CREATE TABLE blocks (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(50) NOT NULL,          -- 'Block A'
  gender        ENUM('male','female') NOT NULL,
  description   VARCHAR(255) DEFAULT NULL,

  -- Lets an admin retire a block from new applications without
  -- deleting it and losing the allocation history it is attached to.
  is_active     TINYINT(1) NOT NULL DEFAULT 1,

  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_blocks_name (name),
  KEY idx_blocks_gender     (gender, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- =====================================================================
--  TABLE 3: rooms
--
--  `occupied_spaces` is a deliberate denormalisation. True occupancy
--  could always be counted from `allocations`, but storing a counter
--  lets the allocation query find free rooms with one indexed scan
--  instead of a GROUP BY over the whole allocation history. The counter
--  is only ever changed inside the same transaction that inserts or
--  releases an allocation row, so it cannot drift.
--
--  `status` is a GENERATED column computed from capacity and
--  occupied_spaces. Because MySQL derives it, it can never contradict
--  them - a class of bug that affects every manually-updated status
--  column.
-- =====================================================================
CREATE TABLE rooms (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  room_number     VARCHAR(20) NOT NULL,
  block_id        INT UNSIGNED NOT NULL,

  -- STEP 4 (Phase 9 pre-work): gender now lives here, not on the
  -- block - see migrations/003_room_gender.sql for why. blocks.gender
  -- is left in place but unused; a block (A/B/C/D) is now just a
  -- capacity grouping and can hold rooms of both genders.
  gender          ENUM('male','female') NOT NULL,

  room_type       ENUM('single','shared') NOT NULL,

  capacity        TINYINT UNSIGNED NOT NULL DEFAULT 1,
  occupied_spaces TINYINT UNSIGNED NOT NULL DEFAULT 0,

  floor           TINYINT UNSIGNED NOT NULL DEFAULT 1,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,

  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- Generated columns are declared last so they only reference columns
  -- already defined above them.
  status          VARCHAR(20) AS (
                    CASE
                      WHEN occupied_spaces = 0          THEN 'vacant'
                      WHEN occupied_spaces < capacity   THEN 'partial'
                      ELSE 'full'
                    END
                  ) STORED,

  -- Cast to SIGNED first. Subtracting one UNSIGNED column from another
  -- raises "BIGINT UNSIGNED value is out of range" in strict mode if the
  -- result would be negative, which would turn a logic bug into a
  -- confusing crash instead of a clear trigger message.
  available_spaces SMALLINT AS (
                    CAST(capacity AS SIGNED) - CAST(occupied_spaces AS SIGNED)
                  ) STORED,

  PRIMARY KEY (id),

  -- STEP 5: scoped to (block_id, gender) instead of room_number alone,
  -- so "R001" can exist once per male section and once per female
  -- section of the same block. See migrations/004_room_number_uniqueness.sql.
  UNIQUE KEY uq_rooms_section_number (block_id, gender, room_number),

  KEY idx_rooms_block             (block_id),
  KEY idx_rooms_status            (status),

  -- The index the allocation query uses. Column order matters: it
  -- filters on type first, then block, then reads availability.
  KEY idx_rooms_allocation        (room_type, block_id, available_spaces),

  -- STEP 4: covers a gender-filtered room search (gender is now the
  -- first, most selective filter since a block can hold both).
  KEY idx_rooms_gender_alloc      (gender, block_id, room_type, available_spaces),

  CONSTRAINT fk_rooms_block
    FOREIGN KEY (block_id) REFERENCES blocks (id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- =====================================================================
--  TABLE 4: applications
--
--  `active_key` is the trick that enforces "one live application per
--  student" AT THE DATABASE LEVEL. MySQL has no partial indexes, so:
--
--    while status is 'pending' or 'approved'  ->  active_key = student_id
--    otherwise                                ->  active_key = NULL
--
--  A UNIQUE index on active_key therefore blocks a second live
--  application, but ignores NULLs, so a rejected student may re-apply.
--
--  Why not just check in JavaScript first? Because two rapid clicks can
--  both pass the check before either row is inserted. The index cannot
--  be raced.
-- =====================================================================
CREATE TABLE applications (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  student_id         INT UNSIGNED NOT NULL,

  room_type          ENUM('single','shared') NOT NULL,
  preferred_block_id INT UNSIGNED DEFAULT NULL,   -- NULL = no preference
  special_request    TEXT,

  status             ENUM('pending','approved','rejected','cancelled')
                       NOT NULL DEFAULT 'pending',

  allocated_room_id  INT UNSIGNED DEFAULT NULL,
  rejection_reason   VARCHAR(255) DEFAULT NULL,

  reviewed_by        INT UNSIGNED DEFAULT NULL,   -- which admin decided
  reviewed_at        DATETIME DEFAULT NULL,

  session_year       VARCHAR(9) NOT NULL DEFAULT '2025/2026',

  applied_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  active_key         INT UNSIGNED AS (
                       CASE WHEN status IN ('pending','approved')
                            THEN student_id ELSE NULL END
                     ) STORED,

  PRIMARY KEY (id),
  UNIQUE KEY uq_active_application (active_key),
  KEY idx_applications_student     (student_id),
  KEY idx_applications_status      (status),
  KEY idx_applications_block       (preferred_block_id),
  KEY idx_applications_room        (allocated_room_id),
  KEY idx_applications_queue       (status, applied_at),

  CONSTRAINT fk_applications_student
    FOREIGN KEY (student_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT fk_applications_block
    FOREIGN KEY (preferred_block_id) REFERENCES blocks (id)
    ON DELETE SET NULL ON UPDATE CASCADE,

  -- RESTRICT: a room that is currently allocated cannot be deleted.
  CONSTRAINT fk_applications_room
    FOREIGN KEY (allocated_room_id) REFERENCES rooms (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,

  CONSTRAINT fk_applications_reviewer
    FOREIGN KEY (reviewed_by) REFERENCES users (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- =====================================================================
--  TABLE 5: allocations
--  The audit trail, and the junction table resolving the many-to-many
--  relationship between students and rooms.
--
--  `applications.allocated_room_id` answers "where is this student now?"
--  This table answers "who has ever occupied this room, and when?" -
--  the question a hostel warden actually asks during a dispute.
-- =====================================================================
CREATE TABLE allocations (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id INT UNSIGNED NOT NULL,
  student_id     INT UNSIGNED NOT NULL,
  room_id        INT UNSIGNED NOT NULL,

  status         ENUM('active','released') NOT NULL DEFAULT 'active',
  allocated_by   INT UNSIGNED DEFAULT NULL,

  allocated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at    DATETIME DEFAULT NULL,
  release_reason VARCHAR(255) DEFAULT NULL,

  -- Same generated-column pattern: a student may have many historical
  -- allocations, but only one ACTIVE one at a time.
  active_key     INT UNSIGNED AS (
                   CASE WHEN status = 'active' THEN student_id ELSE NULL END
                 ) STORED,

  PRIMARY KEY (id),
  UNIQUE KEY uq_active_allocation (active_key),
  KEY idx_allocations_application (application_id),
  KEY idx_allocations_student     (student_id),
  KEY idx_allocations_room        (room_id, status),

  CONSTRAINT fk_allocations_application
    FOREIGN KEY (application_id) REFERENCES applications (id)
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT fk_allocations_student
    FOREIGN KEY (student_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE,

  -- This RESTRICT is what makes "you cannot delete an occupied room"
  -- a database guarantee rather than an application convention.
  CONSTRAINT fk_allocations_room
    FOREIGN KEY (room_id) REFERENCES rooms (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,

  CONSTRAINT fk_allocations_admin
    FOREIGN KEY (allocated_by) REFERENCES users (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- =====================================================================
--  TABLE 6: hostel_fees
--  The authoritative price list. The backend reads the amount from
--  here; the browser never supplies it.
--
--  Changing a fee DEACTIVATES the old row and INSERTS a new one rather
--  than overwriting, so the history of what the hostel charged each
--  session is preserved.
-- =====================================================================
CREATE TABLE hostel_fees (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  room_type    ENUM('single','shared') NOT NULL,

  -- DECIMAL, never FLOAT. Binary floats cannot represent 0.10 exactly,
  -- so summing thousands of fees stored as floats gives a total that is
  -- wrong in the kobo and impossible to reconcile.
  amount       DECIMAL(10,2) NOT NULL,

  currency     CHAR(3) NOT NULL DEFAULT 'NGN',
  session_year VARCHAR(9) NOT NULL DEFAULT '2025/2026',
  active       TINYINT(1) NOT NULL DEFAULT 1,
  updated_by   INT UNSIGNED DEFAULT NULL,

  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- Only one active fee per room type at any moment.
  active_key   VARCHAR(20) AS (
                 CASE WHEN active = 1 THEN room_type ELSE NULL END
               ) STORED,

  PRIMARY KEY (id),
  UNIQUE KEY uq_active_fee   (active_key),
  KEY idx_fees_room_type     (room_type, active),

  CONSTRAINT fk_fees_admin
    FOREIGN KEY (updated_by) REFERENCES users (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- =====================================================================
--  TABLE 7: payments
--
--  NOTE WHAT IS ABSENT: no card number, no CVV, no expiry, no PIN, no
--  OTP. Those are typed on Paystack's own hosted page and never touch
--  this server, which keeps the project outside PCI-DSS scope entirely.
--
--  `amount` is a SNAPSHOT copied from hostel_fees, with no foreign key
--  to it. If the hostel raises the fee next session, last session's
--  receipts must still read the amount that was actually paid. A
--  foreign key would silently rewrite history.
-- =====================================================================
CREATE TABLE payments (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  student_id        INT UNSIGNED NOT NULL,
  application_id    INT UNSIGNED NOT NULL,

  amount            DECIMAL(10,2) NOT NULL,
  currency          CHAR(3) NOT NULL DEFAULT 'NGN',

  payment_reference VARCHAR(80) NOT NULL,        -- ours, sent to the gateway
  gateway_reference VARCHAR(120) DEFAULT NULL,   -- Paystack's own id
  payment_gateway   VARCHAR(30) NOT NULL DEFAULT 'paystack',
  payment_channel   VARCHAR(30) DEFAULT NULL,    -- card / bank / ussd

  status            ENUM('pending','success','failed','abandoned','refunded')
                      NOT NULL DEFAULT 'pending',

  -- Whether OUR server confirmed the transaction with the gateway.
  -- A payment is never trusted because the browser said so.
  verified_at       DATETIME DEFAULT NULL,
  paid_at           DATETIME DEFAULT NULL,

  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- At most ONE successful payment per application. Failed and
  -- abandoned attempts may accumulate freely, which is what a payment
  -- history should show.
  paid_key          INT UNSIGNED AS (
                      CASE WHEN status = 'success' THEN application_id ELSE NULL END
                    ) STORED,

  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_reference (payment_reference),
  UNIQUE KEY uq_paid_application  (paid_key),
  KEY idx_payments_student        (student_id),
  KEY idx_payments_application    (application_id),
  KEY idx_payments_status         (status, created_at),

  -- RESTRICT on both: financial records must not disappear because
  -- somebody deleted a user. That is why users has `is_active` instead.
  CONSTRAINT fk_payments_student
    FOREIGN KEY (student_id) REFERENCES users (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,

  CONSTRAINT fk_payments_application
    FOREIGN KEY (application_id) REFERENCES applications (id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- =====================================================================
--  TABLE 8: sessions
--  Used by express-mysql-session in Phase 4. The library can create
--  this itself, but defining it here means the MySQL user does not
--  need CREATE privileges at runtime, and the schema file describes
--  the whole database.
--
--  Collation must be utf8mb4_bin: session IDs are case-sensitive.
-- =====================================================================
CREATE TABLE sessions (
  session_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
  expires    INT UNSIGNED NOT NULL,
  data       MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (session_id),
  KEY idx_sessions_expires (expires)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;


-- =====================================================================
--  TRIGGERS
--  These replace the CHECK constraints from the Phase 1 design, which
--  MySQL 5.7 accepts and then ignores.
--
--  SIGNAL SQLSTATE '45000' raises a user-defined error. The mysql2
--  driver surfaces it to Node as an Error, and errorMiddleware.js
--  turns it into a clean JSON response.
--
--  These are a BACKSTOP, not the primary control. The application
--  layer checks the same rules first and returns friendly messages.
--  Having both means a bug in our JavaScript still cannot corrupt the
--  data - which is the whole point of putting rules in the database.
-- =====================================================================

DELIMITER $$

-- --- rooms: capacity and occupancy sanity -----------------------------
CREATE TRIGGER trg_rooms_before_insert
BEFORE INSERT ON rooms
FOR EACH ROW
BEGIN
  IF NEW.capacity < 1 OR NEW.capacity > 12 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Room capacity must be between 1 and 12.';
  END IF;

  IF NEW.room_type = 'single' AND NEW.capacity <> 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'A single room must have a capacity of exactly 1.';
  END IF;

  IF NEW.room_type = 'shared' AND NEW.capacity < 2 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'A shared room must have a capacity of at least 2.';
  END IF;

  IF NEW.occupied_spaces > NEW.capacity THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Occupied spaces cannot exceed room capacity.';
  END IF;
END$$

CREATE TRIGGER trg_rooms_before_update
BEFORE UPDATE ON rooms
FOR EACH ROW
BEGIN
  IF NEW.capacity < 1 OR NEW.capacity > 12 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Room capacity must be between 1 and 12.';
  END IF;

  -- THIS IS THE MOST IMPORTANT LINE IN THE FILE.
  -- It is the last line of defence against over-allocation. Even if the
  -- row locking in allocationService.js were wrong, MySQL refuses to
  -- write an occupancy above capacity.
  IF NEW.occupied_spaces > NEW.capacity THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Occupied spaces cannot exceed room capacity.';
  END IF;

  -- Blocks an admin from shrinking a room below the number of students
  -- already living in it.
  IF NEW.capacity < OLD.occupied_spaces THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Capacity cannot be less than the number of students already allocated.';
  END IF;

  IF NEW.room_type = 'single' AND NEW.capacity <> 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'A single room must have a capacity of exactly 1.';
  END IF;
END$$


-- --- users: students need a gender and a student ID -------------------
CREATE TRIGGER trg_users_before_insert
BEFORE INSERT ON users
FOR EACH ROW
BEGIN
  IF NEW.role = 'student' AND (NEW.gender IS NULL) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Gender is required for student accounts.';
  END IF;

  IF NEW.role = 'student' AND (NEW.student_id IS NULL OR NEW.student_id = '') THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Student ID is required for student accounts.';
  END IF;

  -- A plain-text password would be far shorter than a bcrypt hash.
  -- This catches the mistake of forgetting to hash before inserting.
  IF CHAR_LENGTH(NEW.password) < 50 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Password must be stored as a hash, not plain text.';
  END IF;
END$$


-- --- applications: role check only ------------------------------------
-- STEP 4 (Phase 9 pre-work): the gender check that used to live here
-- is gone. A "preferred block" (A/B/C/D) is now a capacity preference
-- only - every block holds both genders (see migrations/003_room_gender
-- .sql) - so it can no longer be validated against a student's gender.
-- Gender is enforced once, at ALLOCATION time (below), against the
-- specific room, which is the point it actually matters.
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


-- --- allocations: the gender rule, again, at the point it matters -----
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

  -- STEP 4: checked against the ROOM directly now, not through a
  -- block join - a block can no longer imply a single gender.
  IF v_room_gender <> v_student_gender THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'A student cannot be allocated to a room of a different gender.';
  END IF;

  -- IMPORTANT FOR PHASE 8: this reads occupied_spaces BEFORE the counter
  -- is incremented, so the allocation transaction must run in this order:
  --
  --     1. SELECT ... FROM rooms WHERE id = ? FOR UPDATE   (take the lock)
  --     2. INSERT INTO allocations ...                      (this trigger runs)
  --     3. UPDATE rooms SET occupied_spaces = occupied_spaces + 1
  --
  -- If steps 2 and 3 were swapped, allocating the LAST space would read
  -- occupied = capacity here and be rejected even though it is valid.
  IF v_occupied >= v_capacity THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'This room is already full.';
  END IF;
END$$


-- --- hostel_fees: amount must be positive -----------------------------
CREATE TRIGGER trg_fees_before_insert
BEFORE INSERT ON hostel_fees
FOR EACH ROW
BEGIN
  IF NEW.amount <= 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Hostel fee must be greater than zero.';
  END IF;
END$$

CREATE TRIGGER trg_fees_before_update
BEFORE UPDATE ON hostel_fees
FOR EACH ROW
BEGIN
  IF NEW.amount <= 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Hostel fee must be greater than zero.';
  END IF;
END$$


-- --- payments: amount must be positive; paid_at implies success -------
CREATE TRIGGER trg_payments_before_insert
BEFORE INSERT ON payments
FOR EACH ROW
BEGIN
  IF NEW.amount <= 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Payment amount must be greater than zero.';
  END IF;
END$$

CREATE TRIGGER trg_payments_before_update
BEFORE UPDATE ON payments
FOR EACH ROW
BEGIN
  -- A payment may only become successful if our server verified it.
  -- This is the database refusing to let a frontend claim of
  -- "payment successful" ever become the truth.
  IF NEW.status = 'success' AND NEW.verified_at IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'A payment cannot be marked successful before it is verified with the gateway.';
  END IF;
END$$

DELIMITER ;


-- =====================================================================
--  VIEWS
--  Read-only convenience for the reports pages. Note the allocation
--  service does NOT use these - it locks the rooms table directly,
--  because you cannot take a row lock through a view reliably.
-- =====================================================================

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


CREATE OR REPLACE VIEW v_application_details AS
SELECT
  a.id                AS application_id,
  a.status,
  a.room_type,
  a.special_request,
  a.rejection_reason,
  a.applied_at,
  a.reviewed_at,
  a.updated_at,
  u.id                AS student_pk,
  u.full_name         AS student_name,
  u.student_id        AS matric_number,
  u.email             AS student_email,
  u.gender            AS student_gender,
  pb.name             AS preferred_block,
  r.room_number       AS allocated_room,
  rb.name             AS allocated_block,
  reviewer.full_name  AS reviewed_by_name
FROM applications a
JOIN users  u          ON u.id  = a.student_id
LEFT JOIN blocks pb    ON pb.id = a.preferred_block_id
LEFT JOIN rooms  r     ON r.id  = a.allocated_room_id
LEFT JOIN blocks rb    ON rb.id = r.block_id
LEFT JOIN users  reviewer ON reviewer.id = a.reviewed_by;


-- =====================================================================
--  SEED DATA
-- =====================================================================

-- --- Blocks: two male, two female -------------------------------------
INSERT INTO blocks (name, gender, description) VALUES
  ('Block A', 'male',   'Male hostel, ground and first floor, single rooms'),
  ('Block B', 'male',   'Male hostel, shared rooms, four bed spaces each'),
  ('Block C', 'female', 'Female hostel, single rooms'),
  ('Block D', 'female', 'Female hostel, shared rooms, four bed spaces each');


-- --- Rooms -------------------------------------------------------------
-- Block A (male, single, capacity 1)
INSERT INTO rooms (room_number, block_id, gender, room_type, capacity, floor) VALUES
  ('A101', 1, 'male', 'single', 1, 1),
  ('A102', 1, 'male', 'single', 1, 1),
  ('A103', 1, 'male', 'single', 1, 1),
  ('A104', 1, 'male', 'single', 1, 1),
  ('A201', 1, 'male', 'single', 1, 2),
  ('A202', 1, 'male', 'single', 1, 2);

-- Block B (male, shared, capacity 4)
INSERT INTO rooms (room_number, block_id, gender, room_type, capacity, floor) VALUES
  ('B101', 2, 'male', 'shared', 4, 1),
  ('B102', 2, 'male', 'shared', 4, 1),
  ('B103', 2, 'male', 'shared', 4, 1),
  ('B201', 2, 'male', 'shared', 4, 2),
  ('B202', 2, 'male', 'shared', 4, 2),
  ('B203', 2, 'male', 'shared', 2, 2);

-- Block C (female, single, capacity 1)
INSERT INTO rooms (room_number, block_id, gender, room_type, capacity, floor) VALUES
  ('C101', 3, 'female', 'single', 1, 1),
  ('C102', 3, 'female', 'single', 1, 1),
  ('C103', 3, 'female', 'single', 1, 1),
  ('C201', 3, 'female', 'single', 1, 2),
  ('C202', 3, 'female', 'single', 1, 2);

-- Block D (female, shared, capacity 4)
INSERT INTO rooms (room_number, block_id, gender, room_type, capacity, floor) VALUES
  ('D101', 4, 'female', 'shared', 4, 1),
  ('D102', 4, 'female', 'shared', 4, 1),
  ('D103', 4, 'female', 'shared', 4, 1),
  ('D201', 4, 'female', 'shared', 4, 2),
  ('D202', 4, 'female', 'shared', 4, 2),
  ('D203', 4, 'female', 'shared', 3, 2);


-- =====================================================================
--  STEP 5 (Phase 9 pre-work): the full 800-room inventory.
--  R001-R100, restarting in each of the 8 block+gender sections. Does
--  NOT touch the 23 legacy rooms just seeded above - see
--  migrations/005_seed_block_rooms.sql for the full rationale (this is
--  the same procedure, included here so a fresh install gets the
--  complete inventory from the start).
-- =====================================================================
DELIMITER $$

DROP PROCEDURE IF EXISTS sp_seed_room_section$$

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

CALL sp_seed_room_section('Block A', 'male',   'single', 1);
CALL sp_seed_room_section('Block A', 'female', 'single', 1);
CALL sp_seed_room_section('Block B', 'male',   'shared', 2);
CALL sp_seed_room_section('Block B', 'female', 'shared', 2);
CALL sp_seed_room_section('Block C', 'male',   'shared', 3);
CALL sp_seed_room_section('Block C', 'female', 'shared', 3);
CALL sp_seed_room_section('Block D', 'male',   'shared', 4);
CALL sp_seed_room_section('Block D', 'female', 'shared', 4);

DROP PROCEDURE IF EXISTS sp_seed_room_section;


-- --- Hostel fees -------------------------------------------------------
INSERT INTO hostel_fees (room_type, amount, currency, session_year, active) VALUES
  ('single', 150000.00, 'NGN', '2025/2026', 1),
  ('shared', 100000.00, 'NGN', '2025/2026', 1);


-- =====================================================================
--  ADMINISTRATOR ACCOUNT
--
--  Deliberately NOT created here.
--
--  A bcrypt hash committed to a .sql file in a public GitHub repository
--  is a published password. Anyone who reads the repo can run the same
--  hash against a wordlist offline, and every project copied from this
--  one would share the same admin credentials.
--
--  Instead, Phase 4 ships backend/scripts/seedAdmin.js, which reads the
--  credentials from .env (which is gitignored), hashes the password at
--  run time, and refuses to run if the password is weak:
--
--      cd backend
--      npm run seed:admin
--
--  Until Phase 4 exists there is no admin account, and no login page to
--  use one with, so nothing is blocked.
-- =====================================================================


-- =====================================================================
--  VERIFICATION
--  These run automatically at the end of the import so you can see the
--  schema loaded correctly.
-- =====================================================================
SELECT 'Database created successfully.' AS status;

SELECT b.name AS block, r.gender, COUNT(r.id) AS rooms,
       SUM(r.capacity) AS total_spaces
FROM blocks b
LEFT JOIN rooms r ON r.block_id = b.id
GROUP BY b.id, b.name, r.gender
ORDER BY b.name, r.gender;

-- STEP 5: grand total across the whole rooms table (23 legacy +
-- 800 new = 823 rooms; the new rooms alone total 2000 beds).
SELECT COUNT(*) AS total_rooms, SUM(capacity) AS total_beds FROM rooms;

SELECT room_type, CONCAT('NGN ', FORMAT(amount, 2)) AS fee
FROM hostel_fees WHERE active = 1;
