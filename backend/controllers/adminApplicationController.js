
/**
 * controllers/adminApplicationController.js
 * ---------------------------------------------------------------
 * Admin visibility of applications, plus approve / reject and
 * room allocation.
 *
 * Allocation, revocation and cancellation transactions live in
 * services/allocationService.js. This controller validates request
 * input, calls the service, and shapes HTTP responses.
 * ---------------------------------------------------------------
 */

const { pool, queryOne, query, withTransaction } = require('../config/database');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const allocationService = require('../services/allocationService');
const { getBlockFee } = require('../services/feeService');
const { getPaymentsSchema } = require('../services/paymentSchema');
const { getCapacityAdvisory } = require('../services/capacityAdvisory');
const { resolveAllocationState } = require('../services/allocationStatusService');

async function mapApplicationRow(row) {
  const state = await resolveAllocationState({
    id: row.id,
    status: row.status,
    allocated_room_id: row.allocated_room_id,
    allocated_room_number: row.allocated_room_number,
    allocated_block_name: row.allocated_block_name,
  });

  return {
    id: row.id,
    status: row.status,
    room_type: row.room_type,
    special_request: row.special_request,
    rejection_reason: row.rejection_reason,
    applied_at: row.applied_at,
    reviewed_at: row.reviewed_at,
    reviewed_by: row.reviewer_name || null,
    student: {
      id: row.student_pk,
      full_name: row.student_name,
      student_id: row.matric_number,
      email: row.student_email,
    },
    preferred_block: row.preferred_block_name,
    allocation: row.allocated_room_id
      ? {
          room_number: row.allocated_room_number,
          block_name: row.allocated_block_name,
        }
      : null,
    ...state,
  };
}

const BASE_SELECT = `
  SELECT a.id, a.status, a.room_type, a.special_request, a.rejection_reason,
         a.applied_at, a.reviewed_at, a.allocated_room_id,
         u.id AS student_pk, u.full_name AS student_name,
         u.student_id AS matric_number, u.email AS student_email,
         pb.name AS preferred_block_name,
         r.room_number AS allocated_room_number,
         rb.name AS allocated_block_name,
         reviewer.full_name AS reviewer_name
    FROM applications a
    JOIN users u ON u.id = a.student_id
    LEFT JOIN blocks pb ON pb.id = a.preferred_block_id
    LEFT JOIN rooms r ON r.id = a.allocated_room_id
    LEFT JOIN blocks rb ON rb.id = r.block_id
    LEFT JOIN users reviewer ON reviewer.id = a.reviewed_by
`;

const NO_PAYMENT = {
  status: 'unpaid',
  verified: false,
  reference: null,
  amount: null,
  currency: null,
  paid_at: null,
  paid_block_id: null,
  paid_block_name: null,
};

function summarisePayment(rows) {
  if (!rows || rows.length === 0) {
    return { ...NO_PAYMENT };
  }

  const row = rows.find((r) => r.status === 'success') || rows[0];
  let status;
  let verified = false;

  if (row.status === 'success') {
    verified = Boolean(
      row.verified_at && row.paid_at && row.gateway_reference
    );
    status = verified ? 'paid' : 'unverified';
  } else if (row.status === 'pending') {
    status = 'pending';
  } else if (row.status === 'failed' || row.status === 'abandoned') {
    status = 'failed';
  } else if (row.status === 'refunded') {
    status = 'refunded';
  } else {
    status = 'unpaid';
  }

  return {
    status,
    verified,
    reference: row.payment_reference,
    amount: row.amount,
    currency: row.currency,
    paid_at: row.paid_at,
    paid_block_id:
      row.paid_block_id === null || row.paid_block_id === undefined
        ? null
        : Number(row.paid_block_id),
    paid_block_name: row.paid_block_name || null,
  };
}

