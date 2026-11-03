
/**
 * services/allocationService.js
 * ---------------------------------------------------------------
 * This file exists because database/hostel.sql's own comments name it:
 * see the note inside trg_rooms_before_update ("even if the row
 * locking in allocationService.js were wrong...") and the statement-
 * order note inside trg_allocations_before_insert. The design doc
 * (docs/phase1-design.md, services layer, section 5) planned this
 * service layer from the start.
 *
 * WHY THIS IS A SERVICE AND NOT A CONTROLLER FUNCTION
 * This service owns transactions involving multiple related writes.
 * Allocation, revocation, and cancellation must update related records
 * atomically to protect room occupancy and allocation history.
 * ---------------------------------------------------------------
 */

const { withTransaction } = require('../config/database');
const ApiError = require('../utils/ApiError');
const { getCurrentSession } = require('./hostelSessionService');
const { assertHostelFeePaid } = require('./paymentGate');

/**
 * @param {number} applicationId
 * @param {number} roomId
 * @param {number} adminId
 * @returns {Promise<object>}
 */
async function allocateRoom({ applicationId, roomId, adminId }) {
  return withTransaction(async (conn) => {
    // 1. Lock the application and re-validate its state.
    const [appRows] = await conn.execute(
      `SELECT id, student_id, room_type, status, allocated_room_id, hostel_session_id
         FROM applications
        WHERE id = ?
        FOR UPDATE`,
      [applicationId]
    );

    const application = appRows[0];

    if (!application) {
      throw ApiError.notFound('Application not found.');
    }

    if (application.status !== 'approved') {
      throw ApiError.conflict(
        `Only an approved application can be allocated a room. This application is ${application.status}.`
      );
    }

    if (application.allocated_room_id) {
      throw ApiError.conflict(
        'This application has already been allocated a room.'
      );
    }

    // 1b. Only an application of the current hostel session may be allocated.
    const currentSession = await getCurrentSession(conn);

    if (application.hostel_session_id !== currentSession.id) {
      throw ApiError.conflict(
        `This application does not belong to the current hostel session (${currentSession.label}) and cannot be allocated a room.`
      );
    }

    // 2. Confirm the student doesn't already hold an active allocation.
    const [activeAlloc] = await conn.execute(
      `SELECT id
         FROM allocations
        WHERE student_id = ?
          AND hostel_session_id = ?
          AND status = 'active'`,
      [application.student_id, application.hostel_session_id]
    );

    if (activeAlloc.length > 0) {
      throw ApiError.conflict(
        'This student already has an active room allocation.'
      );
    }

    // 3. Lock the room row.
    const [roomRows] = await conn.execute(
      `SELECT r.id, r.room_number, r.room_type, r.gender,
              r.capacity, r.occupied_spaces, r.is_active,
              b.id AS block_id, b.name AS block_name
         FROM rooms r
         JOIN blocks b ON b.id = r.block_id
        WHERE r.id = ?
        FOR UPDATE`,
      [roomId]
    );

    const room = roomRows[0];

    if (!room) {
      throw ApiError.badRequest(
        'The selected room does not exist.'
      );
    }

    if (!room.is_active) {
      throw ApiError.conflict(
        'The selected room is not currently active.'
      );
    }

    if (room.room_type !== application.room_type) {
      throw ApiError.conflict(
        `This application requested a ${application.room_type} room; the selected room is ${room.room_type}.`
      );
    }

    // 4. Confirm gender compatibility.
    const [studentRows] = await conn.execute(
      `SELECT gender FROM users WHERE id = ?`,
      [application.student_id]
    );

    const studentGender = studentRows[0]
      ? studentRows[0].gender
      : null;

    if (room.gender !== studentGender) {
      throw ApiError.conflict(
        "The selected room does not accommodate this student's gender."
      );
    }

    // 5. Confirm capacity.
    if (room.occupied_spaces >= room.capacity) {
      throw ApiError.conflict(
        'The selected room is already full.'
      );
    }

    // 5b. Existing hostel-fee payment gate.
    // Intentionally preserved; the later fee-policy change is separate.
    await assertHostelFeePaid(conn, application, room);

    // 6. Insert the allocation.
    const [insertResult] = await conn.execute(
      `INSERT INTO allocations
         (application_id, student_id, room_id, hostel_session_id, allocated_by)
       VALUES (?, ?, ?, ?, ?)`,
      [
        applicationId,
        application.student_id,
        roomId,
        application.hostel_session_id,
        adminId,
      ]
    );

    // 7. Increment room occupancy.
    await conn.execute(
      `UPDATE rooms
          SET occupied_spaces = occupied_spaces + 1
        WHERE id = ?`,
      [roomId]
    );

    // 8. Attach the room to the application.
    await conn.execute(
      `UPDATE applications
          SET allocated_room_id = ?
        WHERE id = ?`,
      [roomId, applicationId]
    );

    return {
      allocation_id: insertResult.insertId,
      hostel_session_id: application.hostel_session_id,
      room_id: room.id,
      room_number: room.room_number,
      block_id: room.block_id,
      block_name: room.block_name,
    };
  });
}

