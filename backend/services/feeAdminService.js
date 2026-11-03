/**
 * services/feeAdminService.js
 * ---------------------------------------------------------------
 * Admin management of the hostel fee PER ACADEMIC SESSION, plus the
 * read-only fee list shown to students.
 *
 * Reuses what already exists (no schema change, no migration):
 *   hostel_fees (hostel_session_id, block_id, amount, currency, active, updated_by, session_year)
 *   with the unique key on active_key = 'B:<session>:<block>' (one ACTIVE fee per session+block).
 * feeService.getBlockFee() already prices an application from ITS OWN session
 * (applications.hostel_session_id) and block; payments point at the fee row they paid
 * (payments.hostel_fee_id). This module only adds the missing way to SET those rows.
 *
 * HISTORY IS NEVER REWRITTEN: changing a fee does not UPDATE its amount. The current row is
 * deactivated (active = 0, kept forever) and a new active row is inserted, so every payment
 * keeps pointing at the exact fee it paid, and no other session's rows are ever touched
 * (every statement is filtered by hostel_session_id AND block_id).
 *
 * Only 'upcoming' and 'open' sessions can be edited; closed/archived sessions are read-only.
 * The session row is locked FOR UPDATE, which serialises every fee write for that session.
 * ---------------------------------------------------------------
 */

const { pool, withTransaction } = require('../config/database');
const ApiError = require('../utils/ApiError');
const { decimalToMinor, minorToDecimal } = require('../utils/money');

const CURRENCY = 'NGN';
const MAX_MINOR = 9999999999; // DECIMAL(10,2) column limit: 99,999,999.99

function idOf(value, what) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw ApiError.badRequest(`A valid ${what} is required.`);
  return n;
}

/** Amount text -> integer kobo. Strings (or safe integers) only; never floats. */
function parseAmount(value) {
  if (value === undefined || value === null || value === '') throw ApiError.badRequest('An amount is required.');
  let minor;
  try {
    minor = decimalToMinor(typeof value === 'string' ? value.trim().replace(/,/g, '') : value, CURRENCY);
  } catch (err) {
    throw ApiError.badRequest('The fee must be a positive amount with at most two decimal places, for example 250000 or 250000.50.');
  }
  if (minor > MAX_MINOR) throw ApiError.badRequest('The fee is too large.');
  return minor;
}

const editable = (status) => status === 'upcoming' || status === 'open';

async function listSessions() {
  const [rows] = await pool.execute(
    `SELECT id, label, status, is_current FROM hostel_sessions ORDER BY label DESC`
  );
  return rows.map((s) => ({ ...s, is_current: Number(s.is_current) === 1, editable: editable(s.status) }));
}

/** Every block with its ACTIVE fee for the session, payment counts, and earlier revisions. */
async function getSessionFees(sessionId) {
  const sid = idOf(sessionId, 'session');
  const [sRows] = await pool.execute(`SELECT id, label, status, is_current FROM hostel_sessions WHERE id = ?`, [sid]);
  if (!sRows[0]) throw ApiError.notFound('Hostel session not found.');
  const session = sRows[0];

  const [blocks] = await pool.execute(`SELECT id, name, gender, is_active FROM blocks ORDER BY name`);
  const [fees] = await pool.execute(
    `SELECT id, block_id, amount, currency, active, updated_by, created_at
       FROM hostel_fees
      WHERE hostel_session_id = ? AND block_id IS NOT NULL
      ORDER BY id DESC`,
    [sid]
  );
  const [counts] = await pool.execute(
    `SELECT f.block_id, COUNT(p.id) AS total, COALESCE(SUM(p.status = 'success'), 0) AS paid,
            COALESCE(SUM(p.status = 'pending'), 0) AS pending
       FROM hostel_fees f
       JOIN payments p ON p.hostel_fee_id = f.id
      WHERE f.hostel_session_id = ? AND f.block_id IS NOT NULL
      GROUP BY f.block_id`,
    [sid]
  );

  return {
    session: { id: session.id, label: session.label, status: session.status, is_current: Number(session.is_current) === 1 },
    editable: editable(session.status),
    currency: CURRENCY,
    blocks: blocks.map((b) => {
      const mine = fees.filter((f) => Number(f.block_id) === Number(b.id));
      const active = mine.find((f) => Number(f.active) === 1) || null;
      const c = counts.find((x) => Number(x.block_id) === Number(b.id));
      return {
        block_id: b.id,
        block_name: b.name,
        gender: b.gender,
        is_active: Number(b.is_active) === 1,
        fee: active ? { id: active.id, amount: active.amount, currency: active.currency, set_at: active.created_at, set_by: active.updated_by } : null,
        payments: { total: c ? Number(c.total) : 0, paid: c ? Number(c.paid) : 0, pending: c ? Number(c.pending) : 0 },
        earlier_fees: mine.filter((f) => Number(f.active) !== 1).map((f) => ({ id: f.id, amount: f.amount, currency: f.currency, set_at: f.created_at })),
      };
    }),
  };
}

