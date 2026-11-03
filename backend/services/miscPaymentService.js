/**
 * services/miscPaymentService.js
 * ---------------------------------------------------------------
 * The student side of miscellaneous charges:
 * which charges apply to me, what is each one's payment state, and
 * starting a payment for ONE of them.
 *
 * Trust model (same as hostel fees, see paymentService.js):
 *  - The student comes from the login session; the browser sends only a
 *    charge id (in the URL). Amount, currency, fine, session, block and
 *    eligibility are all derived here from database rows.
 *  - Eligibility = ALL of:
 *      1. a hostel session is currently open;
 *      2. the student has an APPROVED application in THAT session;
 *      3. the charge is active, belongs to that session, and is either
 *         for everyone (block_id NULL) or for the block the student is
 *         tied to - the block of the ACTIVE allocation, or, before a room
 *         exists, the fee block an admin confirmed at approval (019);
 *      4. the student has not already paid it.
 *    Anything else looks like "no such charge" (404) so charge ids of other
 *    blocks/sessions cannot be probed.
 *  - Late fine: services read `NOW() > deadline_at` from the database and
 *    utils/lateFine.js adds the configured FIXED fine. The result is stored
 *    on the payment row (original_amount, late_fine_applied, amount).
 *  - Settlement (verify / webhook) is NOT here: it is the existing
 *    paymentService.verifyAndSettle(), which is payment-type aware.
 *  - A miscellaneous payment can never open the hostel-fee gate:
 *    paymentGate only counts payment_type = 'hostel'.
 * ---------------------------------------------------------------
 */

const crypto = require('crypto');
const { pool, withTransaction } = require('../config/database');
const ApiError = require('../utils/ApiError');
const { computeMiscAmount } = require('../utils/lateFine');
const { getCurrentSession } = require('./hostelSessionService');
const { getPaymentsSchema } = require('./paymentSchema');
const { assertMiscSchema } = require('./miscSchema');
const paystack = require('./paystackService');
const paymentService = require('./paymentService');

const NOT_AVAILABLE = 'This charge is not available to you.';

/* ---------------------------------------------------------------------
   Student context
   --------------------------------------------------------------------- */

/**
 * Current session + the student's approved application + the block they are tied to.
 * @returns {Promise<{ok:true, session, application, blockId:number|null, blockName:string|null} |
 *                   {ok:false, code:string, message:string}>}
 */
