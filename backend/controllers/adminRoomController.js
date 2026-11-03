const { queryOne, query } = require('../config/database');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

// Gender is a per-ROOM field (migrations/003_room_gender.sql)
// - a block can hold both. Selected directly from rooms, not via the
// now-vestigial blocks.gender.
const ROOM_SELECT = `
  SELECT r.id, r.room_number, r.gender, r.room_type, r.capacity, r.occupied_spaces,
         r.available_spaces, r.status AS occupancy_status, r.is_active, r.floor,
         b.id AS block_id, b.name AS block_name
    FROM rooms r
    JOIN blocks b ON b.id = r.block_id
`;

function mapRoomRow(row) {
  return {
    id: row.id,
    room_number: row.room_number,
    gender: row.gender,
    room_type: row.room_type,
    capacity: row.capacity,
    occupied_spaces: row.occupied_spaces,
    available_spaces: row.available_spaces,
    occupancy_status: row.occupancy_status, 
    is_active: !!row.is_active,
    floor: row.floor,
    block: { id: row.block_id, name: row.block_name },
  };
}


const listRooms = asyncHandler(async (req, res) => {
  const { block_id, gender, room_type, occupancy_status, is_active } = req.query;

  const conditions = [];
  const params = [];

  if (block_id) { conditions.push('r.block_id = ?'); params.push(block_id); }
  // The second of the two independent selectors the admin
  // room-management view is built around - "Block A/B/C/D" and
  // "Male/Female" - each of the 8 combinations is its own section.
  if (gender) { conditions.push('r.gender = ?'); params.push(gender); }
  if (room_type) { conditions.push('r.room_type = ?'); params.push(room_type); }
  if (occupancy_status) { conditions.push('r.status = ?'); params.push(occupancy_status); }
  if (is_active !== undefined) { conditions.push('r.is_active = ?'); params.push(is_active === 'true' || is_active === '1' ? 1 : 0); }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await query(
    `${ROOM_SELECT} ${whereClause} ORDER BY b.name, r.gender, r.room_number`,
    params
  );

  res.json({
    success: true,
    message: rows.length ? 'Rooms retrieved.' : 'No rooms found.',
    data: rows.map(mapRoomRow),
  });
});


const getRoomById = asyncHandler(async (req, res) => {
  const row = await queryOne(`${ROOM_SELECT} WHERE r.id = ?`, [req.params.id]);
  if (!row) {
    throw ApiError.notFound('Room not found.');
  }
  res.json({ success: true, message: 'Room retrieved.', data: mapRoomRow(row) });
});


const ALLOWED_ROOM_FIELDS = ['is_active', 'capacity'];

const updateRoom = asyncHandler(async (req, res) => {
  const roomId = req.params.id;

  const room = await queryOne(
    `SELECT id, room_type, capacity, occupied_spaces FROM rooms WHERE id = ?`,
    [roomId]
  );
  if (!room) {
    throw ApiError.notFound('Room not found.');
  }

  const updates = [];
  const values = [];

  if (req.body.capacity !== undefined) {
    const newCapacity = req.body.capacity;

    if (room.room_type === 'single' && newCapacity !== 1) {
      throw ApiError.badRequest('A single room must have a capacity of exactly 1.');
    }
    if (room.room_type === 'shared' && (newCapacity < 2 || newCapacity > 12)) {
      throw ApiError.badRequest('A shared room capacity must be between 2 and 12.');
    }
    if (newCapacity < room.occupied_spaces) {
      throw ApiError.conflict(
        `Capacity cannot be less than the ${room.occupied_spaces} student(s) already allocated to this room.`
      );
    }

    updates.push('capacity = ?');
    values.push(newCapacity);
  }

  if (req.body.is_active !== undefined) {
    updates.push('is_active = ?');
    values.push(req.body.is_active ? 1 : 0);
  }

  if (updates.length === 0) {
    return res.json({ success: true, message: 'Nothing to update.', data: null });
  }

  values.push(roomId);
  await query(`UPDATE rooms SET ${updates.join(', ')} WHERE id = ?`, values);

  const updated = await queryOne(`${ROOM_SELECT} WHERE r.id = ?`, [roomId]);

  res.json({
    success: true,
    message: 'Room updated successfully.',
    data: mapRoomRow(updated),
  });
});

module.exports = { listRooms, getRoomById, updateRoom };
