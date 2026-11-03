

const express = require('express');
const {
  getRoomOptions,
  createApplication,
  getMyApplication,
  cancelApplication,
} = require('../controllers/applicationController');
const {
  createApplicationValidator,
  cancelApplicationValidator,
} = require('../validators/applicationValidator');
const { requireRole } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate');

const router = express.Router();

router.use(requireRole('student'));

router.get('/room-options', getRoomOptions);
router.post('/', createApplicationValidator, validate, createApplication);
router.get('/my', getMyApplication);
router.put('/:id/cancel', cancelApplicationValidator, validate, cancelApplication);

module.exports = router;
