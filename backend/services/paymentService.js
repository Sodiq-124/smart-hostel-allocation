/**
 * services/paymentService.js
 * ---------------------------------------------------------------
 * Hostel-fee payments through Paystack.
 *
 * What is trusted, and what is not
 * --------------------------------
 *  - The AMOUNT is never supplied by the browser. It comes from
 *    feeService.getHostelFeeForApplication() (the application's own
 *    session + the block of its ACTIVE allocation, or - before any room
 *    exists - the fee block an admin confirmed at approval) and is stored on the
 *    payments row BEFORE the student is sent to Paystack.
 *  - A payment becomes 'success' only when OUR SERVER asks Paystack
 *    (GET /transaction/verify) and Paystack says success with the
 *    same reference, the same currency and exactly the stored amount in
 *    kobo. A reference, a "success" query string or a webhook body is
 *    only a pointer to a row; none of them is believed.
 *  - Idempotent: settling is a single guarded UPDATE
 *    (... WHERE status <> 'success'), so verifying twice, a callback
 *    racing a webhook, or a page refresh all end in the same state.
 *  - One successful hostel payment per application + session is
 *    enforced by the database (generated unique key). A second paid
 *    transaction for the same application is NOT recorded as success;
 *    it is logged for a manual refund.
 *
 * Schema (verified from database/hostel.sql + migrations 013 and 017):
 *   payments(id, student_id, application_id, hostel_session_id,
 *     hostel_fee_id, [payment_type, hostel_misc_charge_id,]
 *     amount, [original_amount, late_fine_applied,] currency,
 *     payment_reference, gateway_reference, payment_gateway,
 *     payment_channel, status ENUM('pending','success','failed',
 *     'abandoned','refunded'), verified_at, paid_at, ...)
 * Migration 017's columns are used when - and only when - they exist
 * (checked once against information_schema), so this works on a 013-only
 * database too. If the 013 columns are missing the service refuses to
 * run (503) instead of guessing.
 * ---------------------------------------------------------------
 */

const crypto = require('crypto');
const { pool, withTransaction } = require('../config/database');
const ApiError = require('../utils/ApiError');
const { decimalToMinor } = require('../utils/money');
const { getCurrentSession } = require('./hostelSessionService');
const { getHostelFeeForApplication } = require('./feeService');
const paystack = require('./paystackService');

/* ---------------------------------------------------------------------
   Schema guard
   --------------------------------------------------------------------- */

// The payments-table shape check lives in ./paymentSchema (shared with paymentGate).
const { getPaymentsSchema, resetSchemaCache } = require('./paymentSchema');

/* ---------------------------------------------------------------------
   Eligibility: which application can this student pay for, and how much?
   --------------------------------------------------------------------- */

const REFUSALS = {
  no_open_session: 'No hostel session is currently open.',
  no_application: 'You have no hostel application for the current session.',
};

/**
 * Resolves the student's payable application for the CURRENT open session.
 * Ownership is built into the query (applications.student_id = ?).
 *
 * @returns {Promise<{ok:true, session, application, fee} |
 *                   {ok:false, code:string, message:string, session?, application?, paid?}>}
 */
async function getPaymentContext(conn, studentId, { forUpdate = false } = {}) {
  const schema = await getPaymentsSchema(conn);

  let session;
  try {
    session = await getCurrentSession(conn);
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 409) {
      return { ok: false, code: 'no_open_session', message: REFUSALS.no_open_session };
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
    return { ok: false, code: 'no_application', message: REFUSALS.no_application, session };
  }

  // Already paid? Reported even if the allocation has since changed.
  const [paidRows] = await conn.execute(
    `SELECT payment_reference, amount, currency, paid_at
       FROM payments
      WHERE application_id = ? AND hostel_session_id = ? AND status = 'success'
        ${schema.typed ? "AND payment_type = 'hostel'" : ''}
      LIMIT 1`,
    [application.id, application.hostel_session_id]
  );
  if (paidRows[0]) {
    return {
      ok: false, code: 'already_paid', session, application, paid: paidRows[0],
      message: 'Your hostel fee for this session has already been paid.',
    };
  }

  if (application.status !== 'approved') {
    return {
      ok: false, code: 'not_approved', session, application,
      message: `Your application is ${application.status}. Payment opens once it is approved and the hostel administration has confirmed your fee block.`,
    };
  }

  let fee;
  try {
    fee = await getHostelFeeForApplication(conn, application.id);
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 409) {
      return { ok: false, code: 'not_payable', message: err.message, session, application };
    }
    throw err; // 500 = data-integrity problem; never price a guess
  }

  return { ok: true, session, application, fee };
}

