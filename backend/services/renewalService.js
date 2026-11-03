/**
 * services/renewalService.js
 * ---------------------------------------------------------------
 * Hostel renewal and forfeiture.
 *
 * ELIGIBILITY (fallback rule chosen by the project owner; no earlier rule exists in the code):
 *   a student may request renewal into the CURRENT (open) hostel session when they hold an
 *   ACTIVE allocation in a previous (closed/archived) session, have no pending/approved
 *   application or renewal for the current session, and the renewal deadline (if one is set
 *   on hostel_sessions.renewal_deadline_at) has not passed. The deadline is compared with the
 *   database clock (NOW()), the same clock the deadline was typed against.
 *
 * WORKFLOW
 *   student  requestRenewal  -> hostel_renewals row, status 'pending'
 *   admin    approveRenewal  -> creates the student's APPROVED application for the current
 *                               session (fee block = the block of the room they hold) and
 *                               marks the renewal 'approved'. The OLD allocation stays
 *                               active: the room is held for the student.
 *            rejectRenewal   -> 'rejected' (+ reason). The old allocation stays until the
 *                               forfeiture sweep (or a manual forfeiture) releases it.
 *   student  pays the hostel fee with the existing flow (payment-before-allocation).
 *   admin    fulfillRenewal  -> in ONE transaction: payment gate, release the old allocation,
 *                               allocate the same (or another) room in the current session.
 *   student  cancelRenewal   -> only while 'pending'.
 *
 * FORFEITURE (see forfeitHeldAllocation): releases an allocation from a past session, exactly
 * once, in one transaction: allocation -> 'released' (history kept), room.occupied_spaces - 1,
 * the old application's allocated_room_id cleared, and the renewal recorded as 'forfeited'.
 * It never touches an allocation of the CURRENT session. allocations.status has no
 * 'forfeited' value in the live schema, so forfeiture = 'released' + release_reason
 * "Forfeited: ..." + hostel_renewals.status = 'forfeited'.
 *
 * LOCK ORDER (every writer): renewal -> application -> allocation -> rooms (ascending id).
 * Nothing here edits allocationService.js; the room-release steps mirror
 * cancelApprovedApplication / revokeAllocation (guarded UPDATEs, affectedRows must be 1).
 * ---------------------------------------------------------------
 */

const { pool, withTransaction } = require('../config/database');
const ApiError = require('../utils/ApiError');
const { assertRenewalSchema } = require('./renewalSchema');
const { getBlockFee } = require('./feeService');
const { assertHostelFeePaid } = require('./paymentGate');

const MAX_REASON = 200;

/* ------------------------------ helpers ------------------------------ */

function cleanReason(value, { required }) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (!text) {
    if (required) throw ApiError.badRequest('A reason is required.');
    return null;
  }
  if (text.length > MAX_REASON) throw ApiError.badRequest(`The reason must be ${MAX_REASON} characters or fewer.`);
  return text;
}

function idOf(value, what) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw ApiError.badRequest(`A valid ${what} is required.`);
  return n;
}

/** 'YYYY-MM-DD HH:MM[:SS]' or 'YYYY-MM-DDTHH:MM[:SS]' -> 'YYYY-MM-DD HH:MM:SS'; null/'' -> null. */
function normaliseDeadline(value) {
  if (value === undefined) throw ApiError.badRequest('renewal_deadline_at is required (use null to clear it).');
  if (value === null || String(value).trim() === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value).trim());
  if (!m) throw ApiError.badRequest('The renewal deadline must look like 2026-12-31 23:59.');
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] || '00'].map(Number);
  const probe = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) {
    throw ApiError.badRequest('The renewal deadline is not a real date and time.');
  }
  const p = (n) => String(n).padStart(2, '0');
  return `${m[1]}-${m[2]}-${m[3]} ${p(h)}:${p(mi)}:${p(s)}`;
}

/** The current open session plus whether its renewal deadline has passed (database clock). */
async function readCurrentSession(conn, { lock }) {
  const [rows] = await conn.execute(
    `SELECT id, label, status, renewal_deadline_at,
            (renewal_deadline_at IS NOT NULL AND NOW() > renewal_deadline_at) AS past_deadline
       FROM hostel_sessions
      WHERE is_current = 1 AND status = 'open'
      LIMIT 1${lock ? ' LOCK IN SHARE MODE' : ''}`
  );
  if (!rows[0]) return null;
  return { ...rows[0], past_deadline: Number(rows[0].past_deadline) === 1 };
}

