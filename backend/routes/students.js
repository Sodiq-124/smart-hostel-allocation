/**
 * routes/students.js
 * ---------------------------------------------------------------
 * Every route here requires requireRole('student') - an admin session
 * hitting these endpoints is refused, just as a student hitting an
 * admin endpoint is refused. Roles are not a hierarchy where admin can
 * do everything a student can; they are two separate capability sets.
 * (An admin has their OWN way to look at a student's data, through
 * the /api/admin/* endpoints - a different, audited path, not a side
 * door through the student's own endpoints.)
 * ---------------------------------------------------------------
 */

const express = require('express');
const { getProfile, updateProfile, deactivateAccount, getDashboard } = require('../controllers/studentController');
const { updateProfileValidator, deactivateAccountValidator } = require('../validators/studentValidator');
const { requireRole } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate');

const router = express.Router();

router.use(requireRole('student'));

router.get('/profile', getProfile);
router.put('/profile', updateProfileValidator, validate, updateProfile);
router.delete('/profile', deactivateAccountValidator, validate, deactivateAccount);
router.get('/dashboard', getDashboard);

module.exports = router;
