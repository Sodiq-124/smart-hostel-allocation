/**
 * tests/phase10_validation_unit.js - server-side input validation
 *
 * Sends malformed input through the REAL app (routes + validators + auth guards) and
 * proves each is answered 400 BEFORE any database work: the fake database records every
 * statement other than the account re-check, and the test fails if any other was run.
 * Each group also sends one acceptable payload to show validation is not rejecting good input
 * (it then reaches the controller, which has no database here, so it ends 500 - not 400).
 * Application-level only; no database; no network.
 *
 *   node tests/phase10_validation_unit.js
 */
const path = require('path');
const http = require('http');
process.env.NODE_ENV = 'test';
const backend = path.join(__dirname, '..');
const resolve = (p) => require.resolve(path.join(backend, p));
function stub(mod, exp) { const id = mod.startsWith('/') ? mod : require.resolve(mod); require.cache[id] = { id, filename: id, loaded: true, exports: exp }; }
let pass = 0; let fail = 0;
function check(name, ok, detail) { if (ok) { pass += 1; } else { fail += 1; console.log(`  FAIL ${name}${detail !== undefined ? ` :: ${detail}` : ''}`); } }

const touched = [];
const USERS = { 1: { role: 'admin', is_active: 1 }, 7: { role: 'student', is_active: 1 } };
const dbFail = async (sql) => { touched.push(String(sql).replace(/\s+/g, ' ').slice(0, 80)); throw new Error('no database in this test'); };
const queryOne = async (sql, p = []) => (/FROM users WHERE id = \?/.test(sql.replace(/\s+/g, ' ')) ? USERS[p[0]] : dbFail(sql));
stub(resolve('config/database'), { pool: { execute: dbFail, getConnection: dbFail }, query: dbFail, queryOne, withTransaction: dbFail, testConnection: async () => true });
stub('bcrypt', { hash: async () => 'x', compare: async () => false });
stub('morgan', () => (req, res, next) => next());
stub(resolve('config/session'), (req, res, next) => {
  const id = Number(req.headers['x-test-user'] || 0);
  req.session = { destroy: (cb) => cb && cb() };
  if (id) { req.session.userId = id; req.session.user = { id, role: USERS[id].role }; }
  next();
});
console.error = () => {};
const app = require(resolve('app'));
let server;
function call(method, urlPath, user, body) {
  return new Promise((ok, bad) => {
    const payload = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const h = { Accept: 'application/json', 'x-test-user': String(user) };
    if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = payload.length; }
    const rq = http.request({ host: '127.0.0.1', port: server.address().port, path: urlPath, method, headers: h }, (res) => { res.resume(); res.on('end', () => ok(res.statusCode)); });
    rq.on('error', bad); if (payload) rq.write(payload); rq.end();
  });
}
const long = (n) => 'x'.repeat(n);

