/**
 * routes/payments.js
 * ---------------------------------------------------------------
 * /webhook is public but signature-checked. Everything after
 * requireRole('student') is the logged-in student's own payment.
 * ---------------------------------------------------------------
 */

const express = require('express');
const { getStatus, initialize, verify, webhook, listMiscCharges, initializeMisc, history } = require('../controllers/paymentController');
const { verifyPaymentValidator } = require('../validators/paymentValidator');
const { studentChargeIdParam } = require('../validators/miscChargeValidator');
const { requireRole } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate');

const router = express.Router();

router.post('/webhook', webhook);

router.use(requireRole('student'));

router.get('/status', getStatus);
router.post('/initialize', initialize);
router.post('/verify', verifyPaymentValidator, validate, verify);

// Miscellaneous charges (same student-only guard as above)
router.get('/misc-charges', listMiscCharges);
router.post('/misc-charges/:chargeId/initialize', studentChargeIdParam, validate, initializeMisc);
router.get('/history', history);

module.exports = router;
