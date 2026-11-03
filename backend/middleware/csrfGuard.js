/**
 * middleware/csrfGuard.js
 * ---------------------------------------------------------------
 * Cross-site request forgery protection for the JSON API, without changing any page.
 *
 * Defence layers:
 *   1. The login cookie is SameSite=Lax (config/session.js), so browsers do not attach it to
 *      cross-site POST/PUT/DELETE requests.
 *   2. This guard, for every state-changing method (anything but GET/HEAD/OPTIONS):
 *        - rejects Sec-Fetch-Site: cross-site;
 *        - if an Origin header is present (browsers always send it on cross-origin writes) its host
 *          must be this server's Host or the host of APP_BASE_URL; "null" is refused;
 *        - otherwise, if a Referer is present, the same host rule applies.
 *      Requests with none of those headers (curl, server-to-server) are allowed: they cannot
 *      carry a victim's browser cookie.
 *
 * Only the host is compared (not the scheme) so the check still works behind a TLS-terminating
 * proxy that does not forward the original protocol.
 *
 * A synchroniser token was not added: it would need every page's requests to change, and the
 * checks above cover the browser CSRF case. Exempt: POST /api/payments/webhook, which is called
 * by Paystack and authenticated by its HMAC signature, not by a cookie.
 * ---------------------------------------------------------------
 */

const ApiError = require('../utils/ApiError');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXEMPT_PATHS = new Set(['/payments/webhook']);

function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return null; }
}

function csrfGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (EXEMPT_PATHS.has(req.path)) return next();

  const blocked = () => next(ApiError.forbidden('This request was blocked because it did not come from this site.'));

  if (String(req.get('sec-fetch-site') || '').toLowerCase() === 'cross-site') return blocked();

  const allowed = new Set();
  const ownHost = String(req.get('host') || '').toLowerCase();
  if (ownHost) allowed.add(ownHost);
  const configured = process.env.APP_BASE_URL ? hostOf(process.env.APP_BASE_URL) : null;
  if (configured) allowed.add(configured);

  const origin = req.get('origin');
  if (origin !== undefined) {
    const host = origin === 'null' ? null : hostOf(origin);
    return host && allowed.has(host) ? next() : blocked();
  }

  const referer = req.get('referer');
  if (referer) {
    const host = hostOf(referer);
    return host && allowed.has(host) ? next() : blocked();
  }
  return next();
}

module.exports = csrfGuard;
