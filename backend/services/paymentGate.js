/**
 * services/paymentGate.js
 * ---------------------------------------------------------------
 * PAYMENT-BEFORE-ALLOCATION gate.
 *
 * allocationService.allocateRoom() calls assertHostelFeePaid() INSIDE its
 * existing transaction, after the application and room rows are locked and
 * before anything is written. If it throws, nothing has been written and the
 * transaction rolls back like any other refusal. The browser has no say: this
 * reads only database rows that paymentService.verifyAndSettle() writes after
 * OUR server has asked Paystack about the transaction.
 *
 * A payment authorises allocating THIS application to a room in THIS block
 * only when ALL of these hold:
 *   1. exactly one payments row for this application + hostel session has
 *      status = 'success' (and payment_type = 'hostel' where that column exists,
 *      so a miscellaneous charge can never stand in for the hostel fee);
 *   2. it belongs to the application's student;
 *   3. it carries server-side verification evidence: verified_at, paid_at and
 *      the gateway's own reference are all set (a row someone flipped to
 *      'success' by hand, without verification, is refused);
 *   4. its fee row (hostel_fee_id) is for the application's session, for the
 *      SAME BLOCK as the room being allocated and, when the application has a
 *      confirmed fee block, for that block;
 *   5. the amount paid and its currency equal that fee row's amount and
 *      currency (compared in integer minor units, never as floats).
 * Pending, failed, abandoned and refunded payments are never 'success', so
 * they authorise nothing.
 *
 * Deliberately NOT done here: it does not re-price against today's active fee.
 * The fee the student was shown and paid is the payments row's own fee row;
 * a later fee revision must not strand a student who already paid.
 *
 * Fails closed: if the payments table lacks the migration-013 columns,
 * paymentSchema throws 503 and the allocation is refused.
 * ---------------------------------------------------------------
 */

const ApiError = require('../utils/ApiError');
const { decimalToMinor } = require('../utils/money');
const { getPaymentsSchema } = require('./paymentSchema');

const CONTACT_ADMIN = 'Please check the payment record before allocating.';

const NOT_PAID_MESSAGE = {
  none: 'A verified, successful hostel-fee payment is required before a room can be allocated. This student has not paid.',
  pending: 'The hostel-fee payment has not been verified as successful (it is still pending), so a room cannot be allocated yet.',
  failed: 'The student\'s last hostel-fee payment attempt did not succeed, so a room cannot be allocated.',
  abandoned: 'The student\'s last hostel-fee payment attempt was not completed, so a room cannot be allocated.',
  refunded: 'The hostel-fee payment was refunded, so it no longer covers a room. A new successful payment is required.',
};

/** Confirmed fee block (migration 019). NULL when unset or when 019 has not been applied. */
async function readFeeBlockId(conn, applicationId) {
  try {
    const [rows] = await conn.execute(
      `SELECT fee_block_id FROM applications WHERE id = ?`,
      [applicationId]
    );
    return rows[0] && rows[0].fee_block_id !== null && rows[0].fee_block_id !== undefined
      ? Number(rows[0].fee_block_id)
      : null;
  } catch (err) {
    if (err && err.code === 'ER_BAD_FIELD_ERROR') return null; // 019 not applied on this database
    throw err;
  }
}

function refuse(paymentId, detail, message) {
  console.error(`[payment-gate] payment ${paymentId} refused allocation: ${detail}`);
  return ApiError.conflict(message);
}

/**
 * @param {object} conn the allocation transaction's connection
 * @param {{id:number, student_id:number, hostel_session_id:number}} application
 * @param {{block_id:number, block_name?:string}} room the room being allocated
 * @returns {Promise<{payment_id:number, payment_reference:string, hostel_fee_id:number,
 *                    block_id:number, amount:string, currency:string}>}
 * @throws {ApiError} 409 (not paid / mismatched) or 500/503 (integrity / unavailable)
 */
