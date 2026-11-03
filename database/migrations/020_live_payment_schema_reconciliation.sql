/*
  Migration 020: Live payment-schema reconciliation
  Target: select the database manually when executing.
  Tested first against: smart_hostel_scratch
  Requires: MariaDB 10.4+
  Does not delete application, allocation, payment, fee, or session rows.

  IMPORTANT:
  - Review before execution.
  - DDL may commit independently in MariaDB.
  - The procedure checks for existing columns, indexes, and constraints.
*/

DELIMITER //

DROP PROCEDURE IF EXISTS apply_migration_020//

CREATE PROCEDURE apply_migration_020()
BEGIN
    DECLARE v_count INT DEFAULT 0;
    DECLARE v_has_ledger INT DEFAULT 0;

    IF DATABASE() IS NULL THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Migration 020 stopped: no database selected';
    END IF;

    IF DATABASE() <> 'smart_hostel_scratch' THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Migration 020 stopped: unexpected database';
    END IF;

    SELECT COUNT(*) INTO v_count
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME IN (
          'applications', 'blocks', 'payments',
          'hostel_misc_charges', 'hostel_fees'
      );

    IF v_count <> 5 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Migration 020 stopped: required tables are missing';
    END IF;

    /*
      G. Ledger. Record completion only after all preceding operations succeed.
    */
    SELECT COUNT(*) INTO v_has_ledger
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'migration_ledger';

    IF v_has_ledger > 0 THEN
        INSERT INTO migration_ledger
            (migration_name, migration_version, entry_kind, applied_by)
        SELECT '020_live_payment_schema_reconciliation', 20,
               'run_started', USER()
        WHERE NOT EXISTS (
            SELECT 1 FROM migration_ledger
            WHERE migration_name = '020_live_payment_schema_reconciliation'
              AND entry_kind = 'run_started'
        );
    END IF;


    /*
      A. Application fee block.
      Existing applications are deliberately not backfilled.
    */
    SELECT COUNT(*) INTO v_count
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'applications'
      AND COLUMN_NAME = 'fee_block_id';

    IF v_count = 0 THEN
        ALTER TABLE applications
            ADD COLUMN fee_block_id INT UNSIGNED NULL
            AFTER preferred_block_id;
    END IF;

    SELECT COUNT(*) INTO v_count
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'applications'
      AND INDEX_NAME = 'idx_applications_fee_block';

    IF v_count = 0 THEN
        ALTER TABLE applications
            ADD KEY idx_applications_fee_block (fee_block_id);
    END IF;

    SELECT COUNT(*) INTO v_count
    FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'applications'
      AND CONSTRAINT_NAME = 'fk_applications_fee_block'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY';

    IF v_count = 0 THEN
        ALTER TABLE applications
            ADD CONSTRAINT fk_applications_fee_block
            FOREIGN KEY (fee_block_id) REFERENCES blocks(id)
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    /*
      B. Miscellaneous-charge deadline and late fine.
    */
    SELECT COUNT(*) INTO v_count
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'hostel_misc_charges'
      AND COLUMN_NAME = 'deadline_at';

    IF v_count = 0 THEN
        ALTER TABLE hostel_misc_charges
            ADD COLUMN deadline_at DATETIME NULL;
    END IF;

    SELECT COUNT(*) INTO v_count
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'hostel_misc_charges'
      AND COLUMN_NAME = 'late_fine_amount';

    IF v_count = 0 THEN
        ALTER TABLE hostel_misc_charges
            ADD COLUMN late_fine_amount DECIMAL(10,2)
            NOT NULL DEFAULT 0.00;
    END IF;

    SELECT COUNT(*) INTO v_count
    FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'hostel_misc_charges'
      AND CONSTRAINT_NAME = 'ck_misc_charges_fine';

    IF v_count = 0 THEN
        ALTER TABLE hostel_misc_charges
            ADD CONSTRAINT ck_misc_charges_fine
            CHECK (late_fine_amount >= 0);
    END IF;

    /*
      C. Payment-type and amount-breakdown fields.
    */
    SELECT COUNT(*) INTO v_count
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'payments'
      AND COLUMN_NAME = 'payment_type';

    IF v_count = 0 THEN
        ALTER TABLE payments
            ADD COLUMN payment_type
            ENUM('hostel','miscellaneous')
            NOT NULL DEFAULT 'hostel';
    END IF;

    SELECT COUNT(*) INTO v_count
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'payments'
      AND COLUMN_NAME = 'hostel_misc_charge_id';

    IF v_count = 0 THEN
        ALTER TABLE payments
            ADD COLUMN hostel_misc_charge_id INT UNSIGNED NULL;
    END IF;

    SELECT COUNT(*) INTO v_count
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'payments'
      AND COLUMN_NAME = 'original_amount';

    IF v_count = 0 THEN
        ALTER TABLE payments
            ADD COLUMN original_amount DECIMAL(10,2)
            NOT NULL DEFAULT 0.00;
    END IF;

    SELECT COUNT(*) INTO v_count
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'payments'
      AND COLUMN_NAME = 'late_fine_applied';

    IF v_count = 0 THEN
        ALTER TABLE payments
            ADD COLUMN late_fine_applied DECIMAL(10,2)
            NOT NULL DEFAULT 0.00;
    END IF;

    /*
      Preserve the recorded payment amount as the original amount for
      existing hostel payments whose new amount-breakdown field is unset.
    */
    UPDATE payments
    SET original_amount = amount
    WHERE payment_type = 'hostel'
      AND original_amount = 0
      AND amount <> 0;

    /*
      The fee link must be nullable for miscellaneous payments.
    */
    SELECT COUNT(*) INTO v_count
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'payments'
      AND COLUMN_NAME = 'hostel_fee_id'
      AND IS_NULLABLE = 'NO';

    IF v_count > 0 THEN
        ALTER TABLE payments
            MODIFY COLUMN hostel_fee_id INT UNSIGNED NULL;
    END IF;

    /*
      D. Payment amount and type/link constraints.
    */
    SELECT COUNT(*) INTO v_count
    FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'payments'
      AND CONSTRAINT_NAME = 'ck_payments_amount_breakdown';

    IF v_count = 0 THEN
        ALTER TABLE payments
            ADD CONSTRAINT ck_payments_amount_breakdown
            CHECK (amount = original_amount + late_fine_applied);
    END IF;

    SELECT COUNT(*) INTO v_count
    FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'payments'
      AND CONSTRAINT_NAME = 'ck_payments_type_links';

    IF v_count = 0 THEN
        ALTER TABLE payments
            ADD CONSTRAINT ck_payments_type_links
            CHECK (
                (
                    payment_type = 'hostel'
                    AND hostel_fee_id IS NOT NULL
                    AND hostel_misc_charge_id IS NULL
                    AND late_fine_applied = 0
                )
                OR
                (
                    payment_type = 'miscellaneous'
                    AND hostel_fee_id IS NULL
                    AND hostel_misc_charge_id IS NOT NULL
                )
            );
    END IF;

    /*
      E. Miscellaneous-charge index and foreign key.
    */
    SELECT COUNT(*) INTO v_count
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'payments'
      AND INDEX_NAME = 'idx_payments_misc_charge';

    IF v_count = 0 THEN
        ALTER TABLE payments
            ADD KEY idx_payments_misc_charge (hostel_misc_charge_id);
    END IF;

    SELECT COUNT(*) INTO v_count
    FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'payments'
      AND CONSTRAINT_NAME = 'fk_payments_misc_charge'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY';

    IF v_count = 0 THEN
        ALTER TABLE payments
            ADD CONSTRAINT fk_payments_misc_charge
            FOREIGN KEY (hostel_misc_charge_id)
            REFERENCES hostel_misc_charges(id)
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    /*
      F. Replace the legacy successful-payment uniqueness design.
      Drop the old unique index before dropping its generated column.
    */
    SELECT COUNT(*) INTO v_count
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'payments'
      AND INDEX_NAME = 'uq_paid_application';

    IF v_count > 0 THEN
        ALTER TABLE payments DROP INDEX uq_paid_application;
    END IF;

    SELECT COUNT(*) INTO v_count
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'payments'
      AND COLUMN_NAME = 'paid_key';

    IF v_count > 0 THEN
        ALTER TABLE payments DROP COLUMN paid_key;
    END IF;

    SELECT COUNT(*) INTO v_count
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'payments'
      AND COLUMN_NAME = 'hostel_paid_key';

    IF v_count = 0 THEN
        ALTER TABLE payments
            ADD COLUMN hostel_paid_key VARCHAR(255)
            GENERATED ALWAYS AS (
                CASE
                    WHEN status = 'success'
                     AND payment_type = 'hostel'
                    THEN CONCAT('H:', application_id, ':', hostel_session_id)
                    ELSE NULL
                END
            ) STORED;
    END IF;

    SELECT COUNT(*) INTO v_count
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'payments'
      AND COLUMN_NAME = 'misc_paid_key';

    IF v_count = 0 THEN
        ALTER TABLE payments
            ADD COLUMN misc_paid_key VARCHAR(255)
            GENERATED ALWAYS AS (
                CASE
                    WHEN status = 'success'
                     AND payment_type = 'miscellaneous'
                     AND hostel_misc_charge_id IS NOT NULL
                    THEN CONCAT(
                        'M:', application_id, ':',
                        hostel_session_id, ':', hostel_misc_charge_id
                    )
                    ELSE NULL
                END
            ) STORED;
    END IF;

    SELECT COUNT(*) INTO v_count
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'payments'
      AND INDEX_NAME = 'uq_successful_hostel_payment';

    IF v_count = 0 THEN
        ALTER TABLE payments
            ADD UNIQUE KEY uq_successful_hostel_payment (hostel_paid_key);
    END IF;

    SELECT COUNT(*) INTO v_count
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'payments'
      AND INDEX_NAME = 'uq_successful_misc_payment';

    IF v_count = 0 THEN
        ALTER TABLE payments
            ADD UNIQUE KEY uq_successful_misc_payment (misc_paid_key);
    END IF;

    /* Record completion only after all schema changes succeed. */
    SELECT COUNT(*) INTO v_has_ledger
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'migration_ledger';

    IF v_has_ledger > 0 THEN
        INSERT INTO migration_ledger
            (migration_name, migration_version, entry_kind, applied_by)
        SELECT '020_live_payment_schema_reconciliation', 20,
               'run_completed', USER()
        WHERE NOT EXISTS (
            SELECT 1 FROM migration_ledger
            WHERE migration_name = '020_live_payment_schema_reconciliation'
              AND entry_kind = 'run_completed'
        );
    END IF;
END//

DELIMITER ;

CALL apply_migration_020();

DROP PROCEDURE IF EXISTS apply_migration_020;

SELECT '020 procedure completed; verify every object before proceeding'
    AS migration_status;
