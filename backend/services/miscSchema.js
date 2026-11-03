/**
 * services/miscSchema.js
 * ---------------------------------------------------------------
 * Fail-closed guard for the miscellaneous-charge feature.
 * Mirrors services/paymentSchema.js: inspects information_schema ONCE (read-only,
 * cached) and refuses with 503 - never guesses - when the database lacks what
 * migrations 014 / 017 / 020 are reported to have created:
 *
 *   hostel_misc_charges: name, description, amount, currency, is_required, is_active,
 *                        hostel_session_id, block_id, created_by, deadline_at, late_fine_amount
 *   payments:            payment_type, hostel_misc_charge_id, original_amount,
 *                        late_fine_applied, and hostel_fee_id NULLABLE
 *
 * No schema change is made or required by this feature.
 * ---------------------------------------------------------------
 */

const ApiError = require('../utils/ApiError');

const CHARGE_COLUMNS = [
  'id', 'hostel_session_id', 'block_id', 'name', 'description', 'amount', 'currency',
  'is_required', 'is_active', 'created_by', 'deadline_at', 'late_fine_amount',
];
const PAYMENT_COLUMNS = [
  'payment_type', 'hostel_misc_charge_id', 'original_amount', 'late_fine_applied',
];

let cached = null;

async function assertMiscSchema(conn) {
  if (cached) return cached;
  const [rows] = await conn.execute(
    `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, IS_NULLABLE AS is_nullable
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('hostel_misc_charges', 'payments')`
  );
  const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  const missing = [
    ...CHARGE_COLUMNS.filter((c) => !have.has(`hostel_misc_charges.${c}`)).map((c) => `hostel_misc_charges.${c}`),
    ...PAYMENT_COLUMNS.filter((c) => !have.has(`payments.${c}`)).map((c) => `payments.${c}`),
  ];
  const feeLink = rows.find((r) => r.table_name === 'payments' && r.column_name === 'hostel_fee_id');
  if (!feeLink || String(feeLink.is_nullable).toUpperCase() !== 'YES') missing.push('payments.hostel_fee_id (must be nullable)');
  if (missing.length > 0) {
    console.error(`[misc-charges] schema incomplete (migrations 014/017/020 not applied?): ${missing.join(', ')}`);
    throw new ApiError(503, 'Miscellaneous charges are temporarily unavailable. Please contact the hostel administration.');
  }
  cached = { ok: true };
  return cached;
}

function resetMiscSchemaCache() { cached = null; } // tests only

module.exports = { assertMiscSchema, resetMiscSchemaCache };