(async () => {
  server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.on('listening', r));
  const rejected = async (label, method, url, user, body) => {
    const before = touched.length; const s = await call(method, url, user, body);
    check(`${label} -> 400`, s === 400, s);
    check(`${label}: rejected before any database work`, touched.length === before, touched.slice(before).join(' | '));
  };
  const accepted = async (label, method, url, user, body) => {
    const s = await call(method, url, user, body); check(`${label} passes validation (not 400)`, s !== 400, s);
  };

  /* applications (student 7) */
  await rejected('application: room_type outside single/shared', 'POST', '/api/applications', 7, { room_type: 'penthouse' });
  await rejected('application: room_type is an SQL string', 'POST', '/api/applications', 7, { room_type: "single' OR '1'='1" });
  await accepted('application: preferred_block_id 0 / empty means "no preference" (by design: optional + checkFalsy; controller stores NULL)', 'POST', '/api/applications', 7, { room_type: 'single', preferred_block_id: 0 });
  await rejected('application: preferred_block_id negative', 'POST', '/api/applications', 7, { room_type: 'single', preferred_block_id: -3 });
  await rejected('application: preferred_block_id not a number', 'POST', '/api/applications', 7, { room_type: 'single', preferred_block_id: 'abc' });
  await rejected('application: special_request over 500 chars', 'POST', '/api/applications', 7, { room_type: 'shared', special_request: long(501) });
  await rejected('application cancel: id = 0', 'PUT', '/api/applications/0/cancel', 7, {});
  await rejected('application cancel: id not numeric', 'PUT', '/api/applications/abc/cancel', 7, {});
  await rejected('application cancel: negative id', 'PUT', '/api/applications/-5/cancel', 7, {});
  await accepted('application: good payload', 'POST', '/api/applications', 7, { room_type: 'single', preferred_block_id: 2, special_request: 'Ground floor please' });

  /* complaints (student 7) */
  const c = { category: 'maintenance', subject: 'Broken tap', description: 'The tap in my room is broken.' };
  await rejected('complaint: subject too short', 'POST', '/api/complaints', 7, { ...c, subject: 'ab' });
  await rejected('complaint: subject over 150', 'POST', '/api/complaints', 7, { ...c, subject: long(151) });
  await rejected('complaint: description too short', 'POST', '/api/complaints', 7, { ...c, description: 'short' });
  await rejected('complaint: description over 2000', 'POST', '/api/complaints', 7, { ...c, description: long(2001) });
  await rejected('complaint: category over 50', 'POST', '/api/complaints', 7, { ...c, category: long(51) });
  await rejected('complaint: empty body', 'POST', '/api/complaints', 7, {});
  await rejected('complaint by id: id = 0', 'GET', '/api/complaints/0', 7);
  await rejected('complaint by id: id not numeric', 'GET', '/api/complaints/abc', 7);
  await accepted('complaint: good payload', 'POST', '/api/complaints', 7, c);

  /* student profile (student 7) */
  const prof = { full_name: 'Ada Obi', email: 'ada@example.com', phone: '08012345678', department: 'Computer Science', level: '300', student_id: '230591052', gender: 'female' };
  await rejected('profile: full_name 1 char', 'PUT', '/api/students/profile', 7, { ...prof, full_name: 'A' });
  await rejected('profile: full_name over 120', 'PUT', '/api/students/profile', 7, { ...prof, full_name: long(121) });
  await rejected('profile: malformed email', 'PUT', '/api/students/profile', 7, { ...prof, email: 'ada@' });
  await rejected('profile: phone with letters', 'PUT', '/api/students/profile', 7, { ...prof, phone: 'call-me-maybe' });
  await rejected('profile: phone too short', 'PUT', '/api/students/profile', 7, { ...prof, phone: '123' });
  await rejected('profile: department over 120', 'PUT', '/api/students/profile', 7, { ...prof, department: long(121) });
  await rejected('profile: level over 10', 'PUT', '/api/students/profile', 7, { ...prof, level: long(11) });
  await rejected('profile: student_id with letters', 'PUT', '/api/students/profile', 7, { ...prof, student_id: 'AB1234' });
  await rejected('profile: gender outside male/female', 'PUT', '/api/students/profile', 7, { ...prof, gender: 'unknown' });
  await accepted('profile: good payload', 'PUT', '/api/students/profile', 7, prof);
  await rejected('deactivate account: password missing', 'DELETE', '/api/students/profile', 7, {});

  /* admin rooms (admin 1) */
  await rejected('rooms list: block_id = 0', 'GET', '/api/admin/rooms?block_id=0', 1);
  await rejected('rooms list: bad gender filter', 'GET', '/api/admin/rooms?gender=other', 1);
  await rejected('rooms list: bad room_type filter', 'GET', '/api/admin/rooms?room_type=suite', 1);
  await rejected('rooms list: bad occupancy filter', 'GET', '/api/admin/rooms?occupancy_status=overfull', 1);
  await rejected('rooms list: bad is_active filter', 'GET', '/api/admin/rooms?is_active=maybe', 1);
  await rejected('room by id: id not numeric', 'GET', '/api/admin/rooms/abc', 1);
  await rejected('room by id: id = 0', 'GET', '/api/admin/rooms/0', 1);
  await rejected('room update: is_active not boolean', 'PUT', '/api/admin/rooms/5', 1, { is_active: 'perhaps' });
  await rejected('room update: capacity 0', 'PUT', '/api/admin/rooms/5', 1, { capacity: 0 });
  await rejected('room update: capacity 13', 'PUT', '/api/admin/rooms/5', 1, { capacity: 13 });
  await rejected('room update: capacity not a number', 'PUT', '/api/admin/rooms/5', 1, { capacity: 'many' });
  await accepted('room update: good payload', 'PUT', '/api/admin/rooms/5', 1, { capacity: 4, is_active: true });
  await accepted('rooms list: good filters', 'GET', '/api/admin/rooms?block_id=1&gender=male&room_type=shared&occupancy_status=vacant&is_active=true', 1);

  server.close();
  console.log(`phase10_validation_unit: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(e.stack); process.exit(2); });
