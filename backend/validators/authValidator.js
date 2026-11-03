

const { body } = require('express-validator');


const STUDENT_ID_PATTERN = /^[0-9]{6,15}$/;

const registerValidator = [
  body('full_name')
    .trim()
    .notEmpty().withMessage('Full name is required.')
    .isLength({ min: 2, max: 120 }).withMessage('Full name must be between 2 and 120 characters.'),

  body('student_id')
    .trim()
    .notEmpty().withMessage('Student ID is required.')
    .matches(STUDENT_ID_PATTERN)
    .withMessage('Student ID must be 6 to 15 digits, e.g. 230591052.'),

  body('email')
    .trim()
    .notEmpty().withMessage('Email is required.')
    .isEmail().withMessage('Enter a valid email address.')
    .normalizeEmail(),

  
  
  
  body('gender')
    .notEmpty().withMessage('Gender is required.')
    .isIn(['male', 'female']).withMessage('Gender must be male or female.'),

  body('password')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters.')
    .matches(/[A-Za-z]/).withMessage('Password must contain at least one letter.')
    .matches(/[0-9]/).withMessage('Password must contain at least one number.'),

  body('confirm_password')
    .custom((value, { req }) => value === req.body.password)
    .withMessage('Passwords do not match.'),
];

const loginValidator = [
  body('email')
    .trim()
    .notEmpty().withMessage('Email is required.')
    .isEmail().withMessage('Enter a valid email address.')
    .normalizeEmail(),

  body('password')
    .notEmpty().withMessage('Password is required.'),
];

module.exports = { registerValidator, loginValidator };
