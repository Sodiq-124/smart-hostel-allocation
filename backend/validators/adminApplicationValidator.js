
/**
 * validators/adminApplicationValidator.js
 * ---------------------------------------------------------------
 * Validates administrator application operations, including listing,
 * approval, rejection, room allocation, allocation revocation,
 * and cancellation of approved applications.
 * ---------------------------------------------------------------
 */

const { query, param, body } = require('express-validator');

const listApplicationsValidator = [
  query('status')
    .optional()
    .isIn(['pending', 'approved', 'rejected', 'cancelled'])
    .withMessage('Invalid status filter.'),

  query('room_type')
    .optional()
    .isIn(['single', 'shared'])
    .withMessage('Invalid room type filter.'),

  query('block_id')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Invalid block filter.')
    .toInt(),

  query('payment_status')
    .optional()
    .isIn(['paid', 'unpaid', 'pending'])
    .withMessage('Invalid payment status filter.'),

  query('q')
    .optional()
    .trim()
    .isLength({ max: 120 })
    .withMessage('Search text is too long.'),
];

const getApplicationByIdValidator = [
  param('id')
    .isInt({ min: 1 })
    .withMessage('Invalid application id.')
    .toInt(),
];

const approveApplicationValidator = [
  param('id')
    .isInt({ min: 1 })
    .withMessage('Invalid application id.')
    .toInt(),

  // Optional: defaults to the student's preferred block.
  body('fee_block_id')
    .optional({ nullable: true, checkFalsy: true })
    .isInt({ min: 1 })
    .withMessage('Invalid fee block.')
    .toInt(),
];

const setFeeBlockValidator = [
  param('id')
    .isInt({ min: 1 })
    .withMessage('Invalid application id.')
    .toInt(),

  body('fee_block_id')
    .notEmpty()
    .withMessage('A fee block must be selected.')
    .isInt({ min: 1 })
    .withMessage('Invalid fee block.')
    .toInt(),
];

const feeBlockAdvisoryValidator = [
  param('id')
    .isInt({ min: 1 })
    .withMessage('Invalid application id.')
    .toInt(),

  query('block_id')
    .notEmpty()
    .withMessage('A block must be selected.')
    .isInt({ min: 1 })
    .withMessage('Invalid block.')
    .toInt(),
];

const rejectApplicationValidator = [
  param('id')
    .isInt({ min: 1 })
    .withMessage('Invalid application id.')
    .toInt(),

  body('rejection_reason')
    .trim()
    .notEmpty()
    .withMessage('A rejection reason is required.')
    .isLength({ min: 5, max: 255 })
    .withMessage(
      'Rejection reason must be between 5 and 255 characters.'
    ),
];

const eligibleRoomsValidator = [
  param('id')
    .isInt({ min: 1 })
    .withMessage('Invalid application id.')
    .toInt(),
];

const allocateApplicationValidator = [
  param('id')
    .isInt({ min: 1 })
    .withMessage('Invalid application id.')
    .toInt(),

  body('room_id')
    .notEmpty()
    .withMessage('A room must be selected.')
    .isInt({ min: 1 })
    .withMessage('Invalid room id.')
    .toInt(),
];

const revokeAllocationValidator = [
  param('id')
    .isInt({ min: 1 })
    .withMessage('Invalid application id.')
    .toInt(),

  body('release_reason')
    .trim()
    .notEmpty()
    .withMessage(
      'A reason is required to revoke this allocation.'
    )
    .isLength({ min: 5, max: 255 })
    .withMessage(
      'Reason must be between 5 and 255 characters.'
    ),
];

/**
 * Validates cancellation of an approved application.
 *
 * The service adds "Admin cancellation: " to the reason before storing
 * it in the existing rejection_reason column (VARCHAR(255)).
 */
const cancelApprovedApplicationValidator = [
  param('id')
    .isInt({ min: 1 })
    .withMessage('Invalid application id.')
    .toInt(),

  body('cancellation_reason')
    .trim()
    .notEmpty()
    .withMessage('A cancellation reason is required.')
    .isLength({ min: 5, max: 220 })
    .withMessage(
      'Cancellation reason must be between 5 and 220 characters.'
    ),
];

module.exports = {
  listApplicationsValidator,
  getApplicationByIdValidator,
  approveApplicationValidator,
  setFeeBlockValidator,
  feeBlockAdvisoryValidator,
  rejectApplicationValidator,
  eligibleRoomsValidator,
  allocateApplicationValidator,
  revokeAllocationValidator,
  cancelApprovedApplicationValidator,
};
