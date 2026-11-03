const ApiError = require('../utils/ApiError');
const { queryOne } = require('../config/database');

const SESSION_COOKIE = 'hostel.sid';

/**
 * The login session stores a copy of the user's role. Before trusting it, confirm against
 * the database that the account still exists, is still active, and still has that role, so
 * a deactivated account or a changed role takes effect on the next request instead of when
 * the cookie expires.
 *
 * @returns {Promise<'none'|'ok'|'invalid'>} none = nobody logged in; invalid = the session was
 *          destroyed because the account is gone, deactivated or has a different role.
 */
async function checkSessionUser(req, res) {
  const sessionUser = req.session && req.session.user;
  if (!sessionUser) return 'none';

  const row = await queryOne(`SELECT role, is_active FROM users WHERE id = ?`, [sessionUser.id]);
  const stillValid = row && Number(row.is_active) === 1 && row.role === sessionUser.role;
  if (stillValid) return 'ok';

  await new Promise((resolve) => req.session.destroy(() => resolve()));
  if (res && typeof res.clearCookie === 'function') res.clearCookie(SESSION_COOKIE);
  return 'invalid';
}

const SESSION_ENDED = 'Your session has ended. Please log in again.';

async function requireAuth(req, res, next) {
  try {
    const state = await checkSessionUser(req, res);
    if (state === 'none') return next(ApiError.unauthorized('Please log in to continue.'));
    if (state === 'invalid') return next(ApiError.unauthorized(SESSION_ENDED));
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireRole(...allowedRoles) {
  return async function roleCheck(req, res, next) {
    try {
      const state = await checkSessionUser(req, res);
      if (state === 'none') return next(ApiError.unauthorized('Please log in to continue.'));
      if (state === 'invalid') return next(ApiError.unauthorized(SESSION_ENDED));

      if (!allowedRoles.includes(req.session.user.role)) {
        return next(
          ApiError.forbidden('You are not authorized to perform this action.')
        );
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
}

/**
 * For GET /api/auth/me: drop a session whose account is no longer valid, so the page
 * guards see "not authenticated" instead of a stale user. Never rejects the request itself.
 */
async function dropInvalidSession(req, res, next) {
  try {
    await checkSessionUser(req, res);
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = { requireAuth, requireRole, dropInvalidSession };
