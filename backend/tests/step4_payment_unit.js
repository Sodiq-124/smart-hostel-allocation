/**
 * tests/step4_payment_unit.js - Paystack payments
 *
 * Runs WITHOUT a database and WITHOUT network access:
 *   - config/database is replaced by an in-memory fake that understands the
 *     SQL paymentService/feeService/hostelSessionService issue, and enforces
 *     the payments table rules that matter (unique payment_reference, ONE
 *     successful payment per application+session, the migration-017 CHECK).
 *   - axios is replaced by a scripted fake Paystack, so the REAL
 *     services/paystackService.js (key check, checkout-host check, webhook
 *     HMAC) runs.
 *   - the REAL app.js is loaded (real Helmet CSP, real raw-body capture, real
 *     router mount, real validators and auth middleware); only the session
 *     store and the request logger are replaced.
 *
 * It proves the payment LOGIC and HTTP wiring. It does NOT prove the SQL is
 * valid MariaDB, nor that Paystack accepts the requests - see
 * tests/step4_scratch_verify.sql and a Paystack sandbox run.
 *
 *   node tests/step4_payment_unit.js
 */
const path = require('path');
const http = require('http');
const crypto = require('crypto');

process.env.PAYSTACK_SECRET_KEY = 'sk_test_unit_test_secret_000000';
process.env.PAYSTACK_BASE_URL = 'https://api.paystack.co';
process.env.PAYMENT_CALLBACK_URL = 'http://localhost:5000/student/payment-callback.html';
process.env.NODE_ENV = 'test';