/**
 * Revoke an existing room allocation without cancelling the application.
 *
 * The application remains approved so an administrator can allocate
 * a different room afterward.
 *
 * @param {number} applicationId
 * @param {string} reason
 * @param {number} adminId
 */
async function revokeAllocation({
  applicationId,
  reason,
  adminId,
}) {
  return withTransaction(async (conn) => {
    // 1. Lock the application and confirm it is allocated.
    const [appRows] = await conn.execute(
      `SELECT id, student_id, status, allocated_room_id
         FROM applications
        WHERE id = ?
        FOR UPDATE`,
      [applicationId]
    );

    const application = appRows[0];

    if (!application) {
      throw ApiError.notFound('Application not found.');
    }

    if (!application.allocated_room_id) {
      throw ApiError.conflict(
        'This application has no active room allocation to revoke.'
      );
    }

    // 2. Lock the active allocation row.
    const [allocRows] = await conn.execute(
      `SELECT id, room_id
         FROM allocations
        WHERE application_id = ?
          AND status = 'active'
        FOR UPDATE`,
      [applicationId]
    );

    const allocation = allocRows[0];

    if (!allocation) {
      throw ApiError.conflict(
        'No active allocation record was found for this application.'
      );
    }

    // 3. Lock the room and validate occupancy before decrementing.
    const [roomRows] = await conn.execute(
      `SELECT id, occupied_spaces
         FROM rooms
        WHERE id = ?
        FOR UPDATE`,
      [allocation.room_id]
    );

    const room = roomRows[0];

    if (!room || Number(room.occupied_spaces) < 1) {
      throw ApiError.conflict(
        'The room occupancy record is inconsistent. Revocation was not completed.'
      );
    }

    const [occupancyResult] = await conn.execute(
      `UPDATE rooms
          SET occupied_spaces = occupied_spaces - 1
        WHERE id = ?
          AND occupied_spaces > 0`,
      [allocation.room_id]
    );

    if (occupancyResult.affectedRows !== 1) {
      throw ApiError.conflict(
        'Room occupancy could not be updated. Revocation was not completed.'
      );
    }

    // 4. Release the allocation while preserving its history.
    const [releaseResult] = await conn.execute(
      `UPDATE allocations
          SET status = 'released',
              released_at = NOW(),
              release_reason = ?
        WHERE id = ?
          AND status = 'active'`,
      [reason, allocation.id]
    );

    if (releaseResult.affectedRows !== 1) {
      throw ApiError.conflict(
        'The active allocation could not be released. Revocation was not completed.'
      );
    }

    // 5. Detach the room without changing application status.
    const [detachResult] = await conn.execute(
      `UPDATE applications
          SET allocated_room_id = NULL
        WHERE id = ?
          AND allocated_room_id = ?`,
      [applicationId, allocation.room_id]
    );

    if (detachResult.affectedRows !== 1) {
      throw ApiError.conflict(
        'The application allocation could not be detached. Revocation was not completed.'
      );
    }

    return {
      application_id: applicationId,
      room_id: allocation.room_id,
      revoked_by: adminId,
    };
  });
}

/**
 * Cancel an approved application atomically.
 *
 * If a room is allocated, release it and decrement occupancy in the
 * same transaction as cancelling the application.
 *
 * The allocation and payment records are retained as historical records.
 * No database migration is required by this function.
 *
 * @param {number|string} applicationId
 * @param {string} reason
 * @param {number} adminId
 * @returns {Promise<{
 *   application_id: number,
 *   allocation_released: boolean
 * }>}
 */
