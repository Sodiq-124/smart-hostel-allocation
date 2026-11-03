/**
 * tests/phase9c_misc_unit.js - miscellaneous-charge payments
 *
 * Runs WITHOUT a database and WITHOUT network access (application-level only):
 *   - config/database is replaced by an in-memory fake that understands the SQL of
 *     paymentService / miscPaymentService / miscChargeService and enforces the table rules
 *     that matter (unique reference, ck_payments_type_links, ck_payments_amount_breakdown,
 *     one successful HOSTEL payment per application+session, one successful MISC payment per
 *     application+session+charge).
 *   - axios is replaced by a scripted fake Paystack; the REAL paystackService runs.
 *   - the REAL app.js (Helmet, raw-body capture, router, validators, auth middleware) is loaded.
 *
 * It proves the application LOGIC and HTTP wiring. It does NOT prove the SQL is valid MariaDB
 * (that needs the user's own database run), nor that Paystack accepts the requests.
 *
 *   node tests/phase9c_misc_unit.js
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
async function rejects(promise) { try { await promise; } catch (e) { return e; } return null; }

const { decimalToMinor } = require(resolve('utils/money'));
const { computeMiscAmount } = require(resolve('utils/lateFine'));

/* ===================================================================
   In-memory database
   =================================================================== */
let STATE;
let MISC_SCHEMA; // 'ok' | 'missing'
let EXECUTED;

function freshState() {
  return {
    now: '2026-11-01 12:00:00', // the fake database clock (NOW())
    sessions: [
      { id: 1, label: '2025/2026', status: 'closed', is_current: 0 },
      { id: 2, label: '2026/2027', status: 'open', is_current: 1 },
      { id: 3, label: '2027/2028', status: 'upcoming', is_current: 0 },
    ],
    users: {
      7: { email: 'ada@example.com', role: 'student', is_active: 1 },
      8: { email: 'bola@example.com', role: 'student', is_active: 1 },
      11: { email: 'eze@example.com', role: 'student', is_active: 1 },
      12: { email: 'femi@example.com', role: 'student', is_active: 1 },
      13: { email: 'gbenga@example.com', role: 'student', is_active: 1 },
    },
    fees: [
      { id: 14, block_id: 1, hostel_session_id: 2, amount: '300000.00', currency: 'NGN', active: 1 },
      { id: 15, block_id: 2, hostel_session_id: 2, amount: '250000.00', currency: 'NGN', active: 1 },
      { id: 16, block_id: 3, hostel_session_id: 2, amount: '200000.00', currency: 'NGN', active: 1 },
    ],
    blocks: { 1: 'Block A', 2: 'Block B', 3: 'Block C', 4: 'Block D' },
    rooms: { 24: { id: 24, room_number: 'R001', room_type: 'single', block_id: 1 }, 30: { id: 30, room_number: 'R101', room_type: 'shared', block_id: 2 } },
    applications: [
      { id: 101, student_id: 7, status: 'approved', allocated_room_id: 24, hostel_session_id: 2, applied_at: 5 },
      { id: 102, student_id: 8, status: 'approved', allocated_room_id: 30, hostel_session_id: 2, applied_at: 5 },
      { id: 105, student_id: 11, status: 'approved', allocated_room_id: null, hostel_session_id: 2, applied_at: 5, fee_block_id: 3 },
      { id: 106, student_id: 12, status: 'pending', allocated_room_id: null, hostel_session_id: 2, applied_at: 5 },
      { id: 107, student_id: 13, status: 'approved', allocated_room_id: 24, hostel_session_id: 1, applied_at: 1 },
    ],
    allocations: [
      { id: 201, application_id: 101, student_id: 7, room_id: 24, hostel_session_id: 2, status: 'active' },
      { id: 202, application_id: 102, student_id: 8, room_id: 30, hostel_session_id: 2, status: 'active' },
      { id: 207, application_id: 107, student_id: 13, room_id: 24, hostel_session_id: 1, status: 'active' },
    ],
    charges: [
      { id: 1, hostel_session_id: 2, block_id: null, name: 'Caution fee', description: 'Refundable', amount: '5000.00', currency: 'NGN', is_required: 1, is_active: 1, deadline_at: null, late_fine_amount: '0.00', created_by: 1 },
      { id: 2, hostel_session_id: 2, block_id: 1, name: 'Block A generator levy', description: null, amount: '12000.50', currency: 'NGN', is_required: 0, is_active: 1, deadline_at: '2026-11-30 23:59:00', late_fine_amount: '1500.00', created_by: 1 },
      { id: 3, hostel_session_id: 2, block_id: 2, name: 'Block B water levy', description: null, amount: '3000.00', currency: 'NGN', is_required: 0, is_active: 1, deadline_at: null, late_fine_amount: '0.00', created_by: 1 },
      { id: 4, hostel_session_id: 2, block_id: null, name: 'Inactive charge', description: null, amount: '100.00', currency: 'NGN', is_required: 0, is_active: 0, deadline_at: null, late_fine_amount: '0.00', created_by: 1 },
      { id: 5, hostel_session_id: 1, block_id: null, name: 'Old-session charge', description: null, amount: '900.00', currency: 'NGN', is_required: 0, is_active: 1, deadline_at: null, late_fine_amount: '0.00', created_by: 1 },
      { id: 6, hostel_session_id: 2, block_id: 3, name: 'Block C levy', description: null, amount: '2500.00', currency: 'NGN', is_required: 0, is_active: 1, deadline_at: null, late_fine_amount: '0.00', created_by: 1 },
    ],
    payments: [],
    nextPayment: 500,
    nextCharge: 100,
  };
}

function dbError(code, message) { const e = new Error(message); e.code = code; return e; }
const sessionOf = (id) => STATE.sessions.find((x) => x.id === id);
const pastDeadline = (c) => (c.deadline_at && STATE.now > c.deadline_at ? 1 : 0);

function chargeRow(c) { return { ...c, block_name: c.block_id ? STATE.blocks[c.block_id] : null, past_deadline: pastDeadline(c) }; }

function adminChargeRow(c) {
  const mine = STATE.payments.filter((p) => p.hostel_misc_charge_id === c.id);
  const sess = sessionOf(c.hostel_session_id);
  const sum = mine.filter((p) => p.status === 'success').reduce((a, p) => a + decimalToMinor(p.amount), 0);
  return {
    ...c, session_label: sess.label, session_status: sess.status, block_name: c.block_id ? STATE.blocks[c.block_id] : null,
    created_at: 't', updated_at: 't',
    payments_total: mine.length, paid_count: mine.filter((p) => p.status === 'success').length,
    pending_count: mine.filter((p) => p.status === 'pending').length,
    collected_total: (sum / 100).toFixed(2),
  };
}

// one successful hostel payment per application+session; one successful misc payment per application+session+charge
function successKeyTaken(row) {
  return STATE.payments.some((p) => p.id !== row.id && p.status === 'success' &&
    p.application_id === row.application_id && p.hostel_session_id === row.hostel_session_id &&
    p.payment_type === row.payment_type &&
    (row.payment_type !== 'miscellaneous' || p.hostel_misc_charge_id === row.hostel_misc_charge_id));
}

const PAY_COLS = ['id', 'student_id', 'application_id', 'hostel_session_id', 'hostel_fee_id', 'amount', 'currency',
  'payment_reference', 'gateway_reference', 'payment_gateway', 'payment_channel', 'status', 'verified_at', 'paid_at', 'created_at',
  'payment_type', 'hostel_misc_charge_id', 'original_amount', 'late_fine_applied'];

