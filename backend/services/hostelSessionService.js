/**
 * services/hostelSessionService.js
 * ---------------------------------------------------------------
 * The single place the backend asks "which hostel session
 * is current?". Not to be confused with config/session.js, which is
 * the Express LOGIN session store.
 *
 * Reads the canonical table (database: hostel_sessions):
 *   id, label, status ('upcoming'|'open'|'closed'|'archived'),
 *   starts_on, ends_on, is_current, current_key.
 *
 * The database guarantees (CHECK ck_hs_current_iff_open and the unique
 * key on current_key) that at most one session is open and current, and
 * that "current" and "open" always go together. Nothing here hard-codes
 * a label: when an admin opens the next session, this simply returns it.
 * ---------------------------------------------------------------
 */

const ApiError = require('../utils/ApiError');

/**
 * The current, open hostel session.
 *
 * LOCK IN SHARE MODE: inside the caller's transaction this blocks a
 * concurrent "close/open session" UPDATE until the caller commits, so a
 * student cannot apply into a session that is being closed at that very
 * moment. (MariaDB 10.4 syntax; "FOR SHARE" is MySQL 8 only.)
 *
 * @param {object} conn - a connection from withTransaction()
 * @returns {Promise<{id: number, label: string}>}
 * @throws {ApiError} 409 when no session is currently open
 */
async function getCurrentSession(conn) {
  const [rows] = await conn.execute(
    `SELECT id, label
       FROM hostel_sessions
      WHERE is_current = 1 AND status = 'open'
      LIMIT 1
      LOCK IN SHARE MODE`
  );

  if (!rows[0]) {
    throw ApiError.conflict(
      'No hostel session is currently open. Please contact the hostel administration.'
    );
  }

  return rows[0];
}

module.exports = { getCurrentSession };
