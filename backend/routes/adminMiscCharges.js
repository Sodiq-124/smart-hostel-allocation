/**
 * routes/adminMiscCharges.js
 * ---------------------------------------------------------------
 * /api/admin/misc-charges. Everything sits behind
 * requireRole('admin'): no login -> 401, a student -> 403, before any
 * validator or service runs. There is deliberately NO delete route:
 * charges with payment history are only ever deactivated.
 * ---------------------------------------------------------------
 */

const express = require('express');
const c = require('../controllers/adminMiscChargeController');
const { chargeIdParam, listChargesQuery } = require('../validators/miscChargeValidator');
const { requireRole } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate');

const router = express.Router();

router.use(requireRole('admin'));

router.get('/options', c.getOptions);
router.get('/', listChargesQuery, validate, c.listCharges);
router.post('/', c.createCharge);
router.get('/:id', chargeIdParam, validate, c.getCharge);
router.put('/:id', chargeIdParam, validate, c.updateCharge);
router.post('/:id/activate', chargeIdParam, validate, c.activateCharge);
router.post('/:id/deactivate', chargeIdParam, validate, c.deactivateCharge);

module.exports = router;