async function assertHostelFeePaid(conn, application, room) {
  const schema = await getPaymentsSchema(conn);
  const typedFilter = schema.typed ? `AND p.payment_type = 'hostel'` : '';

  const [paidRows] = await conn.execute(
    `SELECT p.id, p.student_id, p.application_id, p.hostel_session_id, p.hostel_fee_id,
            p.amount, p.currency, p.status, p.payment_reference, p.gateway_reference,
            p.verified_at, p.paid_at,
            f.hostel_session_id AS fee_session_id, f.block_id AS fee_block_id,
            f.amount AS fee_amount, f.currency AS fee_currency, fb.name AS fee_block_name
       FROM payments p
       JOIN hostel_fees f ON f.id = p.hostel_fee_id
       JOIN blocks fb ON fb.id = f.block_id
      WHERE p.application_id = ? AND p.hostel_session_id = ? AND p.status = 'success'
        ${typedFilter}
      LOCK IN SHARE MODE`,
    [application.id, application.hostel_session_id]
  );

  if (paidRows.length === 0) {
    const [latest] = await conn.execute(
      `SELECT p.status FROM payments p
        WHERE p.application_id = ? AND p.hostel_session_id = ?
          ${typedFilter}
        ORDER BY p.id DESC LIMIT 1`,
      [application.id, application.hostel_session_id]
    );
    const reason = latest[0] && NOT_PAID_MESSAGE[latest[0].status] ? latest[0].status : 'none';
    throw ApiError.conflict(NOT_PAID_MESSAGE[reason]);
  }
  if (paidRows.length > 1) {
    // The unique key on successful hostel payments (hostel_paid_key; uq_paid_application
    // before migration 020) makes this impossible; if it ever happens, never guess.
    throw new ApiError(500, `This application has more than one successful payment. ${CONTACT_ADMIN}`);
  }

  const p = paidRows[0];

  if (Number(p.student_id) !== Number(application.student_id)) {
    throw refuse(p.id, 'payment belongs to a different student', `The successful payment on file does not belong to this student. ${CONTACT_ADMIN}`);
  }
  if (Number(p.hostel_session_id) !== Number(application.hostel_session_id)) {
    throw refuse(p.id, 'payment is for a different hostel session', `The successful payment on file is for a different hostel session. ${CONTACT_ADMIN}`);
  }
  if (!p.verified_at || !p.paid_at || !p.gateway_reference) {
    throw refuse(p.id, 'no server-side verification evidence', `The payment on file is marked successful but has no server-side verification record, so it cannot authorise a room. ${CONTACT_ADMIN}`);
  }
  if (Number(p.fee_session_id) !== Number(application.hostel_session_id)) {
    throw refuse(p.id, 'fee row is for a different session', `The payment was made against a fee from a different hostel session. ${CONTACT_ADMIN}`);
  }
  if (Number(p.fee_block_id) !== Number(room.block_id)) {
    throw refuse(
      p.id,
      `paid block ${p.fee_block_id} but room is in block ${room.block_id}`,
      `This student paid the fee for ${p.fee_block_name}. Allocate a room in ${p.fee_block_name}; ` +
      `${room.block_name ? `${room.block_name} is a different block` : 'the selected room is in a different block'}.`
    );
  }

  const confirmedBlock = await readFeeBlockId(conn, application.id);
  if (confirmedBlock !== null && confirmedBlock !== Number(p.fee_block_id)) {
    throw refuse(p.id, `application fee block ${confirmedBlock} differs from paid fee block ${p.fee_block_id}`, `The paid fee block does not match the fee block confirmed for this application. ${CONTACT_ADMIN}`);
  }

  if (p.currency !== p.fee_currency) {
    throw refuse(p.id, `currency ${p.currency} vs fee ${p.fee_currency}`, `The payment currency does not match the hostel fee currency. ${CONTACT_ADMIN}`);
  }
  let paidMinor;
  let feeMinor;
  try {
    paidMinor = decimalToMinor(p.amount, p.currency);
    feeMinor = decimalToMinor(p.fee_amount, p.fee_currency);
  } catch (err) {
    throw new ApiError(500, `The payment amount on file is not valid. ${CONTACT_ADMIN}`);
  }
  if (paidMinor !== feeMinor) {
    throw refuse(p.id, `paid ${paidMinor} minor units vs fee ${feeMinor}`, `The amount paid does not match the hostel fee for ${p.fee_block_name}. ${CONTACT_ADMIN}`);
  }

  return {
    payment_id: p.id,
    payment_reference: p.payment_reference,
    hostel_fee_id: p.hostel_fee_id,
    block_id: Number(p.fee_block_id),
    amount: p.amount,
    currency: p.currency,
  };
}

module.exports = { assertHostelFeePaid };