async function execute(sqlRaw, params = []) {
  const sql = sqlRaw.replace(/\s+/g, ' ').trim();
  const S = STATE;
  const qm = (sql.match(/\?/g) || []).length;
  if (qm !== params.length) throw new Error(`FAKE DB: ${qm} placeholders but ${params.length} params: ${sql}`);
  EXECUTED.push(sql);
  let m;

  if (/^SELECT COLUMN_NAME AS column_name FROM information_schema\.COLUMNS WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME = 'payments'/.test(sql)) {
    return [PAY_COLS.map((c) => ({ column_name: c })), []];
  }
  if (/^SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, IS_NULLABLE AS is_nullable FROM information_schema\.COLUMNS/.test(sql)) {
    if (MISC_SCHEMA === 'missing') return [[{ table_name: 'payments', column_name: 'hostel_fee_id', is_nullable: 'NO' }], []];
    const chargeCols = ['id', 'hostel_session_id', 'block_id', 'name', 'description', 'amount', 'currency', 'is_required', 'is_active', 'created_by', 'deadline_at', 'late_fine_amount'];
    return [[
      ...chargeCols.map((c) => ({ table_name: 'hostel_misc_charges', column_name: c, is_nullable: 'YES' })),
      ...PAY_COLS.map((c) => ({ table_name: 'payments', column_name: c, is_nullable: c === 'hostel_fee_id' ? 'YES' : 'NO' })),
    ], []];
  }
  if (/^SELECT id, label FROM hostel_sessions WHERE is_current = 1 AND status = 'open' LIMIT 1 LOCK IN SHARE MODE$/.test(sql)) {
    return [S.sessions.filter((x) => x.is_current === 1 && x.status === 'open').map((x) => ({ id: x.id, label: x.label })), []];
  }
  if (/^SELECT id, student_id, status, allocated_room_id, hostel_session_id FROM applications WHERE student_id = \? AND hostel_session_id = \? ORDER BY applied_at DESC, id DESC LIMIT 1( FOR UPDATE)?$/.test(sql)) {
    return [S.applications.filter((a) => a.student_id === params[0] && a.hostel_session_id === params[1])
      .sort((a, b) => b.applied_at - a.applied_at || b.id - a.id).slice(0, 1).map(({ applied_at, fee_block_id, ...a }) => a), []];
  }
  // ---- misc student context ----
  if (/^SELECT r\.block_id AS block_id, b\.name AS block_name FROM allocations al JOIN rooms r ON r\.id = al\.room_id JOIN blocks b ON b\.id = r\.block_id WHERE al\.application_id = \? AND al\.hostel_session_id = \? AND al\.status = 'active'$/.test(sql)) {
    return [S.allocations.filter((a) => a.application_id === params[0] && a.hostel_session_id === params[1] && a.status === 'active')
      .map((a) => ({ block_id: S.rooms[a.room_id].block_id, block_name: S.blocks[S.rooms[a.room_id].block_id] })), []];
  }
  if (/^SELECT a\.fee_block_id AS block_id, b\.name AS block_name FROM applications a LEFT JOIN blocks b ON b\.id = a\.fee_block_id WHERE a\.id = \?$/.test(sql)) {
    const a = S.applications.find((x) => x.id === params[0]);
    return [a ? [{ block_id: a.fee_block_id === undefined ? null : a.fee_block_id, block_name: a.fee_block_id ? S.blocks[a.fee_block_id] : null }] : [], []];
  }
  // ---- feeService (hostel regression path) ----
  if (/^SELECT id, student_id, status, allocated_room_id, hostel_session_id FROM applications WHERE id = \? LOCK IN SHARE MODE$/.test(sql)) {
    return [S.applications.filter((a) => a.id === params[0]).map(({ applied_at, fee_block_id, ...a }) => a), []];
  }
  if (/^SELECT id, application_id, student_id, room_id, hostel_session_id FROM allocations WHERE application_id = \? AND hostel_session_id = \? AND status = 'active' LOCK IN SHARE MODE$/.test(sql)) {
    return [S.allocations.filter((a) => a.application_id === params[0] && a.hostel_session_id === params[1] && a.status === 'active').map((a) => ({ ...a })), []];
  }
  if (/^SELECT r\.id AS room_id, r\.room_number, r\.room_type, r\.block_id, b\.name AS block_name FROM rooms r JOIN blocks b ON b\.id = r\.block_id WHERE r\.id = \?$/.test(sql)) {
    const r = S.rooms[params[0]];
    return [r ? [{ room_id: r.id, room_number: r.room_number, room_type: r.room_type, block_id: r.block_id, block_name: S.blocks[r.block_id] }] : [], []];
  }
  if (/^SELECT id, hostel_session_id, block_id, amount, currency FROM hostel_fees WHERE hostel_session_id = \? AND block_id = \? AND active = 1 LOCK IN SHARE MODE$/.test(sql)) {
    return [S.fees.filter((f) => f.hostel_session_id === params[0] && f.block_id === params[1] && f.active === 1).map((f) => ({ ...f })), []];
  }
  // ---- student charge queries ----
  if (/^SELECT c\.id, c\.name, c\.description, c\.amount, c\.currency, c\.is_required, c\.deadline_at, c\.late_fine_amount, c\.block_id, b\.name AS block_name, \(c\.deadline_at IS NOT NULL AND NOW\(\) > c\.deadline_at\) AS past_deadline FROM hostel_misc_charges c LEFT JOIN blocks b ON b\.id = c\.block_id WHERE c\.hostel_session_id = \? AND c\.is_active = 1 AND \(c\.block_id IS NULL OR c\.block_id = \?\) ORDER BY c\.is_required DESC, c\.id ASC$/.test(sql)) {
    return [S.charges.filter((c) => c.hostel_session_id === params[0] && c.is_active === 1 && (c.block_id === null || c.block_id === params[1]))
      .sort((a, b) => b.is_required - a.is_required || a.id - b.id).map(chargeRow), []];
  }
  if (/^SELECT c\.id, c\.name, .* WHERE c\.id = \? AND c\.hostel_session_id = \? AND c\.is_active = 1 AND \(c\.block_id IS NULL OR c\.block_id = \?\) LOCK IN SHARE MODE$/.test(sql)) {
    return [S.charges.filter((c) => c.id === params[0] && c.hostel_session_id === params[1] && c.is_active === 1 && (c.block_id === null || c.block_id === params[2])).map(chargeRow), []];
  }
  if (/^SELECT hostel_misc_charge_id, status, payment_reference, amount, original_amount, late_fine_applied, currency, paid_at, created_at FROM payments WHERE application_id = \? AND hostel_session_id = \? AND payment_type = 'miscellaneous' ORDER BY id DESC$/.test(sql)) {
    return [S.payments.filter((p) => p.application_id === params[0] && p.hostel_session_id === params[1] && p.payment_type === 'miscellaneous').sort((a, b) => b.id - a.id).map((p) => ({ ...p })), []];
  }
  if (/^SELECT p\.payment_type, p\.payment_reference, p\.status, p\.amount, p\.original_amount, p\.late_fine_applied, p\.currency, p\.paid_at, p\.created_at, hs\.label AS session_label, c\.name AS charge_name FROM payments p JOIN hostel_sessions hs/.test(sql)) {
    return [S.payments.filter((p) => p.student_id === params[0]).sort((a, b) => b.id - a.id).slice(0, 100).map((p) => ({
      ...p, session_label: sessionOf(p.hostel_session_id).label,
      charge_name: p.hostel_misc_charge_id ? S.charges.find((c) => c.id === p.hostel_misc_charge_id).name : null })), []];
  }
  if ((m = /^SELECT payment_reference FROM payments WHERE application_id = \? AND hostel_session_id = \? AND payment_type = 'miscellaneous' AND hostel_misc_charge_id = \? AND status = 'pending' ORDER BY id DESC LIMIT 5$/.exec(sql))) {
    return [S.payments.filter((p) => p.application_id === params[0] && p.hostel_session_id === params[1] && p.payment_type === 'miscellaneous' && p.hostel_misc_charge_id === params[2] && p.status === 'pending').sort((a, b) => b.id - a.id).map((p) => ({ payment_reference: p.payment_reference })), []];
  }
  if ((m = /^SELECT id FROM payments WHERE application_id = \? AND hostel_session_id = \? AND payment_type = 'miscellaneous' AND hostel_misc_charge_id = \? AND status = '(success|pending)' LIMIT 1$/.exec(sql))) {
    return [S.payments.filter((p) => p.application_id === params[0] && p.hostel_session_id === params[1] && p.payment_type === 'miscellaneous' && p.hostel_misc_charge_id === params[2] && p.status === m[1]).slice(0, 1).map((p) => ({ id: p.id })), []];
  }
  // ---- hostel payment queries (typed) ----
  if (/^SELECT payment_reference, amount, currency, paid_at FROM payments WHERE application_id = \? AND hostel_session_id = \? AND status = 'success' AND payment_type = 'hostel' LIMIT 1$/.test(sql)) {
    return [S.payments.filter((p) => p.application_id === params[0] && p.hostel_session_id === params[1] && p.status === 'success' && p.payment_type === 'hostel').slice(0, 1).map((p) => ({ ...p })), []];
  }
  if (/^SELECT payment_reference, status, amount, currency, paid_at, created_at FROM payments WHERE application_id = \? AND hostel_session_id = \? AND payment_type = 'hostel' ORDER BY id DESC LIMIT 5$/.test(sql)) {
    return [S.payments.filter((p) => p.application_id === params[0] && p.hostel_session_id === params[1] && p.payment_type === 'hostel').sort((a, b) => b.id - a.id).slice(0, 5).map((p) => ({ ...p })), []];
  }
  if (/^SELECT payment_reference FROM payments WHERE application_id = \? AND hostel_session_id = \? AND status = 'pending' AND payment_type = 'hostel' ORDER BY id DESC LIMIT 5$/.test(sql)) {
    return [S.payments.filter((p) => p.application_id === params[0] && p.hostel_session_id === params[1] && p.status === 'pending' && p.payment_type === 'hostel').map((p) => ({ payment_reference: p.payment_reference })), []];
  }
  if (/^SELECT id FROM payments WHERE application_id = \? AND hostel_session_id = \? AND status = 'pending' AND payment_type = 'hostel' LIMIT 1$/.test(sql)) {
    return [S.payments.filter((p) => p.application_id === params[0] && p.hostel_session_id === params[1] && p.status === 'pending' && p.payment_type === 'hostel').slice(0, 1).map((p) => ({ id: p.id })), []];
  }
  if (/^SELECT fee_block_id FROM applications WHERE id = \?$/.test(sql)) {
    const a = S.applications.find((x) => x.id === params[0]);
    return [a ? [{ fee_block_id: a.fee_block_id === undefined ? null : a.fee_block_id }] : [], []];
  }
  if (/^SELECT id, name FROM blocks WHERE id = \?$/.test(sql)) {
    return [S.blocks[params[0]] ? [{ id: params[0], name: S.blocks[params[0]] }] : [], []];
  }
  if (/^SELECT email FROM users WHERE id = \? AND role = 'student' AND is_active = 1$/.test(sql)) {
    const u = S.users[params[0]];
    return [u && u.is_active === 1 ? [{ email: u.email }] : [], []];
  }
  // ---- settlement ----
  if (/^SELECT id, student_id, application_id, hostel_session_id, amount, currency, payment_reference, status, paid_at, payment_type, hostel_misc_charge_id, original_amount FROM payments WHERE payment_reference = \?$/.test(sql)) {
    return [S.payments.filter((p) => p.payment_reference === params[0]).map((p) => ({ ...p })), []];
  }
  if (/^SELECT id, hostel_session_id, amount, currency FROM hostel_misc_charges WHERE id = \?$/.test(sql)) {
    return [S.charges.filter((c) => c.id === params[0]).map((c) => ({ ...c })), []];
  }
  if (/^SELECT id, student_id, hostel_session_id FROM applications WHERE id = \?$/.test(sql)) {
    return [S.applications.filter((a) => a.id === params[0]).map((a) => ({ id: a.id, student_id: a.student_id, hostel_session_id: a.hostel_session_id })), []];
  }
  if ((m = /^INSERT INTO payments \(([^)]+)\) VALUES \(([?, ]+)\)$/.exec(sql))) {
    const cols = m[1].split(',').map((c) => c.trim());
    if (cols.length !== params.length) throw new Error('FAKE DB: column/param count');
    const row = { status: 'pending', gateway_reference: null, payment_channel: null, verified_at: null, paid_at: null, created_at: 'now', hostel_fee_id: null, hostel_misc_charge_id: null, id: S.nextPayment++ };
    cols.forEach((c, i) => { row[c] = params[i]; });
    for (const c of cols) if (!PAY_COLS.includes(c)) throw dbError('ER_BAD_FIELD_ERROR', `Unknown column '${c}'`);
    for (const c of ['student_id', 'application_id', 'hostel_session_id', 'amount', 'currency', 'payment_reference']) {
      if (row[c] === undefined || row[c] === null) throw dbError('ER_NO_DEFAULT_FOR_FIELD', `${c} cannot be null`);
    }
    if (S.payments.some((p) => p.payment_reference === row.payment_reference)) throw dbError('ER_DUP_ENTRY', 'uq_payment_reference');
    // ck_payments_type_links
    if (row.payment_type === 'hostel') {
      if (row.hostel_fee_id === null || row.hostel_misc_charge_id !== null || decimalToMinor(row.late_fine_applied, 'NGN', { allowZero: true }) !== 0) throw dbError('ER_CONSTRAINT_FAILED', 'ck_payments_type_links');
    } else if (row.payment_type === 'miscellaneous') {
      if (row.hostel_fee_id !== null || row.hostel_misc_charge_id === null) throw dbError('ER_CONSTRAINT_FAILED', 'ck_payments_type_links');
      if (!S.charges.some((c) => c.id === row.hostel_misc_charge_id)) throw dbError('ER_NO_REFERENCED_ROW_2', 'fk_payments_misc_charge');
    } else throw dbError('ER_CONSTRAINT_FAILED', 'payment_type');
    if (decimalToMinor(row.amount) !== decimalToMinor(row.original_amount, 'NGN', { allowZero: true }) + decimalToMinor(row.late_fine_applied, 'NGN', { allowZero: true })) throw dbError('ER_CONSTRAINT_FAILED', 'ck_payments_amount_breakdown');
    if (decimalToMinor(row.amount) <= 0) throw dbError('ER_CONSTRAINT_FAILED', 'ck_payments_amount_positive');
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
    if (successKeyTaken(p)) throw dbError('ER_DUP_ENTRY', "Duplicate entry for key 'uq_successful_misc_payment'");
    Object.assign(p, { status: 'success', gateway_reference: params[0], payment_channel: params[1], verified_at: 'now', paid_at: 'now' });
    return [{ affectedRows: 1 }, []];
  }
  // ---- admin charge management ----
  if (/^SELECT id, label, status, is_current FROM hostel_sessions ORDER BY id DESC$/.test(sql)) return [S.sessions.slice().reverse().map((x) => ({ ...x })), []];
  if (/^SELECT id, name, is_active FROM blocks ORDER BY name$/.test(sql)) return [Object.entries(S.blocks).map(([id, name]) => ({ id: Number(id), name, is_active: 1 })), []];
  if (/^SELECT c\.id, c\.hostel_session_id, hs\.label AS session_label/.test(sql)) {
    let list = S.charges;
    if (/WHERE c\.hostel_session_id = \?/.test(sql)) list = list.filter((c) => c.hostel_session_id === params[0]);
    else if (/WHERE c\.id = \?/.test(sql)) list = list.filter((c) => c.id === params[0]);
    return [list.slice().sort((a, b) => b.hostel_session_id - a.hostel_session_id || b.id - a.id).map(adminChargeRow), []];
  }
  if (/^SELECT id, label, status FROM hostel_sessions WHERE id = \? LOCK IN SHARE MODE$/.test(sql) || /^SELECT label, status FROM hostel_sessions WHERE id = \? LOCK IN SHARE MODE$/.test(sql)) {
    return [S.sessions.filter((x) => x.id === params[0]).map((x) => ({ ...x })), []];
  }
  if (/^INSERT INTO hostel_misc_charges \(hostel_session_id, block_id, name, description, amount, currency, is_required, is_active, deadline_at, late_fine_amount, created_by\) VALUES/.test(sql)) {
    const [hostel_session_id, block_id, name, description, amount, currency, is_required, is_active, deadline_at, late_fine_amount, created_by] = params;
    if (decimalToMinor(amount) <= 0) throw dbError('ER_CONSTRAINT_FAILED', 'ck_misc_charges_amount');
    const row = { id: S.nextCharge++, hostel_session_id, block_id, name, description, amount, currency, is_required, is_active, deadline_at, late_fine_amount, created_by };
    S.charges.push(row);
    return [{ insertId: row.id, affectedRows: 1 }, []];
  }
  if (/^SELECT id, hostel_session_id, block_id, amount, deadline_at, late_fine_amount FROM hostel_misc_charges WHERE id = \? FOR UPDATE$/.test(sql)) {
    return [S.charges.filter((c) => c.id === params[0]).map((c) => ({ ...c })), []];
  }
  if (/^SELECT COUNT\(\*\) AS n FROM payments WHERE hostel_misc_charge_id = \?$/.test(sql)) {
    return [[{ n: S.payments.filter((p) => p.hostel_misc_charge_id === params[0]).length }], []];
  }
  if ((m = /^UPDATE hostel_misc_charges SET (.+) WHERE id = \?$/.exec(sql)) && !/is_active = \?$/.test(m[1])) {
    const keys = m[1].split(',').map((x) => x.trim().replace(' = ?', ''));
    const c = S.charges.find((x) => x.id === params[params.length - 1]);
    keys.forEach((k, i) => { c[k] = params[i]; });
    return [{ affectedRows: 1 }, []];
  }
  if (/^SELECT id, hostel_session_id, is_active FROM hostel_misc_charges WHERE id = \? FOR UPDATE$/.test(sql)) {
    return [S.charges.filter((c) => c.id === params[0]).map((c) => ({ ...c })), []];
  }
  if (/^UPDATE hostel_misc_charges SET is_active = \? WHERE id = \?$/.test(sql)) {
    S.charges.find((c) => c.id === params[1]).is_active = params[0];
    return [{ affectedRows: 1 }, []];
  }
  throw new Error(`FAKE DB: unexpected SQL: ${sql}`);
}

