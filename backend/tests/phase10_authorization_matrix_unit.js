/**
 * tests/phase10_authorization_matrix_unit.js - route authorization matrix
 *
 * Enumerates EVERY route registered under /api (by walking routes/index.js and each
 * router's stack, so a newly added route is covered automatically) and checks:
 *   - anonymous callers get 401 on everything except the documented public routes;
 *   - a logged-in STUDENT gets 403 on every /api/admin/* route;
 *   - a logged-in ADMIN passes the guard on /api/admin/* routes;
 *   - a deactivated account is rejected everywhere (401).
 * No database, no network: the users lookup is a fake; any other SQL throws, which is
 * fine - a request that passes the guard then fails with 400/500, never 401/403.
 *
 *   node tests/phase10_authorization_matrix_unit.js
 */
const path = require('path');
const http = require('http');
process.env.NODE_ENV = 'test';
const backend = path.join(__dirname, '..');
const resolve = (p) => require.resolve(path.join(backend, p));
function stub(mod, exp) { const id = mod.startsWith('/') ? mod : require.resolve(mod); require.cache[id] = { id, filename: id, loaded: true, exports: exp }; }

let pass = 0; let fail = 0;
function check(name, ok, detail) { if (ok) { pass += 1; } else { fail += 1; console.log(`  FAIL ${name}${detail !== undefined ? ` :: ${detail}` : ''}`); } }

const USERS = { 1: { role: 'admin', is_active: 1 }, 7: { role: 'student', is_active: 1 }, 8: { role: 'student', is_active: 0 } };
const denied = async () => { throw new Error('no database in this test'); };
const queryOne = async (sql, p = []) => (/FROM users WHERE id = \?/.test(sql.replace(/\s+/g, ' ')) ? (USERS[p[0]] || null) : denied());
stub(resolve('config/database'), { pool: { execute: denied, getConnection: denied }, query: denied, queryOne, withTransaction: denied, testConnection: async () => true });
stub('bcrypt', { hash: async () => 'x', compare: async () => false });
stub('morgan', () => (req, res, next) => next());
stub(resolve('config/session'), (req, res, next) => {
  const id = Number(req.headers['x-test-user'] || 0);
  req.session = { destroy: (cb) => cb && cb(), regenerate: (cb) => cb && cb(), save: (cb) => cb && cb() };
  if (id) { req.session.userId = id; req.session.user = { id, role: USERS[id] ? USERS[id].role : 'student' }; }
  next();
});
console.error = () => {};

const authMw = require(resolve('middleware/authMiddleware'));
const app = require(resolve('app'));

/* The session shape used by authMiddleware - read it rather than guess. */
const src = require('fs').readFileSync(resolve('middleware/authMiddleware'), 'utf8');
const sessionKey = /req\.session\.(\w+)/.exec(src)[1];

const MOUNTS = [
  ['/auth', 'auth'], ['/students', 'students'], ['/applications', 'applications'], ['/complaints', 'complaints'],
  ['/admin/applications', 'adminApplications'], ['/admin/rooms', 'adminRooms'], ['/admin/complaints', 'adminComplaints'],
  ['/admin/sessions', 'adminSessions'], ['/payments', 'payments'], ['/admin/misc-charges', 'adminMiscCharges'],
  ['/renewals', 'renewals'], ['/admin/renewals', 'adminRenewals'], ['/fees', 'fees'], ['/admin/fees', 'adminFees'],
];
const routes = [{ method: 'get', path: '/api/health' }];
for (const [mount, file] of MOUNTS) {
  const router = require(resolve(`routes/${file}`));
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      routes.push({ method, path: `/api${mount}${layer.route.path === '/' ? '' : layer.route.path}`.replace(/:\w+/g, '1') });
    }
  }
}
// every router file under routes/ must be mounted above, otherwise this matrix would silently miss it
const mountedFiles = new Set(MOUNTS.map((m) => m[1]).concat(['index']));
const present = require('fs').readdirSync(path.join(backend, 'routes')).filter((f) => f.endsWith('.js')).map((f) => f.replace('.js', ''));
check('every routes/*.js file is covered by the matrix', present.every((f) => mountedFiles.has(f)), present.filter((f) => !mountedFiles.has(f)).join(','));

// Routes that are intentionally reachable without a session. Anything else must answer 401.
const PUBLIC = new Set([
  'get /api/health', 'post /api/auth/register', 'post /api/auth/login', 'post /api/auth/logout', 'get /api/auth/me',
  'post /api/payments/webhook',
]);

let server;
function call(method, urlPath, userId) {
  return new Promise((ok, bad) => {
    const body = ['post', 'put', 'patch', 'delete'].includes(method) ? Buffer.from('{}') : null;
    const headers = { Accept: 'application/json' };
    if (userId) headers['x-test-user'] = String(userId);
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = body.length; }
    const rq = http.request({ host: '127.0.0.1', port: server.address().port, path: urlPath, method: method.toUpperCase(), headers }, (res) => { res.resume(); res.on('end', () => ok(res.statusCode)); });
    rq.on('error', bad); if (body) rq.write(body); rq.end();
  });
}

(async () => {
  server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.on('listening', r));
  check('route enumeration found a meaningful number of routes', routes.length >= 60, routes.length);
  let n = 0;
  for (const r of routes) {
    const key = `${r.method} ${r.path.replace(/\/1(?=\/|$)/g, '/:id')}`;
    const isPublic = PUBLIC.has(`${r.method} ${r.path}`);
    const isAdmin = r.path.startsWith('/api/admin/');
    n += 1;
    const anon = await call(r.method, r.path, 0);
    if (key === 'post /api/payments/webhook') check('webhook is not session-guarded: an unsigned call is refused by its SIGNATURE check (401), not the login guard', anon === 401 && !(await new Promise((ok) => { const rq = http.request({ host: '127.0.0.1', port: server.address().port, path: r.path, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => ok(/log in/i.test(t))); }); rq.end('{}'); })));
    else if (isPublic) check(`public ${key} is reachable anonymously`, anon !== 401 && anon !== 403, anon);
    else check(`anonymous -> 401 on ${key}`, anon === 401, anon);
    if (isPublic) continue;
    const dead = await call(r.method, r.path, 8);
    check(`deactivated account -> 401 on ${key}`, dead === 401, dead);
    if (isAdmin) {
      const st = await call(r.method, r.path, 7);
      check(`student -> 403 on ${key}`, st === 403, st);
      const ad = await call(r.method, r.path, 1);
      check(`admin passes the guard on ${key}`, ad !== 401 && ad !== 403, ad);
    } else {
      const st = await call(r.method, r.path, 7);
      check(`student passes the guard on ${key}`, st !== 401 && st !== 403, st);
    }
  }
  server.close();
  console.log(`routes covered: ${n} (admin-only: ${routes.filter((r) => r.path.startsWith('/api/admin/')).length}, public: ${PUBLIC.size})`);
  console.log(`phase10_authorization_matrix_unit: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(e.stack); process.exit(2); });