function publicFee(fee) {
  return {
    amount: fee.amount,
    currency: fee.currency,
    block_name: fee.block_name,
    room_number: fee.room_number,
    room_type: fee.room_type,
  };
}

/** GET /api/payments/status - everything payment.html needs. Read-only. */
async function getPaymentStatus(studentId) {
  const ctx = await getPaymentContext(pool, studentId);
  const { typed } = await getPaymentsSchema(pool);

  let history = [];
  if (ctx.application) {
    const [rows] = await pool.execute(
      `SELECT payment_reference, status, amount, currency, paid_at, created_at
         FROM payments
        WHERE application_id = ? AND hostel_session_id = ?${typed ? " AND payment_type = 'hostel'" : ''}
        ORDER BY id DESC
        LIMIT 5`,
      [ctx.application.id, ctx.application.hostel_session_id]
    );
    history = rows;
  }

  return {
    eligible: ctx.ok,
    reason: ctx.ok ? null : ctx.code,
    message: ctx.ok ? null : ctx.message,
    session: ctx.session ? { id: ctx.session.id, label: ctx.session.label } : null,
    application: ctx.application
      ? { id: ctx.application.id, status: ctx.application.status, room_allocated: Boolean(ctx.application.allocated_room_id) }
      : null,
    fee: ctx.ok ? publicFee(ctx.fee) : null,
    paid: ctx.paid || null,
    history,
  };
}

/* ---------------------------------------------------------------------
   Initialize
   --------------------------------------------------------------------- */

const HOSTEL_REF_PREFIX = 'LASU-HF-';
const MISC_REF_PREFIX = 'LASU-MC-';

