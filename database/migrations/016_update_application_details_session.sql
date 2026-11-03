/*
===============================================================================
MIGRATION 016
Name: 016_update_application_details_session

Purpose:
  Extend v_application_details from 17 columns to 19 columns.

Adds:
  18. hostel_session_id
  19. session_label

Scope:
  - v_application_details
  - migration_ledger entries for migration 016

IMPORTANT:
  - This version is for P9B SCRATCH TESTING.
  - DO NOT point this file at live smart_hostel yet.
  - Migrations 011–015 are authoritative and must not be recreated,
    rerun, modified, or rolled back.
===============================================================================
*/

USE smart_hostel_p9b_scratch;


/* ============================================================================
   1. PRE-FLIGHT
   ============================================================================ */

SELECT
    '016 PRE-FLIGHT' AS check_name,
    DATABASE() AS connected_database;


/*
Expected:
  connected_database = smart_hostel_p9b_scratch
*/


/* Expected current view column count = 17 */

SELECT
    COUNT(*) AS existing_view_columns
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'v_application_details';


/* Required session columns must exist */

SELECT
    TABLE_NAME,
    COLUMN_NAME
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND (
        (TABLE_NAME = 'applications'
         AND COLUMN_NAME = 'hostel_session_id')
        OR
        (TABLE_NAME = 'hostel_sessions'
         AND COLUMN_NAME IN ('id', 'label'))
      )
ORDER BY TABLE_NAME, COLUMN_NAME;


/* Migration 016 must not already be applied */

SELECT
    COUNT(*) AS existing_016_entries
FROM migration_ledger
WHERE migration_version = 16
  AND rollback_state = 'applied';


/*
STOP CONDITIONS:

  existing_view_columns MUST equal 17.

  Required columns MUST be present:
    applications.hostel_session_id
    hostel_sessions.id
    hostel_sessions.label

  existing_016_entries MUST equal 0.

If any of these conditions are not satisfied, DO NOT continue.
*/


/* ============================================================================
   2. RECORD MIGRATION START
   ============================================================================ */

INSERT INTO migration_ledger
(
    migration_name,
    migration_version,
    entry_kind,
    applied_by
)
VALUES
(
    '016_update_application_details_session',
    16,
    'run_started',
    USER()
);


/* ============================================================================
   3. REPLACE VIEW
   ============================================================================ */

CREATE OR REPLACE
ALGORITHM=UNDEFINED
DEFINER=`root`@`localhost`
SQL SECURITY DEFINER
VIEW `v_application_details` AS
SELECT
    `a`.`id` AS `application_id`,
    `a`.`status` AS `status`,
    `a`.`room_type` AS `room_type`,
    `a`.`special_request` AS `special_request`,
    `a`.`rejection_reason` AS `rejection_reason`,
    `a`.`applied_at` AS `applied_at`,
    `a`.`reviewed_at` AS `reviewed_at`,
    `a`.`updated_at` AS `updated_at`,
    `u`.`id` AS `student_pk`,
    `u`.`full_name` AS `student_name`,
    `u`.`student_id` AS `matric_number`,
    `u`.`email` AS `student_email`,
    `u`.`gender` AS `student_gender`,
    `pb`.`name` AS `preferred_block`,
    `r`.`room_number` AS `allocated_room`,
    `rb`.`name` AS `allocated_block`,
    `reviewer`.`full_name` AS `reviewed_by_name`,
    `a`.`hostel_session_id` AS `hostel_session_id`,
    `hs`.`label` AS `session_label`
FROM `applications` `a`
JOIN `users` `u`
    ON `u`.`id` = `a`.`student_id`
LEFT JOIN `blocks` `pb`
    ON `pb`.`id` = `a`.`preferred_block_id`
LEFT JOIN `rooms` `r`
    ON `r`.`id` = `a`.`allocated_room_id`
LEFT JOIN `blocks` `rb`
    ON `rb`.`id` = `r`.`block_id`
LEFT JOIN `users` `reviewer`
    ON `reviewer`.`id` = `a`.`reviewed_by`
JOIN `hostel_sessions` `hs`
    ON `hs`.`id` = `a`.`hostel_session_id`;


/* ============================================================================
   4. RECORD EXACT VIEW CHANGE
   ============================================================================ */

