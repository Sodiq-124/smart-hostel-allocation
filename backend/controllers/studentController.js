/**
 * controllers/studentController.js
 * ---------------------------------------------------------------
 * Everything a logged-in student can read or change about themselves.
 *
 * Every function here trusts req.session.user.id for WHO the caller is
 * - never a value taken from req.body or req.params. If a route accepted
 * a student ID from the request body instead, any logged-in student
 * could read or edit another student's profile just by changing a
 * number in the request. This is the ownership rule (see
 * docs/phase1-design.md, section 11.3) applied to the simplest case.
 * ---------------------------------------------------------------
 */

const bcrypt = require('bcrypt');
const { pool, queryOne, query } = require('../config/database');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { resolveAllocationState } = require('../services/allocationStatusService');
const { getPaymentsSchema } = require('../services/paymentSchema');

/**
 * Turn a raw payments.status value into the vocabulary the dashboard
 * cards use (docs/phase1-design.md, section 8). Kept in one place so the frontend
 * never has to know the database's internal enum.
 */
function toDisplayPaymentStatus(dbStatus) {
  switch (dbStatus) {
    case 'success':  return 'paid';
    case 'pending':  return 'pending';
    case 'failed':
    case 'abandoned': return 'failed';
    case 'refunded': return 'refunded';
    default:         return 'unpaid';
  }
}

/**
 * The newest-or-successful hostel-fee payment row of the application's own session.
 * A payments schema problem must not take the dashboard down: report "no payment".
 */
async function readHostelPayment(application) {
  let typed = false;
  try {
    ({ typed } = await getPaymentsSchema(pool));
  } catch (err) {
    if (err instanceof ApiError) return null;
    throw err;
  }
  return queryOne(
    `SELECT status, payment_reference, amount, currency, paid_at, verified_at, gateway_reference
       FROM payments
      WHERE application_id = ? AND hostel_session_id = ?
        ${typed ? `AND payment_type = 'hostel'` : ''}
      ORDER BY (status = 'success') DESC, id DESC
      LIMIT 1`,
    [application.id, application.hostel_session_id]
  );
}

/** Name of the block an admin confirmed for this application; null if none or migration 019 is absent. */
async function readFeeBlockName(applicationId) {
  try {
    const row = await queryOne(
      `SELECT b.name FROM applications a JOIN blocks b ON b.id = a.fee_block_id WHERE a.id = ?`,
      [applicationId]
    );
    return row ? row.name : null;
  } catch (err) {
    if (err && err.code === 'ER_BAD_FIELD_ERROR') return null;
    throw err;
  }
}

/**
 * Where an APPROVED application is in the pay-then-allocate sequence. The browser only
 * displays this; nothing here decides eligibility (the server re-checks at payment and
 * at allocation). A revoked allocation keeps its existing dashboard behaviour (null).
 */
function resolvePaymentStage({ status, allocationState, hasRoom, hasFeeBlock, paymentStatus }) {
  if (status !== 'approved' || allocationState === 'revoked') return null;
  const paid = paymentStatus === 'paid';
  if (hasRoom) return paid ? 'allocated_paid' : 'allocated_unpaid'; // legacy: allocated first, pays after
  if (paid) return 'paid_awaiting_room';
  if (!hasFeeBlock) return 'awaiting_fee_block';
  return paymentStatus === 'pending' ? 'payment_pending' : 'payment_required';
}

/**
 * GET /api/students/profile
 */
const getProfile = asyncHandler(async (req, res) => {
  const profile = await queryOne(
    `SELECT id, full_name, student_id, email, gender, phone, department,
            level, created_at
       FROM users
      WHERE id = ? AND role = 'student'`,
    [req.session.user.id]
  );

  res.json({ success: true, message: 'Profile retrieved.', data: profile });
});

/**
 * PUT /api/students/profile
 *
 * Builds the UPDATE statement from a fixed allow-list of columns,
 * never from `Object.keys(req.body)`. That is what makes it impossible
 * for a request to change role through this endpoint however the
 * request body is crafted - `role` is simply never mentioned in the
 * SQL.
 *
 * The allow-list includes student_id and gender. Each gets
 * different treatment:
 *
 *   student_id - relies entirely on the existing UNIQUE index on
 *   users.student_id (database/hostel.sql) plus the existing
 *   ER_DUP_ENTRY -> "An account with this Student ID already exists."
 *   mapping in middleware/errorMiddleware.js. No duplicate-check code
 *   is added here on purpose: a proactive SELECT-then-UPDATE has a race window
 *   where two simultaneous requests could both pass the check before
 *   either writes; letting the database's own unique constraint reject
 *   the second UPDATE is both simpler and actually more correct.
 *
 *   gender - CANNOT rely on a database constraint the same way,
 *   because the rule depends on the student's application history, not
 *   just the shape of the new value. See the guard below.
 */