async function cancelApprovedApplication({
  applicationId,
  reason,
  adminId,
}) {
  return withTransaction(async (conn) => {
    // 1. Lock the application and confirm it is approved.
    const [appRows] = await conn.execute(
      `SELECT id, status, allocated_room_id
         FROM applications
        WHERE id = ?
        FOR UPDATE`,
      [applicationId]
    );

    const application = appRows[0];

    if (!application) {
      throw ApiError.notFound('Application not found.');
    }

    if (application.status !== 'approved') {
      throw ApiError.conflict(
        `Only an approved application can be cancelled. This application is ${application.status}.`
      );
    }

    // 2. Lock any active allocation for this application.
    const [allocationRows] = await conn.execute(
      `SELECT id, room_id
         FROM allocations
        WHERE application_id = ?
          AND status = 'active'
        FOR UPDATE`,
      [applicationId]
    );

    const allocation = allocationRows[0] || null;
    const allocatedRoomId = application.allocated_room_id;

    // 3. Fail safely if application and allocation records disagree.
    if (
      (allocatedRoomId && !allocation) ||
      (!allocatedRoomId && allocation) ||
      (
        allocation &&
        Number(allocatedRoomId) !== Number(allocation.room_id)
      )
    ) {
      throw ApiError.conflict(
        'The application and allocation records are inconsistent. Cancellation was not completed.'
      );
    }

    const auditReason = `Admin cancellation: ${reason}`;

    // 4. If allocated, lock the room and release the occupied space.
    if (allocation) {
      const [roomRows] = await conn.execute(
        `SELECT id, occupied_spaces
           FROM rooms
          WHERE id = ?
          FOR UPDATE`,
        [allocation.room_id]
      );

      const room = roomRows[0];

      if (!room || Number(room.occupied_spaces) < 1) {
        throw ApiError.conflict(
          'The room occupancy record is inconsistent. Cancellation was not completed.'
        );
      }

      const [occupancyResult] = await conn.execute(
        `UPDATE rooms
            SET occupied_spaces = occupied_spaces - 1
          WHERE id = ?
            AND occupied_spaces > 0`,
        [allocation.room_id]
      );

      if (occupancyResult.affectedRows !== 1) {
        throw ApiError.conflict(
          'Room occupancy could not be updated. Cancellation was not completed.'
        );
      }

      // Preserve the allocation record; do not delete it.
      const [releaseResult] = await conn.execute(
        `UPDATE allocations
            SET status = 'released',
                released_at = NOW(),
                release_reason = ?
          WHERE id = ?
            AND status = 'active'`,
        [auditReason, allocation.id]
      );

      if (releaseResult.affectedRows !== 1) {
        throw ApiError.conflict(
          'The active allocation could not be released. Cancellation was not completed.'
        );
      }
    }

    // 5. Cancel the application in the same transaction.
    const [cancelResult] = await conn.execute(
      `UPDATE applications
          SET status = 'cancelled',
              allocated_room_id = NULL,
              rejection_reason = ?,
              reviewed_by = ?,
              reviewed_at = NOW()
        WHERE id = ?
          AND status = 'approved'`,
      [auditReason, adminId, applicationId]
    );

    if (cancelResult.affectedRows !== 1) {
      throw ApiError.conflict(
        'The application could not be cancelled. Cancellation was not completed.'
      );
    }

    return {
      application_id: Number(applicationId),
      allocation_released: Boolean(allocation),
    };
  });
}

/**
 * Reapplication after a revoked allocation.
 *
 * If the student has an approved, unallocated application with a
 * released allocation in its history, mark the old application as
 * cancelled before creating the new application.
 *
 * Other blocking applications remain untouched.
 *
 * @param {number} studentId
 * @param {string} roomType
 * @param {number|null} preferredBlockId
 * @param {string|null} specialRequest
 * @returns {Promise<{id: number}>}
 */
async function createApplication({
  studentId,
  roomType,
  preferredBlockId,
  specialRequest,
}) {
  return withTransaction(async (conn) => {
    // Resolve the current hostel session from the database.
    const session = await getCurrentSession(conn);

    // Lock the student's blocking application before deciding whether
    // the student can submit a new application.
    const [blockingRows] = await conn.execute(
      `SELECT id, status, allocated_room_id
         FROM applications
        WHERE student_id = ?
          AND hostel_session_id = ?
          AND status IN ('pending', 'approved')
        FOR UPDATE`,
      [studentId, session.id]
    );

    const blocking = blockingRows[0];

    if (
      blocking &&
      blocking.status === 'approved' &&
      !blocking.allocated_room_id
    ) {
      const [allocRows] = await conn.execute(
        `SELECT status
           FROM allocations
          WHERE application_id = ?
          ORDER BY allocated_at DESC
          LIMIT 1`,
        [blocking.id]
      );

      const lastAllocation = allocRows[0];

      if (lastAllocation && lastAllocation.status === 'released') {
        await conn.execute(
          `UPDATE applications
              SET status = 'cancelled',
                  rejection_reason = ?
            WHERE id = ?
              AND status = 'approved'
              AND allocated_room_id IS NULL`,
          [
            'Superseded by a new application after the previous room allocation was revoked.',
            blocking.id,
          ]
        );
      }
    }

    const [result] = await conn.execute(
      `INSERT INTO applications
         (
           student_id,
           room_type,
           preferred_block_id,
           special_request,
           hostel_session_id,
           session_year
         )
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        studentId,
        roomType,
        preferredBlockId,
        specialRequest || null,
        session.id,
        session.label,
      ]
    );

    return { id: result.insertId };
  });
}

module.exports = {
  allocateRoom,
  revokeAllocation,
  cancelApprovedApplication,
  createApplication,
};
