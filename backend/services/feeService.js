/**
 * services/feeService.js
 * ---------------------------------------------------------------
 * The server-authoritative hostel fee.
 *
 * The hostel fee is chosen by exactly two facts, both read from the
 * database, never from the client:
 *
 *   applications.hostel_session_id -> the APPLICATION's own session
 *       (not "today's" current session, so history stays correct
 *       after a rollover)
 *   rooms.block_id                 -> the block of the room the
 *       application is ACTIVELY allocated to
 *
 * Relationships used (all enforced by foreign keys):
 *   applications.id = allocations.application_id
 *   (allocations.application_id, allocations.hostel_session_id)
 *       -> (applications.id, applications.hostel_session_id)   composite FK
 *   allocations.room_id = rooms.id,  rooms.block_id = blocks.id
 *   hostel_fees (hostel_session_id, block_id, active = 1)  one per pair
 *
 * PAYMENT-BEFORE-ALLOCATION: an APPROVED application with no room yet is priced from
 * applications.fee_block_id (migration 019), the block an admin confirmed; see
 * getHostelFeeForConfirmedBlock(). Once a room is allocated the room's block is used,
 * exactly as before.
 *
 * room_type plays no part. Legacy single/shared fee rows (block_id
 * NULL, inactive) can never match because the lookup demands a block
 * and active = 1.
 *
 * This service only PRICES. It does not create payments and does not
 * decide whether a student may pay (application status, current-session
 * and "already paid" gates belong to payment initialisation).
 *
 * `conn` is any mysql2 promise object with execute(): a connection from
 * withTransaction() (preferred - the shared locks below then hold until
 * the caller commits, so the allocation and the price cannot change
 * between reading them and inserting a payment) or the pool for a
 * read-only look-up (the locks then release immediately; harmless).
 * LOCK IN SHARE MODE is MariaDB 10.4 syntax; FOR SHARE is MySQL 8 only.
 * ---------------------------------------------------------------
 */

const ApiError = require('../utils/ApiError');
const { decimalToMinor } = require('../utils/money');

const CONTACT_ADMIN = 'Please contact the hostel administration.';

function requireId(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw ApiError.badRequest(`${name} must be a positive integer.`);
  }
}

/**
 * The single active fee for a (hostel session, block).
 *
 * @param {object} conn
 * @param {number} hostelSessionId
 * @param {number} blockId
 * @returns {Promise<{hostel_fee_id:number, hostel_session_id:number, block_id:number,
 *                    amount:string, amount_minor:number, currency:string}>}
 * @throws {ApiError} 400 bad ids; 409 no fee configured; 500 more than one
 *         active fee, or a fee whose amount/currency cannot be converted.
 */
async function getBlockFee(conn, hostelSessionId, blockId) {
  requireId(hostelSessionId, 'hostelSessionId');
  requireId(blockId, 'blockId');

  const [rows] = await conn.execute(
    `SELECT id, hostel_session_id, block_id, amount, currency
       FROM hostel_fees
      WHERE hostel_session_id = ?
        AND block_id = ?
        AND active = 1
      LOCK IN SHARE MODE`,
    [hostelSessionId, blockId]
  );

  if (rows.length === 0) {
    throw ApiError.conflict(
      `No hostel fee has been set for this block in this hostel session. ${CONTACT_ADMIN}`
    );
  }
  if (rows.length > 1) {
    // The unique active key makes this impossible; never guess a price if it is not.
    throw new ApiError(
      500,
      `More than one active hostel fee exists for this block and session. ${CONTACT_ADMIN}`
    );
  }

  const fee = rows[0];

  let amountMinor;
  try {
    amountMinor = decimalToMinor(fee.amount, fee.currency);
  } catch (err) {
    // bad amount, zero amount, or a currency whose precision is not established
    throw new ApiError(500, `The hostel fee for this block is not valid. ${CONTACT_ADMIN}`);
  }

  return {
    hostel_fee_id: fee.id,
    hostel_session_id: fee.hostel_session_id,
    block_id: fee.block_id,
    amount: fee.amount, // exact decimal string, e.g. "300000.00"
    amount_minor: amountMinor, // exact integer kobo, e.g. 30000000
    currency: fee.currency,
  };
}

/**
 * PAYMENT-BEFORE-ALLOCATION: the fee for an APPROVED application that has no room yet.
 * The block comes from applications.fee_block_id (migration 019), which an admin sets
 * when approving; it is never the student's optional preference and never a guess.
 * An application that already has an active allocation never reaches here: it is
 * priced from its allocated room's block, exactly as before.
 *
 * If the column does not exist yet (019 not applied) or is NULL, the result is the
 * same clear 409 as before: nothing is priced and no payment can start.
 */
