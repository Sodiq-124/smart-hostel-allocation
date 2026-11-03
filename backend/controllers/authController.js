const bcrypt = require('bcrypt');
const { queryOne, query } = require('../config/database');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

const BCRYPT_ROUNDS = 12;

function toSessionUser(row) {
  return {
    id: row.id,
    full_name: row.full_name,
    email: row.email,
    role: row.role,
    student_id: row.student_id,
    gender: row.gender,
  };
}

const register = asyncHandler(async (req, res) => {
  const { full_name, student_id, email, password, gender } = req.body;

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const result = await query(
    `INSERT INTO users (full_name, student_id, email, password, role, gender) 
     VALUES (?, ?, ?, ?, 'student', ?)`,
    [full_name, student_id, email, passwordHash, gender]
  );

  res.status(201).json({
    success: true,
    message: 'Registration successful. You can now log in.',
    data: { id: result.insertId, full_name, email },
  });
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const genericError = new ApiError(401, 'Invalid email or password.');

  const user = await queryOne(
    `SELECT id, full_name, student_id, email, password, role, gender, is_active 
       FROM users WHERE email = ?`,
    [email]
  );

  if (!user || !user.is_active) {
    await bcrypt.compare(
      password,
      '$2b$12$invalidsaltinvalidsaltinvalidsalOK'
    );
    throw genericError;
  }

  const passwordMatches = await bcrypt.compare(password, user.password);

  if (!passwordMatches) {
    throw genericError;
  }

  await new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });

  req.session.user = toSessionUser(user);

  await new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });

  res.json({
    success: true,
    message: 'Login successful.',
    data: req.session.user,
  });
});

const logout = asyncHandler(async (req, res) => {
  const cookieName = 'hostel.sid';

  if (!req.session) {
    return res.json({ success: true, message: 'Logged out.' });
  }

  await new Promise((resolve, reject) => {
    req.session.destroy((err) => (err ? reject(err) : resolve()));
  });

  res.clearCookie(cookieName);
  res.json({ success: true, message: 'Logged out successfully.' });
});

const me = asyncHandler(async (req, res) => {
  const user = (req.session && req.session.user) || null;

  res.json({
    success: true,
    message: user ? 'Authenticated.' : 'Not authenticated.',
    data: user,
  });
});

module.exports = { register, login, logout, me };