const backend = path.join(__dirname, '..');
const resolve = (p) => require.resolve(path.join(backend, p));
function stub(modulePath, exportsObj) {
  const id = modulePath.startsWith('/') ? modulePath : require.resolve(modulePath);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail !== undefined ? ` :: ${detail}` : ''}`); }
}
async function rejects(promise) {
  try { await promise; } catch (e) { return e; }
  return null;
}

/* ===================================================================
   In-memory database
   =================================================================== */
const { decimalToMinor } = require(resolve('utils/money'));
let STATE;
let SCHEMA; // 'typed' (013+017) | 'base' (013 only) | 'old' (no hostel_session_id)

const BASE_COLS = ['id', 'student_id', 'application_id', 'hostel_session_id', 'hostel_fee_id', 'amount', 'currency',
  'payment_reference', 'gateway_reference', 'payment_gateway', 'payment_channel', 'status', 'verified_at', 'paid_at', 'created_at'];

function freshState() {
  return {
    sessions: [
      { id: 1, label: '2025/2026', status: 'closed', is_current: 0 },
      { id: 2, label: '2026/2027', status: 'open', is_current: 1 },
    ],
    users: {
      7: { email: 'ada@example.com', role: 'student', is_active: 1 },
      8: { email: 'bola@example.com', role: 'student', is_active: 1 },
      9: { email: 'chi@example.com', role: 'student', is_active: 1 },
      10: { email: 'dayo@example.com', role: 'student', is_active: 1 },
      11: { email: 'eze@example.com', role: 'student', is_active: 1 },
      12: { email: 'femi@example.com', role: 'student', is_active: 1 },
      13: { email: 'gbenga@example.com', role: 'student', is_active: 1 },
    },
    fees: [
      { id: 1, block_id: null, hostel_session_id: 1, amount: '150000.00', currency: 'NGN', active: 0 },
      { id: 14, block_id: 1, hostel_session_id: 2, amount: '300000.00', currency: 'NGN', active: 1 },
      { id: 15, block_id: 2, hostel_session_id: 2, amount: '250000.00', currency: 'NGN', active: 1 },
      { id: 16, block_id: 3, hostel_session_id: 2, amount: '200000.00', currency: 'NGN', active: 1 },
      { id: 17, block_id: 4, hostel_session_id: 2, amount: '150000.00', currency: 'NGN', active: 1 },
    ],
    blocks: { 1: 'Block A', 2: 'Block B', 3: 'Block C', 4: 'Block D' },
    rooms: {
      24: { id: 24, room_number: 'R001', room_type: 'single', block_id: 1 },
      30: { id: 30, room_number: 'R101', room_type: 'shared', block_id: 2 },
      40: { id: 40, room_number: 'R201', room_type: 'single', block_id: 3 },
      50: { id: 50, room_number: 'R301', room_type: 'shared', block_id: 4 },
    },
    applications: [
      { id: 101, student_id: 7, status: 'approved', allocated_room_id: 24, hostel_session_id: 2, applied_at: 5 },
      { id: 102, student_id: 8, status: 'approved', allocated_room_id: 30, hostel_session_id: 2, applied_at: 5 },
      { id: 103, student_id: 9, status: 'approved', allocated_room_id: 40, hostel_session_id: 2, applied_at: 5 },
      { id: 104, student_id: 10, status: 'approved', allocated_room_id: 50, hostel_session_id: 2, applied_at: 5 },
      { id: 105, student_id: 11, status: 'approved', allocated_room_id: null, hostel_session_id: 2, applied_at: 5 }, // revoked
      { id: 106, student_id: 12, status: 'pending', allocated_room_id: null, hostel_session_id: 2, applied_at: 5 },  // not approved
      { id: 107, student_id: 13, status: 'approved', allocated_room_id: 24, hostel_session_id: 1, applied_at: 1 },   // old session only
    ],
    allocations: [
      { id: 201, application_id: 101, student_id: 7, room_id: 24, hostel_session_id: 2, status: 'active' },
      { id: 202, application_id: 102, student_id: 8, room_id: 30, hostel_session_id: 2, status: 'active' },
      { id: 203, application_id: 103, student_id: 9, room_id: 40, hostel_session_id: 2, status: 'active' },
      { id: 204, application_id: 104, student_id: 10, room_id: 50, hostel_session_id: 2, status: 'active' },
      { id: 205, application_id: 105, student_id: 11, room_id: 24, hostel_session_id: 2, status: 'released' },
      { id: 207, application_id: 107, student_id: 13, room_id: 24, hostel_session_id: 1, status: 'active' },
    ],
    payments: [],
    nextPayment: 500,
  };
}

function dbError(code, message) { const e = new Error(message); e.code = code; return e; }

function successKeyTaken(S, row) {
  return S.payments.some((p) => p.id !== row.id && p.status === 'success' &&
    p.application_id === row.application_id && p.hostel_session_id === row.hostel_session_id &&
    (SCHEMA !== 'typed' || p.payment_type === row.payment_type));
}

async function execute(sqlRaw, params = []) {
  const sql = sqlRaw.replace(/\s+/g, ' ').trim();
  const S = STATE;
  const qm = (sql.match(/\?/g) || []).length;
  if (qm !== params.length) throw new Error(`FAKE DB: ${qm} placeholders but ${params.length} params: ${sql}`);
  if (/(?<!hostel_)\bsession_id\b/.test(sql)) throw new Error(`FAKE DB: legacy session_id used: ${sql}`);
  EXECUTED.push(sql);

  let m;
  if (/^SELECT COLUMN_NAME AS column_name FROM information_schema\.COLUMNS WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME = 'payments'/.test(sql)) {
    const cols = SCHEMA === 'old'
      ? BASE_COLS.filter((c) => c !== 'hostel_session_id' && c !== 'hostel_fee_id')
      : BASE_COLS.concat(SCHEMA === 'typed' ? ['payment_type', 'hostel_misc_charge_id', 'original_amount', 'late_fine_applied'] : []);
    return [cols.map((c) => ({ column_name: c })), []];
  }
  if (/^SELECT id, label FROM hostel_sessions WHERE is_current = 1 AND status = 'open' LIMIT 1 LOCK IN SHARE MODE$/.test(sql)) {
    return [S.sessions.filter((x) => x.is_current === 1 && x.status === 'open').map((x) => ({ id: x.id, label: x.label })), []];
  }
  if ((m = /^SELECT id, student_id, status, allocated_room_id, hostel_session_id FROM applications WHERE student_id = \? AND hostel_session_id = \? ORDER BY applied_at DESC, id DESC LIMIT 1( FOR UPDATE)?$/.exec(sql))) {
    const rows = S.applications.filter((a) => a.student_id === params[0] && a.hostel_session_id === params[1])
      .sort((a, b) => b.applied_at - a.applied_at || b.id - a.id).slice(0, 1).map(({ applied_at, ...a }) => a);
    return [rows, []];
  }
  // ---- feeService (same shapes as tests/step3_fee_unit.js) ----
  if (/^SELECT id, student_id, status, allocated_room_id, hostel_session_id FROM applications WHERE id = \? LOCK IN SHARE MODE$/.test(sql)) {
    return [S.applications.filter((a) => a.id === params[0]).map(({ applied_at, ...a }) => a), []];
  }
  if (/^SELECT id, application_id, student_id, room_id, hostel_session_id FROM allocations WHERE application_id = \? AND hostel_session_id = \? AND status = 'active' LOCK IN SHARE MODE$/.test(sql)) {
    return [S.allocations.filter((a) => a.application_id === params[0] && a.hostel_session_id === params[1] && a.status === 'active').map((a) => ({ ...a })), []];
  }
  if (/^SELECT r\.id AS room_id, r\.room_number, r\.room_type, r\.block_id, b\.name AS block_name FROM rooms r JOIN blocks b ON b\.id = r\.block_id WHERE r\.id = \?$/.test(sql)) {
    const r = S.rooms[params[0]];
    return [r ? [{ room_id: r.id, room_number: r.room_number, room_type: r.room_type, block_id: r.block_id, block_name: S.blocks[r.block_id] }] : [], []];
  }
  if (/^SELECT id, hostel_session_id, block_id, amount, currency FROM hostel_fees WHERE hostel_session_id = \? AND block_id = \? AND active = 1 LOCK IN SHARE MODE$/.test(sql)) {
    return [S.fees.filter((f) => f.hostel_session_id === params[0] && f.block_id === params[1] && f.active === 1)
      .map((f) => ({ id: f.id, hostel_session_id: f.hostel_session_id, block_id: f.block_id, amount: f.amount, currency: f.currency })), []];
  }
  if (/^SELECT fee_block_id FROM applications WHERE id = \?$/.test(sql)) {
    const a = S.applications.find((x) => x.id === params[0]);
    return [a ? [{ fee_block_id: a.fee_block_id === undefined ? null : a.fee_block_id }] : [], []];
  }
  if (/^SELECT id, name FROM blocks WHERE id = \?$/.test(sql)) {
    return [S.blocks[params[0]] ? [{ id: params[0], name: S.blocks[params[0]] }] : [], []];
  }
  // ---- payments ----
  if (/^SELECT payment_reference, amount, currency, paid_at FROM payments WHERE application_id = \? AND hostel_session_id = \? AND status = 'success'( AND payment_type = 'hostel')? LIMIT 1$/.test(sql)) {
    return [S.payments.filter((p) => p.application_id === params[0] && p.hostel_session_id === params[1] && p.status === 'success').slice(0, 1)
      .map((p) => ({ payment_reference: p.payment_reference, amount: p.amount, currency: p.currency, paid_at: p.paid_at })), []];
  }
  if (/^SELECT payment_reference, status, amount, currency, paid_at, created_at FROM payments WHERE application_id = \? AND hostel_session_id = \?( AND payment_type = 'hostel')? ORDER BY id DESC LIMIT 5$/.test(sql)) {
    return [S.payments.filter((p) => p.application_id === params[0] && p.hostel_session_id === params[1] && (!/payment_type/.test(sql) || p.payment_type === 'hostel')).sort((a, b) => b.id - a.id).slice(0, 5)
      .map((p) => ({ payment_reference: p.payment_reference, status: p.status, amount: p.amount, currency: p.currency, paid_at: p.paid_at, created_at: p.created_at })), []];
  }
  if (/^SELECT payment_reference FROM payments WHERE application_id = \? AND hostel_session_id = \? AND status = 'pending'( AND payment_type = 'hostel')? ORDER BY id DESC LIMIT 5$/.test(sql)) {
    return [S.payments.filter((p) => p.application_id === params[0] && p.hostel_session_id === params[1] && p.status === 'pending' && (!/payment_type/.test(sql) || p.payment_type === 'hostel')).sort((a, b) => b.id - a.id).slice(0, 5)
      .map((p) => ({ payment_reference: p.payment_reference })), []];
  }
  if (/^SELECT id FROM payments WHERE application_id = \? AND hostel_session_id = \? AND status = 'pending'( AND payment_type = 'hostel')? LIMIT 1$/.test(sql)) {
    return [S.payments.filter((p) => p.application_id === params[0] && p.hostel_session_id === params[1] && p.status === 'pending' && (!/payment_type/.test(sql) || p.payment_type === 'hostel')).slice(0, 1).map((p) => ({ id: p.id })), []];
  }
  if (/^SELECT email FROM users WHERE id = \? AND role = 'student' AND is_active = 1$/.test(sql)) {
    const u = S.users[params[0]];
    return [u && u.role === 'student' && u.is_active === 1 ? [{ email: u.email }] : [], []];
  }
  if (/^SELECT id, student_id, application_id, hostel_session_id, amount, currency, payment_reference, status, paid_at(, payment_type, hostel_misc_charge_id, original_amount)? FROM payments WHERE payment_reference = \?$/.test(sql)) {
    return [S.payments.filter((p) => p.payment_reference === params[0]).map((p) => ({
      id: p.id, student_id: p.student_id, application_id: p.application_id, hostel_session_id: p.hostel_session_id,
      amount: p.amount, currency: p.currency, payment_reference: p.payment_reference, status: p.status, paid_at: p.paid_at,
      payment_type: p.payment_type, hostel_misc_charge_id: p.hostel_misc_charge_id, original_amount: p.original_amount })), []];
  }
  if ((m = /^INSERT INTO payments \(([^)]+)\) VALUES \(([?, ]+)\)$/.exec(sql))) {
    const cols = m[1].split(',').map((c) => c.trim());
    if (cols.length !== params.length) throw new Error('FAKE DB: column/param count');
    const row = { status: 'pending', gateway_reference: null, payment_channel: null, verified_at: null, paid_at: null, created_at: 'now', id: S.nextPayment++ };
    cols.forEach((c, i) => { row[c] = params[i]; });
    const allowed = new Set(BASE_COLS.concat(SCHEMA === 'typed' ? ['payment_type', 'original_amount', 'late_fine_applied'] : []));
    for (const c of cols) if (!allowed.has(c)) throw dbError('ER_BAD_FIELD_ERROR', `Unknown column '${c}'`);
    for (const c of ['student_id', 'application_id', 'hostel_session_id', 'hostel_fee_id', 'amount', 'currency', 'payment_reference']) {
      if (row[c] === undefined || row[c] === null) throw dbError('ER_NO_DEFAULT_FOR_FIELD', `${c} cannot be null`);
    }
    if (S.payments.some((p) => p.payment_reference === row.payment_reference)) throw dbError('ER_DUP_ENTRY', 'uq_payment_reference');
    if (SCHEMA === 'typed') {
      // migration 017: ck_payments_amount_breakdown + ck_payments_type_links (hostel)
      if (row.payment_type !== 'hostel') throw dbError('ER_CONSTRAINT_FAILED', 'payment_type');
      if (decimalToMinor(row.amount) !== decimalToMinor(row.original_amount, 'NGN', { allowZero: true }) + decimalToMinor(row.late_fine_applied, 'NGN', { allowZero: true })) {
        throw dbError('ER_CONSTRAINT_FAILED', 'CONSTRAINT `ck_payments_amount_breakdown` failed');
      }
    }
    S.payments.push(row);
    return [{ insertId: row.id, affectedRows: 1 }, []];
  }
  if ((m = /^UPDATE payments SET status = '(failed|abandoned)' WHERE id = \? AND status = 'pending'$/.exec(sql))) {
    const p = S.payments.find((x) => x.id === params[0]);
    if (p && p.status === 'pending') { p.status = m[1]; return [{ affectedRows: 1 }, []]; }
    return [{ affectedRows: 0 }, []];
  }
  if (/^UPDATE payments SET status = 'success', gateway_reference = \?, payment_channel = \?, verified_at = NOW\(\), paid_at = NOW\(\) WHERE id = \? AND status IN \('pending', 'abandoned', 'failed'\)$/.test(sql)) {
    const p = S.payments.find((x) => x.id === params[2]);
    if (!p || !['pending', 'abandoned', 'failed'].includes(p.status)) return [{ affectedRows: 0 }, []];
    if (successKeyTaken(S, p)) throw dbError('ER_DUP_ENTRY', "Duplicate entry for key 'uq_successful_hostel_payment'");
    Object.assign(p, { status: 'success', gateway_reference: params[0], payment_channel: params[1], verified_at: 'now', paid_at: 'now' });
    return [{ affectedRows: 1 }, []];
  }
  throw new Error(`FAKE DB: unexpected SQL: ${sql}`);
}

let EXECUTED = [];
const fakeConn = { execute };
// SELECT ... FOR UPDATE on the application row makes concurrent payment
// transactions for the same application run one after another. This fake
// cannot block rows, so it models that effect by serialising ALL transactions.
// (Real locking behaviour must still be confirmed on MariaDB.)
let txTail = Promise.resolve();
function withTransaction(cb) {
  const run = txTail.then(async () => {
    const snapshot = JSON.parse(JSON.stringify(STATE.payments));
    try { return await cb(fakeConn); } catch (e) { STATE.payments = snapshot; throw e; }
  });
  txTail = run.catch(() => {});
  return run;
}
// queryOne answers the per-request role/activity re-check in middleware/authMiddleware.js: id 1 is the admin, every other id a student.
const userLookup = async (sql, p) => (/FROM users WHERE id = \?/.test(sql) ? { role: Number(p[0]) === 1 ? 'admin' : 'student', is_active: 1 } : null);
stub(resolve('config/database'), { pool: fakeConn, query: async () => [], queryOne: userLookup, withTransaction, testConnection: async () => true });

/* ===================================================================
   Fake Paystack (replaces axios; the real paystackService runs)
   =================================================================== */
let REMOTE;        // reference -> scripted provider answer | 'unreachable'
let INIT_CALLS;    // bodies sent to /transaction/initialize
let VERIFY_CALLS;  // references sent to /transaction/verify/
let CLIENT_CONFIGS;
let INIT_MODE;     // 'ok' | 'reject' | 'unreachable' | 'bad_host'

const fakeAxios = {
  create(config) {
    CLIENT_CONFIGS.push(config);
    return {
      async post(url, body) {
        if (url !== '/transaction/initialize') throw new Error(`unexpected POST ${url}`);
        INIT_CALLS.push(body);
        if (INIT_MODE === 'unreachable') { const e = new Error('timeout of 15000ms exceeded'); e.code = 'ECONNABORTED'; throw e; }
        if (INIT_MODE === 'reject') return { status: 400, data: { status: false, message: 'Invalid key' } };
        const host = INIT_MODE === 'bad_host' ? 'evil.example.com' : 'checkout.paystack.com';
        return { status: 200, data: { status: true, data: { authorization_url: `https://${host}/${body.reference}`, access_code: 'ac_1', reference: body.reference } } };
      },
      async get(url) {
        const ref = decodeURIComponent(url.replace('/transaction/verify/', ''));
        VERIFY_CALLS.push(ref);
        const r = REMOTE[ref];
        if (r === 'unreachable') { const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; }
        if (r === 'http500') return { status: 500, data: { status: false, message: 'oops' } };
        if (!r) return { status: 404, data: { status: false, message: 'Transaction reference not found' } };
        return { status: 200, data: { status: true, data: { reference: ref, ...r } } };
      },
    };
  },
};
stub('axios', fakeAxios);
stub('morgan', () => (req, res, next) => next());
stub('bcrypt', { hash: async () => 'x', compare: async () => false }); // auth routes load it; payments never use it