const fakeConn = { execute };
let txTail = Promise.resolve();
function withTransaction(cb) {
  const run = txTail.then(async () => {
    const snap = JSON.parse(JSON.stringify({ p: STATE.payments, c: STATE.charges }));
    try { return await cb(fakeConn); } catch (e) { STATE.payments = snap.p; STATE.charges = snap.c; throw e; }
  });
  txTail = run.catch(() => {});
  return run;
}
// queryOne answers the per-request role/activity re-check in middleware/authMiddleware.js: id 1 is the admin, every other id a student.
const userLookup = async (sql, p) => (/FROM users WHERE id = \?/.test(sql) ? { role: Number(p[0]) === 1 ? 'admin' : 'student', is_active: 1 } : null);
stub(resolve('config/database'), { pool: fakeConn, query: async () => [], queryOne: userLookup, withTransaction, testConnection: async () => true });

/* ===================================================================
   Fake Paystack
   =================================================================== */
let REMOTE; let INIT_CALLS; let VERIFY_CALLS;
const fakeAxios = {
  create() {
    return {
      async post(url, body) {
        INIT_CALLS.push(body);
        return { status: 200, data: { status: true, data: { authorization_url: `https://checkout.paystack.com/${body.reference}`, access_code: 'ac', reference: body.reference } } };
      },
      async get(url) {
        const ref = decodeURIComponent(url.replace('/transaction/verify/', ''));
        VERIFY_CALLS.push(ref);
        const r = REMOTE[ref];
        if (!r) return { status: 404, data: { status: false, message: 'not found' } };
        return { status: 200, data: { status: true, data: { reference: ref, ...r } } };
      },
    };
  },
};
stub('axios', fakeAxios);
stub('morgan', () => (req, res, next) => next());
stub('bcrypt', { hash: async () => 'x', compare: async () => false });
stub(resolve('config/session'), (req, res, next) => {
  const u = req.headers['x-test-user'];
  req.session = u ? { user: JSON.parse(u) } : {};
  next();
});

