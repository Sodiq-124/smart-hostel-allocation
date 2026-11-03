/**
 * validators/adminSessionValidator.js
 * ---------------------------------------------------------------
 * Request validation for /api/admin/sessions.
 * Uses the same pure rules as the service (utils/sessionRules.js); the
 * service re-checks them, so this layer is for clear field messages.
 * ---------------------------------------------------------------
 */

const { body, param } = require('express-validator');
const { parseSessionLabel, normaliseDate } = require('../utils/sessionRules');

function asValidatorError(fn) {
  return (value, meta) => {
    try {
      fn(value, meta);
    } catch (err) {
      throw new Error(err.message);
    }
    return true;
  };
}

const sessionIdValidator = [
  param('id').isInt({ min: 1 }).withMessage('Invalid session id.').toInt(),
];

const createSessionValidator = [
  body('label')
    .exists({ checkNull: true }).withMessage('Session label is required.').bail()
    .isString().withMessage('Session label must be text.').bail()
    .trim()
    .custom(asValidatorError((value) => parseSessionLabel(value))),

  body('starts_on')
    .optional({ nullable: true, checkFalsy: true })
    .custom(asValidatorError((value) => normaliseDate(value, 'Start date'))),

  body('ends_on')
    .optional({ nullable: true, checkFalsy: true })
    .custom(asValidatorError((value) => normaliseDate(value, 'End date')))
    .bail()
    .custom((value, { req }) => {
      const start = req.body.starts_on;
      if (start && value && /^\d{4}-\d{2}-\d{2}$/.test(start) && value < start) {
        throw new Error('End date cannot be earlier than the start date.');
      }
      return true;
    }),
];

module.exports = { sessionIdValidator, createSessionValidator };