function newReference(applicationId) {
  // Paystack references allow letters, digits, - . =   (<= 80 chars here)
  return `LASU-HF-${applicationId}-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
}

function getCallbackUrl() {
  const url = process.env.PAYMENT_CALLBACK_URL || '';
  if (!/^https?:\/\/\S+$/.test(url)) {
    console.error('[payments] PAYMENT_CALLBACK_URL is missing or not an http(s) URL.');
    throw new ApiError(503, 'Online payment is temporarily unavailable. Please try again later.');
  }
  return url;
}

/**
 * POST /api/payments/initialize
 * The browser sends NOTHING that matters: the student comes from the
 * session; application, amount and currency come from the database.
 */
async function initializePayment({ studentId }) {
  paystack.assertConfigured(); // before any database write
  const callbackUrl = getCallbackUrl();
  const schema = await getPaymentsSchema(pool);

  // 1. Settle or close any earlier attempt BEFORE creating a new one, so a
  //    student who already paid (e.g. closed the tab) is never charged twice.
  const preview = await getPaymentContext(pool, studentId);
  if (!preview.ok && preview.code !== 'not_payable') {
    throw ApiError.conflict(preview.message);
  }
  if (preview.application) {
    const [pending] = await pool.execute(
      `SELECT payment_reference FROM payments
        WHERE application_id = ? AND hostel_session_id = ? AND status = 'pending'${schema.typed ? " AND payment_type = 'hostel'" : ''}
        ORDER BY id DESC LIMIT 5`,
      [preview.application.id, preview.application.hostel_session_id]
    );
    for (const row of pending) {
      const outcome = await verifyAndSettle(row.payment_reference, { studentId, closeIfUnknown: true });
      if (outcome.status === 'success') {
        throw ApiError.conflict('Your hostel fee for this session has already been paid.');
      }
      if (outcome.status === 'pending') {
        throw ApiError.conflict('A payment is already in progress. Please wait a moment, then check your payment status.');
      }
    }
  }

  // 2. Re-resolve under a row lock and record the intended payment.
  const created = await withTransaction(async (conn) => {
    const ctx = await getPaymentContext(conn, studentId, { forUpdate: true });
    if (!ctx.ok) throw ApiError.conflict(ctx.message);

    const [stillPending] = await conn.execute(
      `SELECT id FROM payments
        WHERE application_id = ? AND hostel_session_id = ? AND status = 'pending'${schema.typed ? " AND payment_type = 'hostel'" : ''}
        LIMIT 1`,
      [ctx.application.id, ctx.application.hostel_session_id]
    );
    if (stillPending[0]) {
      throw ApiError.conflict('A payment is already being started. Please wait a moment, then check your payment status.');
    }

    const [userRows] = await conn.execute(
      `SELECT email FROM users WHERE id = ? AND role = 'student' AND is_active = 1`,
      [studentId]
    );
    if (!userRows[0]) throw ApiError.forbidden('Your account cannot make payments.');

    const reference = newReference(ctx.application.id);
    const columns = [
      'student_id', 'application_id', 'hostel_session_id', 'hostel_fee_id',
      'amount', 'currency', 'payment_reference', 'payment_gateway', 'status',
    ];
    const values = [
      studentId, ctx.application.id, ctx.application.hostel_session_id, ctx.fee.hostel_fee_id,
      ctx.fee.amount, ctx.fee.currency, reference, 'paystack', 'pending',
    ];
    if (schema.typed) {
      // migration 017 CHECK: amount = original_amount + late_fine_applied
      columns.push('payment_type', 'original_amount', 'late_fine_applied');
      values.push('hostel', ctx.fee.amount, '0.00');
    }
    const [result] = await conn.execute(
      `INSERT INTO payments (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      values
    );

    return {
      paymentId: result.insertId,
      reference,
      email: userRows[0].email,
      fee: ctx.fee,
      applicationId: ctx.application.id,
      hostelSessionId: ctx.application.hostel_session_id,
    };
  });

  // 3. Ask Paystack for a checkout page (network call: outside the transaction).
  try {
    const checkout = await paystack.initializeTransaction({
      email: created.email,
      amountMinor: created.fee.amount_minor,
      currency: created.fee.currency,
      reference: created.reference,
      callbackUrl,
      metadata: {
        application_id: created.applicationId,
        student_id: studentId,
        hostel_session_id: created.hostelSessionId,
        hostel_fee_id: created.fee.hostel_fee_id,
      },
    });
    return {
      authorization_url: checkout.authorization_url,
      reference: created.reference,
      amount: created.fee.amount,
      currency: created.fee.currency,
    };
  } catch (err) {
    await pool.execute(
      `UPDATE payments SET status = 'failed' WHERE id = ? AND status = 'pending'`,
      [created.paymentId]
    );
    throw err;
  }
}

/* ---------------------------------------------------------------------
   Verify + settle (callback page, webhook and initialize all use this)
   --------------------------------------------------------------------- */

function toView(row) {
  return {
    payment_type: row.payment_type || 'hostel',
    reference: row.payment_reference,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    paid_at: row.paid_at || null,
  };
}

async function loadPayment(conn, reference) {
  const { typed } = await getPaymentsSchema(conn);
  const [rows] = await conn.execute(
    `SELECT id, student_id, application_id, hostel_session_id, amount, currency,
            payment_reference, status, paid_at${typed ? ', payment_type, hostel_misc_charge_id, original_amount' : ''}
       FROM payments
      WHERE payment_reference = ?`,
    [reference]
  );
  return rows[0] || null;
}