async function loadApplicationExtras(rows) {
  const ids = rows.map((r) => r.id);
  const extras = new Map(
    ids.map((id) => [
      id,
      {
        payment: null,
        fee_block: null,
        fee_block_supported: true,
      },
    ])
  );

  if (ids.length === 0) return extras;

  const marks = ids.map(() => '?').join(', ');

  try {
    const feeRows = await query(
      `SELECT a.id, a.fee_block_id, b.name AS fee_block_name
         FROM applications a
         LEFT JOIN blocks b ON b.id = a.fee_block_id
        WHERE a.id IN (${marks})`,
      ids
    );

    for (const f of feeRows) {
      extras.get(f.id).fee_block = f.fee_block_id
        ? { id: f.fee_block_id, name: f.fee_block_name }
        : null;
    }
  } catch (err) {
    if (!(err && err.code === 'ER_BAD_FIELD_ERROR')) throw err;

    for (const e of extras.values()) {
      e.fee_block_supported = false;
    }
  }

  let schema;

  try {
    schema = await getPaymentsSchema(pool);
  } catch (err) {
    if (err instanceof ApiError) return extras;
    throw err;
  }

  const typed = schema.typed
    ? `AND p.payment_type = 'hostel'`
    : '';

  const [payRows] = await pool.execute(
    `SELECT p.id, p.application_id, p.status, p.payment_reference,
            p.amount, p.currency, p.paid_at, p.verified_at,
            p.gateway_reference, f.block_id AS paid_block_id,
            fb.name AS paid_block_name
       FROM payments p
       JOIN applications a
         ON a.id = p.application_id
        AND a.hostel_session_id = p.hostel_session_id
       LEFT JOIN hostel_fees f ON f.id = p.hostel_fee_id
       LEFT JOIN blocks fb ON fb.id = f.block_id
      WHERE p.application_id IN (${marks})
        ${typed}
      ORDER BY p.id DESC`,
    ids
  );

  const byApplication = new Map();

  for (const p of payRows) {
    if (!byApplication.has(p.application_id)) {
      byApplication.set(p.application_id, []);
    }

    byApplication.get(p.application_id).push(p);
  }

  for (const id of ids) {
    extras.get(id).payment = summarisePayment(
      byApplication.get(id)
    );
  }

  return extras;
}

async function mapApplicationRows(rows) {
  const extras = await loadApplicationExtras(rows);

  return Promise.all(
    rows.map(async (row) => {
      const base = await mapApplicationRow(row);
      const x = extras.get(row.id);

      return {
        ...base,
        fee_block: x.fee_block,
        fee_block_supported: x.fee_block_supported,
        payment: x.payment,
        ready_for_allocation:
          row.status === 'approved' &&
          !row.allocated_room_id &&
          Boolean(x.payment && x.payment.status === 'paid'),
      };
    })
  );
}

async function mapApplicationRowOne(row) {
  return (await mapApplicationRows([row]))[0];
}

/**
 * GET /api/admin/applications
 */
