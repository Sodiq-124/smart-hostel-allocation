/**
 * routes/adminFees.js - /api/admin/fees. Admin role only: no login -> 401,
 * a student -> 403, before any service runs. No delete route: fees are history.
 */
const express = require('express');
const c = require('../controllers/feeController');
const { requireRole } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(requireRole('admin'));
router.get('/options', c.options);
router.get('/sessions/:sessionId', c.sessionFees);
router.put('/sessions/:sessionId/blocks/:blockId', c.setFee);
module.exports = router;