/**
 * A payments row must be internally consistent before it is settled.
 *  - hostel rows must carry a hostel reference (never a miscellaneous one);
 *  - miscellaneous rows must carry a LASU-MC-<application>-<charge>- reference that matches
 *    their own application and charge ids, point at a real charge of the SAME session, belong to
 *    an application of the SAME student and session, and record original_amount = the charge amount
 *    (the amount is locked once payments exist). Anything else is left unsettled and logged.
 */
async function assertPaymentConsistent(conn, payment) {
  const type = payment.payment_type || 'hostel';
  const ref = payment.payment_reference;
  const bad = (why) => {
    console.error(`[payments] payment ${payment.id} (${ref}) failed consistency check: ${why}`);
    return ApiError.conflict('This payment could not be confirmed. Please contact the hostel administration.');
  };

  if (type === 'hostel') {
    if (ref.startsWith(MISC_REF_PREFIX)) throw bad('hostel row with a miscellaneous reference');
    return;
  }
  if (type !== 'miscellaneous') throw bad(`unknown payment type ${type}`);
  if (!payment.hostel_misc_charge_id) throw bad('miscellaneous row without a charge');
  if (!ref.startsWith(`${MISC_REF_PREFIX}${payment.application_id}-${payment.hostel_misc_charge_id}-`)) {
    throw bad('reference does not match the row\'s application and charge');
  }
  const [chargeRows] = await conn.execute(
    `SELECT id, hostel_session_id, amount, currency FROM hostel_misc_charges WHERE id = ?`,
    [payment.hostel_misc_charge_id]
  );
  const charge = chargeRows[0];
  if (!charge) throw bad('charge not found');
  if (Number(charge.hostel_session_id) !== Number(payment.hostel_session_id)) throw bad('charge belongs to another session');
  const [appRows] = await conn.execute(
    `SELECT id, student_id, hostel_session_id FROM applications WHERE id = ?`,
    [payment.application_id]
  );
  const application = appRows[0];
  if (!application || Number(application.student_id) !== Number(payment.student_id) ||
      Number(application.hostel_session_id) !== Number(payment.hostel_session_id)) {
    throw bad('application does not belong to the paying student/session');
  }
  if (charge.currency !== payment.currency ||
      decimalToMinor(charge.amount, charge.currency) !== decimalToMinor(payment.original_amount, payment.currency)) {
    throw bad('original_amount differs from the charge amount');
  }
}

/**
 * Ask Paystack, then update our row. Safe to call any number of times.
 *
 * @param {string} reference         lookup key only (never believed)
 * @param {object} [opts]
 * @param {number|null} [opts.studentId]  when set, the row must belong to this student
 * @param {boolean} [opts.closeIfUnknown] mark the row 'abandoned' if Paystack has never heard of it
 * @returns {Promise<{status:string, payment:object}>}
 */