async function requireCurrentSession(conn, { lock }) {
  const session = await readCurrentSession(conn, { lock });
  if (!session) throw ApiError.conflict('No hostel session is currently open. Please contact the hostel administration.');
  return session;
}

/** Latest ACTIVE allocation the student holds in a closed/archived session (no lock). */
async function findHeldAllocation(conn, studentId) {
  const [rows] = await conn.execute(
    `SELECT al.id, al.application_id, al.room_id, al.hostel_session_id,
            r.room_number, r.block_id, b.name AS block_name, s.label AS session_label
       FROM allocations al
       JOIN rooms r ON r.id = al.room_id
       JOIN blocks b ON b.id = r.block_id
       JOIN hostel_sessions s ON s.id = al.hostel_session_id
      WHERE al.student_id = ? AND al.status = 'active'
        AND s.is_current = 0 AND s.status IN ('closed', 'archived')
      ORDER BY al.hostel_session_id DESC, al.id DESC
      LIMIT 1`,
    [studentId]
  );
  return rows[0] || null;
}

async function latestRenewal(conn, studentId, sessionId) {
  const [rows] = await conn.execute(
    `SELECT id, status, reason, new_application_id, previous_allocation_id, created_at, processed_at
       FROM hostel_renewals
      WHERE student_id = ? AND new_session_id = ?
      ORDER BY id DESC LIMIT 1`,
    [studentId, sessionId]
  );
  return rows[0] || null;
}

const REASON_TEXT = {
  no_open_session: 'No hostel session is currently open.',
  no_previous_allocation: 'Renewal is only available to students who hold an active room allocation from a previous session.',
  already_requested: 'You already have a renewal request for the current session.',
  rejected: 'Your renewal request for the current session was rejected. Please contact the hostel administration.',
  has_application: 'You already have an application for the current session.',
  window_closed: 'The renewal deadline for the current session has passed.',
};

/** Pure decision from already-read facts (so the rule lives in one place). */
function decide({ session, candidate, renewal, liveApplication }) {
  if (!session) return 'no_open_session';
  if (renewal && (renewal.status === 'pending' || renewal.status === 'approved')) return 'already_requested';
  if (renewal && renewal.status === 'rejected') return 'rejected';
  if (!candidate) return 'no_previous_allocation';
  if (liveApplication) return 'has_application';
  if (session.past_deadline) return 'window_closed';
  return null;
}

async function evaluate(conn, studentId, { lock }) {
  const session = await readCurrentSession(conn, { lock });
  if (!session) return { session: null, reason: 'no_open_session' };
  const candidate = await findHeldAllocation(conn, studentId);
  const renewal = await latestRenewal(conn, studentId, session.id);
  const [apps] = await conn.execute(
    `SELECT id FROM applications
      WHERE student_id = ? AND hostel_session_id = ? AND status IN ('pending', 'approved') LIMIT 1`,
    [studentId, session.id]
  );
  const reason = decide({ session, candidate, renewal, liveApplication: apps[0] || null });
  return { session, candidate, renewal, reason };
}

/* ------------------------------ student ------------------------------ */

async function getStudentStatus(studentId) {
  await assertRenewalSchema(pool);
  const ev = await evaluate(pool, studentId, { lock: false });
  const out = {
    session: ev.session ? { id: ev.session.id, label: ev.session.label } : null,
    deadline_at: ev.session ? ev.session.renewal_deadline_at || null : null,
    window_open: ev.session ? !ev.session.past_deadline : false,
    previous_allocation: ev.candidate
      ? { allocation_id: ev.candidate.id, session_label: ev.candidate.session_label, room_number: ev.candidate.room_number, block_name: ev.candidate.block_name }
      : null,
    eligible: ev.reason === null,
    reason: ev.reason,
    message: ev.reason ? REASON_TEXT[ev.reason] : 'You can request renewal of your room for the current session.',
    renewal: null,
  };
  if (ev.renewal) {
    const [apps] = ev.renewal.new_application_id
      ? await pool.execute(`SELECT status, allocated_room_id FROM applications WHERE id = ?`, [ev.renewal.new_application_id])
      : [[]];
    out.renewal = {
      id: ev.renewal.id,
      status: ev.renewal.status,
      reason: ev.renewal.reason,
      new_application_id: ev.renewal.new_application_id,
      application_status: apps[0] ? apps[0].status : null,
      room_allocated: Boolean(apps[0] && apps[0].allocated_room_id),
      created_at: ev.renewal.created_at,
      processed_at: ev.renewal.processed_at,
    };
  }
  return out;
}

