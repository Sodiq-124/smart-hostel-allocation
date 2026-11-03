/**
 * tests/phase9e_fee_unit.js - hostel fee per academic session
 * Application-level only: in-memory fake database (no real DB, no network); REAL app.js, routes,
 * controllers, feeAdminService and feeService.getBlockFee. Proves logic and HTTP wiring, not that
 * the SQL is valid MariaDB.
 *   node tests/phase9e_fee_unit.js
 */
const path = require('path');
const http = require('http');
process.env.NODE_ENV = 'test';
const backend = path.join(__dirname, '..');
const resolve = (p) => require.resolve(path.join(backend, p));
function stub(mod, e) { const id = mod.startsWith('/') ? mod : require.resolve(mod); require.cache[id] = { id, filename: id, loaded: true, exports: e }; }
let pass = 0; let fail = 0;
function check(n, ok, d) { if (ok) { pass += 1; console.log(`  ok   ${n}`); } else { fail += 1; console.log(`  FAIL ${n}${d !== undefined ? ` :: ${d}` : ''}`); } }

let S;
const clone = (x) => JSON.parse(JSON.stringify(x));
function fresh() {
  return {
    sessions: [
      { id: 1, label: '2025/2026', status: 'closed', is_current: 0 },
      { id: 2, label: '2026/2027', status: 'open', is_current: 1 },
      { id: 3, label: '2027/2028', status: 'upcoming', is_current: 0 },
      { id: 4, label: '2024/2025', status: 'archived', is_current: 0 },
    ],
    blocks: [
      { id: 1, name: 'Block A', gender: 'male', description: 'Male hostel', is_active: 1 },
      { id: 2, name: 'Block B', gender: 'male', description: null, is_active: 1 },
      { id: 3, name: 'Block C', gender: 'female', description: null, is_active: 1 },
      { id: 4, name: 'Block D', gender: 'female', description: null, is_active: 0 },
    ],
    users: { 7: { gender: 'male' }, 12: { gender: 'female' }, 13: { gender: null } },
    fees: [
      { id: 1, room_type: 'single', amount: '150000.00', currency: 'NGN', session_year: '2025/2026', hostel_session_id: 1, block_id: null, active: 1, updated_by: null, created_at: 't1' },
      { id: 3, room_type: null, amount: '300000.00', currency: 'NGN', session_year: '2026/2027', hostel_session_id: 2, block_id: 1, active: 1, updated_by: null, created_at: 't3' },
      { id: 4, room_type: null, amount: '250000.00', currency: 'NGN', session_year: '2026/2027', hostel_session_id: 2, block_id: 2, active: 1, updated_by: null, created_at: 't4' },
      { id: 5, room_type: null, amount: '200000.00', currency: 'NGN', session_year: '2026/2027', hostel_session_id: 2, block_id: 3, active: 1, updated_by: null, created_at: 't5' },
    ],
    payments: [
      { id: 1, hostel_fee_id: 3, status: 'success', amount: '300000.00' },
      { id: 2, hostel_fee_id: 3, status: 'pending', amount: '300000.00' },
    ],
    nextFee: 100,
  };
}
const err = (c, m) => { const e = new Error(m); e.code = c; return e; };
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const feeKey = (f) => (f.active === 1 && f.block_id !== null ? `B:${f.hostel_session_id}:${f.block_id}` : null);

