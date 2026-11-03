/**
 * services/capacityAdvisory.js
 * ---------------------------------------------------------------
 * ADVISORY ONLY. When an admin confirms the block whose fee a student will
 * pay, this answers: "are there free places in that block for this student's
 * room type and gender, after allowing for approved applicants who are already
 * waiting for that block?"
 *
 * It reads live capacity (rooms.available_spaces, a generated column
 * capacity - occupied_spaces, on active rooms of the student's room type and
 * gender) and counts approved, unallocated applications of the same session
 * that already have this block confirmed. It does NOT reserve anything and
 * does NOT replace or weaken allocationService's own checks (room lock, type,
 * gender, capacity, payment gate). Payment does not guarantee a room: a room
 * is only guaranteed when an allocation succeeds.
 *
 * Known limits (stated to the admin, not hidden):
 *  - approved applications whose fee block has not been confirmed yet (for
 *    example ones approved before migration 019) are not counted;
 *  - several admins confirming at the same moment can each see the same space.
 *
 * Never throws for data reasons: the caller shows the advisory if available
 * and carries on if not (approval must not depend on it).
 * ---------------------------------------------------------------
 */

const ApiError = require('../utils/ApiError');

const DISCLAIMER = 'Payment does not guarantee a room. A room is only guaranteed once an allocation succeeds.';

function unavailable(reason) {
  return { available: false, reason, disclaimer: DISCLAIMER };
}

/**
 * @param {object} conn any mysql2 promise object with execute()
 * @param {{applicationId:number, blockId:number}} args
 */
async function getCapacityAdvisory(conn, { applicationId, blockId }) {
  const [appRows] = await conn.execute(
    `SELECT a.id, a.room_type, a.hostel_session_id, u.gender
       FROM applications a
       JOIN users u ON u.id = a.student_id
      WHERE a.id = ?`,
    [applicationId]
  );
  const application = appRows[0];
  if (!application) throw ApiError.notFound('Application not found.');
  if (!application.gender) return unavailable('The student has no gender on record, so capacity cannot be checked.');

  const [blockRows] = await conn.execute(`SELECT id, name FROM blocks WHERE id = ?`, [blockId]);
  const block = blockRows[0];
  if (!block) throw ApiError.badRequest('The selected block does not exist.');

  const [freeRows] = await conn.execute(
    `SELECT COALESCE(SUM(r.available_spaces), 0) AS free_spaces, COUNT(*) AS room_count
       FROM rooms r
      WHERE r.block_id = ? AND r.room_type = ? AND r.gender = ? AND r.is_active = 1`,
    [blockId, application.room_type, application.gender]
  );
  const freeSpaces = Number(freeRows[0].free_spaces);

  let committed;
  try {
    const [committedRows] = await conn.execute(
      `SELECT COUNT(*) AS committed
         FROM applications a
         JOIN users u ON u.id = a.student_id
        WHERE a.hostel_session_id = ? AND a.status = 'approved' AND a.allocated_room_id IS NULL
          AND a.fee_block_id = ? AND a.room_type = ? AND u.gender = ? AND a.id <> ?`,
      [application.hostel_session_id, blockId, application.room_type, application.gender, application.id]
    );
    committed = Number(committedRows[0].committed);
  } catch (err) {
    if (err && err.code === 'ER_BAD_FIELD_ERROR') return unavailable('Fee blocks are not set up on this database yet.');
    throw err;
  }

  const remaining = freeSpaces - committed;
  const what = `${application.room_type} room space${freeSpaces === 1 ? '' : 's'} for ${application.gender} students in ${block.name}`;

  let level;
  let message;
  if (freeSpaces === 0) {
    level = 'none';
    message = `There are currently no free ${application.room_type} room spaces for ${application.gender} students in ${block.name}.`;
  } else if (remaining <= 0) {
    level = 'low';
    message = `${freeSpaces} free ${what}, but ${committed} other approved applicant${committed === 1 ? ' is' : 's are'} already waiting for this block. A room may not be available.`;
  } else {
    level = 'ok';
    message = `${freeSpaces} free ${what}; ${committed} other approved applicant${committed === 1 ? ' is' : 's are'} already waiting for this block.`;
  }

  return {
    available: true,
    block_id: block.id,
    block_name: block.name,
    free_spaces: freeSpaces,
    committed_applicants: committed,
    remaining,
    level,
    message,
    disclaimer: DISCLAIMER,
  };
}

module.exports = { getCapacityAdvisory, DISCLAIMER };