async function requestRenewal(studentId) {
  return withTransaction(async (conn) => {
    await assertRenewalSchema(conn);
    const ev = await evaluate(conn, studentId, { lock: true });
    if (ev.reason) throw ApiError.conflict(REASON_TEXT[ev.reason]);

    // Lock the allocation being renewed and re-check it under the lock.
    const [locked] = await conn.execute(
      `SELECT id, status FROM allocations WHERE id = ? FOR UPDATE`,
      [ev.candidate.id]
    );
    if (!locked[0] || locked[0].status !== 'active') {
      throw ApiError.conflict('Your previous room allocation is no longer active, so it cannot be renewed.');
    }

    try {
      const [result] = await conn.execute(
        `INSERT INTO hostel_renewals
           (student_id, previous_allocation_id, previous_session_id, new_session_id, type, status)
         VALUES (?, ?, ?, ?, 'renewal', 'pending')`,
        [studentId, ev.candidate.id, ev.candidate.hostel_session_id, ev.session.id]
      );
      return { id: result.insertId, status: 'pending' };
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') throw ApiError.conflict(REASON_TEXT.already_requested);
      throw err;
    }
  });
}

async function cancelRenewal(studentId, renewalId) {
  const id = idOf(renewalId, 'renewal');
  return withTransaction(async (conn) => {
    await assertRenewalSchema(conn);
    const [rows] = await conn.execute(
      `SELECT id, status FROM hostel_renewals WHERE id = ? AND student_id = ? FOR UPDATE`,
      [id, studentId]
    );
    if (!rows[0]) throw ApiError.notFound('Renewal request not found.');
    if (rows[0].status !== 'pending') {
      throw ApiError.conflict(`Only a pending renewal request can be cancelled. This one is ${rows[0].status}.`);
    }
    const [r] = await conn.execute(
      `UPDATE hostel_renewals SET status = 'cancelled', reason = 'Cancelled by student', processed_at = NOW()
        WHERE id = ? AND status = 'pending'`,
      [id]
    );
    if (r.affectedRows !== 1) throw ApiError.conflict('The renewal request could not be cancelled.');
    return { id, status: 'cancelled' };
  });
}

/* ------------------------------- admin ------------------------------- */

async function listRenewals({ status, sessionId } = {}) {
  await assertRenewalSchema(pool);
  const where = [];
  const params = [];
  if (status) { where.push('hr.status = ?'); params.push(status); }
  if (sessionId) { where.push('hr.new_session_id = ?'); params.push(sessionId); }
  const [rows] = await pool.execute(
    `SELECT hr.id, hr.student_id, hr.previous_allocation_id, hr.previous_session_id, hr.new_session_id,
            hr.new_application_id, hr.type, hr.status, hr.reason, hr.processed_by, hr.processed_at, hr.created_at,
            u.full_name, u.email, u.student_id AS matric_number,
            ps.label AS previous_session_label, ns.label AS new_session_label,
            pr.room_number AS previous_room_number, pb.name AS previous_block_name,
            pal.status AS previous_allocation_status,
            na.status AS application_status, na.allocated_room_id AS application_room_id
       FROM hostel_renewals hr
       JOIN users u ON u.id = hr.student_id
       JOIN hostel_sessions ps ON ps.id = hr.previous_session_id
       JOIN hostel_sessions ns ON ns.id = hr.new_session_id
       LEFT JOIN allocations pal ON pal.id = hr.previous_allocation_id
       LEFT JOIN rooms pr ON pr.id = pal.room_id
       LEFT JOIN blocks pb ON pb.id = pr.block_id
       LEFT JOIN applications na ON na.id = hr.new_application_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY hr.id DESC LIMIT 500`,
    params
  );
  return rows.map((r) => ({
    ...r,
    fulfilled: r.status === 'approved' && Boolean(r.application_room_id),
  }));
}

