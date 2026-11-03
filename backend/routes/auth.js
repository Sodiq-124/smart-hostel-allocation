

const express = require('express');
const { register, login, logout, me } = require('../controllers/authController');
const { registerValidator, loginValidator } = require('../validators/authValidator');
const validate = require('../middleware/validate');
const { loginRateLimiter } = require('../middleware/loginRateLimiter');
const { dropInvalidSession } = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/register', registerValidator, validate, register);
router.post('/login', loginRateLimiter, loginValidator, validate, login);
router.post('/logout', logout);
router.get('/me', dropInvalidSession, me);

module.exports = router;