INSERT INTO migration_ledger
(
    migration_name,
    migration_version,
    entry_kind,
    object_type,
    object_table,
    object_name,
    row_key,
    before_value,
    after_value,
    applied_by
)
VALUES
(
    '016_update_application_details_session',
    16,
    'changed_row',
    'view',
    'v_application_details',
    'v_application_details',
    'definition',

    'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v_application_details` AS select `a`.`id` AS `application_id`,`a`.`status` AS `status`,`a`.`room_type` AS `room_type`,`a`.`special_request` AS `special_request`,`a`.`rejection_reason` AS `rejection_reason`,`a`.`applied_at` AS `applied_at`,`a`.`reviewed_at` AS `reviewed_at`,`a`.`updated_at` AS `updated_at`,`u`.`id` AS `student_pk`,`u`.`full_name` AS `student_name`,`u`.`student_id` AS `matric_number`,`u`.`email` AS `student_email`,`u`.`gender` AS `student_gender`,`pb`.`name` AS `preferred_block`,`r`.`room_number` AS `allocated_room`,`rb`.`name` AS `allocated_block`,`reviewer`.`full_name` AS `reviewed_by_name` from (((((`applications` `a` join `users` `u` on(`u`.`id` = `a`.`student_id`)) left join `blocks` `pb` on(`pb`.`id` = `a`.`preferred_block_id`)) left join `rooms` `r` on(`r`.`id` = `a`.`allocated_room_id`)) left join `blocks` `rb` on(`rb`.`id` = `r`.`block_id`)) left join `users` `reviewer` on(`reviewer`.`id` = `a`.`reviewed_by`))',

    'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v_application_details` AS select `a`.`id` AS `application_id`,`a`.`status` AS `status`,`a`.`room_type` AS `room_type`,`a`.`special_request` AS `special_request`,`a`.`rejection_reason` AS `rejection_reason`,`a`.`applied_at` AS `applied_at`,`a`.`reviewed_at` AS `reviewed_at`,`a`.`updated_at` AS `updated_at`,`u`.`id` AS `student_pk`,`u`.`full_name` AS `student_name`,`u`.`student_id` AS `matric_number`,`u`.`email` AS `student_email`,`u`.`gender` AS `student_gender`,`pb`.`name` AS `preferred_block`,`r`.`room_number` AS `allocated_room`,`rb`.`name` AS `allocated_block`,`reviewer`.`full_name` AS `reviewed_by_name`,`a`.`hostel_session_id` AS `hostel_session_id`,`hs`.`label` AS `session_label` from `applications` `a` join `users` `u` on(`u`.`id` = `a`.`student_id`) left join `blocks` `pb` on(`pb`.`id` = `a`.`preferred_block_id`) left join `rooms` `r` on(`r`.`id` = `a`.`allocated_room_id`) left join `blocks` `rb` on(`rb`.`id` = `r`.`block_id`) left join `users` `reviewer` on(`reviewer`.`id` = `a`.`reviewed_by`) join `hostel_sessions` `hs` on(`hs`.`id` = `a`.`hostel_session_id`)',

    USER()
);


/* ============================================================================
   5. VERIFY COLUMN COUNT
   ============================================================================ */

SELECT
    COUNT(*) AS new_view_column_count
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'v_application_details';


/* ============================================================================
   6. VERIFY COLUMN ORDER
   ============================================================================ */

SELECT
    ORDINAL_POSITION,
    COLUMN_NAME
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'v_application_details'
ORDER BY ORDINAL_POSITION;


/*
Expected:

  1  application_id
  2  status
  3  room_type
  4  special_request
  5  rejection_reason
  6  applied_at
  7  reviewed_at
  8  updated_at
  9  student_pk
 10  student_name
 11  matric_number
 12  student_email
 13  student_gender
 14  preferred_block
 15  allocated_room
 16  allocated_block
 17  reviewed_by_name
 18  hostel_session_id
 19  session_label
*/


/* ============================================================================
   7. VERIFY ROW COUNT
   ============================================================================ */

SELECT
    (SELECT COUNT(*) FROM applications) AS application_count,
    (SELECT COUNT(*) FROM v_application_details) AS view_count;


/*
Expected:
  application_count = view_count
*/


/* ============================================================================
   8. VERIFY DUPLICATE APPLICATION IDs
   ============================================================================ */

SELECT
    application_id,
    COUNT(*) AS duplicate_count
FROM v_application_details
GROUP BY application_id
HAVING COUNT(*) > 1;


/*
Expected:
  Empty result set.
*/


/* ============================================================================
   9. VERIFY SESSION MAPPING
   ============================================================================ */

SELECT
    COUNT(*) AS session_mismatch_count
FROM v_application_details v
JOIN applications a
    ON a.id = v.application_id
JOIN hostel_sessions hs
    ON hs.id = a.hostel_session_id
WHERE v.hostel_session_id <> a.hostel_session_id
   OR v.session_label <> hs.label;


/*
Expected:
  session_mismatch_count = 0
*/


/* ============================================================================
   10. VERIFY ACTUAL SESSION VALUES
   ============================================================================ */

SELECT
    application_id,
    hostel_session_id,
    session_label
FROM v_application_details
ORDER BY application_id;


/* ============================================================================
   11. VERIFY DEFINER AND SECURITY TYPE
   ============================================================================ */

SELECT
    DEFINER,
    SECURITY_TYPE
FROM information_schema.VIEWS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'v_application_details';


/*
Expected:
  DEFINER       = root@localhost
  SECURITY_TYPE = DEFINER
*/


/* ============================================================================
   12. VERIFY FINAL VIEW DEFINITION
   ============================================================================ */

SHOW CREATE VIEW v_application_details\G


/* ============================================================================
   13. RECORD MIGRATION COMPLETION
   ============================================================================ */

INSERT INTO migration_ledger
(
    migration_name,
    migration_version,
    entry_kind,
    applied_by
)
VALUES
(
    '016_update_application_details_session',
    16,
    'run_completed',
    USER()
);


/* ============================================================================
   14. FINAL MIGRATION LEDGER CHECK
   ============================================================================ */

SELECT
    id,
    migration_name,
    migration_version,
    entry_kind,
    object_type,
    object_table,
    object_name,
    row_key,
    rollback_state
FROM migration_ledger
WHERE migration_version = 16
ORDER BY id;


/*
Expected 016 ledger entries:

  run_started
  changed_row
  run_completed
*/


/* ============================================================================
   END MIGRATION 016
===============================================================================
*/