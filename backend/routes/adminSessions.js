/**
 * routes/adminSessions.js
 * ---------------------------------------------------------------
 * /api/admin/sessions. Every route sits behind
 * requireRole('admin'): an unauthenticated request gets 401 and a
 * student gets 403 before any validator or service runs.
 * ---------------------------------------------------------------
 */

const express = require('express');
const {
  listSessions, getCurrentSession, createSession, openSession, closeSession,
} = require('../controllers/adminSessionController');
const { sessionIdValidator, createSessionValidator } = require('../validators/adminSessionValidator');
const { requireRole } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate');

const router = express.Router();

router.use(requireRole('admin'));

router.get('/', listSessions);
router.get('/current', getCurrentSession);
router.post('/', createSessionValidator, validate, createSession);
router.post('/:id/open', sessionIdValidator, validate, openSession);
router.post('/:id/close', sessionIdValidator, validate, closeSession);

module.exports = router;
