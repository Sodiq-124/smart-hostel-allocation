/**
 * services/renewalSchema.js
 * ---------------------------------------------------------------
 * Fail-closed guard for renewal / forfeiture. Same idea as
 * miscSchema.js: inspects information_schema ONCE (read-only, cached) and
 * refuses with 503 - never guesses - when the database lacks what migrations
 * 015 and 022 create:
 *
 *   hostel_renewals: id, student_id, previous_allocation_id, previous_session_id,
 *                    new_session_id, new_application_id, type, status, reason,
 *                    processed_by, processed_at, active_key      (015 + 022)
 *   hostel_sessions: renewal_deadline_at                          (022)
 *
 * It also reports (does not require) whether applications.fee_block_id exists
 * (migration 019), so approving a renewal can confirm the fee block when the
 * column is there and still work on a database where 019 is not applied.
 * ---------------------------------------------------------------
 */

const ApiError = require('../utils/ApiError');

const RENEWAL_COLUMNS = [
  'id', 'student_id', 'previous_allocation_id', 'previous_session_id', 'new_session_id',
  'new_application_id', 'type', 'status', 'reason', 'processed_by', 'processed_at', 'active_key',
];

let cached = null;

async function assertRenewalSchema(conn) {
  if (cached) return cached;
  const [rows] = await conn.execute(
    `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('hostel_renewals', 'hostel_sessions', 'applications')`
  );
  const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  const missing = [
    ...RENEWAL_COLUMNS.filter((c) => !have.has(`hostel_renewals.${c}`)).map((c) => `hostel_renewals.${c}`),
    ...(have.has('hostel_sessions.renewal_deadline_at') ? [] : ['hostel_sessions.renewal_deadline_at']),
  ];
  if (missing.length > 0) {
    console.error(`[renewals] schema incomplete (migrations 015 / 022 not applied?): ${missing.join(', ')}`);
    throw new ApiError(503, 'Hostel renewal is temporarily unavailable. Please contact the hostel administration.');
  }
  cached = { ok: true, feeBlock: have.has('applications.fee_block_id') };
  return cached;
}

function resetRenewalSchemaCache() { cached = null; } // tests only

module.exports = { assertRenewalSchema, resetRenewalSchemaCache };
