/**
 * services/miscChargeService.js
 * ---------------------------------------------------------------
 * Administrator management of miscellaneous charges
 * (table hostel_misc_charges, migrations 014 + 017/020).
 *
 * Rules enforced HERE (the routes are also admin-only; the validators only
 * give clearer messages):
 *   - A charge belongs to ONE hostel session, optionally to ONE block
 *     (block_id NULL = every approved student of that session).
 *   - amount is a positive NGN decimal; late_fine_amount is a non-negative
 *     NGN decimal and may be > 0 only together with a deadline_at.
 *     (The live ck_misc_charges_fine only checks fine >= 0, so the
 *     "fine needs a deadline" rule is enforced here.)
 *   - Charges are NEVER deleted (payments reference them). They are
 *     deactivated; deactivating hides the charge from students but keeps
 *     every historical payment and the charge row itself.
 *   - Once ANY payment row exists for a charge (pending, success, failed...),
 *     its amount and block cannot change - the amount a student was charged
 *     must stay explainable. Title, description, deadline, fine and
 *     is_required remain editable; they only affect future payments.
 *   - Charges of a closed/archived session are historical: read-only
 *     (deactivation is still allowed).
 *   - Currency is always NGN (the only currency utils/money.js supports).
 * ---------------------------------------------------------------
 */

const { pool, withTransaction } = require('../config/database');
const ApiError = require('../utils/ApiError');
const { decimalToMinor, minorToDecimal } = require('../utils/money');
const { assertMiscSchema } = require('./miscSchema');

const CURRENCY = 'NGN';
const MAX_MINOR = 9999999999; // DECIMAL(10,2) = 99,999,999.99
const NAME_MAX = 150;
const DESCRIPTION_MAX = 2000;
const WRITABLE_SESSION_STATUSES = ['upcoming', 'open'];

/* --------------------------- pure validation --------------------------- */

function parseMoney(value, label, { allowZero }) {
  let minor;
  try {
    minor = decimalToMinor(value, CURRENCY, { allowZero });
  } catch (err) {
    throw ApiError.badRequest(
      `${label} must be ${allowZero ? 'zero or a positive' : 'a positive'} naira amount with at most two decimal places, for example 5000.00.`
    );
  }
  if (minor > MAX_MINOR) throw ApiError.badRequest(`${label} is too large.`);
  return minorToDecimal(minor, CURRENCY);
}

function parseBool(value, label) {
  if (value === true || value === 1 || value === '1' || value === 'true') return 1;
  if (value === false || value === 0 || value === '0' || value === 'false') return 0;
  throw ApiError.badRequest(`${label} must be true or false.`);
}

function parseId(value, label) {
  const n = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n <= 0) throw ApiError.badRequest(`${label} must be a valid id.`);
  return n;
}

/** 'YYYY-MM-DD[T| ]HH:MM[:SS]' (datetime-local or MySQL style) -> 'YYYY-MM-DD HH:MM:SS' or null. */
function normaliseDeadline(value) {
  if (value === null || value === undefined || value === '') return null;
  const m = typeof value === 'string'
    ? /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim())
    : null;
  if (!m) throw ApiError.badRequest('Deadline must be a date and time, for example 2026-12-31 23:59.');
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] || '00'].map(Number);
  const probe = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (
    probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d ||
    h > 23 || mi > 59 || s > 59
  ) {
    throw ApiError.badRequest('Deadline is not a real date and time.');
  }
  const p2 = (n) => String(n).padStart(2, '0');
  return `${m[1]}-${m[2]}-${m[3]} ${p2(h)}:${p2(mi)}:${p2(s)}`;
}

/**
 * Validates the writable fields that are PRESENT in `body` (unknown keys are
 * ignored, never stored). With { partial:false } name, amount and
 * hostel_session_id are required.
 * @returns {object} normalised values keyed by column name
 */
function validateChargeInput(body, { partial }) {
  const b = body && typeof body === 'object' ? body : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined;
  const out = {};

  if (!partial || has('hostel_session_id')) {
    if (partial) throw ApiError.badRequest('The session of a charge cannot be changed.');
    if (!has('hostel_session_id')) throw ApiError.badRequest('A session is required.');
    out.hostel_session_id = parseId(b.hostel_session_id, 'Session');
  }

  if (!partial || has('name')) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name) throw ApiError.badRequest('A title is required.');
    if (name.length > NAME_MAX) throw ApiError.badRequest(`Title must be ${NAME_MAX} characters or fewer.`);
    out.name = name;
  }

  if (has('description')) {
    if (b.description !== null && typeof b.description !== 'string') throw ApiError.badRequest('Description must be text.');
    const text = b.description === null ? '' : b.description.trim();
    if (text.length > DESCRIPTION_MAX) throw ApiError.badRequest(`Description must be ${DESCRIPTION_MAX} characters or fewer.`);
    out.description = text === '' ? null : text;
  }

  if (!partial || has('amount')) {
    if (!has('amount')) throw ApiError.badRequest('An amount is required.');
    out.amount = parseMoney(b.amount, 'Amount', { allowZero: false });
  }

  if (has('currency') && b.currency !== CURRENCY) {
    throw ApiError.badRequest('Only NGN charges are supported.');
  }

  if (has('block_id')) {
    out.block_id = b.block_id === null || b.block_id === '' ? null : parseId(b.block_id, 'Block');
  }

  if (has('is_required')) out.is_required = parseBool(b.is_required, 'Required');
  if (has('deadline_at')) out.deadline_at = normaliseDeadline(b.deadline_at);
  if (has('late_fine_amount')) {
    out.late_fine_amount = b.late_fine_amount === null || b.late_fine_amount === ''
      ? '0.00'
      : parseMoney(b.late_fine_amount, 'Late fine', { allowZero: true });
  }
  return out;
}

