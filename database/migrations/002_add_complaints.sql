-- =====================================================================
--  database/migrations/002_add_complaints.sql
--  ---------------------------------------------------------------------
--  PHASE 8d - adds the `complaints` table to an EXISTING smart_hostel
--  database. This is the file to run against your live database.
--
--  DO NOT re-run database/hostel.sql to get this table - hostel.sql
--  starts with DROP DATABASE IF EXISTS and would destroy every student,
--  application, allocation and room-occupancy change you have made
--  while testing Phases 4 through 8c.
--
--  This script only ever ADDS. It does not touch any existing table,
--  row, or column. Run it once with:
--
--      mysql -u root -p smart_hostel < database/migrations/002_add_complaints.sql
--
--  CREATE TABLE IF NOT EXISTS makes it safe to run a second time by
--  accident - it will not error and will not duplicate anything.
--
--  hostel.sql (the master schema file) has ALSO been updated to
--  include this same table, purely so that a FRESH install on a
--  different machine gets it from the start. That copy is for a new
--  install only - it is not what you should run against your current
--  database.
-- =====================================================================

USE smart_hostel;

-- ---------------------------------------------------------------------
--  complaints
--  ---------------------------------------------------------------------
--  category is a plain VARCHAR, not an ENUM. The brief is explicit that
--  complaints must not be restricted to a fixed list of examples
--  (electricity, water, plumbing, ...) - an ENUM would do exactly that,
--  silently rejecting a legitimate complaint type nobody thought to
--  list in advance. The frontend offers the examples as suggestions
--  (an HTML <datalist>), not as a closed set.
--
--  allocation_id links a complaint to the specific stay it concerns -
--  which room, in which block, during which allocation - rather than
--  just a room number, which would not distinguish between two
--  different students' time in the same room. It is NULLABLE: a
--  student may have a complaint before ever being allocated a room
--  (e.g. about the application process itself), so an allocation is
--  attached when one exists and left NULL otherwise. The backend derives
--  this from the student's own active allocation server-side - it is
--  never a value the client sends (see controllers/complaintController.js).
--
--  status has three states, matching the brief exactly:
--  open -> in_progress -> resolved. No student ever sets this column;
--  only PUT /api/admin/complaints/:id (Phase 8d, admin-only) can.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS complaints (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  student_id     INT UNSIGNED NOT NULL,
  allocation_id  INT UNSIGNED DEFAULT NULL,

  category       VARCHAR(50) NOT NULL,
  subject        VARCHAR(150) NOT NULL,
  description    TEXT NOT NULL,

  status         ENUM('open', 'in_progress', 'resolved') NOT NULL DEFAULT 'open',

  admin_reply    TEXT DEFAULT NULL,
  replied_by     INT UNSIGNED DEFAULT NULL,
  replied_at     DATETIME DEFAULT NULL,
  resolved_at    DATETIME DEFAULT NULL,

  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_complaints_student     (student_id),
  KEY idx_complaints_status      (status),
  KEY idx_complaints_allocation  (allocation_id),

  CONSTRAINT fk_complaints_student
    FOREIGN KEY (student_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE,

  -- SET NULL, not RESTRICT or CASCADE: an allocation ending (a student
  -- moving out, a room being reassigned) should not delete complaint
  -- history, and nothing currently deletes an allocations row anyway -
  -- this mirrors applications.reviewed_by's existing SET NULL pattern
  -- for an optional, historical reference.
  CONSTRAINT fk_complaints_allocation
    FOREIGN KEY (allocation_id) REFERENCES allocations (id)
    ON DELETE SET NULL ON UPDATE CASCADE,

  CONSTRAINT fk_complaints_replied_by
    FOREIGN KEY (replied_by) REFERENCES users (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT 'complaints table created (or already existed).' AS status;
SELECT COUNT(*) AS existing_complaints FROM complaints;
-- Phase 8d: Student complaints
-- Safe migration: creates only the complaints table.
-- DO NOT use database/hostel.sql for this change because that
-- file recreates the database.

CREATE TABLE IF NOT EXISTS complaints (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    student_id INT UNSIGNED NOT NULL,
    allocation_id INT UNSIGNED NULL,
    category VARCHAR(100) NOT NULL,
    subject VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    status ENUM('open', 'in_progress', 'resolved') NOT NULL DEFAULT 'open',
    admin_reply TEXT NULL,
    replied_by INT UNSIGNED NULL,
    replied_at DATETIME NULL,
    resolved_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),

    KEY idx_complaints_student (student_id),
    KEY idx_complaints_allocation (allocation_id),
    KEY idx_complaints_status (status),
    KEY idx_complaints_replied_by (replied_by),

    CONSTRAINT fk_complaints_student
        FOREIGN KEY (student_id)
        REFERENCES users(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_complaints_allocation
        FOREIGN KEY (allocation_id)
        REFERENCES allocations(id)
        ON DELETE SET NULL,

    CONSTRAINT fk_complaints_replied_by
        FOREIGN KEY (replied_by)
        REFERENCES users(id)
        ON DELETE SET NULL
);
