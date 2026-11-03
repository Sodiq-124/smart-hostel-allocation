const express = require('express');

const {
listApplications,
getApplicationById,
approveApplication,
setFeeBlock,
getFeeBlockOptions,
getFeeBlockAdvisory,
rejectApplication,
getEligibleRooms,
allocateApplication,
revokeAllocation,
cancelApprovedApplication,
} = require('../controllers/adminApplicationController');

const {
listApplicationsValidator,
getApplicationByIdValidator,
approveApplicationValidator,
setFeeBlockValidator,
feeBlockAdvisoryValidator,
rejectApplicationValidator,
eligibleRoomsValidator,
allocateApplicationValidator,
revokeAllocationValidator,
cancelApprovedApplicationValidator,
} = require('../validators/adminApplicationValidator');

const { requireRole } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate');

const router = express.Router();

router.use(requireRole('admin'));

router.get('/', listApplicationsValidator, validate, listApplications);
router.get('/:id', getApplicationByIdValidator, validate, getApplicationById);

router.put('/:id/approve', approveApplicationValidator, validate, approveApplication);
router.put('/:id/fee-block', setFeeBlockValidator, validate, setFeeBlock);
router.get('/:id/fee-block-options', getApplicationByIdValidator, validate, getFeeBlockOptions);
router.get('/:id/fee-block-advisory', feeBlockAdvisoryValidator, validate, getFeeBlockAdvisory);
router.put('/:id/reject', rejectApplicationValidator, validate, rejectApplication);

router.get('/:id/eligible-rooms', eligibleRoomsValidator, validate, getEligibleRooms);
router.post('/:id/allocate', allocateApplicationValidator, validate, allocateApplication);
router.post('/:id/revoke-allocation', revokeAllocationValidator, validate, revokeAllocation);

router.put('/:id/cancel', cancelApprovedApplicationValidator, validate, cancelApprovedApplication);

module.exports = router;