/** Cross-field rule on the FINAL values. */
function assertFineNeedsDeadline(final) {
  const fineMinor = decimalToMinor(final.late_fine_amount || '0.00', CURRENCY, { allowZero: true });
  if (fineMinor > 0 && !final.deadline_at) {
    throw ApiError.badRequest('A late fine needs a payment deadline.');
  }
  if (fineMinor + decimalToMinor(final.amount, CURRENCY) > MAX_MINOR) {
    throw ApiError.badRequest('The amount plus the late fine is too large.');
  }
}

/* ------------------------------- queries ------------------------------- */

const SELECT_CHARGE = `
  SELECT c.id, c.hostel_session_id, hs.label AS session_label, hs.status AS session_status,
         c.block_id, b.name AS block_name, c.name, c.description, c.amount, c.currency,
         c.is_required, c.is_active, c.deadline_at, c.late_fine_amount, c.created_at, c.updated_at,
         (SELECT COUNT(*) FROM payments p WHERE p.hostel_misc_charge_id = c.id) AS payments_total,
         (SELECT COUNT(*) FROM payments p WHERE p.hostel_misc_charge_id = c.id AND p.status = 'success') AS paid_count,
         (SELECT COUNT(*) FROM payments p WHERE p.hostel_misc_charge_id = c.id AND p.status = 'pending') AS pending_count,
         (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.hostel_misc_charge_id = c.id AND p.status = 'success') AS collected_total
    FROM hostel_misc_charges c
    JOIN hostel_sessions hs ON hs.id = c.hostel_session_id
    LEFT JOIN blocks b ON b.id = c.block_id`;

