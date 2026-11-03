/**
 * routes/renewals.js - student side: /api/renewals (student role only).
 */
const express = require('express');
const c = require('../controllers/renewalController');
const { requireRole } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(requireRole('student'));
router.get('/status', c.getStatus);
router.post('/', c.request);
router.post('/:id/cancel', c.cancel);
module.exports = router;