async function getStudentChargeContext(conn, studentId, { forUpdate = false } = {}) {
  let session;
  try {
    session = await getCurrentSession(conn);
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 409) {
      return { ok: false, code: 'no_open_session', message: 'No hostel session is currently open.' };
    }
    throw err;
  }

  const [appRows] = await conn.execute(
    `SELECT id, student_id, status, allocated_room_id, hostel_session_id
       FROM applications
      WHERE student_id = ? AND hostel_session_id = ?
      ORDER BY applied_at DESC, id DESC
      LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [studentId, session.id]
  );
  const application = appRows[0];
  if (!application) {
    return { ok: false, code: 'no_application', message: 'You have no hostel application for the current session.', session };
  }
  if (application.status !== 'approved') {
    return {
      ok: false, code: 'not_approved', session, application,
      message: `Your application is ${application.status}. Charges apply once it is approved.`,
    };
  }

  // The block the student is tied to: ACTIVE allocation first, else the confirmed fee block.
  let blockId = null;
  let blockName = null;
  const [allocRows] = await conn.execute(
    `SELECT r.block_id AS block_id, b.name AS block_name
       FROM allocations al
       JOIN rooms r ON r.id = al.room_id
       JOIN blocks b ON b.id = r.block_id
      WHERE al.application_id = ? AND al.hostel_session_id = ? AND al.status = 'active'`,
    [application.id, application.hostel_session_id]
  );
  if (allocRows.length > 1) {
    throw new ApiError(500, 'Your allocation records are inconsistent. Please contact the hostel administration.');
  }
  if (allocRows.length === 1) {
    blockId = Number(allocRows[0].block_id);
    blockName = allocRows[0].block_name;
  } else {
    try {
      const [feeRows] = await conn.execute(
        `SELECT a.fee_block_id AS block_id, b.name AS block_name
           FROM applications a
           LEFT JOIN blocks b ON b.id = a.fee_block_id
          WHERE a.id = ?`,
        [application.id]
      );
      if (feeRows[0] && feeRows[0].block_id !== null && feeRows[0].block_id !== undefined) {
        blockId = Number(feeRows[0].block_id);
        blockName = feeRows[0].block_name || null;
      }
    } catch (err) {
      if (!(err && err.code === 'ER_BAD_FIELD_ERROR')) throw err; // 019 not applied: no confirmed block
    }
  }
  return { ok: true, session, application, blockId, blockName };
}

/* ---------------------------------------------------------------------
   Listing
   --------------------------------------------------------------------- */

const CHARGE_SELECT = `
  SELECT c.id, c.name, c.description, c.amount, c.currency, c.is_required, c.deadline_at,
         c.late_fine_amount, c.block_id, b.name AS block_name,
         (c.deadline_at IS NOT NULL AND NOW() > c.deadline_at) AS past_deadline
    FROM hostel_misc_charges c
    LEFT JOIN blocks b ON b.id = c.block_id`;

function chargeView(charge, payments) {
  const mine = payments.filter((p) => Number(p.hostel_misc_charge_id) === Number(charge.id));
  const success = mine.find((p) => p.status === 'success');
  const pending = mine.find((p) => p.status === 'pending');
  const latest = mine[0] || null; // payments are ordered newest first

  let status = 'unpaid';
  if (success) status = 'paid';
  else if (pending) status = 'pending';
  else if (latest) status = latest.status === 'abandoned' ? 'failed' : latest.status; // failed | refunded

  const amounts = computeMiscAmount(charge, Number(charge.past_deadline) === 1);
  const view = {
    id: charge.id,
    name: charge.name,
    description: charge.description || null,
    currency: charge.currency,
    is_required: Number(charge.is_required) === 1,
    block_name: charge.block_name || null,
    deadline_at: charge.deadline_at || null,
    late_fine_amount: charge.late_fine_amount,
    amount: amounts.original,
    is_late: amounts.late,
    late_fine_due: amounts.fine,
    amount_due: amounts.total,
    status,
    can_pay: status !== 'paid' && status !== 'pending',
    paid: null,
  };
  if (success) {
    view.paid = {
      reference: success.payment_reference,
      amount: success.amount,
      original_amount: success.original_amount,
      late_fine_applied: success.late_fine_applied,
      currency: success.currency,
      paid_at: success.paid_at,
    };
    view.amount_due = '0.00';
    view.late_fine_due = '0.00';
  }
  return view;
}

/** GET /api/payments/misc-charges */
async function listEligibleCharges(studentId) {
  await assertMiscSchema(pool);
  await getPaymentsSchema(pool);
  const ctx = await getStudentChargeContext(pool, studentId);
  if (!ctx.ok) {
    return {
      eligible: false, reason: ctx.code, message: ctx.message,
      session: ctx.session ? { id: ctx.session.id, label: ctx.session.label } : null,
      charges: [],
    };
  }

  const [charges] = await pool.execute(
    `${CHARGE_SELECT}
      WHERE c.hostel_session_id = ? AND c.is_active = 1 AND (c.block_id IS NULL OR c.block_id = ?)
      ORDER BY c.is_required DESC, c.id ASC`,
    [ctx.session.id, ctx.blockId]
  );
  const [payments] = await pool.execute(
    `SELECT hostel_misc_charge_id, status, payment_reference, amount, original_amount,
            late_fine_applied, currency, paid_at, created_at
       FROM payments
      WHERE application_id = ? AND hostel_session_id = ? AND payment_type = 'miscellaneous'
      ORDER BY id DESC`,
    [ctx.application.id, ctx.application.hostel_session_id]
  );

  return {
    eligible: true, reason: null, message: null,
    session: { id: ctx.session.id, label: ctx.session.label },
    block_name: ctx.blockName,
    charges: charges.map((c) => chargeView(c, payments)),
  };
}

/** GET /api/payments/history - the student's OWN payments of every type and session. */
async function getPaymentHistory(studentId) {
  await assertMiscSchema(pool);
  const [rows] = await pool.execute(
    `SELECT p.payment_type, p.payment_reference, p.status, p.amount, p.original_amount,
            p.late_fine_applied, p.currency, p.paid_at, p.created_at,
            hs.label AS session_label, c.name AS charge_name
       FROM payments p
       JOIN hostel_sessions hs ON hs.id = p.hostel_session_id
       LEFT JOIN hostel_misc_charges c ON c.id = p.hostel_misc_charge_id
      WHERE p.student_id = ?
      ORDER BY p.id DESC
      LIMIT 100`,
    [studentId]
  );
  return rows.map((r) => ({
    type: r.payment_type,
    description: r.payment_type === 'miscellaneous' ? (r.charge_name || 'Miscellaneous charge') : 'Hostel fee',
    session_label: r.session_label,
    reference: r.payment_reference,
    status: r.status,
    amount: r.amount,
    original_amount: r.original_amount,
    late_fine_applied: r.late_fine_applied,
    currency: r.currency,
    paid_at: r.paid_at || null,
    created_at: r.created_at,
  }));
}

/* ---------------------------------------------------------------------
   Initialize
   --------------------------------------------------------------------- */

function newMiscReference(applicationId, chargeId) {
  // <= 80 chars, Paystack-safe: LASU-MC-<application>-<charge>-<time36>-<12 hex>
  return `${paymentService.MISC_REF_PREFIX}${applicationId}-${chargeId}-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * POST /api/payments/misc-charges/:chargeId/initialize
 * @param {{studentId:number, chargeId:number}} args  chargeId is only a lookup key.
 */
async function initializeMiscPayment({ studentId, chargeId }) {
  if (!Number.isSafeInteger(chargeId) || chargeId <= 0) throw ApiError.notFound(NOT_AVAILABLE);
  paystack.assertConfigured(); // before any database write
  const callbackUrl = paymentService.getCallbackUrl();
  await assertMiscSchema(pool);
  await getPaymentsSchema(pool);

  // 1. Settle or close earlier attempts for THIS application + charge first, so a student
  //    who already paid (closed the tab) is never charged twice.
  const preview = await getStudentChargeContext(pool, studentId);
  if (!preview.ok) throw ApiError.conflict(preview.message);
  const [pending] = await pool.execute(
    `SELECT payment_reference FROM payments
      WHERE application_id = ? AND hostel_session_id = ? AND payment_type = 'miscellaneous'
        AND hostel_misc_charge_id = ? AND status = 'pending'
      ORDER BY id DESC LIMIT 5`,
    [preview.application.id, preview.application.hostel_session_id, chargeId]
  );
  for (const row of pending) {
    const outcome = await paymentService.verifyAndSettle(row.payment_reference, { studentId, closeIfUnknown: true });
    if (outcome.status === 'success') throw ApiError.conflict('You have already paid this charge.');
    if (outcome.status === 'pending') {
      throw ApiError.conflict('A payment for this charge is already in progress. Please wait a moment, then check your payment status.');
    }
  }

  // 2. Re-resolve under locks and record the intended payment.
  const created = await withTransaction(async (conn) => {
    const ctx = await getStudentChargeContext(conn, studentId, { forUpdate: true });
    if (!ctx.ok) throw ApiError.conflict(ctx.message);

    // LOCK IN SHARE MODE: an admin edit/deactivation of this charge waits until we commit,
    // and the amount we read is the amount we store.
    const [chargeRows] = await conn.execute(
      `${CHARGE_SELECT}
        WHERE c.id = ? AND c.hostel_session_id = ? AND c.is_active = 1 AND (c.block_id IS NULL OR c.block_id = ?)
        LOCK IN SHARE MODE`,
      [chargeId, ctx.session.id, ctx.blockId]
    );
    const charge = chargeRows[0];
    if (!charge) throw ApiError.notFound(NOT_AVAILABLE);

    const [paid] = await conn.execute(
      `SELECT id FROM payments
        WHERE application_id = ? AND hostel_session_id = ? AND payment_type = 'miscellaneous'
          AND hostel_misc_charge_id = ? AND status = 'success'
        LIMIT 1`,
      [ctx.application.id, ctx.application.hostel_session_id, chargeId]
    );
    if (paid[0]) throw ApiError.conflict('You have already paid this charge.');

    const [stillPending] = await conn.execute(
      `SELECT id FROM payments
        WHERE application_id = ? AND hostel_session_id = ? AND payment_type = 'miscellaneous'
          AND hostel_misc_charge_id = ? AND status = 'pending'
        LIMIT 1`,
      [ctx.application.id, ctx.application.hostel_session_id, chargeId]
    );
    if (stillPending[0]) {
      throw ApiError.conflict('A payment for this charge is already being started. Please wait a moment, then check your payment status.');
    }

    const [userRows] = await conn.execute(
      `SELECT email FROM users WHERE id = ? AND role = 'student' AND is_active = 1`,
      [studentId]
    );
    if (!userRows[0]) throw ApiError.forbidden('Your account cannot make payments.');

    let amounts;
    try {
      amounts = computeMiscAmount(charge, Number(charge.past_deadline) === 1);
    } catch (err) {
      console.error(`[misc-payments] charge ${charge.id} has an invalid stored amount: ${err.message}`);
      throw new ApiError(500, 'This charge is not valid. Please contact the hostel administration.');
    }

    const reference = newMiscReference(ctx.application.id, charge.id);
    const [result] = await conn.execute(
      `INSERT INTO payments (student_id, application_id, hostel_session_id, payment_type, hostel_misc_charge_id,
                             amount, original_amount, late_fine_applied, currency, payment_reference,
                             payment_gateway, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        studentId, ctx.application.id, ctx.application.hostel_session_id, 'miscellaneous', charge.id,
        amounts.total, amounts.original, amounts.fine, charge.currency, reference,
        'paystack', 'pending',
      ]
    );
    return {
      paymentId: result.insertId, reference, email: userRows[0].email, amounts,
      currency: charge.currency, chargeId: charge.id, applicationId: ctx.application.id,
      hostelSessionId: ctx.application.hostel_session_id,
    };
  });

  // 3. Paystack checkout (network call, outside the transaction).
  try {
    const checkout = await paystack.initializeTransaction({
      email: created.email,
      amountMinor: created.amounts.total_minor,
      currency: created.currency,
      reference: created.reference,
      callbackUrl,
      metadata: {
        payment_type: 'miscellaneous',
        misc_charge_id: created.chargeId,
        application_id: created.applicationId,
        student_id: studentId,
        hostel_session_id: created.hostelSessionId,
      },
    });
    return {
      authorization_url: checkout.authorization_url,
      reference: created.reference,
      amount: created.amounts.total,
      original_amount: created.amounts.original,
      late_fine_applied: created.amounts.fine,
      currency: created.currency,
    };
  } catch (err) {
    await pool.execute(
      `UPDATE payments SET status = 'failed' WHERE id = ? AND status = 'pending'`,
      [created.paymentId]
    );
    throw err;
  }
}

module.exports = { listEligibleCharges, getPaymentHistory, initializeMiscPayment, getStudentChargeContext, newMiscReference };