// session store replacement: identity comes from a test header
stub(resolve('config/session'), (req, res, next) => {
  const u = req.headers['x-test-user'];
  req.session = u ? { user: JSON.parse(u) } : {};
  next();
});

const paymentService = require(resolve('services/paymentService'));
const paystackService = require(resolve('services/paystackService'));
const app = require(resolve('app'));

/* ---- helpers ---- */
function reset(schema = 'typed') {
  STATE = freshState(); SCHEMA = schema; EXECUTED = [];
  REMOTE = {}; INIT_CALLS = []; VERIFY_CALLS = []; CLIENT_CONFIGS = []; INIT_MODE = 'ok';
  paymentService.resetSchemaCache();
}
const rows = () => STATE.payments;
const rowByRef = (ref) => STATE.payments.find((p) => p.payment_reference === ref);
function paidAtProvider(ref, overrides = {}) {
  const row = rowByRef(ref);
  REMOTE[ref] = { status: 'success', amount: decimalToMinor(row.amount), currency: row.currency, id: 4099999 + row.id, channel: 'card', ...overrides };
}

let server;
function call(method, urlPath, { user, body, rawBody, headers = {} } = {}) {
  return new Promise((resolveP, rejectP) => {
    const payload = rawBody !== undefined ? rawBody : body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const h = { Accept: 'application/json', ...headers };
    if (user) h['x-test-user'] = JSON.stringify(user);
    if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = payload.length; }
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: urlPath, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* html */ }
        resolveP({ status: res.statusCode, json, text, headers: res.headers });
      });
    });
    req.on('error', rejectP);
    if (payload) req.write(payload);
    req.end();
  });
}
const student = (id) => ({ id, role: 'student', full_name: `Student ${id}` });
const admin = { id: 1, role: 'admin', full_name: 'Admin' };
const sign = (buf) => crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(buf).digest('hex');