async function getOverview() {
  await assertRenewalSchema(pool);
  const session = await readCurrentSession(pool, { lock: false });
  const counts = { pending: 0, approved: 0, rejected: 0, cancelled: 0, forfeited: 0 };
  if (session) {
    const [rows] = await pool.execute(
      `SELECT status, COUNT(*) AS n FROM hostel_renewals WHERE new_session_id = ? GROUP BY status`,
      [session.id]
    );
    rows.forEach((r) => { counts[r.status] = Number(r.n); });
  }
  return {
    session: session ? { id: session.id, label: session.label } : null,
    renewal_deadline_at: session ? session.renewal_deadline_at || null : null,
    deadline_passed: session ? session.past_deadline : false,
    counts,
  };
}

async function setRenewalDeadline({ sessionId, renewalDeadlineAt }) {
  const deadline = normaliseDeadline(renewalDeadlineAt);
  return withTransaction(async (conn) => {
    await assertRenewalSchema(conn);
    let id = sessionId ? idOf(sessionId, 'session') : null;
    if (!id) id = (await requireCurrentSession(conn, { lock: false })).id;
    const [rows] = await conn.execute(
      `SELECT id, label, status FROM hostel_sessions WHERE id = ? FOR UPDATE`,
      [id]
    );
    if (!rows[0]) throw ApiError.notFound('Hostel session not found.');
    if (rows[0].status !== 'open' && rows[0].status !== 'upcoming') {
      throw ApiError.conflict(`The renewal deadline of a ${rows[0].status} session cannot be changed.`);
    }
    await conn.execute(`UPDATE hostel_sessions SET renewal_deadline_at = ? WHERE id = ?`, [deadline, id]);
    return { id, label: rows[0].label, renewal_deadline_at: deadline };
  });
}

async function lockRenewal(conn, renewalId) {
  const [rows] = await conn.execute(
    `SELECT id, student_id, previous_allocation_id, previous_session_id, new_session_id, new_application_id, status
       FROM hostel_renewals WHERE id = ? FOR UPDATE`,
    [renewalId]
  );
  if (!rows[0]) throw ApiError.notFound('Renewal request not found.');
  return rows[0];
}

async function approveRenewal({ renewalId, adminId }) {
  const id = idOf(renewalId, 'renewal');
  return withTransaction(async (conn) => {
    const schema = await assertRenewalSchema(conn);
    const renewal = await lockRenewal(conn, id);
    if (renewal.status !== 'pending') {
      throw ApiError.conflict(`Only a pending renewal request can be approved. This one is ${renewal.status}.`);
    }

    const session = await requireCurrentSession(conn, { lock: true });
    if (Number(session.id) !== Number(renewal.new_session_id)) {
      throw ApiError.conflict('This renewal request is not for the current hostel session.');
    }

    // The room being renewed must still be held by this student.
    const [allocRows] = renewal.previous_allocation_id
      ? await conn.execute(
          `SELECT id, application_id, room_id, status FROM allocations WHERE id = ? FOR UPDATE`,
          [renewal.previous_allocation_id]
        )
      : [[]];
    const held = allocRows[0];
    if (!held || held.status !== 'active') {
      throw ApiError.conflict('The previous room allocation is no longer active, so this renewal cannot be approved.');
    }

    const [prevApp] = await conn.execute(
      `SELECT room_type, preferred_block_id FROM applications WHERE id = ?`,
      [held.application_id]
    );
    const [roomRows] = await conn.execute(
      `SELECT r.block_id, b.name AS block_name FROM rooms r JOIN blocks b ON b.id = r.block_id WHERE r.id = ?`,
      [held.room_id]
    );
    if (!prevApp[0] || !roomRows[0]) {
      throw ApiError.conflict('The previous application or room record is missing. Renewal was not approved.');
    }

    // No second live application for the student in this session.
    const [live] = await conn.execute(
      `SELECT id FROM applications
        WHERE student_id = ? AND hostel_session_id = ? AND status IN ('pending', 'approved') FOR UPDATE`,
      [renewal.student_id, session.id]
    );
    if (live.length > 0) throw ApiError.conflict('The student already has an application for the current session.');

    // The student must be able to PAY: an active fee for the block must exist.
    const blockId = Number(roomRows[0].block_id);
    try {
      await getBlockFee(conn, session.id, blockId);
    } catch (err) {
      if (err && err.statusCode === 409) {
        throw ApiError.conflict(`No hostel fee is set for ${roomRows[0].block_name} in ${session.label}. Set the fee before approving this renewal.`);
      }
      throw err;
    }

    const cols = ['student_id', 'room_type', 'preferred_block_id', 'status', 'hostel_session_id', 'session_year', 'reviewed_by', 'reviewed_at'];
    const marks = ['?', '?', '?', "'approved'", '?', '?', '?', 'NOW()'];
    const values = [renewal.student_id, prevApp[0].room_type, prevApp[0].preferred_block_id, session.id, session.label, adminId];
    if (schema.feeBlock) { cols.push('fee_block_id'); marks.push('?'); values.push(blockId); }
    const [ins] = await conn.execute(
      `INSERT INTO applications (${cols.join(', ')}) VALUES (${marks.join(', ')})`,
      values
    );

    const [upd] = await conn.execute(
      `UPDATE hostel_renewals
          SET status = 'approved', new_application_id = ?, processed_by = ?, processed_at = NOW()
        WHERE id = ? AND status = 'pending'`,
      [ins.insertId, adminId, id]
    );
    if (upd.affectedRows !== 1) throw ApiError.conflict('The renewal could not be approved.');
    return { id, status: 'approved', new_application_id: ins.insertId, fee_block_id: schema.feeBlock ? blockId : null };
  });
}