const paymentService = require(resolve('services/paymentService'));
const miscPayments = require(resolve('services/miscPaymentService'));
const { resetMiscSchemaCache } = require(resolve('services/miscSchema'));
const { assertHostelFeePaid } = require(resolve('services/paymentGate'));
const app = require(resolve('app'));

function reset() {
  STATE = freshState(); MISC_SCHEMA = 'ok'; EXECUTED = [];
  REMOTE = {}; INIT_CALLS = []; VERIFY_CALLS = [];
  paymentService.resetSchemaCache(); resetMiscSchemaCache();
}
const rows = () => STATE.payments;
const rowByRef = (ref) => STATE.payments.find((p) => p.payment_reference === ref);
function paidAtProvider(ref, overrides = {}) {
  const row = rowByRef(ref);
  REMOTE[ref] = { status: 'success', amount: decimalToMinor(row.amount), currency: row.currency, id: 5000000 + row.id, channel: 'card', ...overrides };
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
        resolveP({ status: res.statusCode, json, text });
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
console.error = (...a) => { errors.push(a.join(' ')); };
const logs = console.log.bind(console);

(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  let r; let e; let row; let res;

  /* ================= L: pure late-fine arithmetic ================= */
  const ch = { amount: '5000.00', late_fine_amount: '500.00', currency: 'NGN' };
  let a = computeMiscAmount(ch, false);
  check('L1  on time: total = amount, no fine', a.total === '5000.00' && a.fine === '0.00' && a.late === false && a.total_minor === 500000);
  a = computeMiscAmount(ch, true);
  check('L2  late: total = amount + fixed fine (5500.00, 550000 kobo), original preserved', a.total === '5500.00' && a.original === '5000.00' && a.fine === '500.00' && a.late && a.total_minor === 550000);
  a = computeMiscAmount({ ...ch, late_fine_amount: '0.00' }, true);
  check('L3  late but fine is 0 -> no fine, still payable', a.total === '5000.00' && a.late === false);
  a = computeMiscAmount({ amount: '12000.50', late_fine_amount: '0.05', currency: 'NGN' }, true);
  check('L4  kobo-exact arithmetic (12000.50 + 0.05 = 12000.55, no float error)', a.total === '12000.55' && a.total_minor === 1200055);
  a = computeMiscAmount({ amount: '5000.00', late_fine_amount: null, currency: 'NGN' }, true);
  check('L5  NULL fine treated as 0', a.total === '5000.00');
  for (const bad of ['-1.00', '0.00', '12abc', '1.234']) {
    e = null; try { computeMiscAmount({ amount: bad, late_fine_amount: '0.00', currency: 'NGN' }, false); } catch (x) { e = x; }
    check(`L6  invalid stored amount ${bad} is refused`, e !== null);
  }
  e = null; try { computeMiscAmount({ amount: '5.00', late_fine_amount: '-1.00', currency: 'NGN' }, true); } catch (x) { e = x; }
  check('L7  negative stored fine is refused', e !== null);

  /* ================= A: admin authorization ================= */
  reset();
  const validCharge = { hostel_session_id: 2, name: 'Laundry levy', amount: '4500.00' };
  for (const [method, url, body] of [['GET', '/api/admin/misc-charges'], ['GET', '/api/admin/misc-charges/options'], ['GET', '/api/admin/misc-charges/1'], ['POST', '/api/admin/misc-charges', validCharge], ['PUT', '/api/admin/misc-charges/1', { name: 'x' }], ['POST', '/api/admin/misc-charges/1/deactivate'], ['POST', '/api/admin/misc-charges/1/activate']]) {
    res = await call(method, url, { body });
    check(`A1  not logged in: ${method} ${url} -> 401`, res.status === 401, res.status);
    res = await call(method, url, { user: student(7), body });
    check(`A2  student: ${method} ${url} -> 403`, res.status === 403, res.status);
  }
  check('A3  nothing was written by unauthorised calls', STATE.charges.length === 6);
  res = await call('DELETE', '/api/admin/misc-charges/1', { user: admin });
  check('A4  there is no delete route (history is never deleted)', res.status === 404 && STATE.charges.length === 6, res.status);

  /* ================= B: admin create / validate ================= */
  reset();
  res = await call('POST', '/api/admin/misc-charges', { user: admin, body: { ...validCharge, description: ' Laundry room ', block_id: 2, deadline_at: '2026-12-01T09:30', late_fine_amount: '250', is_required: true, is_active: 0, created_by: 999, currency: 'NGN' } });
  const created = res.json && res.json.data;
  check('B1  create -> 201 with normalised values', res.status === 201 && created.name === 'Laundry levy' && created.amount === '4500.00' && created.late_fine_amount === '250.00' && created.deadline_at === '2026-12-01 09:30:00' && created.block_id === 2 && created.is_required === true && created.description === 'Laundry room', JSON.stringify(res.json));
  const stored = STATE.charges.find((c) => c.id === created.id);
  check('B2  created_by comes from the login session; is_active forced to 1 (body values ignored)', stored.created_by === 1 && stored.is_active === 1 && stored.currency === 'NGN');
  const bad = [
    ['negative amount', { amount: '-5.00' }], ['zero amount', { amount: '0.00' }], ['3 decimals', { amount: '1.234' }], ['text amount', { amount: 'abc' }],
    ['fractional JS number', { amount: 10.5 }], ['too large', { amount: '100000000.00' }], ['missing amount', { amount: undefined }],
    ['empty title', { name: '   ' }], ['title too long', { name: 'x'.repeat(151) }], ['USD currency', { currency: 'USD' }],
    ['fine without deadline', { late_fine_amount: '100.00' }], ['negative fine', { deadline_at: '2026-12-01 10:00', late_fine_amount: '-1' }],
    ['bad deadline', { deadline_at: '31/12/2026' }], ['impossible deadline', { deadline_at: '2026-02-30 10:00' }], ['hour 25', { deadline_at: '2026-12-01 25:00' }],
    ['unknown block', { block_id: 99 }], ['unknown session', { hostel_session_id: 99 }], ['missing session', { hostel_session_id: undefined }],
    ['text is_required', { is_required: 'maybe' }],
  ];
  for (const [label, patch] of bad) {
    const before = STATE.charges.length;
    res = await call('POST', '/api/admin/misc-charges', { user: admin, body: { ...validCharge, ...patch } });
    check(`B3  rejected: ${label} -> 400, nothing stored`, res.status === 400 && STATE.charges.length === before, `${res.status} ${res.json && res.json.message}`);
  }
  res = await call('POST', '/api/admin/misc-charges', { user: admin, body: { ...validCharge, hostel_session_id: 1 } });
  check('B4  closed session -> 409', res.status === 409 && STATE.charges.every((c) => c.name !== 'Laundry levy' || c.id === created.id));
  res = await call('POST', '/api/admin/misc-charges', { user: admin, body: { ...validCharge, hostel_session_id: 3, name: 'Next year' } });
  check('B5  upcoming session is allowed', res.status === 201);

  /* ================= C: admin list / edit / activate ================= */
  res = await call('GET', '/api/admin/misc-charges', { user: admin });
  check('C1  list returns charges with payment counters', res.status === 200 && res.json.data.length >= 7 && res.json.data[0].payments_total === 0 && res.json.data.some((c) => c.id === 1 && c.read_only === false) && res.json.data.some((c) => c.id === 5 && c.read_only === true));
  res = await call('GET', '/api/admin/misc-charges?session_id=1', { user: admin });
  check('C2  list can be filtered by session', res.status === 200 && res.json.data.length === 1 && res.json.data[0].id === 5);
  res = await call('GET', '/api/admin/misc-charges?session_id=abc', { user: admin });
  check('C3  bad session filter -> 400', res.status === 400);
  res = await call('GET', '/api/admin/misc-charges/999', { user: admin });
  check('C4  unknown charge -> 404', res.status === 404);
  res = await call('GET', '/api/admin/misc-charges/abc', { user: admin });
  check('C5  bad id -> 400', res.status === 400);
  res = await call('GET', '/api/admin/misc-charges/options', { user: admin });
  check('C6  options list sessions (with writable flag) and blocks', res.status === 200 && res.json.data.sessions.find((s) => s.id === 1).writable === false && res.json.data.sessions.find((s) => s.id === 2).writable === true && res.json.data.blocks.length === 4);

  res = await call('PUT', '/api/admin/misc-charges/1', { user: admin, body: { name: 'Caution deposit', amount: '6000.00', late_fine_amount: '100.00', deadline_at: '2026-12-31 23:59' } });
  check('C7  edit with no payments: amount, title, deadline and fine change', res.status === 200 && res.json.data.name === 'Caution deposit' && res.json.data.amount === '6000.00' && res.json.data.late_fine_amount === '100.00');
  res = await call('PUT', '/api/admin/misc-charges/1', { user: admin, body: { deadline_at: null } });
  check('C8  removing the deadline while a fine remains -> 400', res.status === 400 && STATE.charges.find((c) => c.id === 1).deadline_at === '2026-12-31 23:59:00');
  res = await call('PUT', '/api/admin/misc-charges/1', { user: admin, body: { deadline_at: null, late_fine_amount: '0' } });
  check('C9  removing deadline and fine together is fine', res.status === 200 && res.json.data.deadline_at === null);
  res = await call('PUT', '/api/admin/misc-charges/1', { user: admin, body: { hostel_session_id: 3 } });
  check('C10 the session of a charge cannot be changed', res.status === 400 && STATE.charges.find((c) => c.id === 1).hostel_session_id === 2);
  res = await call('PUT', '/api/admin/misc-charges/1', { user: admin, body: { is_active: 0, created_by: 5, id: 77 } });
  check('C11 non-editable fields are ignored (nothing to update -> 400, row untouched)', res.status === 400 && STATE.charges.find((c) => c.id === 1).is_active === 1 && STATE.charges.find((c) => c.id === 1).created_by === 1);
  res = await call('PUT', '/api/admin/misc-charges/5', { user: admin, body: { name: 'Edited history' } });
  check('C12 charge of a closed session is read-only -> 409', res.status === 409 && STATE.charges.find((c) => c.id === 5).name === 'Old-session charge');
  res = await call('POST', '/api/admin/misc-charges/6/deactivate', { user: admin });
  check('C13 deactivate -> inactive, row and payments kept', res.status === 200 && res.json.data.is_active === false && STATE.charges.some((c) => c.id === 6));
  res = await call('POST', '/api/admin/misc-charges/6/activate', { user: admin });
  check('C14 activate -> active again', res.status === 200 && res.json.data.is_active === true);
  res = await call('POST', '/api/admin/misc-charges/5/activate', { user: admin });
  check('C15 charge of a closed session cannot be activated', res.status === 409);
  res = await call('POST', '/api/admin/misc-charges/5/deactivate', { user: admin });
  check('C16 charge of a closed session can still be deactivated', res.status === 200 && res.json.data.is_active === false);
  res = await call('POST', '/api/admin/misc-charges/999/deactivate', { user: admin });
  check('C17 deactivate unknown -> 404', res.status === 404);

  /* ================= D: student eligibility ================= */
  reset();
  const listFor = async (id) => (await call('GET', '/api/payments/misc-charges', { user: student(id) })).json.data;
  let d = await listFor(7);
  check('D1  student 7 (Block A): sees the all-students charge and the Block A charge only', d.eligible && d.charges.map((c) => c.id).join() === '1,2', d.charges.map((c) => c.id).join());
  d = await listFor(8);
  check('D2  student 8 (Block B): sees charges 1 and 3', d.charges.map((c) => c.id).join() === '1,3');
  d = await listFor(11);
  check('D3  student 11 (approved, no room, fee block C): sees charges 1 and 6', d.charges.map((c) => c.id).join() === '1,6');
  check('D4  inactive and other-session charges never listed', ![4, 5].some((id) => d.charges.some((c) => c.id === id)));
  for (const [id, code] of [[12, 'not_approved'], [13, 'no_application'], [99, 'no_application']]) {
    d = await listFor(id);
    check(`D5  student ${id}: not eligible (${code}), no charges`, d.eligible === false && d.reason === code && d.charges.length === 0);
  }
  STATE.sessions[1].status = 'closed'; STATE.sessions[1].is_current = 0;
  d = await listFor(7);
  check('D6  no open session -> not eligible', d.eligible === false && d.reason === 'no_open_session');
  reset();
  res = await call('GET', '/api/payments/misc-charges');
  check('D7  not logged in -> 401', res.status === 401);
  res = await call('GET', '/api/payments/misc-charges', { user: admin });
  check('D8  admin on the student route -> 403', res.status === 403);
  d = await listFor(7);
  const c2 = d.charges.find((c) => c.id === 2);
  check('D9  view shows amount 12000.50, not late yet (deadline 2026-11-30 23:59), amount due 12000.50', c2.amount === '12000.50' && c2.is_late === false && c2.amount_due === '12000.50' && c2.late_fine_amount === '1500.00' && c2.status === 'unpaid' && c2.can_pay);
  STATE.now = '2026-12-01 00:00:00';
  d = await listFor(7);
  const c2late = d.charges.find((c) => c.id === 2);
  check('D10 after the deadline the view shows the fine: due 13500.50', c2late.is_late && c2late.late_fine_due === '1500.00' && c2late.amount_due === '13500.50' && c2late.amount === '12000.50');

  /* ================= E: initialize ================= */
  reset();
  res = await call('POST', '/api/payments/misc-charges/1/initialize', { user: student(7), body: { amount: '1.00', currency: 'USD', student_id: 8, charge_id: 3, late_fine_applied: '0', status: 'success' } });
  row = rows()[0];
  check('E1  initialize -> 201, checkout.paystack.com URL, server amount 5000.00', res.status === 201 && /^https:\/\/checkout\.paystack\.com\//.test(res.json.data.authorization_url) && res.json.data.amount === '5000.00' && res.json.data.currency === 'NGN', JSON.stringify(res.json));
  check('E2  row: miscellaneous, student 7, application 101, session 2, charge 1, hostel_fee_id NULL, 5000.00 = 5000.00 + 0.00, pending',
    rows().length === 1 && row.payment_type === 'miscellaneous' && row.student_id === 7 && row.application_id === 101 && row.hostel_session_id === 2 && row.hostel_misc_charge_id === 1 &&
    row.hostel_fee_id === null && row.amount === '5000.00' && row.original_amount === '5000.00' && row.late_fine_applied === '0.00' && row.status === 'pending' && row.currency === 'NGN', JSON.stringify(row));
  check('E3  browser-supplied amount/currency/student/charge/status were ignored; Paystack got 500000 kobo NGN and the student 7 email',
    INIT_CALLS[0].amount === 500000 && INIT_CALLS[0].currency === 'NGN' && INIT_CALLS[0].email === 'ada@example.com' && INIT_CALLS[0].reference === row.payment_reference && INIT_CALLS[0].callback_url === process.env.PAYMENT_CALLBACK_URL);
  check('E4  reference is Paystack-safe, <= 80 chars, LASU-MC-<application>-<charge>- (hostel references stay LASU-HF-)', /^LASU-MC-101-1-[a-z0-9]+-[0-9a-f]{12}$/.test(row.payment_reference) && row.payment_reference.length <= 80, row.payment_reference);
  check('E5  metadata names type, charge, application, student, session', INIT_CALLS[0].metadata.payment_type === 'miscellaneous' && INIT_CALLS[0].metadata.misc_charge_id === 1 && INIT_CALLS[0].metadata.application_id === 101 && INIT_CALLS[0].metadata.student_id === 7 && INIT_CALLS[0].metadata.hostel_session_id === 2);

  // refusals
  const refuse = async (label, chargeId, uid, code, rx) => {
    reset();
    const rr = await call('POST', `/api/payments/misc-charges/${chargeId}/initialize`, { user: student(uid) });
    check(`E6  ${label} -> ${code}, no row, no Paystack call`, rr.status === code && rows().length === 0 && INIT_CALLS.length === 0 && (!rx || rx.test(rr.json.message)), `${rr.status} ${rr.json && rr.json.message}`);
  };
  await refuse('Block B charge by a Block A student', 3, 7, 404);
  await refuse('Block A charge by a Block B student', 2, 8, 404);
  await refuse('other-session charge', 5, 7, 404);
  await refuse('inactive charge', 4, 7, 404);
  await refuse('unknown charge', 999, 7, 404);
  await refuse('bad charge id', 'abc', 7, 400);
  await refuse('pending application', 1, 12, 409, /pending/);
  await refuse('no application in the current session', 1, 13, 409);
  await refuse('block charge with no confirmed block (student 11 on Block A charge)', 2, 11, 404);
  reset();
  res = await call('POST', '/api/payments/misc-charges/1/initialize');
  check('E7  not logged in -> 401', res.status === 401 && rows().length === 0);
  res = await call('POST', '/api/payments/misc-charges/1/initialize', { user: admin });
  check('E8  admin -> 403', res.status === 403 && rows().length === 0);
  reset();
  STATE.users[7].is_active = 0;
  e = await rejects(miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 1 }));
  check('E9  deactivated account -> 403, row rolled back, no Paystack call', e && e.statusCode === 403 && rows().length === 0 && INIT_CALLS.length === 0);
  reset();
  STATE.charges[0].amount = '-5.00';
  e = await rejects(miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 1 }));
  check('E10 corrupt stored amount -> 500, no row, no Paystack call', e && e.statusCode === 500 && rows().length === 0 && INIT_CALLS.length === 0);
  reset();
  delete process.env.PAYMENT_CALLBACK_URL;
  e = await rejects(miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 1 }));
  process.env.PAYMENT_CALLBACK_URL = 'http://localhost:5000/student/payment-callback.html';
  check('E11 missing PAYMENT_CALLBACK_URL -> 503, nothing created', e && e.statusCode === 503 && rows().length === 0);
  reset(); MISC_SCHEMA = 'missing';
  res = await call('POST', '/api/payments/misc-charges/1/initialize', { user: student(7) });
  check('E12 charge/payment columns missing -> 503, nothing created', res.status === 503 && rows().length === 0 && INIT_CALLS.length === 0);
  res = await call('GET', '/api/payments/misc-charges', { user: student(7) });
  check('E13 student listing also fails closed (503)', res.status === 503);
  res = await call('GET', '/api/admin/misc-charges', { user: admin });
  check('E14 admin listing fails closed (503)', res.status === 503);

  /* ================= F: late-fine boundary through initialize ================= */
  const lateCase = async (label, now, deadline, fine, wantTotal, wantFine, wantKobo) => {
    reset();
    STATE.now = now;
    Object.assign(STATE.charges[0], { amount: '5000.00', deadline_at: deadline, late_fine_amount: fine });
    const rr = await miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 1 });
    const p = rows()[0];
    check(`F  ${label}`, rr.amount === wantTotal && p.amount === wantTotal && p.late_fine_applied === wantFine && p.original_amount === '5000.00' && INIT_CALLS[0].amount === wantKobo, JSON.stringify({ rr, p }));
  };
  await lateCase('well before the deadline: no fine', '2026-11-01 12:00:00', '2026-11-30 23:59:00', '500.00', '5000.00', '0.00', 500000);
  await lateCase('exactly at the deadline: still on time, no fine', '2026-11-30 23:59:00', '2026-11-30 23:59:00', '500.00', '5000.00', '0.00', 500000);
  await lateCase('one second after the deadline: fine added (5500.00)', '2026-11-30 23:59:01', '2026-11-30 23:59:00', '500.00', '5500.00', '500.00', 550000);
  await lateCase('long after the deadline: the fine is added ONCE, not per day', '2027-06-01 00:00:00', '2026-11-30 23:59:00', '500.00', '5500.00', '500.00', 550000);
  await lateCase('after the deadline but fine 0: no fine, payment still allowed', '2027-06-01 00:00:00', '2026-11-30 23:59:00', '0.00', '5000.00', '0.00', 500000);
  await lateCase('no deadline: never late', '2099-01-01 00:00:00', null, '0.00', '5000.00', '0.00', 500000);
  reset();
  STATE.now = '2027-01-01 00:00:00';
  r = await miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 2 });
  check('F2  Block A charge 12000.50 + fine 1500.00 = 13500.50 sent as 1350050 kobo; breakdown stored', r.amount === '13500.50' && r.original_amount === '12000.50' && r.late_fine_applied === '1500.00' && INIT_CALLS[0].amount === 1350050 && rows()[0].amount === '13500.50');

  /* ================= G: duplicate / pending handling ================= */
  reset();
  await miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 1 });
  REMOTE[rows()[0].payment_reference] = { status: 'ongoing', amount: 500000, currency: 'NGN', id: 1, channel: null };
  e = await rejects(miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 1 }));
  check('G1  a second start while Paystack says the first is in progress -> 409, one row', e && e.statusCode === 409 && /in progress/.test(e.message) && rows().length === 1);
  delete REMOTE[rows()[0].payment_reference];
  r = await miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 1 });
  check('G2  abandoned first attempt is closed and a new one can start', rows().length === 2 && rows()[0].status === 'abandoned' && rows()[1].status === 'pending' && r.reference === rows()[1].payment_reference);
  paidAtProvider(rows()[1].payment_reference);
  e = await rejects(miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 1 }));
  check('G3  if the pending attempt was actually paid, starting again settles it and refuses (already paid)', e && e.statusCode === 409 && /already paid/.test(e.message) && rows()[1].status === 'success');
  e = await rejects(miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 1 }));
  check('G4  after success a new start is refused without touching Paystack', e && e.statusCode === 409 && /already paid/.test(e.message));
  r = await miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 2 });
  check('G5  paying charge 1 does not stop the same student paying charge 2', r.amount === '12000.50' && rows().filter((p) => p.status === 'pending').length === 1);
  r = await miscPayments.initializeMiscPayment({ studentId: 8, chargeId: 1 });
  check('G6  another student can pay charge 1 independently', rows().filter((p) => p.student_id === 8).length === 1);

  // type-aware duplicate handling versus the hostel fee
  reset();
  await miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 1 });
  r = await paymentService.initializePayment({ studentId: 7 });
  check('G7  a PENDING miscellaneous payment does not block starting the hostel fee', /^LASU-HF-101-/.test(r.reference) && r.amount === '300000.00' && rows().length === 2 && rows()[1].payment_type === 'hostel');
  paidAtProvider(rows()[1].payment_reference);
  await paymentService.verifyAndSettle(rows()[1].payment_reference, { studentId: 7 });
  r = await miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 2 });
  check('G8  a successful HOSTEL payment does not stop a miscellaneous payment', /^LASU-MC-101-2-/.test(r.reference));
  reset();
  await miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 1 });
  paidAtProvider(rows()[0].payment_reference);
  await paymentService.verifyAndSettle(rows()[0].payment_reference, { studentId: 7 });
  let st = await paymentService.getPaymentStatus(7);
  check('G9  a successful MISC payment does not mark the hostel fee as paid; hostel history shows no misc rows', st.eligible === true && st.paid === null && st.history.length === 0, JSON.stringify(st));
  r = await paymentService.initializePayment({ studentId: 7 });
  check('G10 the hostel fee can still be paid in full after a misc payment (amount 300000.00)', r.amount === '300000.00' && /^LASU-HF-/.test(r.reference));

  /* ================= H: verification / settlement ================= */
  reset();
  await miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 2 });
  const ref = rows()[0].payment_reference;
  paidAtProvider(ref);
  res = await call('POST', '/api/payments/verify', { user: student(7), body: { reference: ref } });
  check('H1  verify -> success, typed as miscellaneous, amount from our row', res.status === 200 && res.json.data.status === 'success' && res.json.data.payment.payment_type === 'miscellaneous' && res.json.data.payment.amount === '12000.50', JSON.stringify(res.json));
  row = rows()[0];
  check('H2  row settled with server-side evidence (verified_at, paid_at, gateway reference, channel)', row.status === 'success' && row.verified_at && row.paid_at && row.gateway_reference === String(5000000 + row.id) || row.gateway_reference === 5000000 + row.id);
  const callsBefore = VERIFY_CALLS.length;
  res = await call('POST', '/api/payments/verify', { user: student(7), body: { reference: ref } });
  check('H3  verifying again is idempotent (still success, no new Paystack call, still ONE success row)', res.json.data.status === 'success' && VERIFY_CALLS.length === callsBefore && rows().filter((p) => p.status === 'success').length === 1);
  const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: ref } }));
  res = await call('POST', '/api/payments/webhook', { rawBody: body, headers: { 'x-paystack-signature': sign(body) } });
  check('H4  a repeated webhook after success is acknowledged and changes nothing', res.status === 200 && rows().length === 1 && rows()[0].status === 'success' && VERIFY_CALLS.length === callsBefore);

  // webhook settles first, then the callback page verifies
  reset();
  await miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 1 });
  const ref2 = rows()[0].payment_reference;
  paidAtProvider(ref2);
  const wb = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: ref2, amount: 1, status: 'success' } }));
  res = await call('POST', '/api/payments/webhook', { rawBody: wb, headers: { 'x-paystack-signature': sign(wb) } });
  check('H5  valid webhook for a miscellaneous reference settles it (body amount ignored, Paystack asked)', res.status === 200 && rows()[0].status === 'success' && VERIFY_CALLS.includes(ref2));
  res = await call('POST', '/api/payments/verify', { user: student(7), body: { reference: ref2 } });
  check('H6  callback after webhook: success, no duplicate row', res.json.data.status === 'success' && rows().length === 1);
  res = await call('POST', '/api/payments/webhook', { rawBody: wb, headers: { 'x-paystack-signature': 'a'.repeat(128) } });
  check('H7  webhook with a bad signature -> 401', res.status === 401);
  reset();
  await miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 1 });
  const ref3 = rows()[0].payment_reference;
  const fake = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: ref3 } }));
  res = await call('POST', '/api/payments/webhook', { rawBody: fake, headers: { 'x-paystack-signature': sign(fake) } });
  check('H8  webhook claiming success while Paystack does not know the reference -> row stays pending', res.status === 200 && rows()[0].status === 'pending');
  REMOTE[ref3] = { status: 'success', amount: 100, currency: 'NGN', id: 9, channel: 'card' };
  res = await call('POST', '/api/payments/verify', { user: student(7), body: { reference: ref3 } });
  check('H9  amount mismatch (provider 100 kobo vs 500000) -> 409, left pending, logged', res.status === 409 && /amount did not match/.test(res.json.message) && rows()[0].status === 'pending' && errors.some((x) => /AMOUNT\/CURRENCY MISMATCH/.test(x)));
  REMOTE[ref3] = { status: 'success', amount: 500000, currency: 'USD', id: 9, channel: 'card' };
  res = await call('POST', '/api/payments/verify', { user: student(7), body: { reference: ref3 } });
  check('H10 currency mismatch -> 409, left pending', res.status === 409 && rows()[0].status === 'pending');
  REMOTE[ref3] = { status: 'success', amount: 500000, currency: 'NGN', id: 9, channel: 'card' };
  res = await call('POST', '/api/payments/verify', { user: student(8), body: { reference: ref3 } });
  check('H11 another student verifying this reference gets "not found" and settles nothing', res.status === 404 && rows()[0].status === 'pending');
  for (const [pstatus, want] of [['failed', 'failed'], ['reversed', 'failed'], ['abandoned', 'abandoned'], ['ongoing', 'pending'], ['pending', 'pending']]) {
    reset();
    await miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 1 });
    REMOTE[rows()[0].payment_reference] = { status: pstatus, amount: 500000, currency: 'NGN', id: 3, channel: null };
    res = await call('POST', '/api/payments/verify', { user: student(7), body: { reference: rows()[0].payment_reference } });
    check(`H12 Paystack '${pstatus}' -> our status '${want}'`, res.status === 200 && res.json.data.status === want && rows()[0].status === want, JSON.stringify(res.json));
  }
  reset();
  await miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 1 });
  REMOTE[rows()[0].payment_reference] = { status: 'failed', amount: 500000, currency: 'NGN', id: 3, channel: null };
  await paymentService.verifyAndSettle(rows()[0].payment_reference, { studentId: 7 });
  r = await miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 1 });
  check('H13 after a failed attempt the student can try the same charge again', rows().length === 2 && rows()[1].status === 'pending' && r.amount === '5000.00');

  /* ================= I: reference / type / linkage matching ================= */
  const tamper = async (label, mutate, rx) => {
    reset();
    await miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 1 });
    const p = rows()[0];
    mutate(p);
    paidAtProvider(p.payment_reference);
    const before = VERIFY_CALLS.length;
    const ee = await rejects(paymentService.verifyAndSettle(p.payment_reference, { studentId: 7 }));
    check(`I  ${label} -> 409, not settled, Paystack not asked`, ee && ee.statusCode === 409 && p.status === 'pending' && VERIFY_CALLS.length === before && (!rx || rx.test(errors[errors.length - 1] || '')), ee && ee.message);
  };
  await tamper('misc row with a hostel-style reference', (p) => { p.payment_reference = 'LASU-HF-101-zzz-abcdef123456'; }, /reference does not match/);
  await tamper('misc row whose reference names another charge', (p) => { p.payment_reference = 'LASU-MC-101-2-zzz-abcdef123456'; }, /reference does not match/);
  await tamper('misc row whose reference names another application', (p) => { p.payment_reference = 'LASU-MC-102-1-zzz-abcdef123456'; }, /reference does not match/);
  await tamper('hostel-typed row with a miscellaneous reference', (p) => { p.payment_type = 'hostel'; }, /hostel row with a miscellaneous reference/);
  await tamper('misc row without a charge id', (p) => { p.hostel_misc_charge_id = null; }, /without a charge/);
  await tamper('misc row whose charge is in another session', (p) => { STATE.charges[0].hostel_session_id = 1; }, /another session/);
  await tamper('misc row whose application belongs to another student', (p) => { STATE.applications.find((x) => x.id === 101).student_id = 8; }, /does not belong/);
  await tamper('misc row whose original_amount differs from the charge amount', (p) => { p.original_amount = '4000.00'; p.amount = '4000.00'; }, /original_amount/);
  await tamper('misc row with an unknown payment type', (p) => { p.payment_type = 'other'; }, /unknown payment type/);

  // duplicate paid transaction (two pending rows for the same charge, both paid at Paystack)
  reset();
  await miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 1 });
  const p1 = rows()[0];
  rows().push({ ...p1, id: 900, payment_reference: 'LASU-MC-101-1-dupe-abcdef123456', status: 'pending' });
  paidAtProvider(p1.payment_reference); paidAtProvider('LASU-MC-101-1-dupe-abcdef123456');
  await paymentService.verifyAndSettle(p1.payment_reference, { studentId: 7 });
  e = await rejects(paymentService.verifyAndSettle('LASU-MC-101-1-dupe-abcdef123456', { studentId: 7 }));
  check('J1  second paid transaction for the same charge: 409 "already paid", NOT recorded as success, logged for refund',
    e && e.statusCode === 409 && /This charge was already paid/.test(e.message) && rows().filter((p) => p.status === 'success').length === 1 && errors.some((x) => /DUPLICATE PAID TRANSACTION.*miscellaneous charge 1/.test(x)), e && e.message);
  // the same application can hold one success per DIFFERENT charge
  reset();
  await miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 1 });
  await miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 2 });
  rows().forEach((p) => paidAtProvider(p.payment_reference));
  for (const p of rows()) await paymentService.verifyAndSettle(p.payment_reference, { studentId: 7 });
  check('J2  one application can have a successful payment for each different charge', rows().filter((p) => p.status === 'success').length === 2);
  // concurrent verify + webhook
  reset();
  await miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 1 });
  paidAtProvider(rows()[0].payment_reference);
  const results = await Promise.all([
    paymentService.verifyAndSettle(rows()[0].payment_reference, { studentId: 7 }),
    paymentService.verifyAndSettle(rows()[0].payment_reference),
    paymentService.handleWebhookEvent({ event: 'charge.success', data: { reference: rows()[0].payment_reference } }),
  ]);
  check('J3  callback + webhook racing: one success row, all calls end well', rows().filter((p) => p.status === 'success').length === 1 && results[0].status === 'success');

  /* ================= K: history & isolation ================= */
  reset();
  await miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 1 });
  await paymentService.initializePayment({ studentId: 7 });
  await miscPayments.initializeMiscPayment({ studentId: 8, chargeId: 3 });
  res = await call('GET', '/api/payments/history', { user: student(7) });
  check('K1  history: only the student\'s OWN rows, hostel and miscellaneous distinguishable', res.status === 200 && res.json.data.length === 2 && res.json.data.some((h) => h.type === 'hostel' && h.description === 'Hostel fee') && res.json.data.some((h) => h.type === 'miscellaneous' && h.description === 'Caution fee') && res.json.data.every((h) => h.session_label === '2026/2027'), JSON.stringify(res.json));
  res = await call('GET', '/api/payments/history');
  check('K2  history needs a login', res.status === 401);
  res = await call('POST', '/api/payments/verify', { user: student(8), body: { reference: rows()[0].payment_reference } });
  check('K3  student 8 cannot verify student 7\'s misc reference (404)', res.status === 404);
  res = await call('GET', '/api/payments/misc-charges', { user: student(7) });
  check('K4  charge list shows student 7\'s own pending state only', res.json.data.charges.find((c) => c.id === 1).status === 'pending' && res.json.data.charges.find((c) => c.id === 2).status === 'unpaid');
  res = await call('GET', '/api/payments/misc-charges', { user: student(8) });
  check('K5  student 8 sees charge 1 as unpaid (student 7\'s payment is invisible to them)', res.json.data.charges.find((c) => c.id === 1).status === 'unpaid' && res.json.data.charges.find((c) => c.id === 3).status === 'pending');

  /* ================= L: admin lock after payments ================= */
  reset();
  await miscPayments.initializeMiscPayment({ studentId: 7, chargeId: 1 });
  res = await call('PUT', '/api/admin/misc-charges/1', { user: admin, body: { amount: '9999.00' } });
  check('L1  amount cannot change once a payment exists (409), charge untouched', res.status === 409 && STATE.charges[0].amount === '5000.00');
  res = await call('PUT', '/api/admin/misc-charges/1', { user: admin, body: { amount: '5000' } });
  check('L2  re-sending the SAME amount is not a change', res.status === 200);
  res = await call('PUT', '/api/admin/misc-charges/1', { user: admin, body: { block_id: 1 } });
  check('L3  block cannot change once a payment exists (409)', res.status === 409 && STATE.charges[0].block_id === null);
  res = await call('PUT', '/api/admin/misc-charges/1', { user: admin, body: { name: 'Renamed', description: 'Updated', deadline_at: '2026-12-31 10:00', late_fine_amount: '200.00' } });
  check('L4  title, description, deadline and fine can still change', res.status === 200 && res.json.data.name === 'Renamed' && res.json.data.amount_locked === true && res.json.data.pending_count === 1);
  res = await call('POST', '/api/admin/misc-charges/1/deactivate', { user: admin });
  const pendingRef = rows()[0].payment_reference;
  paidAtProvider(pendingRef);
  res = await call('POST', '/api/payments/verify', { user: student(7), body: { reference: pendingRef } });
  check('L5  a payment already started still settles after the charge is deactivated (money was paid)', res.json.data.status === 'success');
  e = await rejects(miscPayments.initializeMiscPayment({ studentId: 8, chargeId: 1 }));
  check('L6  a deactivated charge cannot be started by anyone (404)', e && e.statusCode === 404);
  res = await call('GET', '/api/admin/misc-charges/1', { user: admin });
  check('L7  admin counters: 1 paid, collected 5000.00, history intact', res.json.data.paid_count === 1 && res.json.data.collected_total === '5000.00' && res.json.data.is_active === false);

  /* ================= M: misc payments never satisfy the hostel-fee gate ================= */
  // The REAL paymentGate against a tiny fake that honours the payment_type filter in the SQL it receives.
  const gateRows = [
    { id: 1, student_id: 7, application_id: 101, hostel_session_id: 2, hostel_fee_id: null, amount: '300000.00', currency: 'NGN', status: 'success', payment_reference: 'LASU-MC-101-1-x', gateway_reference: 'g', verified_at: 'v', paid_at: 'p', payment_type: 'miscellaneous', fee_session_id: null, fee_block_id: null, fee_amount: null, fee_currency: null, fee_block_name: null },
  ];
  const gateConn = {
    async execute(sqlRaw) {
      const sql = sqlRaw.replace(/\s+/g, ' ');
      if (/information_schema\.COLUMNS/.test(sql)) return [PAY_COLS.map((c) => ({ column_name: c })), []];
      let list = gateRows;
      if (/payment_type = 'hostel'/.test(sql)) list = list.filter((x) => x.payment_type === 'hostel');
      if (/AND p\.status = 'success'/.test(sql)) list = list.filter((x) => x.status === 'success');
      if (/SELECT p\.status FROM payments/.test(sql)) return [list.slice(0, 1).map((x) => ({ status: x.status })), []];
      if (/FROM payments p JOIN hostel_fees/.test(sql)) return [list.filter((x) => x.hostel_fee_id !== null), []];
      return [[], []];
    },
  };
  e = await rejects(assertHostelFeePaid(gateConn, { id: 101, student_id: 7, hostel_session_id: 2 }, { block_id: 1, block_name: 'Block A' }));
  check('M1  a successful miscellaneous payment of the full hostel amount does NOT open the allocation gate (409 "has not paid")', e && e.statusCode === 409 && /has not paid/.test(e.message), e && e.message);
  const typedSqlSeen = [];
  gateConn.execute = ((orig) => async (s, p) => { typedSqlSeen.push(s.replace(/\s+/g, ' ')); return orig(s, p); })(gateConn.execute);
  await rejects(assertHostelFeePaid(gateConn, { id: 101, student_id: 7, hostel_session_id: 2 }, { block_id: 1 }));
  check('M2  the gate query itself filters payment_type = \'hostel\'', typedSqlSeen.some((s) => /FROM payments p JOIN hostel_fees/.test(s) && /p\.payment_type = 'hostel'/.test(s)));

  /* ================= N: hostel-fee flow preserved (spot regression; the full suites are run separately) ================= */
  reset();
  r = await paymentService.initializePayment({ studentId: 8 });
  check('N1  hostel initialize unchanged: LASU-HF reference, 250000.00, type hostel, fee id 15, 25000000 kobo', /^LASU-HF-102-/.test(r.reference) && r.amount === '250000.00' && rows()[0].payment_type === 'hostel' && rows()[0].hostel_fee_id === 15 && rows()[0].hostel_misc_charge_id === null && INIT_CALLS[0].amount === 25000000);
  paidAtProvider(r.reference);
  res = await call('POST', '/api/payments/verify', { user: student(8), body: { reference: r.reference } });
  check('N2  hostel verify unchanged: success, typed hostel', res.json.data.status === 'success' && res.json.data.payment.payment_type === 'hostel' && res.json.data.payment.amount === '250000.00');
  e = await rejects(paymentService.initializePayment({ studentId: 8 }));
  check('N3  second hostel start after paying: 409 already paid', e && e.statusCode === 409 && /already been paid/.test(e.message));
  res = await call('GET', '/api/payments/status', { user: student(8) });
  check('N4  /payments/status still reports the hostel payment', res.json.data.paid && res.json.data.paid.amount === '250000.00' && res.json.data.history.length === 1);

  server.close();
  logs(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { logs('TEST HARNESS ERROR:', err); process.exit(2); });
