

const express = require('express');
const {
  listComplaints,
  getComplaintById,
  updateComplaint,
} = require('../controllers/adminComplaintController');
const {
  listComplaintsValidator,
  getComplaintByIdValidator,
  updateComplaintValidator,
} = require('../validators/adminComplaintValidator');
const { requireRole } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate');

const router = express.Router();

router.use(requireRole('admin'));

router.get('/', listComplaintsValidator, validate, listComplaints);
router.get('/:id', getComplaintByIdValidator, validate, getComplaintById);
router.put('/:id', updateComplaintValidator, validate, updateComplaint);

module.exports = router;
