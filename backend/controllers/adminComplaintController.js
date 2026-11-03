const { queryOne, query } = require('../config/database');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

const ADMIN_COMPLAINT_SELECT = `
  SELECT c.id, c.category, c.subject, c.description, c.status,
         c.admin_reply, c.replied_at, c.resolved_at,
         c.created_at, c.updated_at,
         u.id AS student_pk, u.full_name AS student_name,
         u.student_id AS matric_number, u.email AS student_email,
         r.room_number, b.name AS block_name,
         replier.full_name AS replied_by_name
    FROM complaints c
    JOIN users u ON u.id = c.student_id
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
    student: {
      id: row.student_pk,
      full_name: row.student_name,
      student_id: row.matric_number,
      email: row.student_email,
    },
    room: row.room_number ? { room_number: row.room_number, block_name: row.block_name } : null,
  };
}


const listComplaints = asyncHandler(async (req, res) => {
  const { status, q } = req.query;

  const conditions = [];
  const params = [];

  if (status) {
    conditions.push('c.status = ?');
    params.push(status);
  }
  if (q) {
    conditions.push('(u.full_name LIKE ? OR u.email LIKE ? OR c.subject LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await query(
    `${ADMIN_COMPLAINT_SELECT} ${whereClause} ORDER BY c.created_at DESC`,
    params
  );

  res.json({
    success: true,
    message: rows.length ? 'Complaints retrieved.' : 'No complaints found.',
    data: rows.map(mapComplaintRow),
  });
});


const getComplaintById = asyncHandler(async (req, res) => {
  const row = await queryOne(`${ADMIN_COMPLAINT_SELECT} WHERE c.id = ?`, [req.params.id]);
  if (!row) {
    throw ApiError.notFound('Complaint not found.');
  }
  res.json({ success: true, message: 'Complaint retrieved.', data: mapComplaintRow(row) });
});


const updateComplaint = asyncHandler(async (req, res) => {
  const complaintId = req.params.id;
  const adminId = req.session.user.id;

  const complaint = await queryOne(`SELECT id, status FROM complaints WHERE id = ?`, [complaintId]);
  if (!complaint) {
    throw ApiError.notFound('Complaint not found.');
  }

  const updates = [];
  const values = [];

  if (req.body.admin_reply !== undefined) {
    updates.push('admin_reply = ?', 'replied_by = ?', 'replied_at = NOW()');
    values.push(req.body.admin_reply, adminId);
  }

  if (req.body.status !== undefined) {
    updates.push('status = ?');
    values.push(req.body.status);

    if (req.body.status === 'resolved' && complaint.status !== 'resolved') {
      updates.push('resolved_at = NOW()');
    } else if (req.body.status !== 'resolved' && complaint.status === 'resolved') {
      updates.push('resolved_at = NULL');
    }
  }

  if (updates.length === 0) {
    return res.json({ success: true, message: 'Nothing to update.', data: null });
  }

  values.push(complaintId);
  await query(`UPDATE complaints SET ${updates.join(', ')} WHERE id = ?`, values);

  const updated = await queryOne(`${ADMIN_COMPLAINT_SELECT} WHERE c.id = ?`, [complaintId]);

  res.json({
    success: true,
    message: 'Complaint updated successfully.',
    data: mapComplaintRow(updated),
  });
});

module.exports = { listComplaints, getComplaintById, updateComplaint };