/**
 * Set (or revise) the hostel fee of ONE block in ONE session.
 * @returns {{changed:boolean, session, block, fee, previous_fee}}
 */
async function setBlockFee({ sessionId, blockId, amount, adminId }) {
  const sid = idOf(sessionId, 'session');
  const bid = idOf(blockId, 'block');
  const minor = parseAmount(amount);
  const decimal = minorToDecimal(minor, CURRENCY);

  return withTransaction(async (conn) => {
    const [sRows] = await conn.execute(`SELECT id, label, status FROM hostel_sessions WHERE id = ? FOR UPDATE`, [sid]);
    const session = sRows[0];
    if (!session) throw ApiError.notFound('Hostel session not found.');
    if (!editable(session.status)) {
      throw ApiError.conflict(`The hostel fee of a ${session.status} session cannot be changed. Its fees are kept as a record.`);
    }
    const [bRows] = await conn.execute(`SELECT id, name, is_active FROM blocks WHERE id = ?`, [bid]);
    const block = bRows[0];
    if (!block) throw ApiError.notFound('Block not found.');
    if (Number(block.is_active) !== 1) throw ApiError.conflict(`${block.name} is not active, so a fee cannot be set for it.`);

    const [cur] = await conn.execute(
      `SELECT id, amount, currency FROM hostel_fees
        WHERE hostel_session_id = ? AND block_id = ? AND active = 1 FOR UPDATE`,
      [sid, bid]
    );
    if (cur.length > 1) throw new ApiError(500, 'More than one active fee exists for this block and session. Please contact the system administrator.');
    const previous = cur[0] || null;

    if (previous && previous.currency === CURRENCY && decimalToMinor(previous.amount, CURRENCY) === minor) {
      return { changed: false, session: { id: sid, label: session.label }, block: { id: bid, name: block.name }, fee: { id: previous.id, amount: previous.amount, currency: previous.currency }, previous_fee: null };
    }

    if (previous) {
      const [off] = await conn.execute(
        `UPDATE hostel_fees SET active = 0, updated_by = ? WHERE id = ? AND active = 1`,
        [adminId, previous.id]
      );
      if (off.affectedRows !== 1) throw ApiError.conflict('The current fee was changed by someone else. Please reload and try again.');
    }
    let insertId;
    try {
      const [ins] = await conn.execute(
        `INSERT INTO hostel_fees
           (room_type, amount, currency, session_year, hostel_session_id, block_id, active, updated_by)
         VALUES (NULL, ?, ?, ?, ?, ?, 1, ?)`,
        [decimal, CURRENCY, session.label, sid, bid, adminId]
      );
      insertId = ins.insertId;
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') throw ApiError.conflict('A fee for this block and session already exists. Please reload and try again.');
      throw err;
    }
    return {
      changed: true,
      session: { id: sid, label: session.label },
      block: { id: bid, name: block.name },
      fee: { id: insertId, amount: decimal, currency: CURRENCY },
      previous_fee: previous ? { id: previous.id, amount: previous.amount, currency: previous.currency } : null,
    };
  });
}

/** Read-only: the CURRENT session's active fees, for the blocks that suit this student. */
async function getStudentFees(studentId) {
  const [sRows] = await pool.execute(
    `SELECT id, label FROM hostel_sessions WHERE is_current = 1 AND status = 'open' LIMIT 1`
  );
  if (!sRows[0]) return { session: null, currency: CURRENCY, blocks: [] };
  const [u] = await pool.execute(`SELECT gender FROM users WHERE id = ?`, [studentId]);
  const gender = u[0] && u[0].gender ? u[0].gender : null;
  const [rows] = await pool.execute(
    `SELECT b.id AS block_id, b.name AS block_name, b.gender, b.description, f.amount, f.currency
       FROM blocks b
       JOIN hostel_fees f ON f.block_id = b.id AND f.hostel_session_id = ? AND f.active = 1
      WHERE b.is_active = 1
      ORDER BY b.name`,
    [sRows[0].id]
  );
  return {
    session: { id: sRows[0].id, label: sRows[0].label },
    currency: CURRENCY,
    blocks: rows.filter((r) => !gender || r.gender === gender),
  };
}

module.exports = { listSessions, getSessionFees, setBlockFee, getStudentFees, parseAmount };
