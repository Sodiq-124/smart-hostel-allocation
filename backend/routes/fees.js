/**
 * routes/fees.js - student side: GET /api/fees/current (read-only, student role).
 */
const express = require('express');
const c = require('../controllers/feeController');
const { requireRole } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(requireRole('student'));
router.get('/current', c.studentFees);
module.exports = router;
