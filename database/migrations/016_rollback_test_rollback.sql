USE smart_hostel_016_rollback_scratch;

SELECT
    '016 ROLLBACK PRE-FLIGHT' AS check_name,
    DATABASE() AS connected_database;

SELECT
    COUNT(*) AS current_view_columns
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'v_application_details';

SELECT
    COUNT(*) AS active_016_entries
FROM migration_ledger
WHERE migration_version = 16
  AND rollback_state = 'applied';

SELECT
    entry_kind,
    object_type,
    object_table,
    object_name,
    row_key
FROM migration_ledger
WHERE migration_version = 16
  AND rollback_state = 'applied'
ORDER BY id;


/*
Restore the exact pre-016 view definition.
*/

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
    `reviewer`.`full_name` AS `reviewed_by_name`
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
    ON `reviewer`.`id` = `a`.`reviewed_by`;


/*
Verify the restored view.
*/

SELECT
    COUNT(*) AS restored_view_columns
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'v_application_details';

SELECT
    ORDINAL_POSITION,
    COLUMN_NAME
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'v_application_details'
ORDER BY ORDINAL_POSITION;

SELECT
    (SELECT COUNT(*) FROM applications) AS application_count,
    (SELECT COUNT(*) FROM v_application_details) AS view_count;

SELECT
    application_id,
    COUNT(*) AS duplicate_count
FROM v_application_details
GROUP BY application_id
HAVING COUNT(*) > 1;

SHOW CREATE VIEW v_application_details\G;


/*
Mark the existing 016 migration entries as rolled back.
*/

UPDATE migration_ledger
SET
    rollback_state = 'rolled_back',
    rolled_back_at = CURRENT_TIMESTAMP,
    rolled_back_by = USER()
WHERE migration_version = 16
  AND rollback_state = 'applied';


/*
Record the rollback event.
*/

INSERT INTO migration_ledger
(
    migration_name,
    migration_version,
    entry_kind,
    applied_by,
    rollback_state,
    rolled_back_at,
    rolled_back_by
)
VALUES
(
    '016_update_application_details_session',
    16,
    'run_rolled_back',
    USER(),
    'rolled_back',
    CURRENT_TIMESTAMP,
    USER()
);


/*
Final rollback verification.
*/

SELECT
    id,
    migration_name,
    migration_version,
    entry_kind,
    object_type,
    object_table,
    object_name,
    row_key,
    rollback_state,
    rolled_back_at,
    rolled_back_by
FROM migration_ledger
WHERE migration_version = 16
ORDER BY id;