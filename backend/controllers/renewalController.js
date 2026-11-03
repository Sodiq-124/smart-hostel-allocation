/**
 * controllers/renewalController.js
 * ---------------------------------------------------------------
 * Thin HTTP layer over services/renewalService.js.
 * Student and admin handlers. Identity always comes from the login session;
 * the browser never supplies a student id, session id (except the admin
 * deadline target) or a status.
 * ---------------------------------------------------------------
 */
const asyncHandler = require('../utils/asyncHandler');
const renewals = require('../services/renewalService');

const ok = (res, message, data, status = 200) => res.status(status).json({ success: true, message, data });

// ---- student ----
const getStatus = asyncHandler(async (req, res) => ok(res, 'Renewal status retrieved.', await renewals.getStudentStatus(req.session.user.id)));
const request = asyncHandler(async (req, res) => ok(res, 'Renewal request submitted.', await renewals.requestRenewal(req.session.user.id), 201));
const cancel = asyncHandler(async (req, res) => ok(res, 'Renewal request cancelled.', await renewals.cancelRenewal(req.session.user.id, req.params.id)));

// ---- admin ----
const overview = asyncHandler(async (req, res) => ok(res, 'Renewal overview retrieved.', await renewals.getOverview()));
const list = asyncHandler(async (req, res) => {
  const status = ['pending', 'approved', 'rejected', 'cancelled', 'forfeited'].includes(req.query.status) ? req.query.status : null;
  const sid = Number(req.query.session_id);
  ok(res, 'Renewals retrieved.', await renewals.listRenewals({ status, sessionId: Number.isInteger(sid) && sid > 0 ? sid : null }));
});
const setDeadline = asyncHandler(async (req, res) => ok(res, 'Renewal deadline saved.', await renewals.setRenewalDeadline({
  sessionId: req.body.hostel_session_id, renewalDeadlineAt: req.body.renewal_deadline_at,
})));
const approve = asyncHandler(async (req, res) => ok(res, 'Renewal approved.', await renewals.approveRenewal({ renewalId: req.params.id, adminId: req.session.user.id })));
const reject = asyncHandler(async (req, res) => ok(res, 'Renewal rejected.', await renewals.rejectRenewal({ renewalId: req.params.id, adminId: req.session.user.id, reason: req.body.reason })));
const fulfill = asyncHandler(async (req, res) => ok(res, 'Room allocated for the renewal.', await renewals.fulfillRenewal({ renewalId: req.params.id, adminId: req.session.user.id, roomId: req.body.room_id })));
const preview = asyncHandler(async (req, res) => ok(res, 'Forfeiture preview retrieved.', await renewals.previewForfeitures()));
const runForfeiture = asyncHandler(async (req, res) => ok(res, 'Forfeiture run completed.', await renewals.forfeitOverdue({ adminId: req.session.user.id })));
const forfeitOne = asyncHandler(async (req, res) => ok(res, 'Allocation forfeited.', await renewals.forfeitAllocation({ allocationId: req.params.allocationId, adminId: req.session.user.id, reason: req.body.reason })));

module.exports = { getStatus, request, cancel, overview, list, setDeadline, approve, reject, fulfill, preview, runForfeiture, forfeitOne };
