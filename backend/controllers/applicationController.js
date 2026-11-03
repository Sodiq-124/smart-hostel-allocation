const { queryOne, query } = require('../config/database');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { resolveAllocationState } = require('../services/allocationStatusService');
const allocationService = require('../services/allocationService');

const getRoomOptions = asyncHandler(async (req, res) => {
  const studentGender = req.session.user.gender;

  // Gender lives on rooms, not blocks - a block (A/B/C/D)
  // can hold both genders, so filtering starts from the room's own
  // gender rather than the block's. See migrations/003_room_gender.sql.
  const rows = await query(
    `SELECT b.id AS block_id, b.name AS block_name, r.room_type,
            COUNT(*) AS room_count,
            SUM(CASE WHEN r.available_spaces > 0 THEN 1 ELSE 0 END) AS rooms_with_space,
            COALESCE(SUM(r.available_spaces), 0) AS total_available_spaces
       FROM blocks b
       JOIN rooms r ON r.block_id = b.id AND r.is_active = 1
      WHERE r.gender = ? AND b.is_active = 1
      GROUP BY b.id, b.name, r.room_type
      ORDER BY b.name, r.room_type`,
    [studentGender]
  );

   const overallByType = {};
  for (const row of rows) {
    const t = row.room_type;
    if (!overallByType[t]) overallByType[t] = { total_available_spaces: 0, rooms_with_space: 0 };
    overallByType[t].total_available_spaces += Number(row.total_available_spaces);
    overallByType[t].rooms_with_space += Number(row.rooms_with_space);
  }

  res.json({
    success: true,
    message: 'Room options retrieved.',
    data: { blocks: rows, overallByType },
  });
});


const createApplication = asyncHandler(async (req, res) => {
  const studentId = req.session.user.id;
  const studentGender = req.session.user.gender;
  const { room_type, special_request } = req.body;
  const preferredBlockId = req.body.preferred_block_id || null;

  let block = null;

  if (preferredBlockId) {
    block = await queryOne(
      `SELECT id, name, is_active FROM blocks WHERE id = ?`,
      [preferredBlockId]
    );

    if (!block) {
      throw ApiError.badRequest('The selected block does not exist.');
    }
    if (!block.is_active) {
      throw ApiError.badRequest('The selected block is not currently accepting applications.');
    }

    // A block is not gender-specific (it holds both
    // male and female rooms), so there is nothing to validate about
    // the block itself here - eligibility is entirely a matter of
    // whether it has available rooms of this student's gender AND the
    // requested room_type, which the availability check right below
    // already covers.
    const availability = await queryOne(
      `SELECT COALESCE(SUM(available_spaces), 0) AS spaces
         FROM rooms
        WHERE block_id = ? AND gender = ? AND room_type = ? AND is_active = 1`,
      [block.id, studentGender, room_type]
    );

    if (!availability || Number(availability.spaces) <= 0) {
      throw ApiError.conflict(
        `${block.name} currently has no available ${room_type} rooms. ` +
        'You may leave the block preference blank or choose a different block.'
      );
    }
  } else {
    const availability = await queryOne(
      `SELECT COALESCE(SUM(r.available_spaces), 0) AS spaces
         FROM rooms r
         JOIN blocks b ON b.id = r.block_id
        WHERE r.gender = ? AND b.is_active = 1 AND r.is_active = 1 AND r.room_type = ?`,
      [studentGender, room_type]
    );

    if (!availability || Number(availability.spaces) <= 0) {
      throw ApiError.conflict(
        `No ${room_type} rooms are currently available. Please try again later or choose a different room type.`
      );
    }
  }

  // allocationService.createApplication() makes "is the student's
  // existing application actually revoked, and if so supersede it"
  // and the INSERT one locked, transactional unit - see
  // that function's own header comment for why this needs a
  // transaction rather than a second query in this controller.
  const result = await allocationService.createApplication({
    studentId,
    roomType: room_type,
    preferredBlockId,
    specialRequest: special_request,
  });

  res.status(201).json({
    success: true,
    message: 'Application submitted successfully. Your application is currently pending admin review.',
    data: { id: result.id, status: 'pending' },
  });
});

const getMyApplication = asyncHandler(async (req, res) => {
  const application = await queryOne(
    `SELECT a.id, a.status, a.room_type, a.special_request, a.rejection_reason,
            a.applied_at, a.reviewed_at, a.allocated_room_id,
            pb.name AS preferred_block_name,
            r.room_number AS allocated_room_number,
            rb.name AS allocated_block_name
       FROM applications a
       LEFT JOIN blocks pb ON pb.id = a.preferred_block_id
       LEFT JOIN rooms r  ON r.id  = a.allocated_room_id
       LEFT JOIN blocks rb ON rb.id = r.block_id
      WHERE a.student_id = ?
      ORDER BY a.applied_at DESC
      LIMIT 1`,
    [req.session.user.id]
  );

  // Attach the disambiguated allocation_state (distinguishes
  // "Approved - Awaiting Allocation" from "Allocation Revoked" - both
  // of which otherwise look identical as status = 'approved' with no
  // allocated_room_id). See services/allocationStatusService.js.
  const state = await resolveAllocationState(application);

  res.json({
    success: true,
    message: application ? 'Application retrieved.' : 'No application found.',
    data: application ? { ...application, ...state } : null,
  });
});


const cancelApplication = asyncHandler(async (req, res) => {
  const applicationId = req.params.id;
  const studentId = req.session.user.id;

  const application = await queryOne(
    `SELECT id, status FROM applications WHERE id = ? AND student_id = ?`,
    [applicationId, studentId]
  );

  if (!application) {
    throw ApiError.notFound('Application not found.');
  }

  if (application.status !== 'pending') {
    const message = application.status === 'approved'
      ? 'An approved application cannot be withdrawn here. Please contact hostel administration.'
      : 'This application has already been decided and cannot be withdrawn.';
    throw ApiError.conflict(message);
  }

  const result = await query(
    `UPDATE applications SET status = 'cancelled'
      WHERE id = ? AND student_id = ? AND status = 'pending'`,
    [applicationId, studentId]
  );

  if (result.affectedRows === 0) {
    throw ApiError.conflict('This application was just updated and can no longer be withdrawn.');
  }

  res.json({ success: true, message: 'Application withdrawn.', data: null });
});

module.exports = { getRoomOptions, createApplication, getMyApplication, cancelApplication };
