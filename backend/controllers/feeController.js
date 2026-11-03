/**
 * controllers/feeController.js - thin HTTP layer over services/feeAdminService.js.
 * The admin id comes from the login session; the browser supplies only a session id,
 * a block id (in the URL) and an amount for the admin write.
 */
const asyncHandler = require('../utils/asyncHandler');
const fees = require('../services/feeAdminService');

const ok = (res, message, data) => res.json({ success: true, message, data });

const options = asyncHandler(async (req, res) => ok(res, 'Sessions retrieved.', { sessions: await fees.listSessions() }));
const sessionFees = asyncHandler(async (req, res) => ok(res, 'Fees retrieved.', await fees.getSessionFees(req.params.sessionId)));
const setFee = asyncHandler(async (req, res) => {
  const data = await fees.setBlockFee({
    sessionId: req.params.sessionId, blockId: req.params.blockId,
    amount: req.body ? req.body.amount : undefined, adminId: req.session.user.id,
  });
  ok(res, data.changed ? 'Hostel fee saved.' : 'The fee is already set to that amount. Nothing changed.', data);
});
const studentFees = asyncHandler(async (req, res) => ok(res, 'Hostel fees retrieved.', await fees.getStudentFees(req.session.user.id)));

module.exports = { options, sessionFees, setFee, studentFees };
