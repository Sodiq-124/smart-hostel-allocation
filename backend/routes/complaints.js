

const express = require('express');
const {
  createComplaint,
  getMyComplaints,
  getMyComplaintById,
} = require('../controllers/complaintController');
const {
  createComplaintValidator,
  getComplaintByIdValidator,
} = require('../validators/complaintValidator');
const { requireRole } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate');

const router = express.Router();

router.use(requireRole('student'));

router.post('/', createComplaintValidator, validate, createComplaint);
router.get('/my', getMyComplaints);
router.get('/:id', getComplaintByIdValidator, validate, getMyComplaintById);

module.exports = router;
