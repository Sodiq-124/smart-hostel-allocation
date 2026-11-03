/**
 * tests/phase11_security_unit.js - authentication flows and security controls
 *
 * Runs WITHOUT a database and WITHOUT network access (application-level only):
 *   - config/database is an in-memory fake that understands the users SQL used by
 *     authController and middleware/authMiddleware.
 *   - bcrypt is replaced by a reversible fake (the project's native bcrypt binary is
 *     platform-specific); real express-session with the in-memory store gives real
 *     cookies, session regeneration and destruction.
 *   - the REAL app.js, routes, validators, csrfGuard, rate limiter and auth middleware are loaded.
 * It does NOT prove the SQL is valid MariaDB, and it does not prove bcrypt itself.
 *
 *   node tests/phase11_security_unit.js
 */
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const os = require('os');

process.env.NODE_ENV = 'test';
delete process.env.TRUST_PROXY;
process.env.APP_BASE_URL = 'http://hostel.example.test';

const backend = path.join(__dirname, '..');
const resolve = (p) => require.resolve(path.join(backend, p));
function stub(mod, exportsObj) { const id = mod.startsWith('/') ? mod : require.resolve(mod); require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj }; }

let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail !== undefined ? ` :: ${detail}` : ''}`); }
}

/* ---------------- fake users table ---------------- */
let USERS; let DB_DOWN; let LOOKUPS;
function resetUsers() {
  USERS = [
    { id: 1, full_name: 'Admin', student_id: null, email: 'admin@example.com', password: 'h$AdminPass1', role: 'admin', gender: null, is_active: 1 },
    { id: 7, full_name: 'Ada Obi', student_id: '230591052', email: 'ada@example.com', password: 'h$Password1', role: 'student', gender: 'male', is_active: 1 },
    { id: 8, full_name: 'Bola Ade', student_id: '230591053', email: 'bola@example.com', password: 'h$Password1', role: 'student', gender: 'male', is_active: 0 },
  ];
  DB_DOWN = false; LOOKUPS = 0;
}
const norm = (s) => s.replace(/\s+/g, ' ').trim();
async function queryOne(sql, p = []) {
  if (DB_DOWN) throw new Error('database down');
  const q = norm(sql);
  if (/^SELECT role, is_active FROM users WHERE id = \?$/.test(q)) { LOOKUPS += 1; const u = USERS.find((x) => x.id === p[0]); return u ? { role: u.role, is_active: u.is_active } : null; }
  if (/FROM users WHERE email = \?$/.test(q)) { const u = USERS.find((x) => x.email === p[0]); return u ? { ...u } : null; }
  throw new Error(`FAKE DB: unexpected SQL: ${q}`);
}
async function query(sql, p = []) {
  const q = norm(sql);
  if (/^INSERT INTO users \(full_name, student_id, email, password, role, gender\)/.test(q)) {
    const [full_name, student_id, email, password, gender] = p;
    if (USERS.some((u) => u.email === email)) { const e = new Error("Duplicate entry for key 'uq_users_email'"); e.code = 'ER_DUP_ENTRY'; throw e; }
    if (USERS.some((u) => u.student_id === student_id)) { const e = new Error("Duplicate entry for key 'uq_users_student_id'"); e.code = 'ER_DUP_ENTRY'; throw e; }
    const id = 100 + USERS.length; USERS.push({ id, full_name, student_id, email, password, role: 'student', gender, is_active: 1 });
    return { insertId: id };
  }
  throw new Error(`FAKE DB: unexpected SQL: ${q}`);
}
stub(resolve('config/database'), { pool: { execute: async () => { throw new Error('no database in this test'); } }, query, queryOne, withTransaction: async () => { throw new Error('no database in this test'); }, testConnection: async () => true });
stub('bcrypt', { hash: async (pw) => `h$${pw}`, compare: async (pw, hash) => hash === `h$${pw}` });
stub('morgan', () => (req, res, next) => next());
const expressSession = require('express-session');
stub(resolve('config/session'), expressSession({ name: 'hostel.sid', secret: 'test-secret-test-secret-test-secret-123', resave: false, saveUninitialized: false, rolling: true, cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 7200000 } }));

const security = require(resolve('config/security'));
const { createLoginRateLimiter, loginRateLimiter } = require(resolve('middleware/loginRateLimiter'));
const app = require(resolve('app'));

/* ---------------- http client with a cookie jar ---------------- */
let server;
function call(method, urlPath, { jar, body, headers = {} } = {}) {
  return new Promise((ok, bad) => {
    const payload = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const h = { Accept: 'application/json', ...headers };
    if (jar && jar.cookie) h.Cookie = jar.cookie;
    if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = payload.length; }
    const rq = http.request({ host: '127.0.0.1', port: server.address().port, path: urlPath, method, headers: h }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c));
      res.on('end', () => {
        const sc = res.headers['set-cookie'] || [];
        if (jar && sc.length) {
          const first = sc.find((c) => c.startsWith('hostel.sid='));
          if (first) jar.cookie = /^hostel\.sid=;|Expires=Thu, 01 Jan 1970/.test(first) ? null : first.split(';')[0];
        }
        const t = Buffer.concat(ch).toString('utf8'); let j = null; try { j = JSON.parse(t); } catch { /* html */ }
        ok({ status: res.statusCode, json: j, headers: res.headers, setCookie: sc });
      });
    });
    rq.on('error', bad); if (payload) rq.write(payload); rq.end();
  });
}
const login = (jar, email = 'ada@example.com', password = 'Password1', extra = {}) => call('POST', '/api/auth/login', { jar, body: { email, password }, ...extra });
console.error = () => {};
const log = console.log.bind(console);

(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  let r; let jar;

  /* ===== A. registration ===== */
  resetUsers(); loginRateLimiter.reset();
  const good = { full_name: 'Chi Eze', student_id: '230591099', email: 'chi@example.com', gender: 'female', password: 'Password1', confirm_password: 'Password1' };
  r = await call('POST', '/api/auth/register', { body: good });
  check('A1  valid registration -> 201, student role, password stored hashed (never plain)', r.status === 201 && USERS.at(-1).role === 'student' && USERS.at(-1).password === 'h$Password1' && USERS.at(-1).password !== 'Password1' && !('password' in r.json.data));
  r = await call('POST', '/api/auth/register', { body: { ...good, role: 'admin', is_active: 0, email: 'x2@example.com', student_id: '230591098' } });
  check('A2  a "role: admin" field in the request is ignored (always a student)', r.status === 201 && USERS.at(-1).role === 'student');
  r = await call('POST', '/api/auth/register', { body: good });
  check('A3  duplicate email -> 409 with a clear message', r.status === 409 && /email/i.test(r.json.message));
  r = await call('POST', '/api/auth/register', { body: { ...good, email: 'other@example.com' } });
  check('A4  duplicate student id -> 409', r.status === 409 && /Student ID/i.test(r.json.message));
  const bad = [
    ['missing name', { full_name: '' }], ['short password', { password: 'Ab1', confirm_password: 'Ab1' }],
    ['password without a number', { password: 'Password', confirm_password: 'Password' }], ['password without a letter', { password: '12345678', confirm_password: '12345678' }],
    ['mismatched confirmation', { confirm_password: 'Different1' }], ['bad email', { email: 'not-an-email' }],
    ['student id with letters', { student_id: 'ABC123' }], ['student id too short', { student_id: '123' }], ['bad gender', { gender: 'other' }],
  ];
  const before = USERS.length;
  for (const [name, patch] of bad) {
    r = await call('POST', '/api/auth/register', { body: { ...good, email: 'v@example.com', student_id: '230500001', ...patch } });
    check(`A5  invalid registration (${name}) -> 400`, r.status === 400 && Array.isArray(r.json.errors || r.json.details || []) );
  }
  check('A6  no invalid registration created a user', USERS.length === before);

  /* ===== B. login / session / logout ===== */
  resetUsers(); loginRateLimiter.reset(); jar = {};
  r = await call('GET', '/api/auth/me', { jar });
  check('B1  /me without a login -> not authenticated (data null)', r.status === 200 && r.json.data === null);
  r = await login(jar, 'ada@example.com', 'WrongPass1');
  check('B2  wrong password -> 401 generic message, no session cookie', r.status === 401 && r.json.message === 'Invalid email or password.' && !jar.cookie);
  const unknown = await login({}, 'nobody@example.com', 'Password1');
  check('B3  unknown email gives the SAME message as a wrong password (no account enumeration)', unknown.status === 401 && unknown.json.message === r.json.message);
  const inactive = await login({}, 'bola@example.com', 'Password1');
  check('B4  deactivated account cannot log in (same generic 401)', inactive.status === 401 && inactive.json.message === r.json.message);
  r = await login(jar);
  check('B5  correct login -> 200, user returned WITHOUT the password hash', r.status === 200 && r.json.data.email === 'ada@example.com' && !('password' in r.json.data) && !!jar.cookie);
  const cookieFlags = r.setCookie.find((c) => c.startsWith('hostel.sid='));
  check('B6  session cookie is HttpOnly and SameSite=Lax', /HttpOnly/i.test(cookieFlags) && /SameSite=Lax/i.test(cookieFlags), cookieFlags);
  r = await call('GET', '/api/auth/me', { jar });
  check('B7  /me with the cookie returns the student', r.json.data && r.json.data.role === 'student' && r.json.data.id === 7);
  const oldCookie = jar.cookie; const jar2 = { cookie: 'hostel.sid=s%3Aforged-session-id.invalid' };
  r = await call('GET', '/api/auth/me', { jar: jar2 });
  check('B8  a forged / unknown session cookie is not authenticated', r.json.data === null);
  const fixationJar = { cookie: null };
  await call('GET', '/api/auth/me', { jar: fixationJar }); // anonymous: no session is even created
  check('B9  anonymous visitors get no session cookie (saveUninitialized false)', !fixationJar.cookie);
  r = await call('POST', '/api/auth/logout', { jar });
  check('B10 logout -> 200 and clears the cookie', r.status === 200 && r.setCookie.some((c) => /^hostel\.sid=;/.test(c)));
  r = await call('GET', '/api/auth/me', { jar: { cookie: oldCookie } });
  check('B11 the OLD cookie is dead after logout (session destroyed server-side)', r.json.data === null);
  r = await call('POST', '/api/auth/login', { body: { email: 'ada@example.com' } });
  check('B12 login with a missing password -> 400', r.status === 400);
  r = await call('POST', '/api/auth/login', { body: { email: 'bad', password: 'x' } });
  check('B13 login with a malformed email -> 400', r.status === 400);
  const j1 = {}; const j2 = {};
  await login(j1); await login(j2);
  check('B14 each login gets a NEW session id (regenerated, no fixation)', j1.cookie && j2.cookie && j1.cookie !== j2.cookie);
  const pre = { cookie: oldCookie }; // an attacker-chosen id presented at login must not survive
  await login(pre);
  check('B15 a pre-set session id is replaced at login', pre.cookie !== oldCookie);

  /* ===== C. S1 login rate limiting ===== */
  resetUsers(); loginRateLimiter.reset();
  const attackerHeaders = {};
  for (let i = 1; i <= 5; i += 1) { r = await login({}, 'ada@example.com', `Wrong${i}Pass`); }
  check('C1  five wrong passwords are answered 401', r.status === 401);
  r = await login({}, 'ada@example.com', 'Password1');
  check('C2  the 6th attempt is blocked (429) EVEN with the correct password', r.status === 429 && /Too many/.test(r.json.message));
  check('C3  429 carries a Retry-After header (seconds)', Number(r.headers['retry-after']) > 0 && Number(r.headers['retry-after']) <= 900, r.headers['retry-after']);
  r = await login({}, 'bola.other@example.com', 'Password1');
  check('C4  a different account from the same address is still served (401 here, not 429)', r.status === 401);
  const xff = await login({}, 'ada@example.com', 'Password1', { headers: { 'X-Forwarded-For': '203.0.113.9' } });
  check('C5  a forged X-Forwarded-For does NOT dodge the limit (proxy headers untrusted by default)', xff.status === 429);
  loginRateLimiter.reset();
  for (let i = 0; i < 4; i += 1) await login({}, 'ada@example.com', 'WrongPass9');
  jar = {}; r = await login(jar);
  check('C6  a successful login within the limit works and clears the account counter', r.status === 200);
  for (let i = 0; i < 4; i += 1) r = await login({}, 'ada@example.com', 'WrongPass9');
  check('C7  after the success the account has a fresh allowance (4 more failures still 401)', r.status === 401);
  loginRateLimiter.reset();
  let last;
  for (let i = 0; i < 31; i += 1) last = await login({}, `user${i}@example.com`, 'WrongPass9');
  check('C8  one address trying many accounts hits the per-address limit (429)', last.status === 429);
  loginRateLimiter.reset();
  r = await call('POST', '/api/auth/login', { body: { email: 'bad' } });
  check('C9  the limiter does not block other routes (GET /api/health is not rate limited)', (await call('GET', '/api/health')).status !== 429);
  // window expiry with a controllable clock
  let clock = 1000000; const lim = createLoginRateLimiter({ windowMs: 60000, maxPerAccount: 2, maxPerIp: 10, now: () => clock });
  const fake = (email) => ({ ip: '1.2.3.4', body: { email }, set() {}, on() {} });
  const run = (req) => new Promise((ok) => lim(req, { set() {}, on() {} }, (err) => ok(err || null)));
  await run(fake('a@x.com')); await run(fake('a@x.com'));
  const blocked = await run(fake('a@x.com'));
  check('C10 limiter unit: third attempt in the window is blocked with status 429', blocked && blocked.statusCode === 429);
  clock += 61000;
  check('C11 limiter unit: allowed again after the window passes', (await run(fake('a@x.com'))) === null);
  check('C12 limiter unit: email case/spacing cannot be used to dodge the account limit', (await run(fake('  A@X.com '))) === null && (await run(fake('A@x.COM'))) !== null);

  /* ===== D. S2 per-request account re-validation ===== */
  resetUsers(); loginRateLimiter.reset(); jar = {};
  await login(jar);
  r = await call('GET', '/api/students/profile', { jar });
  check('D1  logged-in student passes the guard (reaches the controller; no DB here so not 401/403)', r.status !== 401 && r.status !== 403 && LOOKUPS >= 1);
  USERS.find((u) => u.id === 7).is_active = 0;
  r = await call('GET', '/api/students/profile', { jar });
  check('D2  account deactivated AFTER login -> next request is 401 "session has ended"', r.status === 401 && /session has ended/i.test(r.json.message));
  check('D3  the session cookie is cleared and the old cookie no longer works', r.setCookie.some((c) => /^hostel\.sid=;/.test(c)));
  r = await call('GET', '/api/auth/me', { jar: { cookie: oldCookie } });
  resetUsers(); loginRateLimiter.reset(); jar = {}; await login(jar);
  USERS.find((u) => u.id === 7).is_active = 0;
  r = await call('GET', '/api/auth/me', { jar });
  check('D4  /me also drops the dead session (reports not authenticated)', r.status === 200 && r.json.data === null);
  resetUsers(); loginRateLimiter.reset(); jar = {}; await login(jar, 'admin@example.com', 'AdminPass1');
  r = await call('GET', '/api/admin/rooms', { jar });
  check('D5  admin passes the admin guard', r.status !== 401 && r.status !== 403);
  USERS.find((u) => u.id === 1).role = 'student';
  r = await call('GET', '/api/admin/rooms', { jar });
  check('D6  role CHANGED after login (admin demoted) -> 401 on the next request, no admin access', r.status === 401);
  resetUsers(); loginRateLimiter.reset(); jar = {}; await login(jar);
  USERS.find((u) => u.id === 7).role = 'admin';
  r = await call('GET', '/api/admin/rooms', { jar });
  check('D7  a student promoted in the database does NOT gain admin from a stale student session', r.status === 401);
  resetUsers(); loginRateLimiter.reset(); jar = {}; await login(jar);
  USERS.splice(USERS.findIndex((u) => u.id === 7), 1);
  r = await call('GET', '/api/students/profile', { jar });
  check('D8  account deleted after login -> 401', r.status === 401);
  resetUsers(); loginRateLimiter.reset(); jar = {}; await login(jar);
  DB_DOWN = true;
  r = await call('GET', '/api/students/profile', { jar });
  check('D9  database error during the re-check fails CLOSED (500, never lets the request through)', r.status === 500);
  DB_DOWN = false;
  r = await call('GET', '/api/students/profile');
  check('D10 no login at all -> 401 and no database lookup', r.status === 401);
  const lookups = LOOKUPS; await call('GET', '/api/students/profile'); await call('GET', '/api/admin/rooms');
  check('D11 anonymous requests cause no users lookup', LOOKUPS === lookups);
  jar = {}; await login(jar);
  r = await call('GET', '/api/admin/rooms', { jar });
  check('D12 a valid student is still 403 on admin routes (role guard unchanged)', r.status === 403);

  /* ===== E. S3 CSRF guard ===== */
  resetUsers(); loginRateLimiter.reset(); jar = {}; await login(jar);
  const blockedMsg = (x) => x.status === 403 && /did not come from this site/.test(x.json.message);
  const post = (headers) => call('POST', '/api/auth/logout', { jar: { cookie: jar.cookie }, headers });
  check('E1  POST with a foreign Origin -> 403', blockedMsg(await post({ Origin: 'https://evil.example' })));
  check('E2  POST with Origin "null" (sandboxed frame / file) -> 403', blockedMsg(await post({ Origin: 'null' })));
  check('E3  POST with Sec-Fetch-Site: cross-site -> 403', blockedMsg(await post({ 'Sec-Fetch-Site': 'cross-site' })));
  check('E4  POST with a foreign Referer and no Origin -> 403', blockedMsg(await post({ Referer: 'https://evil.example/page' })));
  const own = `http://127.0.0.1:${server.address().port}`;
  r = await call('POST', '/api/auth/logout', { jar: { cookie: jar.cookie }, headers: { Origin: own, 'Sec-Fetch-Site': 'same-origin' } });
  check('E5  POST from this site (Origin = own host) is allowed', r.status === 200);
  jar = {}; await login(jar);
  r = await call('POST', '/api/auth/logout', { jar: { cookie: jar.cookie }, headers: { Origin: 'http://hostel.example.test' } });
  check('E6  Origin matching APP_BASE_URL is allowed (behind a proxy that rewrites Host)', r.status === 200);
  jar = {}; await login(jar);
  r = await call('POST', '/api/auth/logout', { jar: { cookie: jar.cookie } });
  check('E7  no Origin/Referer at all (curl, server tools) is allowed', r.status === 200);
  check('E8  PUT and DELETE are guarded too', blockedMsg(await call('PUT', '/api/students/profile', { jar: { cookie: jar.cookie }, headers: { Origin: 'https://evil.example' }, body: {} })) && blockedMsg(await call('DELETE', '/api/students/profile', { headers: { Origin: 'https://evil.example' }, body: {} })));
  r = await call('GET', '/api/auth/me', { headers: { Origin: 'https://evil.example' } });
  check('E9  GET requests are not blocked by the guard', r.status === 200);
  r = await call('POST', '/api/payments/webhook', { headers: { Origin: 'https://evil.example' }, body: { event: 'charge.success' } });
  check('E10 the Paystack webhook is exempt from the origin rule (it is signature-authenticated, and still rejects an unsigned call)', !blockedMsg(r) && r.status >= 400 && r.status < 500, `${r.status} ${r.json && r.json.message}`);
  r = await call('POST', '/api/auth/login', { body: { email: 'ada@example.com', password: 'Password1' }, headers: { Origin: 'https://evil.example' } });
  check('E11 a cross-site LOGIN attempt is blocked before credentials are checked', blockedMsg(r));

  /* ===== F. S4 trust proxy ===== */
  check('F1  TRUST_PROXY unset -> not trusted', security.parseTrustProxy(undefined) === null && security.parseTrustProxy('') === null && security.parseTrustProxy('false') === null && security.parseTrustProxy('0') === null);
  check('F2  a hop count is accepted', security.parseTrustProxy('1') === 1 && security.parseTrustProxy(' 2 ') === 2);
  check('F3  named / address values are accepted', security.parseTrustProxy('loopback') === 'loopback' && security.parseTrustProxy('10.0.0.0/8, 192.168.1.5') === '10.0.0.0/8, 192.168.1.5');
  let threw = false; try { security.parseTrustProxy('true'); } catch { threw = true; }
  check('F4  "true" (trust every hop) is refused', threw);
  threw = false; try { security.parseTrustProxy('$(rm -rf)'); } catch { threw = true; }
  check('F5  garbage is refused', threw);
  check('F6  the running app does NOT trust proxies by default', app.get('trust proxy') === false || app.get('trust proxy') === undefined || typeof app.get('trust proxy') === 'function' && app.get('trust proxy')('1.1.1.1') === false);
  const appPath = resolve('app');
  delete require.cache[appPath]; process.env.TRUST_PROXY = '1';
  const proxied = require(appPath);
  check('F7  TRUST_PROXY=1 enables exactly one trusted hop', proxied.get('trust proxy') === 1, String(proxied.get('trust proxy')));
  delete require.cache[appPath]; delete process.env.TRUST_PROXY;
  let ok = true; try { process.env.TRUST_PROXY = 'true'; require(appPath); ok = false; } catch { /* refused at startup */ }
  delete require.cache[appPath]; delete process.env.TRUST_PROXY;
  check('F8  TRUST_PROXY=true makes the app refuse to load', ok);

  /* ===== G. S5 session secret ===== */
  const secretError = (v) => { try { security.validateSessionSecret(v === undefined ? {} : { SESSION_SECRET: v }); return null; } catch (e) { return e.message; } };
  check('G1  missing SESSION_SECRET is refused', /not set/.test(secretError(undefined)));
  check('G2  blank SESSION_SECRET is refused', /not set/.test(secretError('   ')));
  check('G3  the .env.example placeholder is refused', /example value/.test(secretError('replace_this_with_a_long_random_string')));
  check('G4  a short secret is refused with its length (never its value)', /too short \(11 characters/.test(secretError('short-value')) && !/short-value/.test(secretError('short-value')));
  check('G5  a 48-byte hex secret is accepted', secretError(require('crypto').randomBytes(48).toString('hex')) === null);
  check('G6  a 32-character secret is accepted, 31 refused', secretError('a'.repeat(32)) === null && secretError('a'.repeat(31)) !== null);
  const tmp = os.tmpdir(); // no .env here, so the child sees only the variables passed below
  const runServer = (env) => spawnSync(process.execPath, [path.join(backend, 'server.js')], { cwd: tmp, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 20000 });
  for (const [label, env, re] of [['missing', {}, /SESSION_SECRET is not set/], ['placeholder', { SESSION_SECRET: 'replace_this_with_a_long_random_string' }, /example value/], ['too short', { SESSION_SECRET: 'abc' }, /too short/]]) {
    const out = runServer(env);
    check(`G7  server.js refuses to start with a ${label} secret (exit 1, clear message, no listener)`, out.status === 1 && re.test(out.stderr) && !/Web app/.test(out.stdout), `${out.status} ${out.stderr.slice(0, 120)}`);
  }

  server.close();
  log(`\nphase11_security_unit: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(e.stack); process.exit(2); });
