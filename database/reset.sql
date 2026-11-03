-- =====================================================================
--  database/reset.sql
--  ---------------------------------------------------------------------
--  Clears the data you generated while testing, but KEEPS the schema,
--  the blocks, the rooms and the fee settings.
--
--  Use this before your project defence so you can walk through the
--  whole workflow (register -> apply -> approve -> pay) on a clean
--  system without re-importing hostel.sql and losing your admin account.
--
--      mysql -u root -p smart_hostel < database/reset.sql
--
--  What it does NOT delete:
--    - admin accounts        (you would have to run seed:admin again)
--    - blocks, rooms, fees   (your configuration)
--
--  WARNING: this deletes every student account, application, allocation,
--  complaint and payment record. Do not run it on anything you want to keep.
-- =====================================================================

USE smart_hostel;

-- Foreign keys are switched off for the duration because the tables
-- reference each other in a cycle (payments -> applications -> rooms,
-- allocations -> rooms). Deleting in any single order would violate one
-- constraint or another.
SET FOREIGN_KEY_CHECKS = 0;

TRUNCATE TABLE payments;
TRUNCATE TABLE complaints;
TRUNCATE TABLE allocations;
TRUNCATE TABLE applications;

-- Student accounts only. Admins survive.
DELETE FROM users WHERE role = 'student';

-- Log everyone out.
TRUNCATE TABLE sessions;

SET FOREIGN_KEY_CHECKS = 1;

-- Put every room back to empty. The `status` and `available_spaces`
-- columns are generated, so MySQL recalculates them automatically -
-- there is nothing else to reset.
UPDATE rooms SET occupied_spaces = 0;

-- Restart ID numbering so the demo shows Application #1, not #47.
ALTER TABLE applications  AUTO_INCREMENT = 1;
ALTER TABLE allocations   AUTO_INCREMENT = 1;
ALTER TABLE complaints    AUTO_INCREMENT = 1;
ALTER TABLE payments      AUTO_INCREMENT = 1;

SELECT 'Test data cleared. Blocks, rooms, fees and admin accounts kept.' AS status;

SELECT
  (SELECT COUNT(*) FROM users WHERE role = 'student') AS students,
  (SELECT COUNT(*) FROM users WHERE role = 'admin')   AS admins,
  (SELECT COUNT(*) FROM applications)                 AS applications,
  (SELECT COUNT(*) FROM complaints)                   AS complaints,
  (SELECT COUNT(*) FROM payments)                     AS payments,
  (SELECT COUNT(*) FROM rooms)                        AS rooms,
  (SELECT SUM(occupied_spaces) FROM rooms)            AS occupied_spaces;
