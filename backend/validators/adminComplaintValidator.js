

const { query, param, body } = require('express-validator');

const listComplaintsValidator = [
  query('status')
    .optional()
    .isIn(['open', 'in_progress', 'resolved'])
    .withMessage('Invalid status filter.'),

  query('q').optional().trim().isLength({ max: 120 }).withMessage('Search text is too long.'),
];

const getComplaintByIdValidator = [
  param('id').isInt({ min: 1 }).withMessage('Invalid complaint id.').toInt(),
];

const updateComplaintValidator = [
  param('id').isInt({ min: 1 }).withMessage('Invalid complaint id.').toInt(),

  body('status')
    .optional()
    .isIn(['open', 'in_progress', 'resolved'])
    .withMessage('Invalid status.'),

  body('admin_reply')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ min: 5, max: 2000 })
    .withMessage('Reply must be between 5 and 2000 characters.'),
];

module.exports = { listComplaintsValidator, getComplaintByIdValidator, updateComplaintValidator };
