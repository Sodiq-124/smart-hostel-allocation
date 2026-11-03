/**
 * tests/phase9d_renewal_unit.js - renewal and forfeiture
 *
 * Runs WITHOUT a database and WITHOUT network access (application-level only):
 *   - config/database is replaced by an in-memory fake that understands the SQL of
 *     renewalService / feeService.getBlockFee and enforces the rules the real schema enforces
 *     that matter here (unique active allocation per student+session, unique live renewal per
 *     student+session, room capacity trigger, guarded UPDATE row counts, rollback on error).
 *   - services/paymentGate is replaced by a stub (the REAL gate is covered by the existing
 *     step3_payment_gate_unit.js); here it only answers "paid / not paid" per application.
 *   - the REAL app.js, routes, controllers and auth middleware are loaded.
 * It proves LOGIC and HTTP wiring. It does NOT prove the SQL is valid MariaDB.
 *
 *   node tests/phase9d_renewal_unit.js
 */
const path = require('path');
const http = require('http');

process.env.NODE_ENV = 'test';
const backend = path.join(__dirname, '..');
const resolve = (p) => require.resolve(path.join(backend, p));
function stub(mod, exportsObj) { const id = mod.startsWith('/') ? mod : require.resolve(mod); require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj }; }

let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail !== undefined ? ` :: ${detail}` : ''}`); }
}

let S; let SCHEMA; let PAID;
const clone = (x) => JSON.parse(JSON.stringify(x));

function fresh() {
  return {
    now: '2026-11-01 12:00:00',
    sessions: [
      { id: 1, label: '2025/2026', status: 'closed', is_current: 0, renewal_deadline_at: null },
      { id: 2, label: '2026/2027', status: 'open', is_current: 1, renewal_deadline_at: '2026-12-01 00:00:00' },
    ],
    blocks: { 1: 'Block A', 2: 'Block B', 3: 'Block C' },
    users: {
      7: { full_name: 'Ada', email: 'ada@x', student_id: 'M7', gender: 'male' },
      8: { full_name: 'Bola', email: 'bola@x', student_id: 'M8', gender: 'male' },
      9: { full_name: 'Chi', email: 'chi@x', student_id: 'M9', gender: 'male' },
      10: { full_name: 'Dayo', email: 'dayo@x', student_id: 'M10', gender: 'male' },
      11: { full_name: 'Eze', email: 'eze@x', student_id: 'M11', gender: 'male' },
      12: { full_name: 'Funmi', email: 'funmi@x', student_id: 'M12', gender: 'female' },
    },
    rooms: {
      24: { id: 24, room_number: 'A101', room_type: 'single', gender: 'male', capacity: 1, occupied_spaces: 1, is_active: 1, block_id: 1 },
      25: { id: 25, room_number: 'A102', room_type: 'single', gender: 'male', capacity: 1, occupied_spaces: 0, is_active: 1, block_id: 1 },
      26: { id: 26, room_number: 'A103', room_type: 'single', gender: 'male', capacity: 1, occupied_spaces: 1, is_active: 1, block_id: 1 },
      27: { id: 27, room_number: 'F101', room_type: 'single', gender: 'female', capacity: 1, occupied_spaces: 0, is_active: 1, block_id: 3 },
      30: { id: 30, room_number: 'B201', room_type: 'shared', gender: 'male', capacity: 2, occupied_spaces: 2, is_active: 1, block_id: 2 },
      31: { id: 31, room_number: 'A104', room_type: 'single', gender: 'male', capacity: 1, occupied_spaces: 1, is_active: 1, block_id: 1 },
    },
    applications: [
      { id: 201, student_id: 7, room_type: 'single', preferred_block_id: null, status: 'approved', allocated_room_id: 24, hostel_session_id: 1 },
      { id: 202, student_id: 8, room_type: 'single', preferred_block_id: null, status: 'approved', allocated_room_id: 26, hostel_session_id: 1 },
      { id: 203, student_id: 9, room_type: 'shared', preferred_block_id: 2, status: 'approved', allocated_room_id: 30, hostel_session_id: 1 },
      { id: 204, student_id: 10, room_type: 'single', preferred_block_id: null, status: 'approved', allocated_room_id: null, hostel_session_id: 1 },
      { id: 205, student_id: 11, room_type: 'single', preferred_block_id: null, status: 'approved', allocated_room_id: 31, hostel_session_id: 1 },
    ],
    allocations: [
      { id: 301, application_id: 201, student_id: 7, room_id: 24, hostel_session_id: 1, status: 'active', released_at: null, release_reason: null },
      { id: 302, application_id: 202, student_id: 8, room_id: 26, hostel_session_id: 1, status: 'active', released_at: null, release_reason: null },
      { id: 303, application_id: 203, student_id: 9, room_id: 30, hostel_session_id: 1, status: 'active', released_at: null, release_reason: null },
      { id: 304, application_id: 204, student_id: 10, room_id: 25, hostel_session_id: 1, status: 'released', released_at: 't', release_reason: 'earlier revoke' },
      { id: 305, application_id: 205, student_id: 11, room_id: 31, hostel_session_id: 1, status: 'active', released_at: null, release_reason: null },
    ],
    renewals: [],
    fees: [
      { id: 1, hostel_session_id: 2, block_id: 1, amount: '300000.00', currency: 'NGN', active: 1 },
      { id: 2, hostel_session_id: 2, block_id: 2, amount: '250000.00', currency: 'NGN', active: 1 },
    ],
    nextApp: 400, nextAlloc: 500, nextRenewal: 1,
  };
}

const err = (code, msg) => { const e = new Error(msg); e.code = code; return e; };
const sess = (id) => S.sessions.find((x) => x.id === id);
const cur = () => S.sessions.find((x) => x.is_current === 1 && x.status === 'open');
const norm = (sql) => sql.replace(/\s+/g, ' ').trim();
const live = (r) => r.status === 'pending' || r.status === 'approved';
const NOW = () => S.now.replace(' ', 'T');
const done = (n = 1) => [{ affectedRows: n }, []];

async function execute(raw, p = []) {
  const sql = norm(raw);
  if (sql.includes('FROM information_schema.COLUMNS')) {
    if (SCHEMA === 'missing') return [[{ table_name: 'hostel_renewals', column_name: 'id' }], []];
    const cols = [];
    ['id', 'student_id', 'previous_allocation_id', 'previous_session_id', 'new_session_id', 'new_application_id', 'type', 'status', 'reason', 'processed_by', 'processed_at', 'active_key']
      .forEach((c) => cols.push({ table_name: 'hostel_renewals', column_name: c }));
    cols.push({ table_name: 'hostel_sessions', column_name: 'renewal_deadline_at' });
    if (SCHEMA !== 'nofeeblock') cols.push({ table_name: 'applications', column_name: 'fee_block_id' });
    return [cols, []];
  }
  if (sql.startsWith('SELECT id, label, status, renewal_deadline_at,')) {
    const s = cur(); if (!s) return [[], []];
    return [[{ ...s, past_deadline: s.renewal_deadline_at && S.now > s.renewal_deadline_at ? 1 : 0 }], []];
  }
  if (sql.startsWith('SELECT al.id, al.application_id, al.room_id, al.hostel_session_id, r.room_number')) {
    const rows = S.allocations.filter((a) => a.student_id === p[0] && a.status === 'active')
      .filter((a) => { const s = sess(a.hostel_session_id); return !s.is_current && (s.status === 'closed' || s.status === 'archived'); })
      .sort((a, b) => b.hostel_session_id - a.hostel_session_id || b.id - a.id)
      .map((a) => ({ ...a, room_number: S.rooms[a.room_id].room_number, block_id: S.rooms[a.room_id].block_id, block_name: S.blocks[S.rooms[a.room_id].block_id], session_label: sess(a.hostel_session_id).label }));
    return [rows.slice(0, 1), []];
  }
  if (sql.startsWith('SELECT id, status, reason, new_application_id, previous_allocation_id')) {
    const rows = S.renewals.filter((r) => r.student_id === p[0] && r.new_session_id === p[1]).sort((a, b) => b.id - a.id);
    return [rows.slice(0, 1).map((r) => ({ ...r, created_at: 't', processed_at: r.processed_at || null })), []];
  }
  if (sql.startsWith("SELECT id FROM applications WHERE student_id = ? AND hostel_session_id = ? AND status IN ('pending', 'approved')")) {
    return [S.applications.filter((a) => a.student_id === p[0] && a.hostel_session_id === p[1] && (a.status === 'pending' || a.status === 'approved')).map((a) => ({ id: a.id })), []];
  }
  if (sql === 'SELECT id, status FROM allocations WHERE id = ? FOR UPDATE') {
    return [S.allocations.filter((a) => a.id === p[0]).map((a) => ({ id: a.id, status: a.status })), []];
  }
  if (sql.startsWith("INSERT INTO hostel_renewals (student_id, previous_allocation_id, previous_session_id, new_session_id, type, status) VALUES")) {
    if (S.renewals.some((r) => live(r) && r.student_id === p[0] && r.new_session_id === p[3])) throw err('ER_DUP_ENTRY', 'dup uq_renewals_active');
    const row = { id: S.nextRenewal++, student_id: p[0], previous_allocation_id: p[1], previous_session_id: p[2], new_session_id: p[3], new_application_id: null, type: 'renewal', status: 'pending', reason: null, processed_by: null, processed_at: null };
    S.renewals.push(row); return [{ insertId: row.id, affectedRows: 1 }, []];
  }
  if (sql.startsWith("INSERT INTO hostel_renewals (student_id, previous_allocation_id, previous_session_id, new_session_id, type, status, reason, processed_by, processed_at)")) {
    const row = { id: S.nextRenewal++, student_id: p[0], previous_allocation_id: p[1], previous_session_id: p[2], new_session_id: p[3], new_application_id: null, type: 'renewal', status: 'forfeited', reason: p[4], processed_by: p[5], processed_at: 'now' };
    S.renewals.push(row); return [{ insertId: row.id, affectedRows: 1 }, []];
  }
  if (sql === 'SELECT status, allocated_room_id FROM applications WHERE id = ?') {
    return [S.applications.filter((a) => a.id === p[0]).map((a) => ({ status: a.status, allocated_room_id: a.allocated_room_id })), []];
  }
  if (sql === 'SELECT id, status FROM hostel_renewals WHERE id = ? AND student_id = ? FOR UPDATE') {
    return [S.renewals.filter((r) => r.id === p[0] && r.student_id === p[1]).map((r) => ({ id: r.id, status: r.status })), []];
  }
  if (sql.startsWith("UPDATE hostel_renewals SET status = 'cancelled'")) {
    const r = S.renewals.find((x) => x.id === p[0] && x.status === 'pending'); if (!r) return done(0);
    r.status = 'cancelled'; r.reason = 'Cancelled by student'; return done();
  }
  if (sql.startsWith('SELECT hr.id, hr.student_id')) {
    let rows = S.renewals.slice();
    let i = 0;
    if (sql.includes('hr.status = ?')) { const v = p[i++]; rows = rows.filter((r) => r.status === v); }
    if (sql.includes('hr.new_session_id = ?')) { const v = p[i++]; rows = rows.filter((r) => r.new_session_id === v); }
    return [rows.sort((a, b) => b.id - a.id).map((r) => {
      const al = S.allocations.find((a) => a.id === r.previous_allocation_id); const ap = S.applications.find((a) => a.id === r.new_application_id);
      return { ...r, full_name: S.users[r.student_id].full_name, email: 'e', matric_number: 'm', previous_session_label: sess(r.previous_session_id).label, new_session_label: sess(r.new_session_id).label,
        previous_room_number: al ? S.rooms[al.room_id].room_number : null, previous_block_name: al ? S.blocks[S.rooms[al.room_id].block_id] : null,
        previous_allocation_status: al ? al.status : null, application_status: ap ? ap.status : null, application_room_id: ap ? ap.allocated_room_id : null };
    }), []];
  }
  if (sql.startsWith('SELECT status, COUNT(*) AS n FROM hostel_renewals')) {
    const m = {}; S.renewals.filter((r) => r.new_session_id === p[0]).forEach((r) => { m[r.status] = (m[r.status] || 0) + 1; });
    return [Object.entries(m).map(([status, n]) => ({ status, n })), []];
  }
  if (sql === 'SELECT id, label, status FROM hostel_sessions WHERE id = ? FOR UPDATE') {
    return [S.sessions.filter((s) => s.id === p[0]).map((s) => ({ id: s.id, label: s.label, status: s.status })), []];
  }
  if (sql === 'UPDATE hostel_sessions SET renewal_deadline_at = ? WHERE id = ?') { sess(p[1]).renewal_deadline_at = p[0]; return done(); }
  if (sql === 'SELECT status FROM hostel_sessions WHERE id = ?') return [S.sessions.filter((s) => s.id === p[0]).map((s) => ({ status: s.status })), []];
  if (sql.startsWith('SELECT id, student_id, previous_allocation_id, previous_session_id, new_session_id, new_application_id, status FROM hostel_renewals')) {
    return [S.renewals.filter((r) => r.id === p[0]).map((r) => ({ ...r })), []];
  }
  if (sql === 'SELECT id, application_id, room_id, status FROM allocations WHERE id = ? FOR UPDATE') {
    return [S.allocations.filter((a) => a.id === p[0]).map((a) => ({ ...a })), []];
  }
  if (sql === 'SELECT room_type, preferred_block_id FROM applications WHERE id = ?') {
    return [S.applications.filter((a) => a.id === p[0]).map((a) => ({ room_type: a.room_type, preferred_block_id: a.preferred_block_id })), []];
  }
  if (sql.startsWith('SELECT r.block_id, b.name AS block_name FROM rooms r')) {
    const r = S.rooms[p[0]]; return [r ? [{ block_id: r.block_id, block_name: S.blocks[r.block_id] }] : [], []];
  }
  if (sql.startsWith('SELECT id, hostel_session_id, block_id, amount, currency FROM hostel_fees')) {
    return [S.fees.filter((f) => f.hostel_session_id === p[0] && f.block_id === p[1] && f.active).map((f) => ({ ...f })), []];
  }
  if (sql.startsWith('INSERT INTO applications (')) {
    const cols = /\(([^)]*)\) VALUES/.exec(sql)[1].split(', ');
    const vals = []; let i = 0; /VALUES \(([^)]*\)?[^)]*)\)/.exec(sql)[1].split(', ').forEach((m) => { vals.push(m === '?' ? p[i++] : m); });
    const row = { id: S.nextApp++, allocated_room_id: null }; cols.forEach((c, k) => { row[c] = vals[k] === "'approved'" ? 'approved' : vals[k] === 'NOW()' ? 'now' : vals[k]; });
    if (S.applications.some((a) => a.student_id === row.student_id && a.hostel_session_id === row.hostel_session_id && (a.status === 'pending' || a.status === 'approved'))) throw err('ER_DUP_ENTRY', 'dup uq_active_application');
    S.applications.push(row); return [{ insertId: row.id, affectedRows: 1 }, []];
  }
  if (sql.startsWith("UPDATE hostel_renewals SET status = 'approved'")) {
    const r = S.renewals.find((x) => x.id === p[2] && x.status === 'pending'); if (!r) return done(0);
    r.status = 'approved'; r.new_application_id = p[0]; r.processed_by = p[1]; return done();
  }
  if (sql.startsWith("UPDATE hostel_renewals SET status = 'rejected'")) {
    const r = S.renewals.find((x) => x.id === p[2] && x.status === 'pending'); if (!r) return done(0);
    r.status = 'rejected'; r.reason = p[0]; r.processed_by = p[1]; return done();
  }
  if (sql.startsWith("UPDATE hostel_renewals SET status = 'forfeited'")) {
    const r = S.renewals.find((x) => x.id === p[2] && live(x)); if (!r) return done(0);
    r.status = 'forfeited'; r.reason = p[0]; r.processed_by = p[1]; return done();
  }
  if (sql === 'SELECT id, student_id, room_type, status, allocated_room_id, hostel_session_id FROM applications WHERE id = ? FOR UPDATE') {
    return [S.applications.filter((a) => a.id === p[0]).map((a) => ({ ...a })), []];
  }
  if (sql === "SELECT id FROM allocations WHERE student_id = ? AND hostel_session_id = ? AND status = 'active'") {
    return [S.allocations.filter((a) => a.student_id === p[0] && a.hostel_session_id === p[1] && a.status === 'active').map((a) => ({ id: a.id })), []];
  }
  if (sql.startsWith('SELECT r.id, r.room_number, r.room_type, r.gender, r.capacity')) {
    const r = S.rooms[p[0]]; return [r ? [{ ...r, block_name: S.blocks[r.block_id] }] : [], []];
  }
  if (sql === 'SELECT gender FROM users WHERE id = ?') return [S.users[p[0]] ? [{ gender: S.users[p[0]].gender }] : [], []];
  if (sql === 'UPDATE rooms SET occupied_spaces = occupied_spaces - 1 WHERE id = ? AND occupied_spaces > 0') {
    const r = S.rooms[p[0]]; if (!r || r.occupied_spaces < 1) return done(0); r.occupied_spaces -= 1; return done();
  }
  if (sql === 'UPDATE rooms SET occupied_spaces = occupied_spaces + 1 WHERE id = ? AND occupied_spaces < capacity') {
    const r = S.rooms[p[0]]; if (!r || r.occupied_spaces >= r.capacity) return done(0); r.occupied_spaces += 1; return done();
  }
  if (sql.startsWith("UPDATE allocations SET status = 'released'")) {
    const a = S.allocations.find((x) => x.id === p[1] && x.status === 'active'); if (!a) return done(0);
    a.status = 'released'; a.released_at = 'now'; a.release_reason = p[0]; return done();
  }
  if (sql === 'UPDATE applications SET allocated_room_id = NULL WHERE id = ? AND allocated_room_id = ?') {
    const a = S.applications.find((x) => x.id === p[0] && x.allocated_room_id === p[1]); if (!a) return done(0); a.allocated_room_id = null; return done();
  }
  if (sql.startsWith('INSERT INTO allocations (application_id, student_id, room_id, hostel_session_id, allocated_by)')) {
    if (S.allocations.some((a) => a.status === 'active' && a.student_id === p[1] && a.hostel_session_id === p[3])) throw err('ER_DUP_ENTRY', 'dup uq_active_allocation');
    const r = S.rooms[p[2]]; if (r.occupied_spaces >= r.capacity) throw err('ER_SIGNAL_EXCEPTION', 'This room is already full.');
    const row = { id: S.nextAlloc++, application_id: p[0], student_id: p[1], room_id: p[2], hostel_session_id: p[3], status: 'active', released_at: null, release_reason: null };
    S.allocations.push(row); return [{ insertId: row.id, affectedRows: 1 }, []];
  }
  if (sql === 'UPDATE applications SET allocated_room_id = ? WHERE id = ? AND allocated_room_id IS NULL') {
    const a = S.applications.find((x) => x.id === p[1] && !x.allocated_room_id); if (!a) return done(0); a.allocated_room_id = p[0]; return done();
  }
  if (sql === 'SELECT id, application_id, student_id, room_id, hostel_session_id, status FROM allocations WHERE id = ? FOR UPDATE') {
    return [S.allocations.filter((a) => a.id === p[0]).map((a) => ({ ...a })), []];
  }
  if (sql.startsWith("SELECT id, status, new_application_id FROM hostel_renewals WHERE student_id = ? AND new_session_id = ? AND status IN ('pending', 'approved') FOR UPDATE")) {
    return [S.renewals.filter((r) => r.student_id === p[0] && r.new_session_id === p[1] && live(r)).map((r) => ({ id: r.id, status: r.status, new_application_id: r.new_application_id })), []];
  }
  if (sql === 'SELECT id, occupied_spaces FROM rooms WHERE id = ? FOR UPDATE') {
    const r = S.rooms[p[0]]; return [r ? [{ id: r.id, occupied_spaces: r.occupied_spaces }] : [], []];
  }
  if (sql.startsWith("UPDATE applications SET status = 'cancelled', rejection_reason = ?")) {
    const a = S.applications.find((x) => x.id === p[2] && x.status === 'approved' && !x.allocated_room_id); if (!a) return done(0); a.status = 'cancelled'; return done();
  }
  if (sql.startsWith('SELECT al.id AS allocation_id')) {
    const [sid] = p;
    return [S.allocations.filter((a) => a.status === 'active').filter((a) => { const s = sess(a.hostel_session_id); return !s.is_current && (s.status === 'closed' || s.status === 'archived'); })
      .sort((a, b) => a.id - b.id).map((a) => {
        const rn = S.renewals.filter((r) => r.student_id === a.student_id && r.new_session_id === sid).sort((x, y) => y.id - x.id)[0];
        return { allocation_id: a.id, student_id: a.student_id, room_id: a.room_id, hostel_session_id: a.hostel_session_id, session_label: sess(a.hostel_session_id).label,
          room_number: S.rooms[a.room_id].room_number, block_name: S.blocks[S.rooms[a.room_id].block_id], full_name: S.users[a.student_id].full_name, email: 'e',
          renewal_status: rn ? rn.status : null, current_allocations: S.allocations.filter((c) => c.student_id === a.student_id && c.hostel_session_id === sid && c.status === 'active').length };
      }), []];
  }
  throw new Error(`FAKE DB: unexpected SQL: ${sql}`);
}

const fakeConn = { execute };
let txTail = Promise.resolve();
function withTransaction(cb) {
  const run = txTail.then(async () => {
    const snap = clone(S);
    try { return await cb(fakeConn); } catch (e) { Object.assign(S, snap); throw e; }
  });
  txTail = run.catch(() => {});
  return run;
}
// queryOne answers the per-request role/activity re-check in middleware/authMiddleware.js: id 1 is the admin, every other id a student.
const userLookup = async (sql, p) => (/FROM users WHERE id = \?/.test(sql) ? { role: Number(p[0]) === 1 ? 'admin' : 'student', is_active: 1 } : null);
stub(resolve('config/database'), { pool: fakeConn, query: async () => [], queryOne: userLookup, withTransaction, testConnection: async () => true });
const ApiError = require(resolve('utils/ApiError'));
stub(resolve('services/paymentGate'), {
  assertHostelFeePaid: async (conn, application, room) => {
    if (!PAID.has(application.id)) throw ApiError.conflict('A verified, successful hostel-fee payment is required before a room can be allocated. This student has not paid.');
    if (PAID.get(application.id) !== room.block_id) throw ApiError.conflict('This student paid the fee for a different block.');
    return { payment_id: 1 };
  },
});
stub(resolve('config/session'), (req, res, next) => { const u = req.headers['x-test-user']; req.session = u ? { user: JSON.parse(u) } : {}; next(); });
stub('morgan', () => (req, res, next) => next());
stub('bcrypt', { hash: async () => 'x', compare: async () => false });

const { resetRenewalSchemaCache } = require(resolve('services/renewalSchema'));
const svc = require(resolve('services/renewalService'));
const app = require(resolve('app'));

function reset() { S = fresh(); SCHEMA = 'ok'; PAID = new Map(); resetRenewalSchemaCache(); }
let server;
function call(method, urlPath, { user, body } = {}) {
  return new Promise((ok, bad) => {
    const payload = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const h = { Accept: 'application/json' };
    if (user) h['x-test-user'] = JSON.stringify(user);
    if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = payload.length; }
    const rq = http.request({ host: '127.0.0.1', port: server.address().port, path: urlPath, method, headers: h }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c));
      res.on('end', () => { const t = Buffer.concat(ch).toString('utf8'); let j = null; try { j = JSON.parse(t); } catch { /* html */ } ok({ status: res.statusCode, json: j, text: t }); });
    });
    rq.on('error', bad); if (payload) rq.write(payload); rq.end();
  });
}
const stu = (id) => ({ id, role: 'student', full_name: `S${id}` });
const adm = { id: 1, role: 'admin', full_name: 'Admin' };
console.error = () => {};

const occ = (id) => S.rooms[id].occupied_spaces;
const alloc = (id) => S.allocations.find((a) => a.id === id);
const snapshotCounts = () => ({ a: S.allocations.length, r: S.renewals.length, ap: S.applications.length });

(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  let r; let r2;

  /* ---- A: access control ---- */
  reset();
  r = await call('GET', '/api/renewals/status'); check('A1  student status needs login (401)', r.status === 401);
  r = await call('GET', '/api/renewals/status', { user: adm }); check('A2  admin cannot use the student endpoint (403)', r.status === 403);
  r = await call('POST', '/api/renewals', { user: adm }); check('A3  admin cannot request a renewal (403)', r.status === 403);
  for (const [m, u] of [['GET', '/api/admin/renewals'], ['GET', '/api/admin/renewals/overview'], ['PUT', '/api/admin/renewals/deadline'], ['POST', '/api/admin/renewals/1/approve'], ['POST', '/api/admin/renewals/1/reject'], ['POST', '/api/admin/renewals/1/fulfill'], ['GET', '/api/admin/renewals/forfeitures/preview'], ['POST', '/api/admin/renewals/forfeitures/run'], ['POST', '/api/admin/renewals/forfeitures/allocations/301']]) {
    r = await call(m, u, { user: stu(7), body: {} }); r2 = await call(m, u, { body: {} });
    check(`A4  ${m} ${u}: student 403, anonymous 401`, r.status === 403 && r2.status === 401, `${r.status}/${r2.status}`);
  }

  /* ---- B: eligibility ---- */
  reset();
  r = await call('GET', '/api/renewals/status', { user: stu(7) });
  check('B1  student with an active previous-session allocation is eligible', r.status === 200 && r.json.data.eligible === true && r.json.data.previous_allocation.room_number === 'A101' && r.json.data.session.label === '2026/2027');
  r = await call('GET', '/api/renewals/status', { user: stu(10) });
  check('B2  student whose previous allocation was released is not eligible', r.json.data.eligible === false && r.json.data.reason === 'no_previous_allocation');
  r = await call('GET', '/api/renewals/status', { user: stu(12) });
  check('B3  student with no allocation history is not eligible', r.json.data.reason === 'no_previous_allocation');
  S.sessions[1].renewal_deadline_at = '2026-10-31 23:59:59';
  r = await call('GET', '/api/renewals/status', { user: stu(7) });
  check('B4  deadline passed -> window_closed', r.json.data.reason === 'window_closed' && r.json.data.window_open === false);
  S.sessions[1].renewal_deadline_at = null;
  r = await call('GET', '/api/renewals/status', { user: stu(7) });
  check('B5  no deadline set -> window open and eligible', r.json.data.eligible === true && r.json.data.deadline_at === null);
  S.applications.push({ id: 900, student_id: 7, room_type: 'single', status: 'pending', allocated_room_id: null, hostel_session_id: 2 });
  r = await call('GET', '/api/renewals/status', { user: stu(7) });
  check('B6  a live current-session application blocks renewal', r.json.data.reason === 'has_application');
  S.sessions[1].is_current = 0; S.sessions[1].status = 'closed';
  r = await call('GET', '/api/renewals/status', { user: stu(7) });
  check('B7  no open session -> not eligible', r.json.data.reason === 'no_open_session' && r.json.data.session === null);

  /* ---- C: request / cancel ---- */
  reset();
  r = await call('POST', '/api/renewals', { user: stu(7) });
  check('C1  request creates a pending renewal tied to allocation 301 and session 1 -> 2', r.status === 201 && S.renewals.length === 1 && S.renewals[0].status === 'pending' && S.renewals[0].previous_allocation_id === 301 && S.renewals[0].previous_session_id === 1 && S.renewals[0].new_session_id === 2);
  check('C2  the old allocation and room are untouched by a request', alloc(301).status === 'active' && occ(24) === 1);
  r = await call('POST', '/api/renewals', { user: stu(7) });
  check('C3  duplicate request -> 409, still one row', r.status === 409 && S.renewals.length === 1);
  reset();
  [r, r2] = await Promise.all([call('POST', '/api/renewals', { user: stu(7) }), call('POST', '/api/renewals', { user: stu(7) })]);
  check('C4  two simultaneous requests: exactly one succeeds', [r.status, r2.status].sort().join() === '201,409' && S.renewals.length === 1);
  r = await call('POST', '/api/renewals/1/cancel', { user: stu(8) });
  check('C5  another student cannot cancel it (404)', r.status === 404 && S.renewals[0].status === 'pending');
  r = await call('POST', '/api/renewals/1/cancel', { user: stu(7) });
  check('C6  owner cancels a pending request', r.status === 200 && S.renewals[0].status === 'cancelled');
  r = await call('POST', '/api/renewals/1/cancel', { user: stu(7) });
  check('C7  cancelling again -> 409', r.status === 409);
  r = await call('POST', '/api/renewals', { user: stu(7) });
  check('C8  after cancelling, the student may request again (history kept: 2 rows)', r.status === 201 && S.renewals.length === 2 && S.renewals[0].status === 'cancelled');
  reset(); S.sessions[1].renewal_deadline_at = '2026-10-31 00:00:00';
  r = await call('POST', '/api/renewals', { user: stu(7) });
  check('C9  request after the deadline -> 409, nothing written', r.status === 409 && S.renewals.length === 0);
  reset(); r = await call('POST', '/api/renewals', { user: stu(10) });
  check('C10 ineligible student -> 409, nothing written', r.status === 409 && S.renewals.length === 0);

  /* ---- D/E: approve / reject ---- */
  reset(); await call('POST', '/api/renewals', { user: stu(7) });
  r = await call('POST', '/api/admin/renewals/1/approve', { user: adm });
  const na = S.applications.find((a) => a.id === r.json.data.new_application_id);
  check('D1  approve creates an APPROVED application for the current session with the held room\'s fee block', r.status === 200 && na && na.status === 'approved' && na.hostel_session_id === 2 && na.student_id === 7 && na.fee_block_id === 1 && na.room_type === 'single' && S.renewals[0].status === 'approved' && S.renewals[0].new_application_id === na.id);
  check('D2  the old allocation stays active and the room stays held', alloc(301).status === 'active' && occ(24) === 1 && na.allocated_room_id === null);
  r = await call('POST', '/api/admin/renewals/1/approve', { user: adm });
  check('D3  approving twice -> 409, no second application', r.status === 409 && S.applications.filter((a) => a.student_id === 7 && a.hostel_session_id === 2).length === 1);
  r = await call('POST', '/api/admin/renewals/1/reject', { user: adm, body: { reason: 'late' } });
  check('D4  an approved renewal cannot be rejected', r.status === 409 && S.renewals[0].status === 'approved');
  reset(); await call('POST', '/api/renewals', { user: stu(7) });
  [r, r2] = await Promise.all([call('POST', '/api/admin/renewals/1/approve', { user: adm }), call('POST', '/api/admin/renewals/1/approve', { user: adm })]);
  check('D5  two simultaneous approvals: one wins, one application', [r.status, r2.status].sort().join() === '200,409' && S.applications.filter((a) => a.student_id === 7 && a.hostel_session_id === 2).length === 1);
  reset(); await call('POST', '/api/renewals', { user: stu(7) }); S.fees = [];
  r = await call('POST', '/api/admin/renewals/1/approve', { user: adm });
  check('D6  no fee for the block -> 409, renewal stays pending, no application', r.status === 409 && /fee/i.test(r.json.message) && S.renewals[0].status === 'pending' && S.applications.length === 5);
  reset(); await call('POST', '/api/renewals', { user: stu(7) }); S.allocations[0].status = 'released';
  r = await call('POST', '/api/admin/renewals/1/approve', { user: adm });
  check('D7  previous allocation no longer active -> 409', r.status === 409 && S.renewals[0].status === 'pending');
  reset(); await call('POST', '/api/renewals', { user: stu(7) }); S.applications.push({ id: 901, student_id: 7, room_type: 'single', status: 'pending', allocated_room_id: null, hostel_session_id: 2 });
  r = await call('POST', '/api/admin/renewals/1/approve', { user: adm });
  check('D8  student already has a live application -> 409', r.status === 409 && S.renewals[0].status === 'pending');
  reset(); SCHEMA = 'nofeeblock'; await call('POST', '/api/renewals', { user: stu(7) });
  r = await call('POST', '/api/admin/renewals/1/approve', { user: adm });
  check('D9  without migration 019 the approval still works and simply omits fee_block_id', r.status === 200 && r.json.data.fee_block_id === null);
  reset(); await call('POST', '/api/renewals', { user: stu(7) });
  r = await call('POST', '/api/admin/renewals/1/reject', { user: adm, body: {} });
  check('E1  reject needs a reason (400)', r.status === 400 && S.renewals[0].status === 'pending');
  r = await call('POST', '/api/admin/renewals/1/reject', { user: adm, body: { reason: 'x'.repeat(201) } });
  check('E2  over-long reason (400)', r.status === 400);
  r = await call('POST', '/api/admin/renewals/1/reject', { user: adm, body: { reason: 'Outstanding disciplinary case' } });
  check('E3  reject stores the reason; old allocation untouched', r.status === 200 && S.renewals[0].status === 'rejected' && S.renewals[0].reason === 'Outstanding disciplinary case' && alloc(301).status === 'active');
  r = await call('POST', '/api/admin/renewals/1/reject', { user: adm, body: { reason: 'again' } });
  check('E4  rejecting twice -> 409', r.status === 409);
  r = await call('POST', '/api/renewals', { user: stu(7) });
  check('E5  a rejected student cannot simply re-request (409)', r.status === 409 && S.renewals.length === 1);
  r = await call('POST', '/api/admin/renewals/99/approve', { user: adm }); check('E6  unknown renewal -> 404', r.status === 404);
  r = await call('POST', '/api/admin/renewals/abc/approve', { user: adm }); check('E7  non-numeric id -> 400', r.status === 400);

  /* ---- F: fulfil ---- */
  const approved = async () => { reset(); await call('POST', '/api/renewals', { user: stu(7) }); const a = await call('POST', '/api/admin/renewals/1/approve', { user: adm }); return a.json.data.new_application_id; };
  let appId = await approved();
  r = await call('POST', '/api/admin/renewals/1/fulfill', { user: adm, body: {} });
  check('F1  unpaid -> 409 and NOTHING changes', r.status === 409 && /not paid|payment/i.test(r.json.message) && alloc(301).status === 'active' && occ(24) === 1 && S.allocations.length === 5);
  PAID.set(appId, 1);
  r = await call('POST', '/api/admin/renewals/1/fulfill', { user: adm, body: {} });
  const newAlloc = S.allocations.find((a) => a.application_id === appId);
  check('F2  paid -> same (full, single) room is re-allocated in the new session', r.status === 200 && r.json.data.same_room === true && newAlloc && newAlloc.status === 'active' && newAlloc.hostel_session_id === 2 && newAlloc.room_id === 24);
  check('F3  old allocation released with history kept; occupancy unchanged (1)', alloc(301).status === 'released' && /Renewed for 2026\/2027/.test(alloc(301).release_reason) && alloc(301).room_id === 24 && occ(24) === 1);
  check('F4  new application holds the room; old application detached', S.applications.find((a) => a.id === appId).allocated_room_id === 24 && S.applications.find((a) => a.id === 201).allocated_room_id === null);
  r = await call('POST', '/api/admin/renewals/1/fulfill', { user: adm, body: {} });
  check('F5  fulfilling twice -> 409; no extra allocation, occupancy still 1', r.status === 409 && occ(24) === 1 && S.allocations.filter((a) => a.student_id === 7 && a.status === 'active').length === 1);
  r = await call('GET', '/api/admin/renewals', { user: adm });
  check('F6  admin list shows the renewal as fulfilled', r.json.data[0].fulfilled === true);
  r = await call('GET', '/api/renewals/status', { user: stu(7) });
  check('F7  student sees approved + room allocated', r.json.data.renewal.status === 'approved' && r.json.data.renewal.room_allocated === true);

  appId = await approved(); PAID.set(appId, 1);
  r = await call('POST', '/api/admin/renewals/1/fulfill', { user: adm, body: { room_id: 26 } });
  check('F8  a different room that is full -> 409, nothing changed', r.status === 409 && alloc(301).status === 'active' && occ(24) === 1 && occ(26) === 1);
  r = await call('POST', '/api/admin/renewals/1/fulfill', { user: adm, body: { room_id: 27 } });
  check('F9  a room of the wrong gender -> 409', r.status === 409 && /gender/.test(r.json.message));
  r = await call('POST', '/api/admin/renewals/1/fulfill', { user: adm, body: { room_id: 30 } });
  check('F10 a room of the wrong type -> 409', r.status === 409);
  r = await call('POST', '/api/admin/renewals/1/fulfill', { user: adm, body: { room_id: 999 } });
  check('F11 unknown room -> 400', r.status === 400);
  r = await call('POST', '/api/admin/renewals/1/fulfill', { user: adm, body: { room_id: 25 } });
  check('F12 a free room in the paid block: old room frees (0), new room fills (1)', r.status === 200 && r.json.data.same_room === false && occ(24) === 0 && occ(25) === 1 && S.allocations.find((a) => a.application_id === appId).room_id === 25);
  appId = await approved(); PAID.set(appId, 2);
  r = await call('POST', '/api/admin/renewals/1/fulfill', { user: adm, body: {} });
  check('F13 paid for a different block than the room -> gate refuses, nothing changed', r.status === 409 && alloc(301).status === 'active' && occ(24) === 1);
  await call('POST', '/api/renewals', { user: stu(8) }); r = await call('POST', '/api/admin/renewals/2/fulfill', { user: adm, body: {} });
  check('F14 a pending (unapproved) renewal cannot be fulfilled', r.status === 409);

  /* ---- G: manual forfeiture ---- */
  reset(); let before = snapshotCounts();
  r = await call('POST', '/api/admin/renewals/forfeitures/allocations/301', { user: adm, body: {} });
  check('G1  reason is required (400)', r.status === 400 && alloc(301).status === 'active');
  r = await call('POST', '/api/admin/renewals/forfeitures/allocations/301', { user: adm, body: { reason: 'Did not return' } });
  check('G2  forfeits: released, history kept, room occupancy -1, application detached', r.status === 200 && alloc(301).status === 'released' && /^Forfeited: Did not return/.test(alloc(301).release_reason) && occ(24) === 0 && S.applications.find((a) => a.id === 201).allocated_room_id === null && S.allocations.length === before.a);
  check('G3  a forfeited renewal record is written for the new session', S.renewals.length === 1 && S.renewals[0].status === 'forfeited' && S.renewals[0].previous_allocation_id === 301 && S.renewals[0].new_session_id === 2 && S.renewals[0].processed_by === 1);
  r = await call('POST', '/api/admin/renewals/forfeitures/allocations/301', { user: adm, body: { reason: 'again' } });
  check('G4  forfeiting again -> 409; occupancy NOT decremented twice', r.status === 409 && occ(24) === 0 && S.renewals.length === 1);
  reset();
  [r, r2] = await Promise.all([call('POST', '/api/admin/renewals/forfeitures/allocations/302', { user: adm, body: { reason: 'a' } }), call('POST', '/api/admin/renewals/forfeitures/allocations/302', { user: adm, body: { reason: 'b' } })]);
  check('G5  two simultaneous forfeitures: one succeeds, occupancy decremented exactly once', [r.status, r2.status].sort().join() === '200,409' && occ(26) === 0 && S.renewals.filter((x) => x.previous_allocation_id === 302).length === 1);
  reset(); S.allocations.push({ id: 399, application_id: 900, student_id: 12, room_id: 27, hostel_session_id: 2, status: 'active' }); S.rooms[27].occupied_spaces = 1;
  r = await call('POST', '/api/admin/renewals/forfeitures/allocations/399', { user: adm, body: { reason: 'x' } });
  check('G6  an allocation of the CURRENT session cannot be forfeited (409)', r.status === 409 && S.allocations.find((a) => a.id === 399).status === 'active' && occ(27) === 1);
  r = await call('POST', '/api/admin/renewals/forfeitures/allocations/304', { user: adm, body: { reason: 'x' } });
  check('G7  an already released allocation -> 409', r.status === 409);
  r = await call('POST', '/api/admin/renewals/forfeitures/allocations/777', { user: adm, body: { reason: 'x' } });
  check('G8  unknown allocation -> 404', r.status === 404);
  reset(); S.rooms[24].occupied_spaces = 0;
  r = await call('POST', '/api/admin/renewals/forfeitures/allocations/301', { user: adm, body: { reason: 'x' } });
  check('G9  inconsistent occupancy (0) -> 409, allocation NOT released, no negative count', r.status === 409 && alloc(301).status === 'active' && occ(24) === 0 && S.renewals.length === 0);
  appId = await approved();
  r = await call('POST', '/api/admin/renewals/forfeitures/allocations/301', { user: adm, body: { reason: 'Abandoned renewal' } });
  check('G10 manual forfeiture of an APPROVED but unfulfilled renewal: renewal forfeited, its application cancelled, room freed', r.status === 200 && S.renewals[0].status === 'forfeited' && S.applications.find((a) => a.id === appId).status === 'cancelled' && occ(24) === 0 && S.renewals.length === 1);
  r = await call('POST', '/api/renewals', { user: stu(7) });
  check('G11 the forfeited student has no allocation left, so cannot renew', r.status === 409);

  /* ---- H: sweep ---- */
  reset();
  r = await call('GET', '/api/admin/renewals/forfeitures/preview', { user: adm });
  check('H1  deadline not passed -> preview lists candidates but cannot run', r.status === 200 && r.json.data.can_run === false && r.json.data.forfeitable.length === 4);
  r = await call('POST', '/api/admin/renewals/forfeitures/run', { user: adm });
  check('H2  run before the deadline -> 409, nothing released', r.status === 409 && S.allocations.filter((a) => a.status === 'released').length === 1);
  S.sessions[1].renewal_deadline_at = null;
  r = await call('POST', '/api/admin/renewals/forfeitures/run', { user: adm });
  check('H3  run with no deadline configured -> 409', r.status === 409 && /No renewal deadline/.test(r.json.message));
  S.sessions[1].renewal_deadline_at = '2026-10-30 00:00:00';
  await call('POST', '/api/renewals', { user: stu(7) }).catch(() => {});
  S.renewals.push({ id: 50, student_id: 7, previous_allocation_id: 301, previous_session_id: 1, new_session_id: 2, new_application_id: null, type: 'renewal', status: 'pending', reason: null }); S.nextRenewal = 51; // student 7 asked in time
  S.renewals.push({ id: 51, student_id: 9, previous_allocation_id: 303, previous_session_id: 1, new_session_id: 2, new_application_id: null, type: 'renewal', status: 'rejected', reason: 'no' }); S.nextRenewal = 52;
  S.allocations.push({ id: 398, application_id: 902, student_id: 11, room_id: 25, hostel_session_id: 2, status: 'active' }); S.rooms[25].occupied_spaces = 1; // student 11 got a current-session allocation another way
  r = await call('GET', '/api/admin/renewals/forfeitures/preview', { user: adm });
  const d = r.json.data;
  check('H4  preview classifies: kept=[301], superseded=[305], forfeitable=[302,303]', d.can_run === true && d.kept.map((x) => x.allocation_id).join() === '301' && d.superseded.map((x) => x.allocation_id).join() === '305' && d.forfeitable.map((x) => x.allocation_id).join() === '302,303');
  before = snapshotCounts(); const occBefore = { 24: occ(24), 26: occ(26), 30: occ(30), 31: occ(31) };
  r = await call('POST', '/api/admin/renewals/forfeitures/run', { user: adm });
  check('H5  run forfeits exactly the forfeitable allocations', r.status === 200 && r.json.data.forfeited.map((x) => x.allocation_id).sort().join() === '302,303' && r.json.data.skipped.length === 0);
  check('H6  those rooms lose exactly one space each; every other room is unchanged', occ(26) === occBefore[26] - 1 && occ(30) === occBefore[30] - 1 && occ(24) === occBefore[24] && occ(31) === occBefore[31]);
  check('H7  student with a pending renewal and the superseded student keep their allocation', alloc(301).status === 'active' && alloc(305).status === 'active');
  check('H8  history preserved: no allocation row deleted; renewal 51 (rejected) kept, new forfeited rows added', S.allocations.length === before.a && S.renewals.find((x) => x.id === 51).status === 'rejected' && S.renewals.filter((x) => x.status === 'forfeited').length === 2);
  r = await call('POST', '/api/admin/renewals/forfeitures/run', { user: adm });
  check('H9  running again forfeits nothing more (idempotent)', r.status === 200 && r.json.data.forfeited.length === 0 && occ(26) === occBefore[26] - 1);
  r = await call('POST', '/api/admin/renewals/forfeitures/allocations/305', { user: adm, body: { reason: 'Duplicate holding' } });
  check('H10 a superseded holding can be released manually: released as "Superseded", no renewal record, current allocation intact', r.status === 200 && r.json.data.superseded === true && /^Superseded:/.test(alloc(305).release_reason) && occ(31) === occBefore[31] - 1 && S.allocations.find((a) => a.id === 398).status === 'active' && !S.renewals.some((x) => x.previous_allocation_id === 305));
  reset(); S.sessions[1].renewal_deadline_at = '2026-10-30 00:00:00';
  [r, r2] = await Promise.all([call('POST', '/api/admin/renewals/forfeitures/run', { user: adm }), call('POST', '/api/admin/renewals/forfeitures/run', { user: adm })]);
  check('H11 two simultaneous sweeps: each allocation released once, no negative occupancy', Object.values(S.rooms).every((x) => x.occupied_spaces >= 0) && occ(26) === 0 && occ(24) === 0 && occ(30) === 1 && S.renewals.filter((x) => x.status === 'forfeited').length === 4);

  /* ---- I: deadline ---- */
  reset();
  r = await call('PUT', '/api/admin/renewals/deadline', { user: adm, body: { renewal_deadline_at: '2026-12-31T23:59' } });
  check('I1  set a deadline on the current session (datetime-local format accepted)', r.status === 200 && sess(2).renewal_deadline_at === '2026-12-31 23:59:00');
  for (const bad of ['tomorrow', '2026-02-30 10:00', '2026-13-01 10:00', '2026-12-31 25:00']) {
    r = await call('PUT', '/api/admin/renewals/deadline', { user: adm, body: { renewal_deadline_at: bad } });
    check(`I2  invalid deadline "${bad}" -> 400`, r.status === 400 && sess(2).renewal_deadline_at === '2026-12-31 23:59:00');
  }
  r = await call('PUT', '/api/admin/renewals/deadline', { user: adm, body: {} });
  check('I3  missing field -> 400', r.status === 400);
  r = await call('PUT', '/api/admin/renewals/deadline', { user: adm, body: { renewal_deadline_at: null } });
  check('I4  null clears the deadline', r.status === 200 && sess(2).renewal_deadline_at === null);
  r = await call('PUT', '/api/admin/renewals/deadline', { user: adm, body: { hostel_session_id: 1, renewal_deadline_at: '2026-12-31 10:00' } });
  check('I5  a closed session\'s deadline cannot be changed (409)', r.status === 409 && sess(1).renewal_deadline_at === null);
  r = await call('PUT', '/api/admin/renewals/deadline', { user: adm, body: { hostel_session_id: 55, renewal_deadline_at: '2026-12-31 10:00' } });
  check('I6  unknown session -> 404', r.status === 404);
  await call('PUT', '/api/admin/renewals/deadline', { user: adm, body: { renewal_deadline_at: '2026-10-01 10:00' } });
  r = await call('GET', '/api/renewals/status', { user: stu(7) });
  check('I7  moving the deadline into the past closes the window for students', r.json.data.reason === 'window_closed');
  r = await call('GET', '/api/admin/renewals/overview', { user: adm });
  check('I8  overview reports the session, deadline and pass/fail', r.status === 200 && r.json.data.deadline_passed === true && r.json.data.session.label === '2026/2027');
  check('I9  normaliseDeadline unit: seconds default, null/empty clear, rejects 2-digit-less hour', svc.normaliseDeadline('2026-12-31 09:05') === '2026-12-31 09:05:00' && svc.normaliseDeadline('') === null && svc.normaliseDeadline(null) === null && (() => { try { svc.normaliseDeadline('2026-12-31 9:00'); return false; } catch (e) { return e.statusCode === 400; } })());

  /* ---- J: schema guard + list filter ---- */
  reset(); SCHEMA = 'missing';
  r = await call('GET', '/api/renewals/status', { user: stu(7) });
  check('J1  schema not migrated -> 503, no guessing', r.status === 503);
  r = await call('POST', '/api/renewals', { user: stu(7) });
  check('J2  request also refuses (503) and writes nothing', r.status === 503 && S.renewals.length === 0);
  reset(); await call('POST', '/api/renewals', { user: stu(7) }); await call('POST', '/api/renewals', { user: stu(8) }); await call('POST', '/api/admin/renewals/2/reject', { user: adm, body: { reason: 'x' } });
  r = await call('GET', '/api/admin/renewals?status=rejected', { user: adm });
  check('J3  list filter by status', r.json.data.length === 1 && r.json.data[0].student_id === 8);
  r = await call('GET', '/api/admin/renewals', { user: adm });
  check('J4  list returns all, newest first, with names and rooms', r.json.data.length === 2 && r.json.data[0].id === 2 && r.json.data[1].previous_room_number === 'A101');

  server.close();
  console.log(`\nphase9d_renewal_unit: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log(e.stack); process.exit(2); });
