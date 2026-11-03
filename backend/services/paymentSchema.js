/**
 * services/paymentSchema.js
 * ---------------------------------------------------------------
 * The one place that inspects the shape of the payments table, shared by
 * paymentService.js and paymentGate.js (moved out of paymentService.js
 * unchanged, so the same SQL runs and nothing is duplicated).
 *
 * - If any migration-013 column is missing the callers must refuse to run
 *   (503), never guess.
 * - Migration 017 columns (payment_type, ...) are used when, and only when,
 *   they exist ("typed"). Checked once and cached.
 * ---------------------------------------------------------------
 */

const ApiError = require('../utils/ApiError');

const REQUIRED_COLUMNS = [
  'student_id', 'application_id', 'hostel_session_id', 'hostel_fee_id', 'amount', 'currency',
  'payment_reference', 'gateway_reference', 'payment_gateway', 'payment_channel',
  'status', 'verified_at', 'paid_at',
];
const MIGRATION_017_COLUMNS = ['payment_type', 'original_amount', 'late_fine_applied'];

let cachedSchema = null;

async function getPaymentsSchema(conn) {
  if (cachedSchema) return cachedSchema;
  const [rows] = await conn.execute(
    `SELECT COLUMN_NAME AS column_name
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments'`
  );
  const have = new Set(rows.map((r) => r.column_name));
  const missing = REQUIRED_COLUMNS.filter((c) => !have.has(c));
  if (missing.length > 0) {
    console.error(`[payments] payments table is missing columns: ${missing.join(', ')} (migration 013 not applied?)`);
    throw new ApiError(503, 'Online payment is temporarily unavailable. Please contact the hostel administration.');
  }
  cachedSchema = { typed: MIGRATION_017_COLUMNS.every((c) => have.has(c)) };
  return cachedSchema;
}

function resetSchemaCache() { cachedSchema = null; } // tests only

module.exports = { getPaymentsSchema, resetSchemaCache, REQUIRED_COLUMNS, MIGRATION_017_COLUMNS };