async function rejectRenewal({ renewalId, adminId, reason }) {
  const id = idOf(renewalId, 'renewal');
  const text = cleanReason(reason, { required: true });
  return withTransaction(async (conn) => {
    await assertRenewalSchema(conn);
    const renewal = await lockRenewal(conn, id);
    if (renewal.status !== 'pending') {
      throw ApiError.conflict(`Only a pending renewal request can be rejected. This one is ${renewal.status}.`);
    }
    const [r] = await conn.execute(
      `UPDATE hostel_renewals SET status = 'rejected', reason = ?, processed_by = ?, processed_at = NOW()
        WHERE id = ? AND status = 'pending'`,
      [text, adminId, id]
    );
    if (r.affectedRows !== 1) throw ApiError.conflict('The renewal could not be rejected.');
    return { id, status: 'rejected' };
  });
}

/**
 * Give an approved, PAID renewal its room in the current session and release the old one,
 * in one transaction. roomId defaults to the room the student already holds.
 */
async function fulfillRenewal({ renewalId, adminId, roomId }) {
  const id = idOf(renewalId, 'renewal');
  return withTransaction(async (conn) => {
    await assertRenewalSchema(conn);
    const renewal = await lockRenewal(conn, id);
    if (renewal.status !== 'approved' || !renewal.new_application_id) {
      throw ApiError.conflict(`Only an approved renewal can be given a room. This one is ${renewal.status}.`);
    }
    const session = await requireCurrentSession(conn, { lock: true });
    if (Number(session.id) !== Number(renewal.new_session_id)) {
      throw ApiError.conflict('This renewal is not for the current hostel session.');
    }

    const [appRows] = await conn.execute(
      `SELECT id, student_id, room_type, status, allocated_room_id, hostel_session_id
         FROM applications WHERE id = ? FOR UPDATE`,
      [renewal.new_application_id]
    );
    const application = appRows[0];
    if (!application || application.status !== 'approved') {
      throw ApiError.conflict('The renewal application is not approved, so a room cannot be allocated.');
    }
    if (application.allocated_room_id) throw ApiError.conflict('This renewal has already been given a room.');

    const [oldRows] = await conn.execute(
      `SELECT id, application_id, room_id, status FROM allocations WHERE id = ? FOR UPDATE`,
      [renewal.previous_allocation_id]
    );
    const old = oldRows[0];
    if (!old || old.status !== 'active') {
      throw ApiError.conflict('The previous room allocation is no longer active, so it cannot be renewed.');
    }

    const [dup] = await conn.execute(
      `SELECT id FROM allocations WHERE student_id = ? AND hostel_session_id = ? AND status = 'active'`,
      [renewal.student_id, session.id]
    );
    if (dup.length > 0) throw ApiError.conflict('This student already has an active room allocation for the current session.');

    const targetId = roomId ? idOf(roomId, 'room') : Number(old.room_id);
    const lockRoom = async (rid) => {
      const [rows] = await conn.execute(
        `SELECT r.id, r.room_number, r.room_type, r.gender, r.capacity, r.occupied_spaces, r.is_active,
                r.block_id, b.name AS block_name
           FROM rooms r JOIN blocks b ON b.id = r.block_id WHERE r.id = ? FOR UPDATE`,
        [rid]
      );
      return rows[0];
    };
    // Ascending id order keeps two concurrent renewals from deadlocking on a pair of rooms.
    const ids = [...new Set([Number(old.room_id), targetId])].sort((a, b) => a - b);
    const rooms = {};
    for (const rid of ids) rooms[rid] = await lockRoom(rid);
    const oldRoom = rooms[Number(old.room_id)];
    const target = rooms[targetId];

    if (!target) throw ApiError.badRequest('The selected room does not exist.');
    if (!target.is_active) throw ApiError.conflict('The selected room is not currently active.');
    if (target.room_type !== application.room_type) {
      throw ApiError.conflict(`This renewal is for a ${application.room_type} room; the selected room is ${target.room_type}.`);
    }
    const [stu] = await conn.execute(`SELECT gender FROM users WHERE id = ?`, [renewal.student_id]);
    if (!stu[0] || target.gender !== stu[0].gender) {
      throw ApiError.conflict("The selected room does not accommodate this student's gender.");
    }
    if (!oldRoom || Number(oldRoom.occupied_spaces) < 1) {
      throw ApiError.conflict('The room occupancy record is inconsistent. Renewal was not completed.');
    }
    const sameRoom = Number(old.room_id) === targetId;
    if (!sameRoom && Number(target.occupied_spaces) >= Number(target.capacity)) {
      throw ApiError.conflict('The selected room is already full.');
    }

    // Payment-before-allocation: the SAME gate the normal allocation uses.
    await assertHostelFeePaid(conn, application, { block_id: target.block_id, block_name: target.block_name });

    // 1. release the old allocation and its occupied space (history kept)
    const [dec] = await conn.execute(
      `UPDATE rooms SET occupied_spaces = occupied_spaces - 1 WHERE id = ? AND occupied_spaces > 0`,
      [old.room_id]
    );
    if (dec.affectedRows !== 1) throw ApiError.conflict('Room occupancy could not be updated. Renewal was not completed.');
    const [rel] = await conn.execute(
      `UPDATE allocations SET status = 'released', released_at = NOW(), release_reason = ?
        WHERE id = ? AND status = 'active'`,
      [`Renewed for ${session.label} (renewal #${id})`, old.id]
    );
    if (rel.affectedRows !== 1) throw ApiError.conflict('The previous allocation could not be released. Renewal was not completed.');
    await conn.execute(
      `UPDATE applications SET allocated_room_id = NULL WHERE id = ? AND allocated_room_id = ?`,
      [old.application_id, old.room_id]
    );

    // 2. allocate in the current session
    const [ins] = await conn.execute(
      `INSERT INTO allocations (application_id, student_id, room_id, hostel_session_id, allocated_by)
       VALUES (?, ?, ?, ?, ?)`,
      [application.id, renewal.student_id, targetId, session.id, adminId]
    );
    const [inc] = await conn.execute(
      `UPDATE rooms SET occupied_spaces = occupied_spaces + 1 WHERE id = ? AND occupied_spaces < capacity`,
      [targetId]
    );
    if (inc.affectedRows !== 1) throw ApiError.conflict('The room could not take the student. Renewal was not completed.');
    const [att] = await conn.execute(
      `UPDATE applications SET allocated_room_id = ? WHERE id = ? AND allocated_room_id IS NULL`,
      [targetId, application.id]
    );
    if (att.affectedRows !== 1) throw ApiError.conflict('The application could not be attached to the room. Renewal was not completed.');

    return {
      renewal_id: id,
      application_id: application.id,
      allocation_id: ins.insertId,
      released_allocation_id: old.id,
      room_id: targetId,
      room_number: target.room_number,
      block_name: target.block_name,
      same_room: sameRoom,
    };
  });
}