function toAdminView(r) {
  return {
    id: r.id,
    hostel_session_id: r.hostel_session_id,
    session_label: r.session_label,
    session_status: r.session_status,
    block_id: r.block_id === undefined ? null : r.block_id,
    block_name: r.block_name || null,
    name: r.name,
    description: r.description || null,
    amount: r.amount,
    currency: r.currency,
    is_required: Number(r.is_required) === 1,
    is_active: Number(r.is_active) === 1,
    deadline_at: r.deadline_at || null,
    late_fine_amount: r.late_fine_amount,
    payments_total: Number(r.payments_total),
    paid_count: Number(r.paid_count),
    pending_count: Number(r.pending_count),
    collected_total: r.collected_total,
    amount_locked: Number(r.payments_total) > 0,
    read_only: !WRITABLE_SESSION_STATUSES.includes(r.session_status),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

async function listCharges({ sessionId = null } = {}) {
  await assertMiscSchema(pool);
  const where = sessionId ? 'WHERE c.hostel_session_id = ?' : '';
  const [rows] = await pool.execute(
    `${SELECT_CHARGE} ${where} ORDER BY c.hostel_session_id DESC, c.id DESC`,
    sessionId ? [sessionId] : []
  );
  return rows.map(toAdminView);
}

async function getCharge(id, conn = pool) {
  const [rows] = await conn.execute(`${SELECT_CHARGE} WHERE c.id = ?`, [id]);
  if (!rows[0]) throw ApiError.notFound('Charge not found.');
  return toAdminView(rows[0]);
}

async function getOptions() {
  const [sessions] = await pool.execute(
    `SELECT id, label, status, is_current FROM hostel_sessions ORDER BY id DESC`
  );
  const [blocks] = await pool.execute(`SELECT id, name, is_active FROM blocks ORDER BY name`);
  return {
    sessions: sessions.map((s) => ({
      id: s.id, label: s.label, status: s.status, is_current: Number(s.is_current) === 1,
      writable: WRITABLE_SESSION_STATUSES.includes(s.status),
    })),
    blocks: blocks.map((b) => ({ id: b.id, name: b.name, is_active: Number(b.is_active) === 1 })),
    currency: CURRENCY,
  };
}

async function assertBlockExists(conn, blockId) {
  if (blockId === null || blockId === undefined) return;
  const [rows] = await conn.execute(`SELECT id, name FROM blocks WHERE id = ?`, [blockId]);
  if (!rows[0]) throw ApiError.badRequest('That block does not exist.');
}

async function createCharge(adminId, body) {
  await assertMiscSchema(pool);
  const input = validateChargeInput(body, { partial: false });
  const final = {
    amount: input.amount,
    deadline_at: input.deadline_at === undefined ? null : input.deadline_at,
    late_fine_amount: input.late_fine_amount === undefined ? '0.00' : input.late_fine_amount,
  };
  assertFineNeedsDeadline(final);

  const id = await withTransaction(async (conn) => {
    const [sess] = await conn.execute(
      `SELECT id, label, status FROM hostel_sessions WHERE id = ? LOCK IN SHARE MODE`,
      [input.hostel_session_id]
    );
    if (!sess[0]) throw ApiError.badRequest('That session does not exist.');
    if (!WRITABLE_SESSION_STATUSES.includes(sess[0].status)) {
      throw ApiError.conflict(`Session ${sess[0].label} is ${sess[0].status}; charges can only be added to an upcoming or open session.`);
    }
    await assertBlockExists(conn, input.block_id);

    const [result] = await conn.execute(
      `INSERT INTO hostel_misc_charges
         (hostel_session_id, block_id, name, description, amount, currency, is_required, is_active,
          deadline_at, late_fine_amount, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.hostel_session_id,
        input.block_id === undefined ? null : input.block_id,
        input.name,
        input.description === undefined ? null : input.description,
        input.amount,
        CURRENCY,
        input.is_required === undefined ? 0 : input.is_required,
        1,
        final.deadline_at,
        final.late_fine_amount,
        adminId,
      ]
    );
    return result.insertId;
  });
  return getCharge(id);
}

async function updateCharge(id, body) {
  await assertMiscSchema(pool);
  const input = validateChargeInput(body, { partial: true });
  if (Object.keys(input).length === 0) throw ApiError.badRequest('Nothing to update.');

  await withTransaction(async (conn) => {
    const [rows] = await conn.execute(
      `SELECT id, hostel_session_id, block_id, amount, deadline_at, late_fine_amount
         FROM hostel_misc_charges WHERE id = ? FOR UPDATE`,
      [id]
    );
    const current = rows[0];
    if (!current) throw ApiError.notFound('Charge not found.');

    const [sess] = await conn.execute(
      `SELECT label, status FROM hostel_sessions WHERE id = ? LOCK IN SHARE MODE`,
      [current.hostel_session_id]
    );
    if (!sess[0] || !WRITABLE_SESSION_STATUSES.includes(sess[0].status)) {
      throw ApiError.conflict('This charge belongs to a closed session and is now a historical record; it cannot be edited.');
    }

    const [cnt] = await conn.execute(
      `SELECT COUNT(*) AS n FROM payments WHERE hostel_misc_charge_id = ?`,
      [id]
    );
    const hasPayments = Number(cnt[0].n) > 0;
    const sameMoney = (a, b) => decimalToMinor(a, CURRENCY, { allowZero: true }) === decimalToMinor(b, CURRENCY, { allowZero: true });
    if (hasPayments && input.amount !== undefined && !sameMoney(input.amount, current.amount)) {
      throw ApiError.conflict('Payments already exist for this charge, so its amount can no longer be changed. Deactivate it and create a new charge instead.');
    }
    if (hasPayments && input.block_id !== undefined && input.block_id !== current.block_id) {
      throw ApiError.conflict('Payments already exist for this charge, so its block can no longer be changed.');
    }
    if (input.block_id !== undefined) await assertBlockExists(conn, input.block_id);

    assertFineNeedsDeadline({
      amount: input.amount !== undefined ? input.amount : current.amount,
      deadline_at: input.deadline_at !== undefined ? input.deadline_at : current.deadline_at,
      late_fine_amount: input.late_fine_amount !== undefined ? input.late_fine_amount : current.late_fine_amount,
    });

    const editable = ['name', 'description', 'amount', 'block_id', 'is_required', 'deadline_at', 'late_fine_amount'];
    const sets = editable.filter((k) => input[k] !== undefined);
    await conn.execute(
      `UPDATE hostel_misc_charges SET ${sets.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      [...sets.map((k) => input[k]), id]
    );
  });
  return getCharge(id);
}

async function setChargeActive(id, active) {
  await assertMiscSchema(pool);
  await withTransaction(async (conn) => {
    const [rows] = await conn.execute(
      `SELECT id, hostel_session_id, is_active FROM hostel_misc_charges WHERE id = ? FOR UPDATE`,
      [id]
    );
    if (!rows[0]) throw ApiError.notFound('Charge not found.');
    if (active) {
      const [sess] = await conn.execute(
        `SELECT label, status FROM hostel_sessions WHERE id = ? LOCK IN SHARE MODE`,
        [rows[0].hostel_session_id]
      );
      if (!sess[0] || !WRITABLE_SESSION_STATUSES.includes(sess[0].status)) {
        throw ApiError.conflict('This charge belongs to a closed session and cannot be reactivated.');
      }
    }
    await conn.execute(
      `UPDATE hostel_misc_charges SET is_active = ? WHERE id = ?`,
      [active ? 1 : 0, id]
    );
  });
  return getCharge(id);
}

module.exports = {
  listCharges, getCharge, getOptions, createCharge, updateCharge, setChargeActive,
  validateChargeInput, normaliseDeadline, assertFineNeedsDeadline, WRITABLE_SESSION_STATUSES,
};