const ALLOWED_PROFILE_FIELDS = ['full_name', 'email', 'phone', 'department', 'level', 'student_id', 'gender'];

const updateProfile = asyncHandler(async (req, res) => {
  // Gender changes a block's eligibility rules (the
  // trg_applications_before_insert and allocation triggers).
  // Once a student has an APPROVED application, that approval may
  // already assume a particular block's gender - a room in that
  // block may already have been allocated. Letting gender change
  // freely after that point would leave a real inconsistency sitting
  // in the data: a student whose recorded gender no longer matches
  // the block they were placed in. Pending, rejected and cancelled
  // applications carry no such commitment, so only 'approved' blocks
  // the change.
  //
  // "approved" alone is not enough to decide this - an
  // approved application can be ALLOCATED, AWAITING its
  // first allocation, or REVOKED (see allocation_state), and only
  // the first two still carry the block-gender commitment described
  // above. A revoked allocation has given up its room, so it no longer
  // constrains gender - this is evaluated fresh on every request, so
  // a later re-allocation (or a brand new active allocation) blocks
  // gender again automatically, without any separate "permanent lock"
  // ever being written down.
  if (req.body.gender !== undefined) {
    const approvedApplication = await queryOne(
      `SELECT id, allocated_room_id FROM applications WHERE student_id = ? AND status = 'approved'`,
      [req.session.user.id]
    );

    if (approvedApplication) {
      const { allocation_state } = await resolveAllocationState(approvedApplication);
      const stillCommitsToABlock = allocation_state === 'allocated' || allocation_state === 'awaiting_allocation';

      if (stillCommitsToABlock) {
        throw ApiError.conflict(
          'Your gender cannot be changed because you have an approved hostel application. ' +
          'Contact hostel administration if this needs to change.'
        );
      }
      // else: allocation_state === 'revoked' - falls through, gender
      // change is allowed.
    }
  }

  const updates = [];
  const values = [];

  for (const field of ALLOWED_PROFILE_FIELDS) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = ?`);
      values.push(req.body[field] || null);
    }
  }

  if (updates.length === 0) {
    return res.json({ success: true, message: 'Nothing to update.', data: null });
  }

  values.push(req.session.user.id);

  // A duplicate email OR student_id here (ER_DUP_ENTRY) is caught by
  // errorMiddleware.js and turned into the matching friendly message -
  // see translateDatabaseError() there.
  await query(`UPDATE users SET ${updates.join(', ')} WHERE id = ? AND role = 'student'`, values);

  // Keep the session's copy of the user in sync, since the sidebar and
  // topbar read name/email/gender/student_id from req.session.user,
  // not from a fresh query on every page load.
  if (req.body.full_name !== undefined) req.session.user.full_name = req.body.full_name;
  if (req.body.email !== undefined) req.session.user.email = req.body.email;
  if (req.body.student_id !== undefined) req.session.user.student_id = req.body.student_id;
  if (req.body.gender !== undefined) req.session.user.gender = req.body.gender;

  const updated = await queryOne(
    `SELECT id, full_name, student_id, email, gender, phone, department, level, created_at
       FROM users WHERE id = ?`,
    [req.session.user.id]
  );

  res.json({ success: true, message: 'Profile updated successfully.', data: updated });
});

/**
 * DELETE /api/students/profile
 * Body: { password }
 *
 * SOFT DEACTIVATION, not a real DELETE - the users table cannot be
 * hard-deleted for a student who has ever applied, been allocated a
 * room, or paid: applications.student_id CASCADEs (acceptable), but
 * payments.student_id and payments.application_id are RESTRICT
 * (database/hostel.sql), specifically so a payment record can
 * never disappear because the account behind it did. Attempting a real
 * DELETE on such an account would simply fail at the database level -
 * this endpoint does not attempt one at all, by design, not because a
 * DELETE was tried and worked around.
 *
 * Sets is_active = 0. authController.login already refuses a login
 * for any account where is_active is false - so deactivation
 * takes effect immediately with no change needed there.
 *
 * KNOWN LIMITATION: this destroys the CURRENT session only. A second
 * session for the same account open in another browser would remain
 * valid until it separately expires, since requireAuth/requireRole
 * (middleware/authMiddleware.js) check req.session.user, not a live
 * database lookup, on every request. Closing that gap would mean
 * re-checking is_active on every authenticated request across the
 * whole app - a broader change than this endpoint alone, better suited
 * to a dedicated security-hardening pass than folded silently in here.
 */
const deactivateAccount = asyncHandler(async (req, res) => {
  const user = await queryOne(`SELECT password FROM users WHERE id = ?`, [req.session.user.id]);

  const passwordMatches = await bcrypt.compare(req.body.password, user.password);
  if (!passwordMatches) {
    throw ApiError.badRequest('Incorrect password.');
  }

  await query(`UPDATE users SET is_active = 0 WHERE id = ? AND role = 'student'`, [req.session.user.id]);

  await new Promise((resolve, reject) => {
    req.session.destroy((err) => (err ? reject(err) : resolve()));
  });

  res.clearCookie('hostel.sid');
  res.json({ success: true, message: 'Your account has been deactivated.', data: null });
});

/**
 * GET /api/students/dashboard
 *
 * Returns everything the four dashboard cards need in one call
 * (docs/phase1-design.md, section 9, explains why this is one endpoint
 * rather than four). A student with no application or payment yet is
 * reported honestly as such; nothing is hardcoded.
 */
const getDashboard = asyncHandler(async (req, res) => {
  const studentId = req.session.user.id;

  // The student's most recent application, whatever its status. Not
  // just the "active" one (see active_key), because a rejected
  // application should still be visible on the dashboard until the
  // student submits a new one.
  const application = await queryOne(
    `SELECT a.id, a.status, a.room_type, a.rejection_reason,
            a.applied_at, a.reviewed_at, a.allocated_room_id, a.hostel_session_id,
            pb.name AS preferred_block
       FROM applications a
       LEFT JOIN blocks pb ON pb.id = a.preferred_block_id
      WHERE a.student_id = ?
      ORDER BY a.applied_at DESC
      LIMIT 1`,
    [studentId]
  );

  let room = null;
  let payment = null;

  if (application && application.allocated_room_id) {
    room = await queryOne(
      `SELECT r.room_number, r.room_type, b.name AS block_name
         FROM rooms r
         JOIN blocks b ON b.id = r.block_id
        WHERE r.id = ?`,
      [application.allocated_room_id]
    );
  }

  // Disambiguate "Approved - Awaiting Allocation" from
  // "Allocation Revoked" for the dashboard's status card - see
  // services/allocationStatusService.js for why applications.status
  // alone cannot tell these two apart.
  const allocationState = await resolveAllocationState(
    application && room
      ? { ...application, allocated_room_number: room.room_number, allocated_block_name: room.block_name }
      : application
  );

  let paymentStage = null;
  let feeBlockName = null;

  if (application) {
    // The hostel-fee payment of THIS application's OWN hostel session - never another
    // session's and never a miscellaneous charge - and a successful payment always wins
    // over a newer pending/failed attempt. (Before: the newest row by created_at of ANY
    // type or session, with no tie-break, so a later non-hostel or old-session row could
    // hide a paid fee.) Success without server-side verification evidence is shown as
    // pending, matching what the allocation gate accepts.
    const latestPayment = await readHostelPayment(application);

    let displayStatus = toDisplayPaymentStatus(latestPayment && latestPayment.status);
    if (latestPayment && latestPayment.status === 'success'
        && !(latestPayment.verified_at && latestPayment.paid_at && latestPayment.gateway_reference)) {
      displayStatus = 'pending';
    }

    payment = {
      status: displayStatus,
      reference: latestPayment ? latestPayment.payment_reference : null,
      amount: latestPayment ? latestPayment.amount : null,
      currency: latestPayment ? latestPayment.currency : null,
      paid_at: latestPayment ? latestPayment.paid_at : null,
    };

    feeBlockName = await readFeeBlockName(application.id);
    paymentStage = resolvePaymentStage({
      status: application.status,
      allocationState: allocationState.allocation_state,
      hasRoom: Boolean(room),
      hasFeeBlock: feeBlockName !== null,
      paymentStatus: displayStatus,
    });
  }

  res.json({
    success: true,
    message: 'Dashboard data retrieved.',
    data: {
      application: application
        ? {
            id: application.id,
            status: application.status,
            room_type: application.room_type,
            preferred_block: application.preferred_block,
            rejection_reason: application.rejection_reason,
            applied_at: application.applied_at,
            reviewed_at: application.reviewed_at,
            payment_stage: paymentStage,
            fee_block: feeBlockName,
            ...allocationState,
          }
        : null,
      room,     // null until an application is approved and allocated
      payment,  // null until an application exists at all
    },
  });
});

module.exports = { getProfile, updateProfile, deactivateAccount, getDashboard, resolvePaymentStage };
