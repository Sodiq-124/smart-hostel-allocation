/**
 * validators/miscChargeValidator.js
 * ---------------------------------------------------------------
 * Request-shape checks for the miscellaneous-charge routes.
 * The service (services/miscChargeService.js) re-validates every value with
 * the same rules; this layer only gives early, field-level messages and
 * rejects malformed ids before any service runs.
 * ---------------------------------------------------------------
 */

const { param, query } = require('express-validator');

const chargeIdParam = [
  param('id').isInt({ min: 1 }).withMessage('Invalid charge id.').toInt(),
];

const studentChargeIdParam = [
  param('chargeId').isInt({ min: 1 }).withMessage('Invalid charge id.').toInt(),
];

const listChargesQuery = [
  query('session_id').optional().isInt({ min: 1 }).withMessage('Invalid session id.').toInt(),
];

module.exports = { chargeIdParam, studentChargeIdParam, listChargesQuery };
