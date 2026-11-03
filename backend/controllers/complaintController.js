const { queryOne, query } = require('../config/database');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

const COMPLAINT_SELECT = `
  SELECT c.id, c.category, c.subject, c.description, c.status, 
         c.admin_reply, c.replied_at, c.resolved_at, 
         c.created_at, c.updated_at, 
         r.room_number, b.name AS block_name, 
         replier.full_name AS replied_by_name 
    FROM complaints c 
    LEFT JOIN allocations al ON al.id = c.allocation_id 
    LEFT JOIN rooms r ON r.id = al.room_id 
    LEFT JOIN blocks b ON b.id = r.block_id 
    LEFT JOIN users replier ON replier.id = c.replied_by 
`;

function mapComplaintRow(row) {
  return {
    id: row.id,
    category: row.category,
    subject: row.subject,
    description: row.description,
    status: row.status,
    admin_reply: row.admin_reply,
    replied_at: row.replied_at,
    replied_by: row.replied_by_name,
    resolved_at: row.resolved_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    room: row.room_number
      ? {
          room_number: row.room_number,
          block_name: row.block_name,
        }
      : null,
  };
}

const createComplaint = asyncHandler(async (req, res) => {
  const studentId = req.session.user.id;
  const { category, subject, description } = req.body;

  const activeAllocation = await queryOne(
    `SELECT id FROM allocations WHERE student_id = ? AND status = 'active'`,
    [studentId]
  );

  const result = await query(
    `INSERT INTO complaints (student_id, allocation_id, category, subject, description) 
     VALUES (?, ?, ?, ?, ?)`,
    [
      studentId,
      activeAllocation ? activeAllocation.id : null,
      category,
      subject,
      description,
    ]
  );

  res.status(201).json({
    success: true,
    message: 'Complaint submitted successfully.',
    data: { id: result.insertId, status: 'open' },
  });
});

const getMyComplaints = asyncHandler(async (req, res) => {
  const rows = await query(
    `${COMPLAINT_SELECT} WHERE c.student_id = ? ORDER BY c.created_at DESC`,
    [req.session.user.id]
  );

  res.json({
    success: true,
    message: rows.length ? 'Complaints retrieved.' : 'No complaints found.',
    data: rows.map(mapComplaintRow),
  });
});

const getMyComplaintById = asyncHandler(async (req, res) => {
  const row = await queryOne(
    `${COMPLAINT_SELECT} WHERE c.id = ? AND c.student_id = ?`,
    [req.params.id, req.session.user.id]
  );

  if (!row) {
    throw ApiError.notFound('Complaint not found.');
  }

  res.json({
    success: true,
    message: 'Complaint retrieved.',
    data: mapComplaintRow(row),
  });
});

module.exports = {
  createComplaint,
  getMyComplaints,
  getMyComplaintById,
};