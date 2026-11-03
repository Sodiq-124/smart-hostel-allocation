/**
 * routes/adminRenewals.js - admin side: /api/admin/renewals (admin role only).
 * Static paths come before /:id. There is no delete route: renewal records are history.
 */
const express = require('express');
const c = require('../controllers/renewalController');
const { requireRole } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(requireRole('admin'));
router.get('/overview', c.overview);
router.put('/deadline', c.setDeadline);
router.get('/forfeitures/preview', c.preview);
router.post('/forfeitures/run', c.runForfeiture);
router.post('/forfeitures/allocations/:allocationId', c.forfeitOne);
router.get('/', c.list);
router.post('/:id/approve', c.approve);
router.post('/:id/reject', c.reject);
router.post('/:id/fulfill', c.fulfill);
module.exports = router;
