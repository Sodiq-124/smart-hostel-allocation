const { param, body } = require('express-validator');

const createComplaintValidator = [
  body('category')
    .trim()
    .notEmpty().withMessage('Category is required.')
    .isLength({ max: 50 }).withMessage('Category must be under 50 characters.'),

  body('subject')
    .trim()
    .notEmpty().withMessage('Subject is required.')
    .isLength({ min: 3, max: 150 }).withMessage('Subject must be between 3 and 150 characters.'),

  body('description')
    .trim()
    .notEmpty().withMessage('Description is required.')
    .isLength({ min: 10, max: 2000 }).withMessage('Description must be between 10 and 2000 characters.'),
];

const getComplaintByIdValidator = [
  param('id').isInt({ min: 1 }).withMessage('Invalid complaint id.').toInt(),
];

module.exports = { createComplaintValidator, getComplaintByIdValidator };
