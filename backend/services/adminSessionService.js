/**
 * services/adminSessionService.js
 * ---------------------------------------------------------------
 * Admin management of hostel sessions
 * (table: hostel_sessions; columns id, label, status, starts_on,
 * ends_on, is_current, created_at, updated_at, current_key).
 *
 * Not to be confused with hostelSessionService.js, which only answers
 * "which session is current?" for the student/payment code paths and is
 * left untouched.
 *
 * Rules enforced HERE, in a transaction, not assumed from the database
 * -----------------------------------------------------------------
 * The trigger/constraint state of a given database must not be assumed
 * (migration 010 may or may not have been applied there), so every rule
 * is checked in code. If the database also enforces them (010's
 * triggers, ck_hs_current_iff_open, uq_hostel_sessions_current), that is
 * a second, independent safety net; any violation it reports surfaces
 * as a 409 through middleware/errorMiddleware.js.
 *
 *  - Label: YYYY/YYYY with consecutive years (utils/sessionRules.js).
 *  - Dates: optional, end >= start.
 *  - Create: always 'upcoming', never current; the label must be unused
 *    and later than every existing session (no back-dated sessions).
 *  - Open:   only 'upcoming' -> 'open'; refused while ANY session is
 *    open/current; refused if an earlier upcoming session is still
 *    waiting (sessions are opened in order).
 *  - Close:  only 'open' -> 'closed'.
 *  - There is no archive, delete or edit operation. Closing changes the
 *    session row only: no application, allocation, fee or payment row is
 *    touched.
 *
 * Concurrency: each write transaction first locks every hostel_sessions
 * row (SELECT ... FOR UPDATE; the table holds a handful of rows), so two
 * admins opening/closing/creating at once are serialised and the second
 * re-validates against committed state.
 * ---------------------------------------------------------------
 */

const { pool, withTransaction } = require('../config/database');
const ApiError = require('../utils/ApiError');
const { parseSessionLabel, validateSessionDates } = require('../utils/sessionRules');

// The counts are read-only context so an admin can see what a close affects.
const SESSION_SELECT = `
  SELECT s.id, s.label, s.status, s.starts_on, s.ends_on, s.is_current,
         s.created_at, s.updated_at,
         (SELECT COUNT(*) FROM applications a
           WHERE a.hostel_session_id = s.id) AS applications_total,
         (SELECT COUNT(*) FROM applications a
           WHERE a.hostel_session_id = s.id AND a.status = 'pending') AS applications_pending,
         (SELECT COUNT(*) FROM applications a
           WHERE a.hostel_session_id = s.id AND a.status = 'approved'
             AND a.allocated_room_id IS NULL) AS applications_awaiting_room,
         (SELECT COUNT(*) FROM allocations al
           WHERE al.hostel_session_id = s.id AND al.status = 'active') AS active_allocations
    FROM hostel_sessions s
`;

function toSession(row) {
  return {
    id: row.id,
    label: row.label,
    status: row.status,
    is_current: Number(row.is_current) === 1,
    starts_on: row.starts_on || null,
    ends_on: row.ends_on || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    applications_total: Number(row.applications_total),
    applications_pending: Number(row.applications_pending),
    applications_awaiting_room: Number(row.applications_awaiting_room),
    active_allocations: Number(row.active_allocations),
  };
}

async function loadSession(conn, id) {
  const [rows] = await conn.execute(`${SESSION_SELECT} WHERE s.id = ?`, [id]);
  return rows[0] ? toSession(rows[0]) : null;
}

/** Locks every session row; the table is tiny and this serialises all writers. */
async function lockAllSessions(conn) {
  const [rows] = await conn.execute(
    `SELECT id, label, status, is_current FROM hostel_sessions ORDER BY label FOR UPDATE`
  );
  return rows;
}

function startYearOf(label) {
  return Number(String(label).slice(0, 4));
}

/** GET /api/admin/sessions - newest first. */
async function listSessions() {
  const [rows] = await pool.execute(`${SESSION_SELECT} ORDER BY s.label DESC`);
  return rows.map(toSession);
}