const listApplications = asyncHandler(async (req, res) => {
  const { status, room_type, block_id, q, payment_status } = req.query;

  const conditions = [];
  const params = [];

  if (status) {
    conditions.push('a.status = ?');
    params.push(status);
  }

  if (room_type) {
    conditions.push('a.room_type = ?');
    params.push(room_type);
  }

  if (block_id) {
    conditions.push('a.preferred_block_id = ?');
    params.push(block_id);
  }

  if (q) {
    conditions.push('(u.full_name LIKE ? OR u.email LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like);
  }

  if (payment_status) {
    const { typed } = await getPaymentsSchema(pool);
    const t = typed ? `AND p.payment_type = 'hostel'` : '';

    const paid = `EXISTS (
      SELECT 1 FROM payments p
       WHERE p.application_id = a.id
         AND p.hostel_session_id = a.hostel_session_id
         AND p.status = 'success'
         AND p.verified_at IS NOT NULL
         AND p.paid_at IS NOT NULL
         AND p.gateway_reference IS NOT NULL ${t}
    )`;

    const pending = `EXISTS (
      SELECT 1 FROM payments p
       WHERE p.application_id = a.id
         AND p.hostel_session_id = a.hostel_session_id
         AND p.status = 'pending' ${t}
    )`;

    if (payment_status === 'paid') {
      conditions.push(paid);
    } else if (payment_status === 'unpaid') {
      conditions.push(`NOT ${paid}`);
    } else if (payment_status === 'pending') {
      conditions.push(pending, `NOT ${paid}`);
    }
  }

  const whereClause = conditions.length
    ? `WHERE ${conditions.join(' AND ')}`
    : '';

  const rows = await query(
    `${BASE_SELECT} ${whereClause} ORDER BY a.applied_at DESC`,
    params
  );

  const data = await mapApplicationRows(rows);

  res.json({
    success: true,
    message: rows.length
      ? 'Applications retrieved.'
      : 'No hostel applications found.',
    data,
  });
});

/**
 * GET /api/admin/applications/:id
 */
const getApplicationById = asyncHandler(async (req, res) => {
  const row = await queryOne(
    `${BASE_SELECT} WHERE a.id = ?`,
    [req.params.id]
  );

  if (!row) {
    throw ApiError.notFound('Application not found.');
  }

  res.json({
    success: true,
    message: 'Application retrieved.',
    data: await mapApplicationRowOne(row),
  });
});

/**
 * PUT /api/admin/applications/:id/approve
 * Body: { fee_block_id? }
 */
const approveApplication = asyncHandler(async (req, res) => {
  const applicationId = req.params.id;
  const adminId = req.session.user.id;
  const requestedBlockId =
    req.body && req.body.fee_block_id
      ? req.body.fee_block_id
      : null;

  const feeBlockId = await withTransaction(async (conn) => {
    const [appRows] = await conn.execute(
      `SELECT id, status, preferred_block_id, hostel_session_id
         FROM applications
        WHERE id = ?
        FOR UPDATE`,
      [applicationId]
    );

    const application = appRows[0];

    if (!application) {
      throw ApiError.notFound('Application not found.');
    }

    if (application.status !== 'pending') {
      throw ApiError.conflict(
        `This application is already ${application.status} and cannot be approved.`
      );
    }

    const blockId =
      requestedBlockId ||
      application.preferred_block_id ||
      null;

    if (!blockId) {
      throw ApiError.badRequest(
        'Choose the block whose fee this applicant will pay. The applicant stated no block preference.'
      );
    }

    await getBlockFee(
      conn,
      application.hostel_session_id,
      blockId
    );

    try {
      const [result] = await conn.execute(
        `UPDATE applications
            SET status = 'approved',
                reviewed_by = ?,
                reviewed_at = NOW(),
                fee_block_id = ?
          WHERE id = ?
            AND status = 'pending'`,
        [adminId, blockId, applicationId]
      );

      if (result.affectedRows === 0) {
        throw ApiError.conflict(
          'This application was just updated and could not be approved.'
        );
      }
    } catch (err) {
      if (err && err.code === 'ER_BAD_FIELD_ERROR') {
        throw new ApiError(
          503,
          'Fee blocks are not set up on this database yet (migration 019). Nothing was changed.'
        );
      }

      throw err;
    }

    return blockId;
  });

  const updated = await queryOne(
    `${BASE_SELECT} WHERE a.id = ?`,
    [applicationId]
  );

  const advisory = await safeAdvisory(
    applicationId,
    feeBlockId
  );

  res.json({
    success: true,
    message:
      'Application approved. The student can now pay the hostel fee; a room is allocated after payment.',
    data: {
      ...(await mapApplicationRowOne(updated)),
      advisory,
    },
  });
});

/** Advisory capacity must never make approval or fee-block changes fail. */
async function safeAdvisory(applicationId, blockId) {
  try {
    return await getCapacityAdvisory(pool, {
      applicationId,
      blockId,
    });
  } catch (err) {
    console.error(
      '[capacity-advisory] unavailable:',
      err && err.message
    );

    return {
      available: false,
      reason: 'Capacity could not be checked right now.',
    };
  }
}

/**
 * PUT /api/admin/applications/:id/fee-block
 * Body: { fee_block_id }
 */
const setFeeBlock = asyncHandler(async (req, res) => {
  const applicationId = req.params.id;
  const blockId = req.body.fee_block_id;

  await withTransaction(async (conn) => {
    const [appRows] = await conn.execute(
      `SELECT id, status, allocated_room_id, hostel_session_id
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
        `Only an approved application has a fee block. This application is ${application.status}.`
      );
    }

    if (application.allocated_room_id) {
      throw ApiError.conflict(
        'This application already has a room, so its fee follows that room and its fee block cannot be changed.'
      );
    }

    const { typed } = await getPaymentsSchema(conn);

    const [blocking] = await conn.execute(
      `SELECT p.status
         FROM payments p
        WHERE p.application_id = ?
          AND p.hostel_session_id = ?
          AND p.status IN ('success', 'pending')
          ${typed ? `AND p.payment_type = 'hostel'` : ''}
        LIMIT 1`,
      [application.id, application.hostel_session_id]
    );

    if (blocking[0]) {
      throw ApiError.conflict(
        blocking[0].status === 'success'
          ? 'A successful payment already exists, so the fee block can no longer be changed.'
          : 'A payment is in progress, so the fee block cannot be changed right now. Try again once it has completed or been closed.'
      );
    }

    await getBlockFee(
      conn,
      application.hostel_session_id,
      blockId
    );

    try {
      await conn.execute(
        `UPDATE applications
            SET fee_block_id = ?
          WHERE id = ?
            AND status = 'approved'
            AND allocated_room_id IS NULL`,
        [blockId, applicationId]
      );
    } catch (err) {
      if (err && err.code === 'ER_BAD_FIELD_ERROR') {
        throw new ApiError(
          503,
          'Fee blocks are not set up on this database yet (migration 019). Nothing was changed.'
        );
      }

      throw err;
    }
  });

  const updated = await queryOne(
    `${BASE_SELECT} WHERE a.id = ?`,
    [applicationId]
  );

  const advisory = await safeAdvisory(
    applicationId,
    blockId
  );

  res.json({
    success: true,
    message:
      'Fee block confirmed. The student can now pay the hostel fee for this block.',
    data: {
      ...(await mapApplicationRowOne(updated)),
      advisory,
    },
  });
});

/**
 * GET /api/admin/applications/:id/fee-block-options
 */
const getFeeBlockOptions = asyncHandler(async (req, res) => {
  const application = await queryOne(
    `SELECT id, status, preferred_block_id, hostel_session_id
       FROM applications
      WHERE id = ?`,
    [req.params.id]
  );

  if (!application) {
    throw ApiError.notFound('Application not found.');
  }

  const blocks = await query(
    `SELECT b.id, b.name, f.amount, f.currency
       FROM hostel_fees f
       JOIN blocks b ON b.id = f.block_id
      WHERE f.hostel_session_id = ?
        AND f.active = 1
      ORDER BY b.name ASC`,
    [application.hostel_session_id]
  );

  let confirmed = null;

  try {
    const row = await queryOne(
      `SELECT fee_block_id
         FROM applications
        WHERE id = ?`,
      [application.id]
    );

    confirmed =
      row && row.fee_block_id
        ? row.fee_block_id
        : null;
  } catch (err) {
    if (!(err && err.code === 'ER_BAD_FIELD_ERROR')) {
      throw err;
    }
  }

  res.json({
    success: true,
    message: 'Fee block options retrieved.',
    data: {
      blocks,
      preferred_block_id:
        application.preferred_block_id || null,
      fee_block_id: confirmed,
    },
  });
});

/**
 * GET /api/admin/applications/:id/fee-block-advisory?block_id=
 */
const getFeeBlockAdvisory = asyncHandler(async (req, res) => {
  const application = await queryOne(
    `SELECT id, status
       FROM applications
      WHERE id = ?`,
    [req.params.id]
  );

  if (!application) {
    throw ApiError.notFound('Application not found.');
  }

  if (!['pending', 'approved'].includes(application.status)) {
    throw ApiError.conflict(
      `This application is ${application.status}; there is no fee block to choose.`
    );
  }

  const advisory = await safeAdvisory(
    application.id,
    req.query.block_id
  );

  res.json({
    success: true,
    message: 'Capacity advisory retrieved.',
    data: advisory,
  });
});

/**
 * PUT /api/admin/applications/:id/reject
 * Body: { rejection_reason }
 */
const rejectApplication = asyncHandler(async (req, res) => {
  const applicationId = req.params.id;
  const adminId = req.session.user.id;
  const { rejection_reason } = req.body;

  const application = await queryOne(
    `SELECT id, status
       FROM applications
      WHERE id = ?`,
    [applicationId]
  );

  if (!application) {
    throw ApiError.notFound('Application not found.');
  }

  if (application.status !== 'pending') {
    throw ApiError.conflict(
      `This application is already ${application.status} and cannot be rejected.`
    );
  }

  const result = await query(
    `UPDATE applications
        SET status = 'rejected',
            rejection_reason = ?,
            reviewed_by = ?,
            reviewed_at = NOW()
      WHERE id = ?
        AND status = 'pending'`,
    [rejection_reason, adminId, applicationId]
  );

  if (result.affectedRows === 0) {
    throw ApiError.conflict(
      'This application was just updated and could not be rejected.'
    );
  }

  const updated = await queryOne(
    `${BASE_SELECT} WHERE a.id = ?`,
    [applicationId]
  );

  res.json({
    success: true,
    message: 'Application rejected.',
    data: await mapApplicationRowOne(updated),
  });
});

/**
 * GET /api/admin/applications/:id/eligible-rooms
 */
const getEligibleRooms = asyncHandler(async (req, res) => {
  const application = await queryOne(
    `SELECT id, student_id, room_type, status, preferred_block_id
       FROM applications
      WHERE id = ?`,
    [req.params.id]
  );

  if (!application) {
    throw ApiError.notFound('Application not found.');
  }

  if (application.status !== 'approved') {
    throw ApiError.conflict(
      `Only an approved application can be allocated a room. This application is ${application.status}.`
    );
  }

  // Existing payment-before-allocation policy is intentionally unchanged.
  const extras = (
    await loadApplicationExtras([application])
  ).get(application.id);

  if (!extras.payment || extras.payment.status !== 'paid') {
    const state = extras.payment
      ? extras.payment.status
      : 'unknown';

    throw ApiError.conflict(
      state === 'pending'
        ? 'The hostel-fee payment has not been verified as successful yet. A room can be allocated after it is.'
        : 'A verified, successful hostel-fee payment is required before a room can be allocated.'
    );
  }

  const paidBlockId = extras.payment.paid_block_id;

  if (!paidBlockId) {
    throw ApiError.conflict(
      'The payment on file has no fee block, so a room cannot be offered. Please check the payment record.'
    );
  }

  const student = await queryOne(
    `SELECT gender FROM users WHERE id = ?`,
    [application.student_id]
  );

  const rooms = await query(
    `SELECT r.id, r.room_number, r.room_type, r.gender,
            r.capacity, r.occupied_spaces, r.available_spaces,
            b.id AS block_id, b.name AS block_name
       FROM rooms r
       JOIN blocks b ON b.id = r.block_id
      WHERE r.room_type = ?
        AND r.gender = ?
        AND r.is_active = 1
        AND r.available_spaces > 0
        AND r.block_id = ?
      ORDER BY (b.id = ?) DESC,
               r.occupied_spaces DESC,
               r.room_number ASC`,
    [
      application.room_type,
      student.gender,
      paidBlockId,
      application.preferred_block_id || 0,
    ]
  );

  res.json({
    success: true,
    message: rooms.length
      ? 'Eligible rooms retrieved.'
      : 'No eligible rooms are currently available.',
    data: {
      application: {
        id: application.id,
        room_type: application.room_type,
      },
      rooms,
    },
  });
});

/**
 * POST /api/admin/applications/:id/allocate
 * Body: { room_id }
 */
const allocateApplication = asyncHandler(async (req, res) => {
  const result = await allocationService.allocateRoom({
    applicationId: req.params.id,
    roomId: req.body.room_id,
    adminId: req.session.user.id,
  });

  const updated = await queryOne(
    `${BASE_SELECT} WHERE a.id = ?`,
    [req.params.id]
  );

  res.status(201).json({
    success: true,
    message: `Room ${result.room_number} (${result.block_name}) allocated successfully.`,
    data: await mapApplicationRowOne(updated),
  });
});

/**
 * POST /api/admin/applications/:id/revoke-allocation
 * Body: { release_reason }
 */
const revokeAllocation = asyncHandler(async (req, res) => {
  await allocationService.revokeAllocation({
    applicationId: req.params.id,
    reason: req.body.release_reason,
    adminId: req.session.user.id,
  });

  const updated = await queryOne(
    `${BASE_SELECT} WHERE a.id = ?`,
    [req.params.id]
  );

  res.json({
    success: true,
    message:
      'Room allocation revoked. This application is still approved and can be allocated a different room.',
    data: await mapApplicationRowOne(updated),
  });
});

/**
 * PUT /api/admin/applications/:id/cancel
 * Body: { cancellation_reason }
 *
 * Cancels an approved application through the service transaction.
 * If the application has an active room allocation, the service releases
 * it and adjusts occupancy atomically. Historical records are preserved.
 */
const cancelApprovedApplication = asyncHandler(async (req, res) => {
  const result = await allocationService.cancelApprovedApplication({
    applicationId: req.params.id,
    reason: req.body.cancellation_reason,
    adminId: req.session.user.id,
  });

  const updated = await queryOne(
    `${BASE_SELECT} WHERE a.id = ?`,
    [req.params.id]
  );

  res.json({
    success: true,
    message: result.allocation_released
      ? 'Application cancelled and room allocation released.'
      : 'Application cancelled. No active room allocation needed to be released.',
    data: await mapApplicationRowOne(updated),
  });
});

module.exports = {
  listApplications,
  getApplicationById,
  approveApplication,
  setFeeBlock,
  getFeeBlockOptions,
  getFeeBlockAdvisory,
  rejectApplication,
  getEligibleRooms,
  allocateApplication,
  revokeAllocation,
  cancelApprovedApplication,
};