const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.join(' ')); };

(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));

  /* ---------------- P1 eligibility / status ---------------- */
  reset();
  let s = await paymentService.getPaymentStatus(7);
  check('P1  student 7 (approved, active allocation in Block A) is eligible for 300000.00 NGN',
    s.eligible && s.reason === null && s.fee.amount === '300000.00' && s.fee.currency === 'NGN' && s.fee.block_name === 'Block A' && s.session.label === '2026/2027', JSON.stringify(s));
  for (const [id, code, re] of [[11, 'not_payable', /active room allocation/], [12, 'not_approved', /pending/], [13, 'no_application', /no hostel application for the current session/], [99, 'no_application', /no hostel application/]]) {
    s = await paymentService.getPaymentStatus(id);
    check(`P1  student ${id}: not eligible (${code})`, !s.eligible && s.reason === code && re.test(s.message) && s.fee === null, JSON.stringify(s));
  }
  STATE.sessions[1].status = 'closed'; STATE.sessions[1].is_current = 0;
  s = await paymentService.getPaymentStatus(7);
  check('P1  no open session -> not eligible (no_open_session)', !s.eligible && s.reason === 'no_open_session');

  /* ---------------- P2 initialize happy path ---------------- */
  reset();
  let r = await paymentService.initializePayment({ studentId: 7 });
  let row = rows()[0];
  check('P2  returns a checkout.paystack.com URL and our reference', /^https:\/\/checkout\.paystack\.com\//.test(r.authorization_url) && r.reference === row.payment_reference && r.amount === '300000.00' && r.currency === 'NGN', JSON.stringify(r));
  check('P2  payments row: pending, student 7, application 101, session 2, fee 14, 300000.00 NGN, gateway paystack',
    rows().length === 1 && row.status === 'pending' && row.student_id === 7 && row.application_id === 101 && row.hostel_session_id === 2 &&
    row.hostel_fee_id === 14 && row.amount === '300000.00' && row.currency === 'NGN' && row.payment_gateway === 'paystack');
  check('P2  migration-017 columns filled consistently (type hostel, original = amount, fine 0.00)', row.payment_type === 'hostel' && row.original_amount === '300000.00' && row.late_fine_applied === '0.00');
  const body0 = INIT_CALLS[0];
  check('P2  Paystack got INTEGER kobo 30000000, NGN, the student email, our reference and the callback URL',
    body0.amount === 30000000 && Number.isInteger(body0.amount) && body0.currency === 'NGN' && body0.email === 'ada@example.com' &&
    body0.reference === row.payment_reference && body0.callback_url === process.env.PAYMENT_CALLBACK_URL, JSON.stringify(body0));
  check('P2  metadata names application/student/session/fee', body0.metadata.application_id === 101 && body0.metadata.student_id === 7 && body0.metadata.hostel_session_id === 2 && body0.metadata.hostel_fee_id === 14);
  check('P2  secret key only in the Authorization header of the server-side client, base URL from env',
    CLIENT_CONFIGS[0].headers.Authorization === `Bearer ${process.env.PAYSTACK_SECRET_KEY}` && CLIENT_CONFIGS[0].baseURL === 'https://api.paystack.co' && CLIENT_CONFIGS[0].maxRedirects === 0);
  check('P2  reference is Paystack-safe and <= 80 chars', /^[A-Za-z0-9.=-]{1,80}$/.test(row.payment_reference), row.payment_reference);

  for (const [id, minor, amount] of [[8, 25000000, '250000.00'], [9, 20000000, '200000.00'], [10, 15000000, '150000.00']]) {
    reset();
    await paymentService.initializePayment({ studentId: id });
    check(`P2  student ${id}: block fee ${amount} sent as ${minor} kobo`, INIT_CALLS[0].amount === minor && rows()[0].amount === amount);
  }

  reset('base');
  await paymentService.initializePayment({ studentId: 7 });
  check('P2  013-only schema (no payment_type columns): insert omits migration-017 columns and works', rows().length === 1 && rows()[0].payment_type === undefined);
  reset('old');
  e = await rejects(paymentService.initializePayment({ studentId: 7 }));
  check('P2  payments table without hostel_session_id/hostel_fee_id -> 503, nothing inserted, no Paystack call',
    e && e.statusCode === 503 && rows().length === 0 && INIT_CALLS.length === 0 && errors.some((x) => /missing columns: hostel_session_id, hostel_fee_id/.test(x)), e && e.message);

  /* ---------------- P2b a bad stored fee never enters the payment workflow ---------------- */
  // amount = original_amount + late_fine_applied is built from ONE validated fee value, so a
  // negative/zero/malformed fee must stop the workflow before any row exists or Paystack is called.
  for (const [label, amount] of [['negative', '-1.00'], ['negative, full size', '-300000.00'], ['zero', '0.00'], ['malformed', '12abc'], ['3 decimals', '300000.001']]) {
    reset();
    STATE.fees.find((f) => f.id === 14).amount = amount;
    e = await rejects(paymentService.initializePayment({ studentId: 7 }));
    check(`P2b  stored fee ${label} (${amount}) -> 500 "not valid", NO payments row, NO Paystack call`,
      e && e.statusCode === 500 && /not valid/.test(e.message) && rows().length === 0 && INIT_CALLS.length === 0, e && e.message);
  }
  reset();
  STATE.fees.find((f) => f.id === 14).amount = '-1.00';
  e = await rejects(paymentService.getPaymentStatus(7));
  check('P2b  the status endpoint never shows a negative fee either (500, no amount returned)', e && e.statusCode === 500 && !/-1/.test(e.message), e && e.message);

  /* ---------------- P3 initialize refusals ---------------- */
  for (const [id, re, why] of [[11, /active room allocation/, 'allocation revoked'], [12, /pending/, 'application not approved'], [13, /no hostel application for the current session/, 'only an old-session application'], [99, /no hostel application/, 'no application']]) {
    reset();
    e = await rejects(paymentService.initializePayment({ studentId: id }));
    check(`P3  ${why} -> 409, no row, no Paystack call`, e && e.statusCode === 409 && re.test(e.message) && rows().length === 0 && INIT_CALLS.length === 0, e && e.message);
  }
  reset();
  STATE.sessions[1].status = 'closed'; STATE.sessions[1].is_current = 0;
  e = await rejects(paymentService.initializePayment({ studentId: 7 }));
  check('P3  no open session -> 409, nothing created', e && e.statusCode === 409 && rows().length === 0 && INIT_CALLS.length === 0);
  reset();
  STATE.fees = STATE.fees.filter((f) => f.id !== 14);
  e = await rejects(paymentService.initializePayment({ studentId: 7 }));
  check('P3  no fee configured for the allocated block -> 409, nothing created', e && e.statusCode === 409 && /No hostel fee/.test(e.message) && rows().length === 0);
  reset();
  STATE.users[7].is_active = 0;
  e = await rejects(paymentService.initializePayment({ studentId: 7 }));
  check('P3  deactivated account -> 403, row rolled back', e && e.statusCode === 403 && rows().length === 0 && INIT_CALLS.length === 0);
  reset();
  delete process.env.PAYMENT_CALLBACK_URL;
  e = await rejects(paymentService.initializePayment({ studentId: 7 }));
  process.env.PAYMENT_CALLBACK_URL = 'http://localhost:5000/student/payment-callback.html';
  check('P3  missing PAYMENT_CALLBACK_URL -> 503, nothing created', e && e.statusCode === 503 && rows().length === 0);
  reset();
  const keep = process.env.PAYSTACK_SECRET_KEY;
  for (const bad of ['', 'pk_test_abcdef', 'not-a-key']) {
    process.env.PAYSTACK_SECRET_KEY = bad;
    e = await rejects(paymentService.initializePayment({ studentId: 7 }));
    check(`P3  PAYSTACK_SECRET_KEY ${JSON.stringify(bad)} (missing / public key / junk) -> 503 BEFORE any row or provider call, no secret in message`,
      e && e.statusCode === 503 && !/sk_|pk_|secret/i.test(e.message) && rows().length === 0 && INIT_CALLS.length === 0, e && e.message);
  }
    process.env.PAYSTACK_SECRET_KEY = 'pk_test_abcdef';
  await paymentService.initializePayment({ studentId: 7 }).catch(() => {});
  process.env.PAYSTACK_SECRET_KEY = keep;
  await paymentService.initializePayment({ studentId: 7 });
  process.env.PAYSTACK_SECRET_KEY = 'pk_test_abcdef';
  e = await rejects(paymentService.verifyAndSettle(rows()[0].payment_reference, { studentId: 7 }));
  process.env.PAYSTACK_SECRET_KEY = keep;
  check('P3  verify with a bad key -> 503 (not mislabelled 502), row unchanged', e && e.statusCode === 503 && rows()[0].status === 'pending', e && e.message);

  /* ---------------- P4 provider failures during initialize ---------------- */
  for (const mode of ['reject', 'unreachable', 'bad_host']) {
    reset(); INIT_MODE = mode;
    e = await rejects(paymentService.initializePayment({ studentId: 7 }));
    check(`P4  Paystack ${mode}: 502, the new row is closed as failed (no dangling pending)`, e && e.statusCode === 502 && rows().length === 1 && rows()[0].status === 'failed', e && e.message);
    INIT_MODE = 'ok';
    r = await paymentService.initializePayment({ studentId: 7 });
    check(`P4  after ${mode}: the student can try again (one failed + one pending)`, rows().length === 2 && rows().filter((p) => p.status === 'pending').length === 1 && !!r.authorization_url);
  }
  check('P4  provider error text is never shown to the student', !/Invalid key/.test(JSON.stringify(e && e.message)));

  /* ---------------- P5 idempotency / duplicate-payment protection ---------------- */
  reset();
  await paymentService.initializePayment({ studentId: 7 });
  const first = rows()[0].payment_reference;
  // student opened checkout but never paid -> Paystack says abandoned
  REMOTE[first] = { status: 'abandoned', amount: 30000000, currency: 'NGN', id: 1, channel: null };
  await paymentService.initializePayment({ studentId: 7 });
  check('P5  re-initialize after an unpaid attempt: old row closed as abandoned, exactly one pending row', rowByRef(first).status === 'abandoned' && rows().length === 2 && rows().filter((p) => p.status === 'pending').length === 1);

  reset();
  await paymentService.initializePayment({ studentId: 7 });
  const inflight = rows()[0].payment_reference;
  REMOTE[inflight] = { status: 'ongoing', amount: 30000000, currency: 'NGN', id: 1, channel: 'card' };
  e = await rejects(paymentService.initializePayment({ studentId: 7 }));
  check('P5  re-initialize while the earlier payment is still in progress -> 409, no second row', e && e.statusCode === 409 && /in progress/.test(e.message) && rows().length === 1 && INIT_CALLS.length === 1, e && e.message);

  reset();
  await paymentService.initializePayment({ studentId: 7 });
  const paidTab = rows()[0].payment_reference;
  paidAtProvider(paidTab); // student paid in another tab and never came back
  e = await rejects(paymentService.initializePayment({ studentId: 7 }));
  check('P5  student already paid but never returned: initialize settles it and refuses a second charge', e && e.statusCode === 409 && /already been paid/.test(e.message) && rowByRef(paidTab).status === 'success' && rows().length === 1 && INIT_CALLS.length === 1, e && e.message);

  reset();
  await paymentService.initializePayment({ studentId: 7 });
  paidAtProvider(rows()[0].payment_reference);
  await paymentService.verifyAndSettle(rows()[0].payment_reference, { studentId: 7 });
  const callsBefore = INIT_CALLS.length;
  e = await rejects(paymentService.initializePayment({ studentId: 7 }));
  check('P5  after a successful payment, initialize -> 409 already paid; no row, no Paystack call', e && e.statusCode === 409 && /already been paid/.test(e.message) && rows().length === 1 && INIT_CALLS.length === callsBefore);
  s = await paymentService.getPaymentStatus(7);
  check('P5  status now reports paid (not eligible, reason already_paid, paid details present)', !s.eligible && s.reason === 'already_paid' && s.paid.payment_reference === rows()[0].payment_reference && s.history.length === 1);

  reset(); // concurrent clicks: the second transaction sees the first pending row
  const concurrent = await Promise.all([paymentService.initializePayment({ studentId: 7 }).catch((x) => x), paymentService.initializePayment({ studentId: 7 }).catch((x) => x)]);
  const okCount = concurrent.filter((x) => x && x.authorization_url).length;
  const loser = concurrent.find((x) => x instanceof Error);
  check('P5  two simultaneous initialize calls (with serialised transactions): exactly one checkout, one pending row, the other gets 409',
    okCount === 1 && rows().length === 1 && rows()[0].status === 'pending' && loser && loser.statusCode === 409 && INIT_CALLS.length === 1, `ok=${okCount} rows=${rows().length}`);

  /* ---------------- P6 verify and settle ---------------- */
  reset();
  await paymentService.initializePayment({ studentId: 7 });
  const ref = rows()[0].payment_reference;
  paidAtProvider(ref);
  let v = await paymentService.verifyAndSettle(ref, { studentId: 7 });
  row = rowByRef(ref);
  check('P6  Paystack success + matching amount/currency/reference -> success, verified_at/paid_at set, gateway id + channel stored',
    v.status === 'success' && row.status === 'success' && row.verified_at && row.paid_at && row.gateway_reference === String(4099999 + row.id) && row.payment_channel === 'card', JSON.stringify(v));
  check('P6  provider was asked with OUR stored reference', VERIFY_CALLS[0] === ref);
  const n = VERIFY_CALLS.length;
  v = await paymentService.verifyAndSettle(ref, { studentId: 7 });
  const v2 = await paymentService.verifyAndSettle(ref, { studentId: 7 });
  check('P6  verifying again (refresh / double callback) is idempotent: still success, one row, no extra provider call', v.status === 'success' && v2.status === 'success' && VERIFY_CALLS.length === n && rows().length === 1 && rows().filter((p) => p.status === 'success').length === 1);

  const mismatches = [
    ['amount too low (provider says 100.00 NGN)', { amount: 10000 }],
    ['amount too high', { amount: 30000001 }],
    ['wrong currency (USD)', { currency: 'USD' }],
    ['amount sent as a string', { amount: '30000000' }],
    ['amount missing', { amount: undefined }],
  ];
  for (const [label, ov] of mismatches) {
    reset();
    await paymentService.initializePayment({ studentId: 7 });
    const rr = rows()[0].payment_reference;
    paidAtProvider(rr, ov);
    e = await rejects(paymentService.verifyAndSettle(rr, { studentId: 7 }));
    check(`P6  ${label} -> 409, payment NOT marked success, logged`, e && e.statusCode === 409 && /amount did not match/.test(e.message) && rowByRef(rr).status === 'pending' && errors.some((x) => /AMOUNT\/CURRENCY MISMATCH/.test(x)), e && e.message);
  }
  reset();
  await paymentService.initializePayment({ studentId: 7 });
  const rr0 = rows()[0].payment_reference;
  REMOTE[rr0] = { status: 'success', amount: 30000000, currency: 'NGN', id: 1, channel: 'card' };
  const realGet = fakeAxios.create;
  REMOTE[rr0].reference = 'SOMEONE-ELSE'; // provider answers about a different reference
  fakeAxios.create = (c) => { const cl = realGet(c); const g = cl.get; cl.get = async (u) => { const x = await g(u); x.data.data.reference = 'SOMEONE-ELSE'; return x; }; return cl; };
  e = await rejects(paymentService.verifyAndSettle(rr0, { studentId: 7 }));
  fakeAxios.create = realGet;
  check('P6  provider reference differs from ours -> 409, not success', e && e.statusCode === 409 && rowByRef(rr0).status === 'pending');

  for (const [pstatus, expected] of [['failed', 'failed'], ['reversed', 'failed'], ['abandoned', 'abandoned'], ['ongoing', 'pending'], ['pending', 'pending'], ['processing', 'pending'], ['queued', 'pending'], ['something-new', 'pending']]) {
    reset();
    await paymentService.initializePayment({ studentId: 7 });
    const rf = rows()[0].payment_reference;
    REMOTE[rf] = { status: pstatus, amount: 30000000, currency: 'NGN', id: 9, channel: 'card' };
    v = await paymentService.verifyAndSettle(rf, { studentId: 7 });
    check(`P6  provider status "${pstatus}" -> local "${expected}", never success`, v.status === expected && rowByRef(rf).status === expected && !rows().some((p) => p.status === 'success'));
  }
  reset();
  await paymentService.initializePayment({ studentId: 7 });
  const ru = rows()[0].payment_reference;
  REMOTE[ru] = 'unreachable';
  e = await rejects(paymentService.verifyAndSettle(ru, { studentId: 7 }));
  check('P6  Paystack unreachable -> 502, row unchanged (still pending, retryable)', e && e.statusCode === 502 && rowByRef(ru).status === 'pending');
  REMOTE[ru] = 'http500';
  e = await rejects(paymentService.verifyAndSettle(ru, { studentId: 7 }));
  check('P6  Paystack HTTP 500 -> 502, row unchanged', e && e.statusCode === 502 && rowByRef(ru).status === 'pending');
  delete REMOTE[ru]; // provider 404
  v = await paymentService.verifyAndSettle(ru, { studentId: 7 });
  check('P6  provider does not know the reference (404): stays pending on a normal check', v.status === 'pending' && rowByRef(ru).status === 'pending');

  reset();
  await paymentService.initializePayment({ studentId: 7 });
  const rl = rows()[0].payment_reference;
  REMOTE[rl] = { status: 'abandoned', amount: 30000000, currency: 'NGN', id: 9, channel: null };
  await paymentService.verifyAndSettle(rl, { studentId: 7 });
  paidAtProvider(rl); // the student finished paying later
  v = await paymentService.verifyAndSettle(rl, { studentId: 7 });
  check('P6  an "abandoned" attempt that is paid later is correctly settled as success', v.status === 'success' && rowByRef(rl).status === 'success');
  reset();
  await paymentService.initializePayment({ studentId: 7 });
  const rrf = rows()[0].payment_reference;
  rowByRef(rrf).status = 'refunded';
  paidAtProvider(rrf);
  v = await paymentService.verifyAndSettle(rrf, { studentId: 7 });
  check('P6  a refunded payment is never turned back into success', v.status === 'refunded' && rowByRef(rrf).status === 'refunded' && VERIFY_CALLS.length === 0);

  /* ---------------- P7 duplicate successful payment ---------------- */
  reset();
  await paymentService.initializePayment({ studentId: 7 });
  const a = rows()[0].payment_reference;
  // a second pending row for the same application (e.g. two tabs raced past every check)
  STATE.payments.push({ ...rows()[0], id: 900, payment_reference: 'LASU-HF-101-dup', status: 'pending' });
  paidAtProvider(a);
  REMOTE['LASU-HF-101-dup'] = { status: 'success', amount: 30000000, currency: 'NGN', id: 777, channel: 'card' };
  await paymentService.verifyAndSettle(a, { studentId: 7 });
  e = await rejects(paymentService.verifyAndSettle('LASU-HF-101-dup', { studentId: 7 }));
  check('P7  second paid transaction for the same application is NOT recorded as success (409, refund logged)',
    e && e.statusCode === 409 && /refund/.test(e.message) && rows().filter((p) => p.status === 'success').length === 1 && rowByRef('LASU-HF-101-dup').status === 'pending' &&
    errors.some((x) => /DUPLICATE PAID TRANSACTION.*REFUND MANUALLY/.test(x)), e && e.message);

  /* ---------------- P8 ownership ---------------- */
  reset();
  await paymentService.initializePayment({ studentId: 7 });
  const mine = rows()[0].payment_reference;
  paidAtProvider(mine);
  e = await rejects(paymentService.verifyAndSettle(mine, { studentId: 8 }));
  check("P8  student 8 cannot verify student 7's reference (404, no provider call, row untouched)", e && e.statusCode === 404 && VERIFY_CALLS.length === 0 && rowByRef(mine).status === 'pending');
  for (const bad of ['nope', '', 'x'.repeat(81), null, undefined, 123, { a: 1 }]) {
    e = await rejects(paymentService.verifyAndSettle(bad, { studentId: 7 }));
    check(`P8  unknown/invalid reference ${JSON.stringify(bad && String(bad).slice(0, 12))} -> 404`, e && e.statusCode === 404);
  }

  /* ---------------- H routes through the REAL app ---------------- */
  reset();
  let res = await call('GET', '/api/payments/status');
  check('H1  GET /status without login -> 401', res.status === 401);
  res = await call('POST', '/api/payments/initialize');
  check('H1  POST /initialize without login -> 401, nothing created', res.status === 401 && rows().length === 0);
  res = await call('POST', '/api/payments/verify', { body: { reference: 'abc' } });
  check('H1  POST /verify without login -> 401', res.status === 401);
  for (const [m, p] of [['GET', '/api/payments/status'], ['POST', '/api/payments/initialize'], ['POST', '/api/payments/verify']]) {
    res = await call(m, p, { user: admin, body: m === 'POST' ? { reference: 'abc' } : undefined });
    check(`H1  admin session on ${m} ${p} -> 403`, res.status === 403);
  }
  res = await call('GET', '/api/payments/status', { user: student(7) });
  check('H2  GET /status as student 7 -> 200 with the server-calculated fee', res.status === 200 && res.json.data.eligible && res.json.data.fee.amount === '300000.00', res.text.slice(0, 200));

  // the browser tries to dictate the payment
  res = await call('POST', '/api/payments/initialize', { user: student(7), body: { amount: '1.00', amount_minor: 100, currency: 'USD', application_id: 102, student_id: 8, hostel_fee_id: 17, status: 'success', email: 'evil@example.com' } });
  row = rows()[0];
  check('H3  POST /initialize ignores everything in the body: student 7, application 101, 300000.00 NGN, fee 14, own email',
    res.status === 201 && row.student_id === 7 && row.application_id === 101 && row.amount === '300000.00' && row.currency === 'NGN' && row.hostel_fee_id === 14 && row.status === 'pending' &&
    INIT_CALLS[0].amount === 30000000 && INIT_CALLS[0].email === 'ada@example.com', res.text.slice(0, 200));
  check('H3  response never contains the secret key or provider internals', !/sk_test|access_code|Bearer/.test(res.text) && /checkout\.paystack\.com/.test(res.json.data.authorization_url));

  const ref3 = row.payment_reference;
  REMOTE[ref3] = { status: 'abandoned', amount: 30000000, currency: 'NGN', id: 5, channel: null };
  res = await call('POST', '/api/payments/verify', { user: student(7), body: { reference: ref3, status: 'success', paid: true, amount: 30000000, trxref: ref3 } });
  check('H4  browser claiming "success" is irrelevant: provider says abandoned -> not success', res.status === 200 && res.json.data.status === 'abandoned' && rowByRef(ref3).status === 'abandoned');
  for (const bad of [undefined, '', '  ', 'a b', 'ab/../cd', "x'; DROP TABLE payments;--", 'x'.repeat(81), 12345, ['a']]) {
    res = await call('POST', '/api/payments/verify', { user: student(7), body: bad === undefined ? {} : { reference: bad } });
    check(`H4  invalid reference ${JSON.stringify(bad)} -> 400 (validator)`, res.status === 400, String(res.status));
  }
  paidAtProvider(ref3);
  res = await call('POST', '/api/payments/verify', { user: student(8), body: { reference: ref3 } });
  check("H4  another student verifying this reference -> 404", res.status === 404 && rowByRef(ref3).status === 'abandoned');
  res = await call('POST', '/api/payments/verify', { user: student(7), body: { reference: ref3 } });
  check('H4  owner verifies after paying -> 200 success', res.status === 200 && res.json.data.status === 'success' && res.json.data.payment.amount === '300000.00');

  /* ---------------- W webhook ---------------- */
  reset();
  await paymentService.initializePayment({ studentId: 7 });
  const wref = rows()[0].payment_reference;
  paidAtProvider(wref);
  const event = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: wref, amount: 1, status: 'success' } }));

  res = await call('POST', '/api/payments/webhook', { rawBody: event });
  check('W1  no signature header -> 401, nothing verified', res.status === 401 && VERIFY_CALLS.length === 0 && rowByRef(wref).status === 'pending');
  res = await call('POST', '/api/payments/webhook', { rawBody: event, headers: { 'x-paystack-signature': 'a'.repeat(128) } });
  check('W1  wrong signature -> 401', res.status === 401 && VERIFY_CALLS.length === 0);
  res = await call('POST', '/api/payments/webhook', { rawBody: event, headers: { 'x-paystack-signature': 'zz' } });
  check('W1  malformed signature -> 401', res.status === 401);
  const tampered = Buffer.from(event.toString().replace(wref, wref.toLowerCase().replace('lasu', 'LASU') + ' '));
  res = await call('POST', '/api/payments/webhook', { rawBody: tampered, headers: { 'x-paystack-signature': sign(event) } });
  check('W1  body altered after signing -> 401', res.status === 401 && VERIFY_CALLS.length === 0);
  const otherKey = crypto.createHmac('sha512', 'sk_test_other_key').update(event).digest('hex');
  res = await call('POST', '/api/payments/webhook', { rawBody: event, headers: { 'x-paystack-signature': otherKey } });
  check('W1  signature made with a different key -> 401', res.status === 401);
  res = await call('POST', '/api/payments/webhook', { rawBody: event, headers: { 'x-paystack-signature': sign(event) }, user: student(8) });
  check('W2  valid signature (no login needed) + charge.success -> 200, payment verified with Paystack and settled', res.status === 200 && rowByRef(wref).status === 'success' && VERIFY_CALLS.length === 1, String(res.status));
  res = await call('POST', '/api/payments/webhook', { rawBody: event, headers: { 'x-paystack-signature': sign(event) } });
  check('W2  same event delivered again -> 200, still exactly one success, no second provider call', res.status === 200 && rows().filter((p) => p.status === 'success').length === 1 && VERIFY_CALLS.length === 1);

  reset();
  await paymentService.initializePayment({ studentId: 7 });
  const wref2 = rows()[0].payment_reference;
  REMOTE[wref2] = { status: 'abandoned', amount: 30000000, currency: 'NGN', id: 5, channel: null };
  const lie = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: wref2, amount: 30000000, status: 'success' } }));
  res = await call('POST', '/api/payments/webhook', { rawBody: lie, headers: { 'x-paystack-signature': sign(lie) } });
  check('W3  signed event claiming success but Paystack says abandoned -> not success', res.status === 200 && rowByRef(wref2).status === 'abandoned');
  for (const [label, obj] of [['other event type', { event: 'transfer.success', data: { reference: wref2 } }], ['unknown reference', { event: 'charge.success', data: { reference: 'NOT-OURS-1' } }], ['no data', { event: 'charge.success' }], ['non-string reference', { event: 'charge.success', data: { reference: 42 } }]]) {
    const b = Buffer.from(JSON.stringify(obj));
    const before = VERIFY_CALLS.length;
    res = await call('POST', '/api/payments/webhook', { rawBody: b, headers: { 'x-paystack-signature': sign(b) } });
    check(`W3  signed ${label} -> 200 acknowledged and ignored`, res.status === 200 && (label === 'other event type' || label === 'no data' || label === 'non-string reference' ? VERIFY_CALLS.length === before : true));
  }
  reset();
  await paymentService.initializePayment({ studentId: 7 });
  const wref3 = rows()[0].payment_reference;
  const ev3 = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: wref3 } }));
  REMOTE[wref3] = 'unreachable';
  res = await call('POST', '/api/payments/webhook', { rawBody: ev3, headers: { 'x-paystack-signature': sign(ev3) } });
  check('W4  Paystack unreachable during a webhook -> 5xx so Paystack retries later; row unchanged', res.status === 502 && rowByRef(wref3).status === 'pending', String(res.status));
  paidAtProvider(wref3, { amount: 5 });
  res = await call('POST', '/api/payments/webhook', { rawBody: ev3, headers: { 'x-paystack-signature': sign(ev3) } });
  check('W4  amount mismatch during a webhook -> 200 (permanent, logged), NOT marked success', res.status === 200 && rowByRef(wref3).status === 'pending' && errors.some((x) => /webhook acknowledged with error/.test(x)));
  res = await call('POST', '/api/payments/webhook', { rawBody: Buffer.from('not json'), headers: { 'x-paystack-signature': sign(Buffer.from('not json')) } });
  check('W4  unparsable body is rejected (not 2xx) and changes nothing (note: malformed JSON answers 500 app-wide - existing errorMiddleware behaviour, unchanged)',
    res.status >= 400 && rows().every((p) => p.status !== 'success'), String(res.status));

  /* ---------------- S security / hygiene ---------------- */
  const csp = (await call('GET', '/api/health')).headers['content-security-policy'] || '';
  check('S1  CSP unchanged: scripts only self+cdnjs (no inline, no js.paystack.co), frames allow checkout.paystack.com, connect self',
    /script-src 'self' https:\/\/cdnjs\.cloudflare\.com(;|$)/.test(csp) && /frame-src 'self' https:\/\/checkout\.paystack\.com/.test(csp) && /connect-src 'self'(;|$)/.test(csp) && !/js\.paystack\.co/.test(csp), csp);
  const pageRes = await call('GET', '/student/payment.html');
  const cbRes = await call('GET', '/student/payment-callback.html');
  check('S1  both payment pages are served and contain no inline <script> and no Paystack key',
    pageRes.status === 200 && cbRes.status === 200 && ![pageRes.text, cbRes.text].some((t) => /<script(?![^>]*\ssrc=)/i.test(t) || /pk_(test|live)|sk_(test|live)/.test(t)), `${pageRes.status}/${cbRes.status}`);
  const fs = require('fs');
  const clientJs = fs.readFileSync(path.join(backend, '..', 'frontend', 'js', 'payment.js'), 'utf8');
  check('S1  payment.js: sends no amount/currency, holds no key, no js.paystack.co, no eval/innerHTML of raw input',
    !/PAYSTACK|pk_|sk_|js\.paystack\.co|eval\(|new Function/.test(clientJs) && /api\.post\('\/payments\/initialize'\)/.test(clientJs) && /api\.post\('\/payments\/verify', \{ reference \}\)/.test(clientJs));
  const srcAll = ['services/paystackService.js', 'services/paymentService.js', 'controllers/paymentController.js']
    .map((f) => fs.readFileSync(path.join(backend, f), 'utf8')).join('\n');
  const logLines = srcAll.split('\n').filter((l) => /console\.(log|error|warn)/.test(l));
  const leaky = (l) => /\$\{[^}]*(secretKey|process\.env|req\.body|Authorization|signature)[^}]*\}/.test(l) || /\+\s*(secretKey|process\.env|req\.body)/.test(l);
  check('S1  no log statement interpolates the key, env, the Authorization header, the signature or a request body', !logLines.some(leaky), logLines.find(leaky));
  check('S1  the secret key is read in exactly one module (paystackService) and nowhere in controllers/payment service', /PAYSTACK_SECRET_KEY/.test(fs.readFileSync(path.join(backend, 'services/paystackService.js'), 'utf8')) && !/PAYSTACK_SECRET_KEY/.test(fs.readFileSync(path.join(backend, 'services/paymentService.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')) && !/PAYSTACK_SECRET_KEY/.test(fs.readFileSync(path.join(backend, 'controllers/paymentController.js'), 'utf8')));
  check('S1  server never reads amount/currency/application from req.body', !/req\.body\.(amount|currency|application|student|fee)/i.test(fs.readFileSync(path.join(backend, 'controllers/paymentController.js'), 'utf8')));
  check('S1  no bare session_id in the payment code', !/(?<!hostel_)\bsession_id\b/.test(srcAll.replace(/\/\*[\s\S]*?\*\//g, '')));
  check('S1  every payment SQL statement was parameterised (fake DB enforces placeholders == params)', EXECUTED.length > 0);

  console.error = origError;
  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error = origError; console.error('TEST HARNESS ERROR:', err); process.exit(2); });

var e; // shared scratch variable used by the checks above
