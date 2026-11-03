const { body } = require('express-validator');

// Paystack references are letters, digits, "-", "." and "=". Ours are <= 80 chars.
const verifyPaymentValidator = [
  body('reference')
    .isString().withMessage('A payment reference is required.')
    .trim()
    .isLength({ min: 1, max: 80 }).withMessage('Invalid payment reference.')
    .matches(/^[A-Za-z0-9.=-]+$/).withMessage('Invalid payment reference.'),
];

module.exports = { verifyPaymentValidator };
