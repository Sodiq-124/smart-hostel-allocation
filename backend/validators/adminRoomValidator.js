

const { query, param, body } = require('express-validator');

const listRoomsValidator = [
  query('block_id').optional().isInt({ min: 1 }).withMessage('Invalid block filter.').toInt(),
  query('gender').optional().isIn(['male', 'female']).withMessage('Invalid gender filter.'),
  query('room_type').optional().isIn(['single', 'shared']).withMessage('Invalid room type filter.'),
  query('occupancy_status').optional().isIn(['vacant', 'partial', 'full']).withMessage('Invalid status filter.'),
  query('is_active').optional().isIn(['true', 'false', '0', '1']).withMessage('Invalid active filter.'),
];

const getRoomByIdValidator = [
  param('id').isInt({ min: 1 }).withMessage('Invalid room id.').toInt(),
];

const updateRoomValidator = [
  param('id').isInt({ min: 1 }).withMessage('Invalid room id.').toInt(),

  body('is_active').optional().isBoolean().withMessage('is_active must be true or false.').toBoolean(),

  
  
  
  
  
  body('capacity').optional().isInt({ min: 1, max: 12 }).withMessage('Capacity must be between 1 and 12.').toInt(),
];

module.exports = { listRoomsValidator, getRoomByIdValidator, updateRoomValidator };
