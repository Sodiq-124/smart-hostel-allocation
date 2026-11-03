/**
 * controllers/adminMiscChargeController.js
 * ---------------------------------------------------------------
 * Thin HTTP layer over services/miscChargeService.js.
 * Admin-only (routes/adminMiscCharges.js). Only whitelisted fields reach the
 * service; created_by always comes from the login session.
 * ---------------------------------------------------------------
 */

const asyncHandler = require('../utils/asyncHandler');
const charges = require('../services/miscChargeService');

const listCharges = asyncHandler(async (req, res) => {
  const data = await charges.listCharges({ sessionId: req.query.session_id || null });
  res.json({ success: true, message: 'Charges retrieved.', data });
});

const getOptions = asyncHandler(async (req, res) => {
  const data = await charges.getOptions();
  res.json({ success: true, message: 'Charge options retrieved.', data });
});

const getCharge = asyncHandler(async (req, res) => {
  const data = await charges.getCharge(req.params.id);
  res.json({ success: true, message: 'Charge retrieved.', data });
});

const createCharge = asyncHandler(async (req, res) => {
  const data = await charges.createCharge(req.session.user.id, req.body);
  res.status(201).json({ success: true, message: 'Charge created.', data });
});

const updateCharge = asyncHandler(async (req, res) => {
  const data = await charges.updateCharge(req.params.id, req.body);
  res.json({ success: true, message: 'Charge updated.', data });
});

const activateCharge = asyncHandler(async (req, res) => {
  const data = await charges.setChargeActive(req.params.id, true);
  res.json({ success: true, message: 'Charge activated.', data });
});

const deactivateCharge = asyncHandler(async (req, res) => {
  const data = await charges.setChargeActive(req.params.id, false);
  res.json({ success: true, message: 'Charge deactivated. Existing payments are unchanged.', data });
});

module.exports = { listCharges, getOptions, getCharge, createCharge, updateCharge, activateCharge, deactivateCharge };
