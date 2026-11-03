/**
 * controllers/adminSessionController.js
 * ---------------------------------------------------------------
 * Thin HTTP layer over services/adminSessionService.js.
 * Every rule lives in the service; nothing here trusts the browser for
 * a session's status or "current" flag (the client can only ask for a
 * transition by id, never set a status).
 * ---------------------------------------------------------------
 */

const asyncHandler = require('../utils/asyncHandler');
const sessions = require('../services/adminSessionService');

/** GET /api/admin/sessions */
const listSessions = asyncHandler(async (req, res) => {
  const data = await sessions.listSessions();
  res.json({ success: true, message: 'Hostel sessions retrieved.', data });
});

/** GET /api/admin/sessions/current  (data is null when no session is open) */
const getCurrentSession = asyncHandler(async (req, res) => {
  const data = await sessions.getCurrentSessionSummary();
  res.json({ success: true, message: 'Current hostel session retrieved.', data });
});

/** POST /api/admin/sessions  { label, starts_on?, ends_on? } */
const createSession = asyncHandler(async (req, res) => {
  const { label, starts_on, ends_on } = req.body;
  const data = await sessions.createSession({ label, starts_on, ends_on });
  res.status(201).json({ success: true, message: `Session ${data.label} created as upcoming.`, data });
});

/** POST /api/admin/sessions/:id/open */
const openSession = asyncHandler(async (req, res) => {
  const data = await sessions.openSession(req.params.id);
  res.json({ success: true, message: `Session ${data.label} is now open and current.`, data });
});

/** POST /api/admin/sessions/:id/close */
const closeSession = asyncHandler(async (req, res) => {
  const data = await sessions.closeSession(req.params.id);
  res.json({
    success: true,
    message: `Session ${data.label} is now closed. No applications, allocations or payments were changed.`,
    data,
  });
});

module.exports = { listSessions, getCurrentSession, createSession, openSession, closeSession };