async function verifyAndSettle(reference, { studentId = null, closeIfUnknown = false } = {}) {
  if (typeof reference !== 'string' || reference.length === 0 || reference.length > 80) {
    throw ApiError.notFound('Payment not found.');
  }

  let payment = await loadPayment(pool, reference);
  // Someone else's reference looks exactly like a non-existent one.
  if (!payment || (studentId !== null && payment.student_id !== studentId)) {
    throw ApiError.notFound('Payment not found.');
  }
  if (payment.status === 'success') {
    return { status: 'success', payment: toView(payment) };
  }
  if (payment.status === 'refunded') {
    return { status: 'refunded', payment: toView(payment) };
  }

  // Payment type, reference family and (for miscellaneous payments) the charge/application/
  // student linkage must all agree BEFORE anything is settled.
  await assertPaymentConsistent(pool, payment);

  // Use OUR stored reference, not the browser's spelling of it.
  const remote = await paystack.verifyTransaction(payment.payment_reference);

  if (remote === null) {
    if (closeIfUnknown) {
      await pool.execute(`UPDATE payments SET status = 'abandoned' WHERE id = ? AND status = 'pending'`, [payment.id]);
      payment = await loadPayment(pool, reference);
    }
    return { status: payment.status, payment: toView(payment) };
  }

  if (remote.reference !== payment.payment_reference) {
    console.error(`[payments] reference mismatch for payment ${payment.id}: provider returned a different reference.`);
    throw ApiError.conflict('This payment could not be confirmed. Please contact the hostel administration.');
  }

  if (remote.status === 'success') {
    const expectedMinor = decimalToMinor(payment.amount, payment.currency);
    if (remote.currency !== payment.currency || remote.amount !== expectedMinor) {
      console.error(
        `[payments] AMOUNT/CURRENCY MISMATCH payment ${payment.id} ref ${payment.payment_reference}: ` +
        `expected ${expectedMinor} ${payment.currency}, provider says ${remote.amount} ${remote.currency}. Left pending.`
      );
      throw ApiError.conflict(
        `This payment could not be confirmed because the amount did not match. ` +
        `Please contact the hostel administration and quote reference ${payment.payment_reference}.`
      );
    }

    try {
      await pool.execute(
        `UPDATE payments
            SET status = 'success', gateway_reference = ?, payment_channel = ?,
                verified_at = NOW(), paid_at = NOW()
          WHERE id = ? AND status IN ('pending', 'abandoned', 'failed')`,
        [remote.id, remote.channel ? remote.channel.slice(0, 30) : null, payment.id]
      );
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') {
        // The database allows ONE successful payment per application+session.
        const isMisc = payment.payment_type === 'miscellaneous';
        console.error(
          `[payments] DUPLICATE PAID TRANSACTION: ref ${payment.payment_reference} (payment ${payment.id}, ${isMisc ? `miscellaneous charge ${payment.hostel_misc_charge_id}` : 'hostel fee'}) was paid ` +
          `at Paystack but application ${payment.application_id} already has a successful ${isMisc ? 'payment for that charge' : 'payment'}. REFUND MANUALLY.`
        );
        throw ApiError.conflict(
          `${isMisc ? 'This charge was already paid' : 'Your hostel fee was already paid'}, and this second transaction was not recorded. ` +
          `Please contact the hostel administration about a refund and quote reference ${payment.payment_reference}.`
        );
      }
      throw err;
    }
  } else if (remote.status === 'failed' || remote.status === 'reversed') {
    await pool.execute(`UPDATE payments SET status = 'failed' WHERE id = ? AND status = 'pending'`, [payment.id]);
  } else if (remote.status === 'abandoned') {
    await pool.execute(`UPDATE payments SET status = 'abandoned' WHERE id = ? AND status = 'pending'`, [payment.id]);
  }
  // any other provider status (ongoing, pending, processing, queued) stays 'pending'

  payment = await loadPayment(pool, reference);
  return { status: payment.status, payment: toView(payment) };
}

/* ---------------------------------------------------------------------
   Webhook (signature already checked by the controller)
   --------------------------------------------------------------------- */

/**
 * Only 'charge.success' matters. The body is NOT believed: it only names a
 * reference, which is then verified with Paystack exactly like a callback.
 * @returns {Promise<{handled:boolean}>}
 */
async function handleWebhookEvent(event) {
  if (!event || event.event !== 'charge.success' || !event.data || typeof event.data.reference !== 'string') {
    return { handled: false };
  }
  try {
    await verifyAndSettle(event.data.reference);
    return { handled: true };
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 404) return { handled: false }; // not one of ours
    throw err;
  }
}

module.exports = {
  getPaymentStatus,
  initializePayment,
  verifyAndSettle,
  handleWebhookEvent,
  getPaymentContext,
  resetSchemaCache,
  // Reused by miscellaneous payments:
  getCallbackUrl,
  MISC_REF_PREFIX,
};
