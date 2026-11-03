

const { body, param } = require('express-validator');

const createApplicationValidator = [
  body('room_type')
    .notEmpty().withMessage('Room type is required.')
    .isIn(['single', 'shared']).withMessage('Room type must be single or shared.'),

  body('preferred_block_id')
    .optional({ nullable: true, checkFalsy: true })
    .isInt({ min: 1 }).withMessage('Invalid block selected.')
    .toInt(),

  body('special_request')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 500 }).withMessage('Special request must be under 500 characters.'),
];

const cancelApplicationValidator = [
  param('id')
    .isInt({ min: 1 }).withMessage('Invalid application id.')
    .toInt(),
];

module.exports = { createApplicationValidator, cancelApplicationValidator };
