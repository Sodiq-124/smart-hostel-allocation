/**
 * validators/studentValidator.js
 * ---------------------------------------------------------------
 * Rules for PUT /api/students/profile and DELETE /api/students/profile.
 *
 * Editable fields: full_name, email, phone, department, level,
 * student_id and gender - see studentController.js for the
 * business rules attached to each (student_id relies on the existing
 * unique index rather than a redundant check here; gender gets a
 * business-rule guard that only that controller can evaluate, since it
 * depends on the student's application history, not just the shape of
 * the input). role is never accepted anywhere in this file
 * - that is what makes it impossible to become an admin
 * through this endpoint no matter what the request body contains.
 * ---------------------------------------------------------------
 */

const { body } = require('express-validator');

// Same pattern used at registration (validators/authValidator.js) -
// kept in sync so a student can only ever change their ID to a value
// that would also have been accepted when creating an account.
const STUDENT_ID_PATTERN = /^[0-9]{6,15}$/;

const updateProfileValidator = [
  body('full_name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 120 }).withMessage('Full name must be between 2 and 120 characters.'),

  body('email')
    .optional()
    .trim()
    .isEmail().withMessage('Enter a valid email address.')
    .normalizeEmail(),

  body('phone')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .matches(/^[0-9+()\-\s]{7,20}$/).withMessage('Enter a valid phone number.'),

  body('department')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 120 }).withMessage('Department must be under 120 characters.'),

  body('level')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 10 }).withMessage('Level must be under 10 characters.'),

  body('student_id')
    .optional()
    .trim()
    .matches(STUDENT_ID_PATTERN).withMessage('Student ID must be 6 to 15 digits, e.g. 230591052.'),

  body('gender')
    .optional()
    .isIn(['male', 'female']).withMessage('Gender must be male or female.'),
];

/**
 * DELETE /api/students/profile
 * Requires the student's current password as a deliberate friction
 * step against an accidental click - see the brief's own requirement
 * for a confirmation step before deactivation.
 */
const deactivateAccountValidator = [
  body('password')
    .notEmpty().withMessage('Enter your password to confirm account deactivation.'),
];

module.exports = { updateProfileValidator, deactivateAccountValidator };