/* ---------------------------- forfeiture ---------------------------- */

/**
 * Release ONE allocation of a past session. Runs inside the caller's transaction.
 * Exactly-once: the allocation row is locked and must still be 'active'; the release,
 * the occupancy decrement and the application detach are guarded updates.
 *
 * @param {object} conn
 * @param {{allocationId:number, adminId:number, reason:string, sweep?:boolean}} o
 *        sweep=true refuses an allocation whose student has a live renewal (the sweep must
 *        never forfeit someone who asked in time); manual forfeiture closes that renewal.
 */
async function forfeitHeldAllocation(conn, { allocationId, adminId, reason, sweep }) {
  const session = await requireCurrentSession(conn, { lock: true });

  const [aRows] = await conn.execute(
    `SELECT id, application_id, student_id, room_id, hostel_session_id, status
       FROM allocations WHERE id = ? FOR UPDATE`,
    [allocationId]
  );
  const alloc = aRows[0];
  if (!alloc) throw ApiError.notFound('Allocation not found.');
  if (alloc.status !== 'active') {
    const err = ApiError.conflict('This allocation has already been released.');
    err.alreadyReleased = true;
    throw err;
  }
  if (Number(alloc.hostel_session_id) === Number(session.id)) {
    throw ApiError.conflict('This allocation belongs to the current session. Use revoke or cancel instead; forfeiture only applies to past sessions.');
  }
  const [sRows] = await conn.execute(`SELECT status FROM hostel_sessions WHERE id = ?`, [alloc.hostel_session_id]);
  if (!sRows[0] || (sRows[0].status !== 'closed' && sRows[0].status !== 'archived')) {
    throw ApiError.conflict('Only an allocation from a closed or archived session can be forfeited.');
  }

  const [liveRows] = await conn.execute(
    `SELECT id, status, new_application_id FROM hostel_renewals
      WHERE student_id = ? AND new_session_id = ? AND status IN ('pending', 'approved') FOR UPDATE`,
    [alloc.student_id, session.id]
  );
  const live = liveRows[0] || null;
  if (sweep && live) {
    const err = ApiError.conflict('The student has a live renewal request.');
    err.hasLiveRenewal = true;
    throw err;
  }
  const [curAlloc] = await conn.execute(
    `SELECT id FROM allocations WHERE student_id = ? AND hostel_session_id = ? AND status = 'active'`,
    [alloc.student_id, session.id]
  );
  const superseded = curAlloc.length > 0;

  // room occupancy: exactly one space
  const [roomRows] = await conn.execute(`SELECT id, occupied_spaces FROM rooms WHERE id = ? FOR UPDATE`, [alloc.room_id]);
  if (!roomRows[0] || Number(roomRows[0].occupied_spaces) < 1) {
    throw ApiError.conflict('The room occupancy record is inconsistent. Forfeiture was not completed.');
  }
  const [dec] = await conn.execute(
    `UPDATE rooms SET occupied_spaces = occupied_spaces - 1 WHERE id = ? AND occupied_spaces > 0`,
    [alloc.room_id]
  );
  if (dec.affectedRows !== 1) throw ApiError.conflict('Room occupancy could not be updated. Forfeiture was not completed.');

  const releaseReason = `${superseded ? 'Superseded' : 'Forfeited'}: ${reason}`.slice(0, 255);
  const [rel] = await conn.execute(
    `UPDATE allocations SET status = 'released', released_at = NOW(), release_reason = ?
      WHERE id = ? AND status = 'active'`,
    [releaseReason, alloc.id]
  );
  if (rel.affectedRows !== 1) throw ApiError.conflict('The allocation could not be released. Forfeiture was not completed.');

  await conn.execute(
    `UPDATE applications SET allocated_room_id = NULL WHERE id = ? AND allocated_room_id = ?`,
    [alloc.application_id, alloc.room_id]
  );

  let renewalId = null;
  if (!superseded) {
    if (live) {
      renewalId = live.id;
      await conn.execute(
        `UPDATE hostel_renewals SET status = 'forfeited', reason = ?, processed_by = ?, processed_at = NOW()
          WHERE id = ? AND status IN ('pending', 'approved')`,
        [reason, adminId, live.id]
      );
      if (live.new_application_id) {
        // an approved renewal that never got its room: close its application too
        await conn.execute(
          `UPDATE applications
              SET status = 'cancelled', rejection_reason = ?, reviewed_by = ?, reviewed_at = NOW()
            WHERE id = ? AND status = 'approved' AND allocated_room_id IS NULL`,
          [`Renewal forfeited: ${reason}`.slice(0, 255), adminId, live.new_application_id]
        );
      }
    } else {
      const [ins] = await conn.execute(
        `INSERT INTO hostel_renewals
           (student_id, previous_allocation_id, previous_session_id, new_session_id, type, status, reason, processed_by, processed_at)
         VALUES (?, ?, ?, ?, 'renewal', 'forfeited', ?, ?, NOW())`,
        [alloc.student_id, alloc.id, alloc.hostel_session_id, session.id, reason, adminId]
      );
      renewalId = ins.insertId;
    }
  }
  return {
    allocation_id: alloc.id,
    student_id: alloc.student_id,
    room_id: alloc.room_id,
    renewal_id: renewalId,
    superseded,
  };
}