async function execute(raw, p = []) {
  const sql = norm(raw);
  if (sql === 'SELECT id, label, status, is_current FROM hostel_sessions ORDER BY label DESC') return [clone(S.sessions).sort((a, b) => (a.label < b.label ? 1 : -1)), []];
  if (sql === 'SELECT id, label, status, is_current FROM hostel_sessions WHERE id = ?') return [clone(S.sessions.filter((s) => s.id === p[0])), []];
  if (sql === 'SELECT id, name, gender, is_active FROM blocks ORDER BY name') return [clone(S.blocks), []];
  if (sql.startsWith('SELECT id, block_id, amount, currency, active, updated_by, created_at FROM hostel_fees WHERE hostel_session_id = ?')) {
    return [clone(S.fees.filter((f) => f.hostel_session_id === p[0] && f.block_id !== null)).sort((a, b) => b.id - a.id), []];
  }
  if (sql.startsWith('SELECT f.block_id, COUNT(p.id) AS total')) {
    const out = {};
    S.fees.filter((f) => f.hostel_session_id === p[0] && f.block_id !== null).forEach((f) => S.payments.filter((x) => x.hostel_fee_id === f.id).forEach((x) => {
      const o = out[f.block_id] || (out[f.block_id] = { block_id: f.block_id, total: 0, paid: 0, pending: 0 });
      o.total += 1; if (x.status === 'success') o.paid += 1; if (x.status === 'pending') o.pending += 1;
    }));
    return [Object.values(out), []];
  }
  if (sql === 'SELECT id, label, status FROM hostel_sessions WHERE id = ? FOR UPDATE') return [clone(S.sessions.filter((s) => s.id === p[0])), []];
  if (sql === 'SELECT id, name, is_active FROM blocks WHERE id = ?') return [clone(S.blocks.filter((b) => b.id === p[0])), []];
  if (sql.startsWith('SELECT id, amount, currency FROM hostel_fees WHERE hostel_session_id = ? AND block_id = ? AND active = 1 FOR UPDATE')) {
    return [clone(S.fees.filter((f) => f.hostel_session_id === p[0] && f.block_id === p[1] && f.active === 1)), []];
  }
  if (sql === 'UPDATE hostel_fees SET active = 0, updated_by = ? WHERE id = ? AND active = 1') {
    const f = S.fees.find((x) => x.id === p[1] && x.active === 1); if (!f) return [{ affectedRows: 0 }, []];
    f.active = 0; f.updated_by = p[0]; return [{ affectedRows: 1 }, []];
  }
  if (sql.startsWith('INSERT INTO hostel_fees (room_type, amount, currency, session_year, hostel_session_id, block_id, active, updated_by)')) {
    const row = { id: S.nextFee++, room_type: null, amount: p[0], currency: p[1], session_year: p[2], hostel_session_id: p[3], block_id: p[4], active: 1, updated_by: p[5], created_at: 'now' };
    if (S.fees.some((f) => feeKey(f) && feeKey(f) === feeKey(row))) throw err('ER_DUP_ENTRY', 'dup uq_active_fee');
    if (Number(row.amount) <= 0) throw err('ER_SIGNAL', 'Hostel fee must be greater than zero.');
    S.fees.push(row); return [{ insertId: row.id, affectedRows: 1 }, []];
  }
  if (sql === "SELECT id, label FROM hostel_sessions WHERE is_current = 1 AND status = 'open' LIMIT 1") return [clone(S.sessions.filter((s) => s.is_current === 1 && s.status === 'open')), []];
  if (sql === 'SELECT gender FROM users WHERE id = ?') return [S.users[p[0]] ? [{ gender: S.users[p[0]].gender }] : [], []];
  if (sql.startsWith('SELECT b.id AS block_id, b.name AS block_name, b.gender, b.description, f.amount, f.currency FROM blocks b')) {
    return [S.blocks.filter((b) => b.is_active === 1).map((b) => { const f = S.fees.find((x) => x.block_id === b.id && x.hostel_session_id === p[0] && x.active === 1); return f ? { block_id: b.id, block_name: b.name, gender: b.gender, description: b.description, amount: f.amount, currency: f.currency } : null; }).filter(Boolean), []];
  }
  // feeService.getBlockFee
  if (sql.startsWith('SELECT id, hostel_session_id, block_id, amount, currency FROM hostel_fees WHERE hostel_session_id = ? AND block_id = ? AND active = 1')) {
    return [clone(S.fees.filter((f) => f.hostel_session_id === p[0] && f.block_id === p[1] && f.active === 1)), []];
  }
  throw new Error(`FAKE DB: unexpected SQL: ${sql}`);
}
const fakeConn = { execute };
let tail = Promise.resolve();
function withTransaction(cb) {
  const run = tail.then(async () => { const snap = clone(S); try { return await cb(fakeConn); } catch (e) { Object.assign(S, snap); throw e; } });
  tail = run.catch(() => {}); return run;
}
// queryOne answers the per-request role/activity re-check in middleware/authMiddleware.js: id 1 is the admin, every other id a student.
const userLookup = async (sql, p) => (/FROM users WHERE id = \?/.test(sql) ? { role: Number(p[0]) === 1 ? 'admin' : 'student', is_active: 1 } : null);
stub(resolve('config/database'), { pool: fakeConn, query: async () => [], queryOne: userLookup, withTransaction, testConnection: async () => true });
stub(resolve('config/session'), (req, res, next) => { const u = req.headers['x-test-user']; req.session = u ? { user: JSON.parse(u) } : {}; next(); });
stub('morgan', () => (req, res, next) => next());
stub('bcrypt', { hash: async () => 'x', compare: async () => false });
const { getBlockFee } = require(resolve('services/feeService'));
const app = require(resolve('app'));