async function getHostelFeeForConfirmedBlock(conn, application) {
  if (application.status !== 'approved') {
    throw ApiError.conflict(
      `Only an approved application has a hostel fee. This application is ${application.status}.`
    );
  }

  let feeBlockId = null;
  try {
    const [rows] = await conn.execute(
      `SELECT fee_block_id FROM applications WHERE id = ?`,
      [application.id]
    );
    if (rows[0] && rows[0].fee_block_id !== null && rows[0].fee_block_id !== undefined) {
      feeBlockId = rows[0].fee_block_id; // INT column: already an integer, no numeric conversion needed
    }
  } catch (err) {
    if (!(err && err.code === 'ER_BAD_FIELD_ERROR')) throw err; // 019 not applied: treat as unset
  }

  if (feeBlockId === null) {
    throw ApiError.conflict(
      'This application does not have an active room allocation or a confirmed fee block yet, ' +
      'so no hostel fee applies. The hostel administration must confirm your fee block first.'
    );
  }

  const [blockRows] = await conn.execute(
    `SELECT id, name FROM blocks WHERE id = ?`,
    [feeBlockId]
  );
  if (!blockRows[0]) {
    throw new ApiError(500, `The confirmed fee block could not be found. ${CONTACT_ADMIN}`);
  }

  const fee = await getBlockFee(conn, application.hostel_session_id, feeBlockId);

  return {
    application_id: application.id,
    application_status: application.status,
    student_id: application.student_id,
    allocation_id: null,
    room_id: null,
    room_number: null,
    room_type: null,
    block_id: blockRows[0].id,
    block_name: blockRows[0].name,
    hostel_session_id: fee.hostel_session_id,
    hostel_fee_id: fee.hostel_fee_id,
    amount: fee.amount,
    amount_minor: fee.amount_minor,
    currency: fee.currency,
  };
}

/**
 * The hostel fee that applies to an application: its own session, and
 * the block of the room it is ACTIVELY allocated to.
 *
 * @param {object} conn
 * @param {number} applicationId
 * @returns {Promise<object>} application / student / allocation / room /
 *          block details plus the fee (see getBlockFee for fee fields)
 * @throws {ApiError} 400 bad id; 404 unknown application; 409 no active
 *         allocation or no fee configured; 500 inconsistent data
 *         (several active allocations, student or room pointer mismatch,
 *         missing room/block, more than one fee).
 */
async function getHostelFeeForApplication(conn, applicationId) {
  requireId(applicationId, 'applicationId');

  const [appRows] = await conn.execute(
    `SELECT id, student_id, status, allocated_room_id, hostel_session_id
       FROM applications
      WHERE id = ?
      LOCK IN SHARE MODE`,
    [applicationId]
  );
  const application = appRows[0];
  if (!application) {
    throw ApiError.notFound('Application not found.');
  }

  // Same session as the application: the composite foreign key already
  // guarantees it, and the filter makes another session's allocation
  // impossible to pick up even if that ever changed.
  const [allocRows] = await conn.execute(
    `SELECT id, application_id, student_id, room_id, hostel_session_id
       FROM allocations
      WHERE application_id = ?
        AND hostel_session_id = ?
        AND status = 'active'
      LOCK IN SHARE MODE`,
    [application.id, application.hostel_session_id]
  );

  if (allocRows.length === 0) {
    // PAYMENT-BEFORE-ALLOCATION: no room yet, so price the block an admin confirmed.
    return getHostelFeeForConfirmedBlock(conn, application);
  }
  if (allocRows.length > 1) {
    throw new ApiError(
      500,
      `This application has more than one active room allocation. ${CONTACT_ADMIN}`
    );
  }
  const allocation = allocRows[0];

  if (
    allocation.student_id !== application.student_id ||
    allocation.hostel_session_id !== application.hostel_session_id ||
    allocation.room_id !== application.allocated_room_id
  ) {
    throw new ApiError(
      500,
      `This application's allocation records are inconsistent. ${CONTACT_ADMIN}`
    );
  }

  // Rooms and blocks are read WITHOUT a lock on purpose: a shared lock on
  // the room row would stall occupancy updates for the whole transaction.
  const [roomRows] = await conn.execute(
    `SELECT r.id AS room_id, r.room_number, r.room_type, r.block_id, b.name AS block_name
       FROM rooms r
       JOIN blocks b ON b.id = r.block_id
      WHERE r.id = ?`,
    [allocation.room_id]
  );
  const room = roomRows[0];
  if (!room) {
    throw new ApiError(
      500,
      `The room allocated to this application could not be found. ${CONTACT_ADMIN}`
    );
  }

  const fee = await getBlockFee(conn, application.hostel_session_id, room.block_id);

  return {
    application_id: application.id,
    application_status: application.status,
    student_id: application.student_id,
    allocation_id: allocation.id,
    room_id: room.room_id,
    room_number: room.room_number,
    room_type: room.room_type,
    block_id: room.block_id,
    block_name: room.block_name,
    hostel_session_id: fee.hostel_session_id,
    hostel_fee_id: fee.hostel_fee_id,
    amount: fee.amount,
    amount_minor: fee.amount_minor,
    currency: fee.currency,
  };
}

module.exports = { getBlockFee, getHostelFeeForApplication };
