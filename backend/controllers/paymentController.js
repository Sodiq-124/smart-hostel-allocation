/**
 * controllers/paymentController.js
 * ---------------------------------------------------------------
 * Thin HTTP layer over services/paymentService.js. Nothing here reads
 * an amount, a currency, an application id or a "paid" flag from the
 * request: the student comes from the login session and everything else
 * is looked up (and verified with Paystack) on the server.
 * ---------------------------------------------------------------
 */

const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paymentService = require('../services/paymentService');
const miscPayments = require('../services/miscPaymentService');
const paystack = require('../services/paystackService');

/** GET /api/payments/status */
const getStatus = asyncHandler(async (req, res) => {
  const data = await paymentService.getPaymentStatus(req.session.user.id);
  res.json({ success: true, message: 'Payment status retrieved.', data });
});

/** POST /api/payments/initialize  (no body is read) */
const initialize = asyncHandler(async (req, res) => {
  const data = await paymentService.initializePayment({ studentId: req.session.user.id });
  res.status(201).json({ success: true, message: 'Payment started.', data });
});

/** POST /api/payments/verify  { reference } - called by the page Paystack returns the student to. */
const verify = asyncHandler(async (req, res) => {
  const result = await paymentService.verifyAndSettle(req.body.reference, {
    studentId: req.session.user.id,
  });
  res.json({ success: true, message: 'Payment checked.', data: result });
});

/** GET /api/payments/misc-charges - charges that apply to THIS student, with payment state. */
const listMiscCharges = asyncHandler(async (req, res) => {
  const data = await miscPayments.listEligibleCharges(req.session.user.id);
  res.json({ success: true, message: 'Charges retrieved.', data });
});

/** POST /api/payments/misc-charges/:chargeId/initialize  (the id is only a lookup key; no body is read) */
const initializeMisc = asyncHandler(async (req, res) => {
  const data = await miscPayments.initializeMiscPayment({
    studentId: req.session.user.id,
    chargeId: req.params.chargeId,
  });
  res.status(201).json({ success: true, message: 'Payment started.', data });
});

/** GET /api/payments/history - this student's own payments (hostel and miscellaneous, typed). */
const history = asyncHandler(async (req, res) => {
  const data = await miscPayments.getPaymentHistory(req.session.user.id);
  res.json({ success: true, message: 'Payment history retrieved.', data });
});

/**
 * POST /api/payments/webhook  (no login: Paystack calls this)
 * Authenticated by the HMAC-SHA512 signature over the RAW body. The body
 * itself is only used to learn which reference to verify with Paystack.
 */
const webhook = asyncHandler(async (req, res) => {
  const signature = req.get('x-paystack-signature');
  if (!paystack.isValidWebhookSignature(req.rawBody, signature)) {
    throw ApiError.unauthorized('Invalid signature.');
  }
  try {
    await paymentService.handleWebhookEvent(req.body);
  } catch (err) {
    // 4xx = permanent (e.g. amount mismatch, already logged): acknowledge so
    // Paystack stops retrying. 5xx = transient (provider/db down): let it retry.
    if (!(err instanceof ApiError) || err.statusCode >= 500) throw err;
    console.error(`[payments] webhook acknowledged with error: ${err.message}`);
  }
  res.json({ success: true, message: 'OK', data: null });
});

module.exports = { getStatus, initialize, verify, webhook, listMiscCharges, initializeMisc, history };