let server;
function call(method, urlPath, { user, body } = {}) {
  return new Promise((ok, bad) => {
    const payload = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const h = { Accept: 'application/json' };
    if (user) h['x-test-user'] = JSON.stringify(user);
    if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = payload.length; }
    const rq = http.request({ host: '127.0.0.1', port: server.address().port, path: urlPath, method, headers: h }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c));
      res.on('end', () => { const t = Buffer.concat(ch).toString('utf8'); let j = null; try { j = JSON.parse(t); } catch { /* html */ } ok({ status: res.statusCode, json: j }); });
    });
    rq.on('error', bad); if (payload) rq.write(payload); rq.end();
  });
}
const stu = (id) => ({ id, role: 'student' });
const adm = { id: 1, role: 'admin' };
console.error = () => {};
const rowsOf = (sid) => S.fees.filter((f) => f.hostel_session_id === sid);
const activeOf = (sid, bid) => S.fees.filter((f) => f.hostel_session_id === sid && f.block_id === bid && f.active === 1);
const put = (sid, bid, amount, user = adm) => call('PUT', `/api/admin/fees/sessions/${sid}/blocks/${bid}`, { user, body: { amount } });

(async () => {
  server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.on('listening', r));
  let r; let r2;

  /* A: authorisation */
  S = fresh();
  r = await put(3, 1, '320000', stu(7)); check('A1  a student cannot set a fee (403) and nothing changes', r.status === 403 && rowsOf(3).length === 0);
  r = await call('PUT', '/api/admin/fees/sessions/3/blocks/1', { body: { amount: '1' } }); check('A2  anonymous cannot set a fee (401)', r.status === 401);
  r = await call('GET', '/api/admin/fees/sessions/2', { user: stu(7) }); check('A3  a student cannot read the admin fee list (403)', r.status === 403);
  r = await call('GET', '/api/admin/fees/options'); check('A4  anonymous cannot read options (401)', r.status === 401);
  r = await call('GET', '/api/fees/current'); check('A5  student fee list needs login (401)', r.status === 401);
  r = await call('GET', '/api/fees/current', { user: adm }); check('A6  the student fee list is not the admin\'s (403)', r.status === 403);
  r = await call('PUT', '/api/fees/current', { user: stu(7), body: { amount: '1' } }); check('A7  there is no student write route (404)', r.status === 404);

  /* B: set a fee for a NEW (upcoming) session; previous sessions untouched */
  S = fresh(); const before = clone(S);
  r = await put(3, 1, '320000');
  check('B1  admin sets Block A for 2027/2028', r.status === 200 && r.json.data.changed && r.json.data.fee.amount === '320000.00' && activeOf(3, 1).length === 1 && activeOf(3, 1)[0].session_year === '2027/2028' && activeOf(3, 1)[0].updated_by === 1);
  check('B2  every row of other sessions is byte-identical (session 1 and 2 untouched)', JSON.stringify(rowsOf(1)) === JSON.stringify(before.fees.filter((f) => f.hostel_session_id === 1)) && JSON.stringify(rowsOf(2)) === JSON.stringify(before.fees.filter((f) => f.hostel_session_id === 2)));
  check('B3  payment records are untouched', JSON.stringify(S.payments) === JSON.stringify(before.payments));
  r = await put(3, 1, '320000.00'); check('B4  same amount again = no-op, no new row', r.status === 200 && r.json.data.changed === false && rowsOf(3).length === 1);

  /* C: revise a fee in the OPEN session: history kept, payments keep their fee row */
  r = await put(2, 1, '310000.50');
  const a2 = activeOf(2, 1);
  check('C1  revision creates a new active row (310000.50) and keeps the old one inactive', r.status === 200 && a2.length === 1 && a2[0].amount === '310000.50' && S.fees.find((f) => f.id === 3).active === 0 && S.fees.find((f) => f.id === 3).amount === '300000.00');
  check('C2  payments still point to the old fee row, whose amount is unchanged', S.payments.every((p) => p.hostel_fee_id === 3) && S.fees.find((f) => f.id === 3).amount === '300000.00');
  check('C3  other blocks of the same session unchanged', activeOf(2, 2)[0].amount === '250000.00' && activeOf(2, 3)[0].amount === '200000.00');
  check('C4  session 2027/2028 unaffected by the 2026/2027 revision', activeOf(3, 1)[0].amount === '320000.00' && rowsOf(3).length === 1);
  r = await call('GET', '/api/admin/fees/sessions/2', { user: adm });
  const a = r.json.data.blocks.find((b) => b.block_id === 1);
  check('C5  admin list: current fee, earlier fee, and payment counts on the old fee', a.fee.amount === '310000.50' && a.earlier_fees.length === 1 && a.earlier_fees[0].amount === '300000.00' && a.payments.total === 2 && a.payments.paid === 1 && a.payments.pending === 1);

  /* D: pricing uses the application's own session */
  S = fresh(); await put(3, 1, '999000');
  const p2 = await getBlockFee(fakeConn, 2, 1); const p3 = await getBlockFee(fakeConn, 3, 1);
  check('D1  getBlockFee prices session 2 and session 3 differently (300000.00 vs 999000.00)', p2.amount === '300000.00' && p3.amount === '999000.00' && p2.hostel_fee_id !== p3.hostel_fee_id && p3.hostel_session_id === 3);
  let e = null; try { await getBlockFee(fakeConn, 3, 2); } catch (x) { e = x; }
  check('D2  a block with no fee in a session is refused (409), not borrowed from another session', e && e.statusCode === 409);
  await put(2, 1, '305000');
  check('D3  after revising session 2, session 3 still prices at 999000.00 and session 2 at 305000.00', (await getBlockFee(fakeConn, 3, 1)).amount === '999000.00' && (await getBlockFee(fakeConn, 2, 1)).amount === '305000.00');

  /* E: read-only sessions */
  S = fresh();
  r = await put(1, 1, '100000'); check('E1  closed session is read-only (409)', r.status === 409 && rowsOf(1).length === 1);
  r = await put(4, 1, '100000'); check('E2  archived session is read-only (409)', r.status === 409 && rowsOf(4).length === 0);
  r = await call('GET', '/api/admin/fees/sessions/1', { user: adm }); check('E3  closed session can still be viewed, flagged not editable', r.status === 200 && r.json.data.editable === false);
  r = await put(99, 1, '100000'); check('E4  unknown session -> 404', r.status === 404);
  r = await put(3, 99, '100000'); check('E5  unknown block -> 404', r.status === 404);
  r = await put(3, 4, '100000'); check('E6  inactive block -> 409', r.status === 409 && rowsOf(3).length === 0);
  r = await put('abc', 1, '100000'); check('E7  non-numeric session -> 400', r.status === 400);

  /* F: validation */
  for (const bad of ['', '0', '0.00', '-5', 'abc', '1e6', '100.123', '1,2,3x', '100000000', null, 12.5, [], {}]) {
    r = await put(3, 2, bad);
    check(`F1  invalid amount ${JSON.stringify(bad)} -> 400, nothing written`, r.status === 400 && rowsOf(3).length === 0, r.status);
  }
  r = await put(3, 2, '1,250,000.5'); check('F2  thousands separators accepted and stored exactly (1250000.50)', r.status === 200 && activeOf(3, 2)[0].amount === '1250000.50');
  r = await put(3, 3, 400000); check('F3  an integer JSON number is accepted', r.status === 200 && activeOf(3, 3)[0].amount === '400000.00');
  r = await put(3, 1, '99999999.99'); check('F4  the largest value the column holds is accepted', r.status === 200);

  /* G: concurrency */
  S = fresh();
  [r, r2] = await Promise.all([put(3, 1, '111000'), put(3, 1, '222000')]);
  check('G1  two simultaneous sets: exactly one ACTIVE row remains, the other is kept as history', activeOf(3, 1).length === 1 && rowsOf(3).length === 2 && r.status === 200 && r2.status === 200);

  /* H: student display */
  S = fresh();
  r = await call('GET', '/api/fees/current', { user: stu(7) });
  check('H1  a male student sees the current session\'s male-block fees from the database', r.status === 200 && r.json.data.session.label === '2026/2027' && r.json.data.blocks.map((b) => `${b.block_name}:${b.amount}`).join() === 'Block A:300000.00,Block B:250000.00');
  r = await call('GET', '/api/fees/current', { user: stu(12) });
  check('H2  a female student sees only female blocks that have a fee (inactive Block D hidden)', r.json.data.blocks.map((b) => b.block_name).join() === 'Block C');
  await put(3, 1, '999000');
  r = await call('GET', '/api/fees/current', { user: stu(7) });
  check('H3  a fee set for the upcoming session is NOT shown to students applying in the current session', r.json.data.blocks[0].amount === '300000.00');
  S.fees = S.fees.filter((f) => f.hostel_session_id !== 2);
  r = await call('GET', '/api/fees/current', { user: stu(7) });
  check('H4  no fee configured -> empty list (UI says "not announced yet")', r.status === 200 && r.json.data.blocks.length === 0);
  S = fresh(); S.sessions[1].status = 'closed'; S.sessions[1].is_current = 0;
  r = await call('GET', '/api/fees/current', { user: stu(7) });
  check('H5  no open session -> session null', r.json.data.session === null);

  /* I: list / options */
  S = fresh();
  r = await call('GET', '/api/admin/fees/options', { user: adm });
  check('I1  options list every session with editable flag', r.json.data.sessions.length === 4 && r.json.data.sessions.find((s) => s.label === '2026/2027').editable === true && r.json.data.sessions.find((s) => s.label === '2025/2026').editable === false);
  r = await call('GET', '/api/admin/fees/sessions/3', { user: adm });
  check('I2  a new session lists every block with fee = null until set', r.json.data.blocks.length === 4 && r.json.data.blocks.every((b) => b.fee === null) && r.json.data.editable === true);
  check('I3  legacy room-type fee rows (block NULL) are never listed or altered', S.fees.find((f) => f.id === 1).active === 1);

  server.close();
  console.log(`\nphase9e_fee_unit: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(e.stack); process.exit(2); });