/**
 * GET /api/admin/sessions/current - the open, current session or null.
 * Same predicate as hostelSessionService.getCurrentSession(), but a missing
 * session is a normal answer here, not a 409.
 */
async function getCurrentSessionSummary() {
  const [rows] = await pool.execute(
    `${SESSION_SELECT} WHERE s.is_current = 1 AND s.status = 'open' LIMIT 1`
  );
  return rows[0] ? toSession(rows[0]) : null;
}

/** POST /api/admin/sessions */
async function createSession({ label, starts_on, ends_on }) {
  const { startYear } = parseSessionLabel(label);
  const dates = validateSessionDates({ starts_on, ends_on });

  return withTransaction(async (conn) => {
    const existing = await lockAllSessions(conn);

    if (existing.some((row) => row.label === label)) {
      throw ApiError.conflict(`A hostel session labelled ${label} already exists.`);
    }
    const latest = existing.reduce(
      (best, row) => (best === null || startYearOf(row.label) > startYearOf(best.label) ? row : best),
      null
    );
    if (latest && startYear <= startYearOf(latest.label)) {
      throw ApiError.conflict(
        `A new session must be later than the latest existing session (${latest.label}).`
      );
    }

    let insertId;
    try {
      const [result] = await conn.execute(
        `INSERT INTO hostel_sessions (label, status, is_current, starts_on, ends_on)
         VALUES (?, 'upcoming', 0, ?, ?)`,
        [label, dates.starts_on, dates.ends_on]
      );
      insertId = result.insertId;
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') {
        throw ApiError.conflict(`A hostel session labelled ${label} already exists.`);
      }
      throw err;
    }

    return loadSession(conn, insertId);
  });
}

/** POST /api/admin/sessions/:id/open */
async function openSession(sessionId) {
  return withTransaction(async (conn) => {
    const sessions = await lockAllSessions(conn);

    const target = sessions.find((row) => row.id === sessionId);
    if (!target) throw ApiError.notFound('Hostel session not found.');

    if (target.status !== 'upcoming') {
      throw ApiError.conflict(
        `Only an upcoming session can be opened. Session ${target.label} is ${target.status}.`
      );
    }

    const alreadyOpen = sessions.find(
      (row) => row.status === 'open' || Number(row.is_current) === 1
    );
    if (alreadyOpen) {
      throw ApiError.conflict(
        `Session ${alreadyOpen.label} is still open. Close it before opening ${target.label}.`
      );
    }

    const earlierUpcoming = sessions.find(
      (row) => row.status === 'upcoming' && row.id !== target.id && startYearOf(row.label) < startYearOf(target.label)
    );
    if (earlierUpcoming) {
      throw ApiError.conflict(
        `Session ${earlierUpcoming.label} is still upcoming and must be opened before ${target.label}.`
      );
    }

    const [result] = await conn.execute(
      `UPDATE hostel_sessions SET status = 'open', is_current = 1
        WHERE id = ? AND status = 'upcoming'`,
      [target.id]
    );
    if (result.affectedRows !== 1) {
      throw ApiError.conflict('This session was just changed by someone else. Please refresh and try again.');
    }

    return loadSession(conn, target.id);
  });
}

/** POST /api/admin/sessions/:id/close */
async function closeSession(sessionId) {
  return withTransaction(async (conn) => {
    const sessions = await lockAllSessions(conn);

    const target = sessions.find((row) => row.id === sessionId);
    if (!target) throw ApiError.notFound('Hostel session not found.');

    if (target.status !== 'open') {
      throw ApiError.conflict(
        `Only an open session can be closed. Session ${target.label} is ${target.status}.`
      );
    }

    const [result] = await conn.execute(
      `UPDATE hostel_sessions SET status = 'closed', is_current = 0
        WHERE id = ? AND status = 'open'`,
      [target.id]
    );
    if (result.affectedRows !== 1) {
      throw ApiError.conflict('This session was just changed by someone else. Please refresh and try again.');
    }

    return loadSession(conn, target.id);
  });
}

module.exports = {
  listSessions,
  getCurrentSessionSummary,
  createSession,
  openSession,
  closeSession,
};
