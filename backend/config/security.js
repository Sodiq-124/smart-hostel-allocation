/**
 * config/security.js
 * ---------------------------------------------------------------
 * Startup checks and parsing for security-related environment variables.
 * Pure functions: they read only the object they are given, so they are
 * testable without touching process.env or the database.
 * ---------------------------------------------------------------
 */

const MIN_SECRET_LENGTH = 32;
const PLACEHOLDER_SECRETS = new Set([
  'replace_this_with_a_long_random_string',
  'changeme',
  'change_me',
  'secret',
  'your_secret_here',
]);

/**
 * The session secret signs the login cookie, so a missing, example or short value
 * would let anyone forge a session. Refuse to start instead of running unsafely.
 * @param {Record<string, string|undefined>} env
 * @throws {Error} with a message that says how to fix it (never includes the secret)
 */
function validateSessionSecret(env) {
  const secret = env.SESSION_SECRET;
  const fix = "Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\" and set SESSION_SECRET in backend/.env.";
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new Error(`SESSION_SECRET is not set. ${fix}`);
  }
  if (PLACEHOLDER_SECRETS.has(secret.trim().toLowerCase())) {
    throw new Error(`SESSION_SECRET is still the example value. ${fix}`);
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`SESSION_SECRET is too short (${secret.length} characters; at least ${MIN_SECRET_LENGTH} are required). ${fix}`);
  }
}

/**
 * Express "trust proxy" is OFF unless TRUST_PROXY is set on purpose. Trusting a proxy that
 * is not really there lets any client spoof its IP address (and so dodge the login rate
 * limit), so the value must name the real deployment:
 *   unset / false / 0 / off   -> not trusted (returns null)
 *   a whole number N >= 1     -> trust N proxy hops in front of the app
 *   loopback | linklocal | uniquelocal, or a comma-separated list of IPs/CIDR ranges
 * "true" is refused because it trusts every hop.
 * @returns {null|number|string} the value for app.set('trust proxy', ...), or null for "leave off"
 */
function parseTrustProxy(raw) {
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim();
  const lower = value.toLowerCase();
  if (value === '' || lower === 'false' || lower === 'off' || value === '0') return null;
  if (lower === 'true' || lower === 'on' || lower === 'yes') {
    throw new Error('TRUST_PROXY=true trusts every proxy hop and lets clients spoof their IP. Use the number of proxies in front of the app (for example 1), or an address list such as loopback.');
  }
  if (/^\d+$/.test(value)) return Number(value);
  if (/^[0-9a-zA-Z:.\/, -]+$/.test(value)) return value;
  throw new Error('TRUST_PROXY is not a hop count or a list of addresses.');
}

module.exports = { validateSessionSecret, parseTrustProxy, MIN_SECRET_LENGTH };