async function forfeitAllocation({ allocationId, adminId, reason }) {
  const id = idOf(allocationId, 'allocation');
  const text = cleanReason(reason, { required: true });
  return withTransaction(async (conn) => {
    await assertRenewalSchema(conn);
    return forfeitHeldAllocation(conn, { allocationId: id, adminId, reason: text, sweep: false });
  });
}

/** Read-only classification of every active allocation that belongs to a past session. */
async function previewForfeitures() {
  await assertRenewalSchema(pool);
  const session = await readCurrentSession(pool, { lock: false });
  const out = {
    session: session ? { id: session.id, label: session.label } : null,
    renewal_deadline_at: session ? session.renewal_deadline_at || null : null,
    deadline_passed: session ? session.past_deadline : false,
    can_run: false,
    message: null,
    forfeitable: [],
    superseded: [],
    kept: [],
  };
  if (!session) { out.message = 'No hostel session is currently open.'; return out; }
  if (!session.renewal_deadline_at) out.message = 'No renewal deadline is set for the current session, so nothing is forfeited automatically.';
  else if (!session.past_deadline) out.message = 'The renewal deadline has not passed yet.';
  else out.can_run = true;

  const [rows] = await pool.execute(
    `SELECT al.id AS allocation_id, al.student_id, al.room_id, al.hostel_session_id,
            s.label AS session_label, r.room_number, b.name AS block_name, u.full_name, u.email,
            (SELECT hr.status FROM hostel_renewals hr
              WHERE hr.student_id = al.student_id AND hr.new_session_id = ?
              ORDER BY hr.id DESC LIMIT 1) AS renewal_status,
            (SELECT COUNT(*) FROM allocations c
              WHERE c.student_id = al.student_id AND c.hostel_session_id = ? AND c.status = 'active') AS current_allocations
       FROM allocations al
       JOIN hostel_sessions s ON s.id = al.hostel_session_id
       JOIN rooms r ON r.id = al.room_id
       JOIN blocks b ON b.id = r.block_id
       JOIN users u ON u.id = al.student_id
      WHERE al.status = 'active' AND s.is_current = 0 AND s.status IN ('closed', 'archived')
      ORDER BY al.id`,
    [session.id, session.id]
  );
  for (const r of rows) {
    if (r.renewal_status === 'pending' || r.renewal_status === 'approved') out.kept.push(r);
    else if (Number(r.current_allocations) > 0) out.superseded.push(r);
    else out.forfeitable.push(r);
  }
  return out;
}

/** Forfeit every allocation the preview lists as forfeitable. Each one is its own transaction. */
async function forfeitOverdue({ adminId }) {
  const preview = await previewForfeitures();
  if (!preview.session) throw ApiError.conflict(preview.message);
  if (!preview.can_run) throw ApiError.conflict(preview.message);
  const forfeited = [];
  const skipped = [];
  for (const c of preview.forfeitable) {
    try {
      const done = await withTransaction((conn) => forfeitHeldAllocation(conn, {
        allocationId: c.allocation_id,
        adminId,
        reason: `Renewal deadline passed without a renewal request (${preview.session.label})`,
        sweep: true,
      }));
      forfeited.push(done);
    } catch (err) {
      if (err && err.isOperational) skipped.push({ allocation_id: c.allocation_id, reason: err.message });
      else throw err;
    }
  }
  return { forfeited, skipped };
}

module.exports = {
  getStudentStatus, requestRenewal, cancelRenewal,
  listRenewals, getOverview, setRenewalDeadline,
  approveRenewal, rejectRenewal, fulfillRenewal,
  previewForfeitures, forfeitOverdue, forfeitAllocation,
  // exported for tests
  normaliseDeadline, decide,
};
