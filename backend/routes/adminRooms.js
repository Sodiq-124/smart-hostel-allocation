

const express = require('express');
const { listRooms, getRoomById, updateRoom } = require('../controllers/adminRoomController');
const {
  listRoomsValidator,
  getRoomByIdValidator,
  updateRoomValidator,
} = require('../validators/adminRoomValidator');
const { requireRole } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate');

const router = express.Router();

router.use(requireRole('admin'));

router.get('/', listRoomsValidator, validate, listRooms);
router.get('/:id', getRoomByIdValidator, validate, getRoomById);
router.put('/:id', updateRoomValidator, validate, updateRoom);

module.exports = router;
