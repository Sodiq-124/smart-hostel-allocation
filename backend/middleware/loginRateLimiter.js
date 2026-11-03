/**
 * middleware/loginRateLimiter.js
 * ---------------------------------------------------------------
 * Slows down password guessing on POST /api/auth/login.
 *
 * Two in-memory counters per time window:
 *   - per account (client IP + email): maxPerAccount attempts
 *   - per client IP:                   maxPerIp attempts
 * An attempt is counted when it ARRIVES, so a burst of parallel guesses cannot all slip
 * under the limit before the first one finishes. A successful login clears the account
 * counter and gives the IP its attempt back. Over the limit -> 429 with Retry-After.
 *
 * The counters live in this Node process: they reset when the server restarts and are not
 * shared between several server instances. That is enough for a single-instance deployment;
 * a shared store would be needed for a cluster.
 *
 * The client IP is req.ip, which is only trustworthy behind a proxy when TRUST_PROXY is
 * configured (see config/security.js).
 * ---------------------------------------------------------------
 */

const ApiError = require('../utils/ApiError');

const DEFAULTS = {
  windowMs: 15 * 60 * 1000,
  maxPerAccount: 5,
  maxPerIp: 30,
};

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function createLoginRateLimiter(options = {}) {
  const windowMs = options.windowMs || envNumber('LOGIN_RATE_WINDOW_MS', DEFAULTS.windowMs);
  const maxPerAccount = options.maxPerAccount || envNumber('LOGIN_RATE_MAX_PER_ACCOUNT', DEFAULTS.maxPerAccount);
  const maxPerIp = options.maxPerIp || envNumber('LOGIN_RATE_MAX_PER_IP', DEFAULTS.maxPerIp);
  const now = options.now || Date.now;
  const buckets = new Map();

  function purge(t) {
    if (buckets.size < 5000) return;
    for (const [key, b] of buckets) if (b.resetAt <= t) buckets.delete(key);
  }
  function live(key, t) {
    const b = buckets.get(key);
    if (!b || b.resetAt <= t) { buckets.delete(key); return null; }
    return b;
  }
  function hit(key, t) {
    const b = live(key, t) || { count: 0, resetAt: t + windowMs };
    b.count += 1;
    buckets.set(key, b);
    return b;
  }

  function middleware(req, res, next) {
    const t = now();
    purge(t);
    const ip = String(req.ip || 'unknown');
    const email = String((req.body && req.body.email) || '').trim().toLowerCase().slice(0, 254);
    const ipKey = `ip:${ip}`;
    const accountKey = `acct:${ip}|${email}`;

    const ipBucket = live(ipKey, t);
    const accountBucket = live(accountKey, t);
    const blocked = (ipBucket && ipBucket.count >= maxPerIp) || (accountBucket && accountBucket.count >= maxPerAccount);
    if (blocked) {
      const resetAt = Math.max(ipBucket && ipBucket.count >= maxPerIp ? ipBucket.resetAt : 0, accountBucket && accountBucket.count >= maxPerAccount ? accountBucket.resetAt : 0);
      const seconds = Math.max(1, Math.ceil((resetAt - t) / 1000));
      res.set('Retry-After', String(seconds));
      return next(new ApiError(429, 'Too many login attempts. Please wait a few minutes and try again.'));
    }

    hit(ipKey, t);
    hit(accountKey, t);

    res.on('finish', () => {
      if (res.statusCode === 200) {
        buckets.delete(accountKey);
        const b = buckets.get(ipKey);
        if (b && b.count > 0) b.count -= 1;
      }
    });
    return next();
  }

  middleware.reset = () => buckets.clear(); // tests only
  return middleware;
}

module.exports = { createLoginRateLimiter, loginRateLimiter: createLoginRateLimiter(), DEFAULTS };
