/**
 * tests/step3_payment_gate_unit.js - PAYMENT-BEFORE-ALLOCATION
 *
 * Runs WITHOUT a database (an in-memory fake that understands exactly the SQL
 * the services issue and THROWS on anything it does not recognise, so a changed
 * query cannot pass silently).
 *
 * Proves, in code: no new allocation without a verified successful payment for the
 * right student / session / block / amount / currency; pending, failed, abandoned,
 * refunded, unverified and mismatched payments authorise nothing; the gate runs
 * inside the allocation transaction before any write; the existing allocation
 * rules still hold; pre-allocation pricing from the confirmed fee block; the
 * admin API (approve with a block, set/lock the block, advisory, gated room list);
 * and the dashboard payment fix.
 *
 * Does NOT prove: that the SQL is valid MariaDB 10.4 against the real schema, or
 * how migration 019 behaves. That needs read-only checks against the real database,
 * run by you.
 *
 *   node tests/step3_payment_gate_unit.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail !== undefined ? ` :: ${detail}` : ''}`); }
}
async function rejects(promise) { try { await promise; } catch (e) { return e; } return null; }

/* ------------------------------------------------------------------ */
/* In-memory database                                                   */
/* ------------------------------------------------------------------ */

function room(id, number, type, gender, cap, occ, block, active = 1) {
  return { id, room_number: number, room_type: type, gender, capacity: cap, occupied_spaces: occ, is_active: active, block_id: block };
}

function freshState() {
  return {
    sessions: [
      { id: 1, label: '2025/2026', status: 'closed', is_current: 0 },
      { id: 2, label: '2026/2027', status: 'open', is_current: 1 },
    ],
    users: {
      7: { id: 7, full_name: 'Ada Obi', student_id: '220001', email: 'ada@x.test', gender: 'male' },
      8: { id: 8, full_name: 'Tunde Bello', student_id: '220002', email: 'tunde@x.test', gender: 'male' },
      9: { id: 9, full_name: 'Zainab Musa', student_id: '220003', email: 'zainab@x.test', gender: 'female' },
    },
    blocks: { 1: 'Block A', 2: 'Block B' },
    fees: [
      { id: 14, hostel_session_id: 2, block_id: 1, amount: '300000.00', currency: 'NGN', active: 1 },
      { id: 15, hostel_session_id: 2, block_id: 2, amount: '250000.00', currency: 'NGN', active: 1 },
      { id: 12, hostel_session_id: 1, block_id: 1, amount: '280000.00', currency: 'NGN', active: 0 },
    ],
    rooms: {
      24: room(24, 'A-101', 'single', 'male', 1, 0, 1),
      25: room(25, 'A-102', 'single', 'male', 1, 0, 1),
      26: room(26, 'A-103', 'single', 'male', 1, 1, 1),          // full
      27: room(27, 'A-104', 'single', 'female', 1, 0, 1),        // wrong gender for the male students
      28: room(28, 'A-105', 'shared', 'male', 2, 0, 1),          // wrong room type
      29: room(29, 'A-106', 'single', 'male', 1, 0, 1, 0),       // inactive
      30: room(30, 'B-101', 'single', 'male', 1, 0, 2),          // Block B
    },
    applications: [],
    allocations: [],
    payments: [],
    nextApp: 100, nextAlloc: 200, nextPay: 500,
    payTypedColumn: true,       // migration-017 column present
    paySchemaMissing: false,    // simulate migration 013 absent
    feeBlockColumn: true,       // migration 019 applied
    failAllocationInsert: false,
  };
}

let STATE;
let SQL_LOG;
let txChain = Promise.resolve();

const norm = (sql) => sql.replace(/\s+/g, ' ').trim();
const appOf = (id) => STATE.applications.find((a) => a.id === id);
const spaces = (r) => r.capacity - r.occupied_spaces;

function addApp(over = {}) {
  const a = {
    id: STATE.nextApp++, student_id: 7, room_type: 'single', status: 'approved', allocated_room_id: null,
    hostel_session_id: 2, preferred_block_id: 1, fee_block_id: 1, special_request: null, rejection_reason: null,
    applied_at: '2026-10-01 09:00:00', reviewed_at: null, reviewed_by: null, ...over,
  };
  STATE.applications.push(a);
  return a;
}

/** A payment row as paymentService.verifyAndSettle() leaves it after server-side verification. */
function addPayment(app, over = {}) {
  const p = {
    id: STATE.nextPay++, student_id: app.student_id, application_id: app.id, hostel_session_id: app.hostel_session_id,
    hostel_fee_id: 14, amount: '300000.00', currency: 'NGN', status: 'success',
    payment_reference: `LASU-${app.id}-${STATE.nextPay}`, gateway_reference: `gw-${STATE.nextPay}`,
    verified_at: '2026-10-10 10:00:00', paid_at: '2026-10-10 10:00:00', payment_type: 'hostel', ...over,
  };
  STATE.payments.push(p);
  return p;
}

function feeOf(id) { return STATE.fees.find((f) => f.id === id); }

function baseRow(a) {
  const u = STATE.users[a.student_id];
  const rm = a.allocated_room_id ? STATE.rooms[a.allocated_room_id] : null;
  return {
    id: a.id, status: a.status, room_type: a.room_type, special_request: a.special_request, rejection_reason: a.rejection_reason,
    applied_at: a.applied_at, reviewed_at: a.reviewed_at, allocated_room_id: a.allocated_room_id,
    student_pk: u.id, student_name: u.full_name, matric_number: u.student_id, student_email: u.email,
    preferred_block_name: a.preferred_block_id ? STATE.blocks[a.preferred_block_id] : null,
    allocated_room_number: rm ? rm.room_number : null, allocated_block_name: rm ? STATE.blocks[rm.block_id] : null,
    reviewer_name: null,
  };
}

function exec(sqlRaw, params = []) {
  const sql = norm(sqlRaw);
  const S = STATE;
  const qm = (sql.match(/\?/g) || []).length;
  if (qm !== params.length) throw new Error(`FAKE DB: ${qm} placeholders but ${params.length} params: ${sql}`);
  SQL_LOG.push(sql);
  let m;

  /* ---- hostel session ---- */
  if (/FROM hostel_sessions WHERE is_current = 1 AND status = 'open'/.test(sql)) {
    return [S.sessions.filter((x) => x.is_current === 1 && x.status === 'open').slice(0, 1).map((x) => ({ id: x.id, label: x.label }))];
  }

  /* ---- allocationService (same shapes as tests/step1_unit.js) ---- */
  if (/^SELECT id, student_id, room_type, status, allocated_room_id, hostel_session_id FROM applications WHERE id = \? FOR UPDATE/.test(sql)) {
    return [S.applications.filter((a) => a.id === params[0]).map((a) => ({ ...a }))];
  }
  if (/^SELECT .* FROM applications WHERE id = \? FOR UPDATE/.test(sql) && !/preferred_block_id, hostel_session_id FROM applications/.test(sql) && !/allocated_room_id, hostel_session_id FROM applications WHERE id = \? FOR UPDATE$/.test(sql)) {
    return [S.applications.filter((a) => a.id === params[0]).map((a) => ({ ...a }))];
  }
  if (/FROM allocations WHERE student_id = \? AND hostel_session_id = \? AND status = 'active'/.test(sql)) {
    return [S.allocations.filter((a) => a.student_id === params[0] && a.hostel_session_id === params[1] && a.status === 'active').map((a) => ({ id: a.id }))];
  }
  if (/FROM rooms r JOIN blocks b ON b.id = r.block_id WHERE r.id = \? FOR UPDATE/.test(sql)) {
    const r = S.rooms[params[0]];
    return [r ? [{ ...r, block_name: S.blocks[r.block_id] }] : []];
  }
  if (/^SELECT gender FROM users WHERE id = \?/.test(sql)) {
    const u = S.users[params[0]];
    return [u ? [{ gender: u.gender }] : []];
  }
  if (/^INSERT INTO allocations \(application_id, student_id, room_id, hostel_session_id, allocated_by\)/.test(sql)) {
    if (S.failAllocationInsert) throw new Error('simulated failure after the gate (insert)');
    const [application_id, student_id, room_id, hostel_session_id, allocated_by] = params;
    S.allocations.push({ id: S.nextAlloc, application_id, student_id, room_id, hostel_session_id, allocated_by, status: 'active' });
    return [{ insertId: S.nextAlloc++, affectedRows: 1 }];
  }
  if (/^UPDATE rooms SET occupied_spaces = occupied_spaces \+ 1 WHERE id = \?/.test(sql)) { S.rooms[params[0]].occupied_spaces += 1; return [{ affectedRows: 1 }]; }
  if (/^UPDATE rooms SET occupied_spaces = occupied_spaces - 1 WHERE id = \?/.test(sql)) { S.rooms[params[0]].occupied_spaces -= 1; return [{ affectedRows: 1 }]; }
  if (/^UPDATE applications SET allocated_room_id = \? WHERE id = \?/.test(sql)) { appOf(params[1]).allocated_room_id = params[0]; return [{ affectedRows: 1 }]; }
  if (/^UPDATE applications SET allocated_room_id = NULL WHERE id = \?/.test(sql)) { appOf(params[0]).allocated_room_id = null; return [{ affectedRows: 1 }]; }
  if (/^SELECT id, room_id FROM allocations WHERE application_id = \? AND status = 'active' FOR UPDATE/.test(sql)) {
    return [S.allocations.filter((a) => a.application_id === params[0] && a.status === 'active').map((a) => ({ id: a.id, room_id: a.room_id }))];
  }
  if (/^SELECT id FROM rooms WHERE id = \? FOR UPDATE/.test(sql)) return [[{ id: params[0] }]];
  // revokeAllocation / cancelApprovedApplication lock the room row and read its occupancy before decrementing
  if (/^SELECT id, occupied_spaces FROM rooms WHERE id = \? FOR UPDATE/.test(sql)) { const r = S.rooms[params[0]]; return [r ? [{ id: r.id, occupied_spaces: r.occupied_spaces }] : []]; }
  if (/^UPDATE allocations SET status = 'released'/.test(sql)) {
    const a = S.allocations.find((x) => x.id === params[1]); a.status = 'released'; a.release_reason = params[0]; return [{ affectedRows: 1 }];
  }
  if (/^SELECT status FROM allocations WHERE application_id = \? ORDER BY allocated_at DESC LIMIT 1/.test(sql)) {
    const list = S.allocations.filter((a) => a.application_id === params[0]);
    return [list.length ? [{ status: list[list.length - 1].status }] : []];
  }

  /* ---- payment schema + gate ---- */
  if (/^SELECT COLUMN_NAME AS column_name FROM information_schema\.COLUMNS WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME = 'payments'/.test(sql)) {
    let cols = ['student_id', 'application_id', 'hostel_session_id', 'hostel_fee_id', 'amount', 'currency', 'payment_reference', 'gateway_reference',
      'payment_gateway', 'payment_channel', 'status', 'verified_at', 'paid_at'];
    if (S.paySchemaMissing) cols = cols.filter((c) => c !== 'hostel_fee_id' && c !== 'hostel_session_id');
    if (S.payTypedColumn) cols = cols.concat(['payment_type', 'original_amount', 'late_fine_applied']);
    return [cols.map((c) => ({ column_name: c }))];
  }
  if (/^SELECT fee_block_id FROM applications WHERE id = \?$/.test(sql)) {
    if (!S.feeBlockColumn) { const e = new Error("Unknown column 'fee_block_id'"); e.code = 'ER_BAD_FIELD_ERROR'; throw e; }
    const a = appOf(params[0]);
    return [a ? [{ fee_block_id: a.fee_block_id === undefined ? null : a.fee_block_id }] : []];
  }
  if (/^SELECT p\.id, p\.student_id, p\.application_id, p\.hostel_session_id, p\.hostel_fee_id, p\.amount, p\.currency, p\.status, p\.payment_reference, p\.gateway_reference, p\.verified_at, p\.paid_at, f\.hostel_session_id AS fee_session_id/.test(sql)) {
    const typed = /AND p\.payment_type = 'hostel'/.test(sql);
    return [S.payments
      .filter((p) => p.application_id === params[0] && p.hostel_session_id === params[1] && p.status === 'success' && (!typed || p.payment_type === 'hostel'))
      .map((p) => {
        const f = feeOf(p.hostel_fee_id);
        return { ...p, fee_session_id: f.hostel_session_id, fee_block_id: f.block_id, fee_amount: f.amount, fee_currency: f.currency, fee_block_name: S.blocks[f.block_id] };
      })];
  }
  if (/^SELECT p\.status FROM payments p WHERE p\.application_id = \? AND p\.hostel_session_id = \? (AND p\.payment_type = 'hostel' )?ORDER BY p\.id DESC LIMIT 1$/.test(sql)) {
    const typed = /AND p\.payment_type = 'hostel'/.test(sql);
    const list = S.payments.filter((p) => p.application_id === params[0] && p.hostel_session_id === params[1] && (!typed || p.payment_type === 'hostel'));
    return [list.length ? [{ status: list[list.length - 1].status }] : []];
  }

  /* ---- feeService ---- */
  if (/^SELECT id, student_id, status, allocated_room_id, hostel_session_id FROM applications WHERE id = \? LOCK IN SHARE MODE$/.test(sql)) {
    return [S.applications.filter((a) => a.id === params[0]).map(({ id, student_id, status, allocated_room_id, hostel_session_id }) => ({ id, student_id, status, allocated_room_id, hostel_session_id }))];
  }
  if (/^SELECT id, application_id, student_id, room_id, hostel_session_id FROM allocations WHERE application_id = \? AND hostel_session_id = \? AND status = 'active' LOCK IN SHARE MODE$/.test(sql)) {
    return [S.allocations.filter((a) => a.application_id === params[0] && a.hostel_session_id === params[1] && a.status === 'active').map((a) => ({ ...a }))];
  }
  if (/^SELECT r\.id AS room_id, r\.room_number, r\.room_type, r\.block_id, b\.name AS block_name FROM rooms r JOIN blocks b ON b\.id = r\.block_id WHERE r\.id = \?$/.test(sql)) {
    const r = S.rooms[params[0]];
    return [r ? [{ room_id: r.id, room_number: r.room_number, room_type: r.room_type, block_id: r.block_id, block_name: S.blocks[r.block_id] }] : []];
  }
  if (/^SELECT id, hostel_session_id, block_id, amount, currency FROM hostel_fees WHERE hostel_session_id = \? AND block_id = \? AND active = 1 LOCK IN SHARE MODE$/.test(sql)) {
    return [S.fees.filter((f) => f.hostel_session_id === params[0] && f.block_id === params[1] && f.active === 1)
      .map(({ id, hostel_session_id, block_id, amount, currency }) => ({ id, hostel_session_id, block_id, amount, currency }))];
  }
  if (/^SELECT id, name FROM blocks WHERE id = \?$/.test(sql)) {
    return [S.blocks[params[0]] ? [{ id: params[0], name: S.blocks[params[0]] }] : []];
  }

  /* ---- adminApplicationController ---- */
  if (sql.startsWith('SELECT a.id, a.status, a.room_type, a.special_request') && sql.includes('FROM applications a JOIN users u ON u.id = a.student_id')) {
    if (sql.endsWith('WHERE a.id = ?')) return [S.applications.filter((a) => a.id === params[0]).map(baseRow)];
    return [S.applications.map(baseRow)];
  }
  if (/^SELECT id, status, preferred_block_id, hostel_session_id FROM applications WHERE id = \? FOR UPDATE$/.test(sql)) {
    return [S.applications.filter((a) => a.id === params[0]).map(({ id, status, preferred_block_id, hostel_session_id }) => ({ id, status, preferred_block_id, hostel_session_id }))];
  }
  if (/^SELECT id, status, allocated_room_id, hostel_session_id FROM applications WHERE id = \? FOR UPDATE$/.test(sql)) {
    return [S.applications.filter((a) => a.id === params[0]).map(({ id, status, allocated_room_id, hostel_session_id }) => ({ id, status, allocated_room_id, hostel_session_id }))];
  }
  if (/^SELECT id, status, preferred_block_id, hostel_session_id FROM applications WHERE id = \?$/.test(sql)) {
    return [S.applications.filter((a) => a.id === params[0]).map(({ id, status, preferred_block_id, hostel_session_id }) => ({ id, status, preferred_block_id, hostel_session_id }))];
  }
  if (/^SELECT id, status FROM applications WHERE id = \?$/.test(sql)) {
    return [S.applications.filter((a) => a.id === params[0]).map(({ id, status }) => ({ id, status }))];
  }
  if (/^SELECT id, student_id, room_type, status, preferred_block_id FROM applications WHERE id = \?$/.test(sql)) {
    return [S.applications.filter((a) => a.id === params[0]).map(({ id, student_id, room_type, status, preferred_block_id }) => ({ id, student_id, room_type, status, preferred_block_id }))];
  }
  if (/^UPDATE applications SET status = 'approved', reviewed_by = \?, reviewed_at = NOW\(\), fee_block_id = \? WHERE id = \? AND status = 'pending'$/.test(sql)) {
    if (!S.feeBlockColumn) { const e = new Error("Unknown column 'fee_block_id'"); e.code = 'ER_BAD_FIELD_ERROR'; throw e; }
    const a = appOf(params[2]);
    if (!a || a.status !== 'pending') return [{ affectedRows: 0 }];
    a.status = 'approved'; a.reviewed_by = params[0]; a.fee_block_id = params[1];
    return [{ affectedRows: 1 }];
  }
  if (/^UPDATE applications SET fee_block_id = \? WHERE id = \? AND status = 'approved' AND allocated_room_id IS NULL$/.test(sql)) {
    if (!S.feeBlockColumn) { const e = new Error("Unknown column 'fee_block_id'"); e.code = 'ER_BAD_FIELD_ERROR'; throw e; }
    const a = appOf(params[1]);
    if (!a || a.status !== 'approved' || a.allocated_room_id) return [{ affectedRows: 0 }];
    a.fee_block_id = params[0];
    return [{ affectedRows: 1 }];
  }
  if (/^SELECT p\.status FROM payments p WHERE p\.application_id = \? AND p\.hostel_session_id = \? AND p\.status IN \('success', 'pending'\)/.test(sql)) {
    const typed = /AND p\.payment_type = 'hostel'/.test(sql);
    return [S.payments.filter((p) => p.application_id === params[0] && p.hostel_session_id === params[1] && ['success', 'pending'].includes(p.status) && (!typed || p.payment_type === 'hostel')).slice(0, 1).map((p) => ({ status: p.status }))];
  }
  if (/^SELECT a\.id, a\.fee_block_id, b\.name AS fee_block_name FROM applications a LEFT JOIN blocks b ON b\.id = a\.fee_block_id WHERE a\.id IN/.test(sql)) {
    if (!S.feeBlockColumn) { const e = new Error("Unknown column 'fee_block_id'"); e.code = 'ER_BAD_FIELD_ERROR'; throw e; }
    return [params.map((id) => { const a = appOf(id); return { id, fee_block_id: a.fee_block_id || null, fee_block_name: a.fee_block_id ? S.blocks[a.fee_block_id] : null }; })];
  }
  if (/^SELECT p\.id, p\.application_id, p\.status, p\.payment_reference, p\.amount, p\.currency, p\.paid_at, p\.verified_at, p\.gateway_reference, f\.block_id AS paid_block_id, fb\.name AS paid_block_name FROM payments p/.test(sql)) {
    const typed = /AND p\.payment_type = 'hostel'/.test(sql);
    return [S.payments
      .filter((p) => params.includes(p.application_id) && (!typed || p.payment_type === 'hostel') && appOf(p.application_id).hostel_session_id === p.hostel_session_id)
      .sort((a, b) => b.id - a.id)
      .map((p) => { const f = feeOf(p.hostel_fee_id); return { ...p, paid_block_id: f ? f.block_id : null, paid_block_name: f ? S.blocks[f.block_id] : null }; })];
  }
  if (/^SELECT b\.id, b\.name, f\.amount, f\.currency FROM hostel_fees f JOIN blocks b ON b\.id = f\.block_id WHERE f\.hostel_session_id = \? AND f\.active = 1 ORDER BY b\.name ASC$/.test(sql)) {
    return [S.fees.filter((f) => f.hostel_session_id === params[0] && f.active === 1).map((f) => ({ id: f.block_id, name: S.blocks[f.block_id], amount: f.amount, currency: f.currency }))];
  }
  if (/^SELECT r\.id, r\.room_number, r\.room_type, r\.gender, r\.capacity, r\.occupied_spaces, r\.available_spaces, b\.id AS block_id, b\.name AS block_name FROM rooms r JOIN blocks b ON b\.id = r\.block_id WHERE r\.room_type = \? AND r\.gender = \? AND r\.is_active = 1 AND r\.available_spaces > 0 AND r\.block_id = \?/.test(sql)) {
    return [Object.values(S.rooms)
      .filter((r) => r.room_type === params[0] && r.gender === params[1] && r.is_active === 1 && spaces(r) > 0 && r.block_id === params[2])
      .map((r) => ({ ...r, available_spaces: spaces(r), block_name: S.blocks[r.block_id] }))];
  }

  /* ---- capacityAdvisory ---- */
  if (/^SELECT a\.id, a\.room_type, a\.hostel_session_id, u\.gender FROM applications a JOIN users u ON u\.id = a\.student_id WHERE a\.id = \?$/.test(sql)) {
    return [S.applications.filter((a) => a.id === params[0]).map((a) => ({ id: a.id, room_type: a.room_type, hostel_session_id: a.hostel_session_id, gender: S.users[a.student_id].gender }))];
  }
  if (/^SELECT COALESCE\(SUM\(r\.available_spaces\), 0\) AS free_spaces, COUNT\(\*\) AS room_count FROM rooms r WHERE r\.block_id = \? AND r\.room_type = \? AND r\.gender = \? AND r\.is_active = 1$/.test(sql)) {
    const rs = Object.values(S.rooms).filter((r) => r.block_id === params[0] && r.room_type === params[1] && r.gender === params[2] && r.is_active === 1);
    return [[{ free_spaces: String(rs.reduce((n, r) => n + spaces(r), 0)), room_count: rs.length }]];
  }
  if (/^SELECT COUNT\(\*\) AS committed FROM applications a JOIN users u ON u\.id = a\.student_id WHERE a\.hostel_session_id = \? AND a\.status = 'approved' AND a\.allocated_room_id IS NULL AND a\.fee_block_id = \? AND a\.room_type = \? AND u\.gender = \? AND a\.id <> \?$/.test(sql)) {
    if (!S.feeBlockColumn) { const e = new Error('Unknown column'); e.code = 'ER_BAD_FIELD_ERROR'; throw e; }
    return [[{ committed: S.applications.filter((a) => a.hostel_session_id === params[0] && a.status === 'approved' && !a.allocated_room_id && a.fee_block_id === params[1] && a.room_type === params[2] && S.users[a.student_id].gender === params[3] && a.id !== params[4]).length }]];
  }

  /* ---- student dashboard ---- */
  if (sql.startsWith('SELECT a.id, a.status, a.room_type, a.rejection_reason, a.applied_at, a.reviewed_at, a.allocated_room_id, a.hostel_session_id, pb.name AS preferred_block FROM applications a')) {
    const rows = S.applications.filter((a) => a.student_id === params[0]).sort((x, y) => (x.applied_at < y.applied_at ? 1 : -1)).slice(0, 1)
      .map((a) => ({ ...a, preferred_block: a.preferred_block_id ? S.blocks[a.preferred_block_id] : null }));
    return [rows];
  }
  if (/^SELECT r\.room_number, r\.room_type, b\.name AS block_name FROM rooms r JOIN blocks b ON b\.id = r\.block_id WHERE r\.id = \?$/.test(sql)) {
    const r = S.rooms[params[0]];
    return [r ? [{ room_number: r.room_number, room_type: r.room_type, block_name: S.blocks[r.block_id] }] : []];
  }
  if (/^SELECT status, payment_reference, amount, currency, paid_at, verified_at, gateway_reference FROM payments WHERE application_id = \? AND hostel_session_id = \? (AND payment_type = 'hostel' )?ORDER BY \(status = 'success'\) DESC, id DESC LIMIT 1$/.test(sql)) {
    const typed = /AND payment_type = 'hostel'/.test(sql);
    const rows = S.payments.filter((p) => p.application_id === params[0] && p.hostel_session_id === params[1] && (!typed || p.payment_type === 'hostel'))
      .sort((a, b) => ((b.status === 'success') - (a.status === 'success')) || (b.id - a.id)).slice(0, 1);
    return [rows.map((p) => ({ status: p.status, payment_reference: p.payment_reference, amount: p.amount, currency: p.currency, paid_at: p.paid_at, verified_at: p.verified_at, gateway_reference: p.gateway_reference }))];
  }
  if (/^SELECT b\.name FROM applications a JOIN blocks b ON b\.id = a\.fee_block_id WHERE a\.id = \?$/.test(sql)) {
    if (!S.feeBlockColumn) { const e = new Error('Unknown column'); e.code = 'ER_BAD_FIELD_ERROR'; throw e; }
    const a = appOf(params[0]);
    return [a && a.fee_block_id ? [{ name: S.blocks[a.fee_block_id] }] : []];
  }

  // per-request role/activity re-check in middleware/authMiddleware.js (id 1 = admin, every other id a student)
  if (/^SELECT role, is_active FROM users WHERE id = \?$/.test(sql)) return [[{ role: Number(params[0]) === 1 ? 'admin' : 'student', is_active: 1 }]];
  throw new Error(`step3 fake database: unrecognised SQL: ${sql}`);
}

const fakeConn = { execute: async (sql, params) => exec(sql, params) };
const fakePool = { execute: async (sql, params) => exec(sql, params) };

async function fakeWithTransaction(callback) {
  const run = txChain.then(async () => {
    const snapshot = JSON.stringify(STATE);
    try { return await callback(fakeConn); }
    catch (err) { STATE = JSON.parse(snapshot); throw err; } // emulate ROLLBACK
  });
  txChain = run.catch(() => {});
  return run;
}

const dbPath = require.resolve('../config/database');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    pool: fakePool,
    query: async (sql, params) => (await exec(sql, params))[0],
    queryOne: async (sql, params) => { const rows = (await exec(sql, params))[0]; return rows[0] || null; },
    withTransaction: fakeWithTransaction,
    testConnection: async () => true,
  },
};

const { assertHostelFeePaid } = require('../services/paymentGate');
const paymentSchema = require('../services/paymentSchema');
const allocationService = require('../services/allocationService');
const feeService = require('../services/feeService');

function reset() {
  STATE = freshState();
  SQL_LOG = [];
  txChain = Promise.resolve();
  paymentSchema.resetSchemaCache();
}
const writesLog = () => SQL_LOG.filter((s) => /^(INSERT|UPDATE|DELETE)/i.test(s));
const roomOf = (id) => STATE.rooms[id];

/* ------------------------------------------------------------------ */
/* A. The gate                                                          */
/* ------------------------------------------------------------------ */

async function testGate() {
  console.log('\n[A] paymentGate.assertHostelFeePaid');
  reset();
  const app = addApp();
  const rm = { block_id: 1, block_name: 'Block A' };
  const gate = (over = {}) => assertHostelFeePaid(fakeConn, { id: app.id, student_id: app.student_id, hostel_session_id: app.hostel_session_id, ...over }, rm);

  let e = await rejects(gate());
  check('no payment at all -> 409 "has not paid"', e && e.statusCode === 409 && /has not paid/.test(e.message), e && e.message);

  for (const [status, re] of [['pending', /still pending/], ['failed', /did not succeed/], ['abandoned', /not completed/], ['refunded', /refunded/]]) {
    reset(); const a = addApp(); addPayment(a, { status, verified_at: null, paid_at: null });
    e = await rejects(assertHostelFeePaid(fakeConn, a, rm));
    check(`${status} payment -> 409, authorises nothing`, e && e.statusCode === 409 && re.test(e.message), e && e.message);
  }

  reset(); let a = addApp(); addPayment(a, { status: 'failed' }); addPayment(a, { status: 'pending' });
  e = await rejects(assertHostelFeePaid(fakeConn, a, rm));
  check('failed + pending attempts together -> still 409', e && e.statusCode === 409);

  reset(); a = addApp(); const ok = addPayment(a);
  const res = await assertHostelFeePaid(fakeConn, a, rm);
  check('verified successful payment for the right block -> allowed', res.payment_id === ok.id && res.block_id === 1 && res.amount === '300000.00');
  check('gate read uses LOCK IN SHARE MODE and parameters only', SQL_LOG.some((s) => /FROM payments p JOIN hostel_fees f/.test(s) && /LOCK IN SHARE MODE$/.test(s)));

  for (const [label, over] of [['verified_at missing', { verified_at: null }], ['paid_at missing', { paid_at: null }], ['gateway reference missing', { gateway_reference: null }]]) {
    reset(); a = addApp(); addPayment(a, over);
    e = await rejects(assertHostelFeePaid(fakeConn, a, rm));
    check(`success row with ${label} (never server-verified) -> 409`, e && e.statusCode === 409 && /verification record/.test(e.message), e && e.message);
  }

  reset(); a = addApp(); addPayment(a, { student_id: 8 });
  e = await rejects(assertHostelFeePaid(fakeConn, a, rm));
  check("another student's payment id on this application -> 409", e && e.statusCode === 409 && /does not belong to this student/.test(e.message), e && e.message);

  reset(); a = addApp(); const other = addApp({ student_id: 8, preferred_block_id: 1 }); addPayment(other);
  e = await rejects(assertHostelFeePaid(fakeConn, a, rm));
  check("a different application's payment cannot authorise this one", e && e.statusCode === 409 && /has not paid/.test(e.message));

  reset(); a = addApp(); addPayment(a, { hostel_session_id: 1 });
  e = await rejects(assertHostelFeePaid(fakeConn, a, rm));
  check("a payment recorded against another hostel session does not count", e && e.statusCode === 409);

  reset(); a = addApp(); addPayment(a, { hostel_fee_id: 12 }); // fee row of session 1
  e = await rejects(assertHostelFeePaid(fakeConn, a, rm));
  check('payment tied to a fee of a different session -> 409', e && e.statusCode === 409 && /different hostel session/.test(e.message), e && e.message);

  reset(); a = addApp({ fee_block_id: 1 }); addPayment(a);
  e = await rejects(assertHostelFeePaid(fakeConn, a, { block_id: 2, block_name: 'Block B' }));
  check('paid Block A but room is in Block B -> 409 naming Block A', e && e.statusCode === 409 && /paid the fee for Block A/.test(e.message), e && e.message);

  reset(); a = addApp({ fee_block_id: 2 }); addPayment(a); // paid Block A fee, application says Block B
  e = await rejects(assertHostelFeePaid(fakeConn, a, rm));
  check('paid block differs from the application\'s confirmed fee block -> 409', e && e.statusCode === 409 && /fee block confirmed/.test(e.message), e && e.message);

  reset(); a = addApp(); addPayment(a, { currency: 'USD' });
  e = await rejects(assertHostelFeePaid(fakeConn, a, rm));
  check('currency mismatch -> 409', e && e.statusCode === 409 && /currency/.test(e.message), e && e.message);

  reset(); a = addApp(); addPayment(a, { amount: '299999.99' });
  e = await rejects(assertHostelFeePaid(fakeConn, a, rm));
  check('amount one kobo short -> 409', e && e.statusCode === 409 && /amount paid/.test(e.message), e && e.message);

  reset(); a = addApp(); addPayment(a, { amount: '300000.01' });
  e = await rejects(assertHostelFeePaid(fakeConn, a, rm));
  check('amount one kobo over -> 409 (exact match required)', e && e.statusCode === 409);

  reset(); a = addApp(); addPayment(a, { amount: 'abc' });
  e = await rejects(assertHostelFeePaid(fakeConn, a, rm));
  check('unparseable amount -> 500 (never guessed)', e && e.statusCode === 500, e && e.message);

  reset(); a = addApp(); addPayment(a, { payment_type: 'miscellaneous' });
  e = await rejects(assertHostelFeePaid(fakeConn, a, rm));
  check('a successful MISCELLANEOUS payment cannot stand in for the hostel fee -> 409', e && e.statusCode === 409 && /has not paid/.test(e.message), e && e.message);

  reset(); a = addApp(); addPayment(a); addPayment(a);
  e = await rejects(assertHostelFeePaid(fakeConn, a, rm));
  check('two successful payments (impossible by the unique key) -> 500, not guessed', e && e.statusCode === 500, e && e.message);

  reset(); STATE.payTypedColumn = false; a = addApp(); addPayment(a);
  check('013-only payments table (no payment_type) works', (await assertHostelFeePaid(fakeConn, a, rm)).block_id === 1);

  reset(); STATE.paySchemaMissing = true; a = addApp(); addPayment(a);
  e = await rejects(assertHostelFeePaid(fakeConn, a, rm));
  const calls = SQL_LOG.length;
  check('payments table missing migration-013 columns -> 503, fails closed', e && e.statusCode === 503, e && e.message);

  reset(); STATE.feeBlockColumn = false; a = addApp(); delete a.fee_block_id; addPayment(a);
  check('migration 019 not applied: legacy revoke->re-allocate with a valid payment still passes', (await assertHostelFeePaid(fakeConn, a, rm)).block_id === 1);
}

/* ------------------------------------------------------------------ */
/* B. allocateRoom with the gate                                        */
/* ------------------------------------------------------------------ */

async function testAllocate() {
  console.log('\n[B] allocationService.allocateRoom (gate inside the transaction)');
  const alloc = (a, roomId) => allocationService.allocateRoom({ applicationId: a.id, roomId, adminId: 1 });
  const unchanged = (before) => JSON.stringify(STATE.rooms) === before.rooms && STATE.allocations.length === before.allocs;
  const snap = () => ({ rooms: JSON.stringify(STATE.rooms), allocs: STATE.allocations.length });

  reset(); let a = addApp(); let before = snap();
  let e = await rejects(alloc(a, 24));
  check('approved but UNPAID -> 409, no allocation', e && e.statusCode === 409 && /has not paid/.test(e.message), e && e.message);
  check('...and nothing was written (no INSERT/UPDATE statement was even issued)', writesLog().length === 0 && unchanged(before) && appOf(a.id).allocated_room_id === null);

  for (const status of ['pending', 'failed', 'abandoned', 'refunded']) {
    reset(); a = addApp(); addPayment(a, { status, verified_at: null, paid_at: null }); before = snap();
    e = await rejects(alloc(a, 24));
    check(`${status} payment -> 409, no allocation, nothing written`, e && e.statusCode === 409 && writesLog().length === 0 && unchanged(before), e && e.message);
  }

  reset(); a = addApp(); addPayment(a, { verified_at: null, paid_at: null, gateway_reference: null }); before = snap();
  e = await rejects(alloc(a, 24));
  check('success flag without server verification evidence -> 409, nothing written', e && e.statusCode === 409 && writesLog().length === 0 && unchanged(before));

  reset(); a = addApp(); addPayment(a, { amount: '1.00' }); before = snap();
  e = await rejects(alloc(a, 24));
  check('wrong amount paid -> 409, nothing written', e && e.statusCode === 409 && writesLog().length === 0 && unchanged(before), e && e.message);

  reset(); a = addApp({ student_id: 8 }); addPayment(a, { student_id: 7 }); before = snap();
  e = await rejects(alloc(a, 24));
  check('payment owned by a different student -> 409, nothing written', e && e.statusCode === 409 && writesLog().length === 0 && unchanged(before));

  reset(); a = addApp(); addPayment(a); before = snap();
  e = await rejects(alloc(a, 30)); // Block B room, Block A paid
  check('paid Block A, room in Block B -> 409, nothing written', e && e.statusCode === 409 && /paid the fee for Block A/.test(e.message) && writesLog().length === 0 && unchanged(before), e && e.message);
  check('(the same payment still allocates a Block A room afterwards)', (await alloc(a, 24)).room_number === 'A-101');

  reset(); a = addApp(); const pay = addPayment(a);
  const r = await alloc(a, 24);
  check('paid + eligible -> allocated', r && r.room_number === 'A-101' && r.block_id === 1);
  check('occupancy 1, one active allocation, pointer set', roomOf(24).occupied_spaces === 1 && STATE.allocations.filter((x) => x.status === 'active').length === 1 && appOf(a.id).allocated_room_id === 24);
  const gateIdx = SQL_LOG.findIndex((s) => /FROM payments p JOIN hostel_fees f/.test(s));
  const insIdx = SQL_LOG.findIndex((s) => /^INSERT INTO allocations/.test(s));
  const roomLockIdx = SQL_LOG.findIndex((s) => /FROM rooms r JOIN blocks b ON b\.id = r\.block_id WHERE r\.id = \? FOR UPDATE/.test(s));
  check('order: application+room locked, THEN payment gate, THEN first write', roomLockIdx >= 0 && roomLockIdx < gateIdx && gateIdx < insIdx, `${roomLockIdx},${gateIdx},${insIdx}`);
  check('the payment row is untouched by allocation', STATE.payments.length === 1 && STATE.payments[0].id === pay.id && STATE.payments[0].status === 'success');

  // existing rules still hold when the student HAS paid
  const rule = async (title, mk, roomId, re) => {
    reset(); const ap = addApp(mk); addPayment(ap); const b = snap();
    const er = await rejects(alloc(ap, roomId));
    check(`paid, but ${title} -> refused`, er && er.statusCode >= 400 && re.test(er.message) && writesLog().length === 0 && unchanged(b), er && er.message);
  };
  await rule('room is full', {}, 26, /full/i);
  await rule('room gender does not match the student', {}, 27, /gender|male|female/i);
  await rule('room type does not match', {}, 28, /type|single|shared/i);
  await rule('room is inactive', {}, 29, /not currently active/i);
  await rule('room does not exist', {}, 999, /not found|exist/i);

  reset(); a = addApp({ status: 'pending' }); addPayment(a);
  e = await rejects(alloc(a, 24));
  check('paid but application not approved -> 409', e && e.statusCode === 409 && writesLog().length === 0, e && e.message);

  reset(); a = addApp({ hostel_session_id: 1 }); addPayment(a, { hostel_fee_id: 12, hostel_session_id: 1 });
  e = await rejects(alloc(a, 24));
  check('paid application from a closed session -> 409 (current-session rule intact)', e && e.statusCode === 409 && /current hostel session/.test(e.message), e && e.message);

  reset(); a = addApp(); addPayment(a); await alloc(a, 24);
  e = await rejects(alloc(a, 25));
  check('already allocated -> 409, second allocation refused', e && e.statusCode === 409 && STATE.allocations.length === 1 && roomOf(25).occupied_spaces === 0, e && e.message);

  reset(); a = addApp(); addPayment(a); STATE.failAllocationInsert = true; before = snap();
  e = await rejects(alloc(a, 24));
  check('failure AFTER the gate rolls everything back (no partial state)', e && /simulated/.test(e.message) && unchanged(before) && appOf(a.id).allocated_room_id === null);

  reset(); a = addApp(); addPayment(a); await alloc(a, 24);
  await allocationService.revokeAllocation({ applicationId: a.id, reason: 'room needs repair', adminId: 1 });
  e = await rejects(alloc(a, 30));
  check('after revoke, the paid block still binds: Block B room refused', e && e.statusCode === 409 && /paid the fee for Block A/.test(e.message), e && e.message);
  check('after revoke, the same payment re-allocates in the paid block', (await alloc(a, 25)).room_number === 'A-102' && STATE.payments.length === 1);

  reset(); a = addApp(); addPayment(a);
  const both = await Promise.allSettled([alloc(a, 24), alloc(a, 25)]);
  check('two admins allocating one paid student at once: exactly one succeeds', both.filter((x) => x.status === 'fulfilled').length === 1 && STATE.allocations.filter((x) => x.status === 'active').length === 1);
  check('...and only one room is occupied', roomOf(24).occupied_spaces + roomOf(25).occupied_spaces === 1);

  const hold = fs.readFileSync(path.join(__dirname, '..', 'services', 'allocationService.js'), 'utf8');
  check('allocationService calls the gate (not a duplicate implementation)', /require\('\.\/paymentGate'\)/.test(hold) && /await assertHostelFeePaid\(conn, application, room\)/.test(hold));
}

/* ------------------------------------------------------------------ */
/* C. Pre-allocation pricing from the confirmed fee block               */
/* ------------------------------------------------------------------ */

async function testFeePath() {
  console.log('\n[C] feeService: pricing before a room exists');
  reset();
  let a = addApp({ fee_block_id: 1 });
  let fee = await feeService.getHostelFeeForApplication(fakeConn, a.id);
  check('approved, no room, block A confirmed -> 300000.00 from the application\'s OWN session', fee.amount === '300000.00' && fee.amount_minor === 30000000 && fee.block_name === 'Block A' && fee.hostel_session_id === 2);
  check('no room details are invented', fee.allocation_id === null && fee.room_id === null && fee.room_number === null);

  a = addApp({ fee_block_id: 2 });
  check('block B confirmed -> 250000.00', (await feeService.getHostelFeeForApplication(fakeConn, a.id)).amount === '250000.00');

  a = addApp({ fee_block_id: null, preferred_block_id: 1 });
  let e = await rejects(feeService.getHostelFeeForApplication(fakeConn, a.id));
  check('NO confirmed block -> 409 (the preference is NOT used as the fee block)', e && e.statusCode === 409 && /confirmed fee block/.test(e.message) && /active room allocation/.test(e.message), e && e.message);

  a = addApp({ status: 'pending', fee_block_id: 1 });
  e = await rejects(feeService.getHostelFeeForApplication(fakeConn, a.id));
  check('not approved -> 409', e && e.statusCode === 409 && /approved/.test(e.message), e && e.message);

  STATE.fees = STATE.fees.filter((f) => f.block_id !== 2);
  a = addApp({ fee_block_id: 2 });
  e = await rejects(feeService.getHostelFeeForApplication(fakeConn, a.id));
  check('confirmed block with no active fee this session -> 409', e && e.statusCode === 409 && /No hostel fee has been set/.test(e.message), e && e.message);

  reset(); STATE.feeBlockColumn = false;
  a = addApp(); delete a.fee_block_id;
  e = await rejects(feeService.getHostelFeeForApplication(fakeConn, a.id));
  check('migration 019 absent -> same clear 409 (not a crash)', e && e.statusCode === 409 && /confirmed fee block/.test(e.message), e && e.message);

  reset();
  a = addApp({ fee_block_id: 2, allocated_room_id: 24 });
  STATE.allocations.push({ id: 900, application_id: a.id, student_id: 7, room_id: 24, hostel_session_id: 2, status: 'active' });
  fee = await feeService.getHostelFeeForApplication(fakeConn, a.id);
  check('an application that already has a room is priced from the ROOM\'s block (pay-after-allocation unchanged)', fee.block_name === 'Block A' && fee.amount === '300000.00' && fee.allocation_id === 900);
}

/* ------------------------------------------------------------------ */
/* D. Admin API through the real router                                 */
/* ------------------------------------------------------------------ */

function listen(app) {
  return new Promise((resolve) => { const server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(server)); });
}
async function call(server, method, url, { role, body } = {}) {
  const { port } = server.address();
  const headers = { Accept: 'application/json' };
  if (role) headers['x-test-role'] = role;
  const init = { method, headers };
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch(`http://127.0.0.1:${port}${url}`, init);
  let json = null; try { json = await res.json(); } catch (_) { /* none */ }
  return { status: res.status, json };
}

async function testAdminApi() {
  console.log('\n[D] /api/admin/applications (real router, validators, auth, controller)');
  const express = require('express');
  const errorMiddleware = require('../middleware/errorMiddleware');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const role = req.get('x-test-role');
    req.session = role ? { user: { id: role === 'admin' ? 1 : 7, role } } : {};
    next();
  });
  app.use('/api/admin/applications', require('../routes/adminApplications'));
  app.use(errorMiddleware);

  const quiet = { warn: console.warn, error: console.error };
  console.warn = () => {}; console.error = () => {};
  const server = await listen(app);
  const A = { role: 'admin' };

  try {
    // ---- authorisation ----
    reset(); let a = addApp({ status: 'pending', fee_block_id: null, preferred_block_id: 1 });
    for (const [m, u, b] of [['PUT', `/${a.id}/approve`, {}], ['PUT', `/${a.id}/fee-block`, { fee_block_id: 1 }], ['GET', `/${a.id}/fee-block-options`], ['GET', `/${a.id}/fee-block-advisory?block_id=1`], ['GET', `/${a.id}/eligible-rooms`], ['POST', `/${a.id}/allocate`, { room_id: 24 }]]) {
      const noLogin = await call(server, m, `/api/admin/applications${u}`, { body: b });
      const student = await call(server, m, `/api/admin/applications${u}`, { role: 'student', body: b });
      check(`${m} ${u.replace(/\/\d+/, '/:id').split('?')[0]}: 401 without login, 403 for a student`, noLogin.status === 401 && student.status === 403, `${noLogin.status}/${student.status}`);
    }
    // the only statement a rejected caller may cause is the per-request role/activity re-check of the logged-in student
    check('rejected callers caused no database activity beyond the role re-check', SQL_LOG.every((q) => /^SELECT role, is_active FROM users WHERE id = \?$/.test(q)) && appOf(a.id).status === 'pending');

    // ---- approve ----
    reset(); a = addApp({ status: 'pending', fee_block_id: null, preferred_block_id: 1 });
    let r = await call(server, 'PUT', `/api/admin/applications/${a.id}/approve`, { ...A, body: {} });
    check('approve with no body defaults to the student\'s preferred block (A)', r.status === 200 && appOf(a.id).status === 'approved' && appOf(a.id).fee_block_id === 1 && r.json.data.fee_block.name === 'Block A', JSON.stringify(r.json));
    check('approve does NOT allocate a room or touch payments', appOf(a.id).allocated_room_id === null && STATE.allocations.length === 0 && STATE.payments.length === 0);
    check('response carries the advisory with the "does not guarantee a room" disclaimer', r.json.data.advisory && /does not guarantee a room/.test(r.json.data.advisory.disclaimer));
    check('...and an unpaid, approved application shows payment status "unpaid" / not ready', r.json.data.payment.status === 'unpaid' && r.json.data.ready_for_allocation === false);

    reset(); a = addApp({ status: 'pending', fee_block_id: null, preferred_block_id: 1 });
    r = await call(server, 'PUT', `/api/admin/applications/${a.id}/approve`, { ...A, body: { fee_block_id: 2 } });
    check('admin may override the preference: block B confirmed', r.status === 200 && appOf(a.id).fee_block_id === 2 && r.json.data.fee_block.name === 'Block B');

    reset(); a = addApp({ status: 'pending', fee_block_id: null, preferred_block_id: null });
    r = await call(server, 'PUT', `/api/admin/applications/${a.id}/approve`, { ...A, body: {} });
    check('NO preference and no block chosen -> 400, nothing approved (never picked silently)', r.status === 400 && /Choose the block/.test(r.json.message) && appOf(a.id).status === 'pending' && appOf(a.id).fee_block_id === null, JSON.stringify(r.json));

    reset(); a = addApp({ status: 'pending', fee_block_id: null, preferred_block_id: null });
    r = await call(server, 'PUT', `/api/admin/applications/${a.id}/approve`, { ...A, body: { fee_block_id: 2 } });
    check('no preference + admin chooses block B -> approved with B', r.status === 200 && appOf(a.id).fee_block_id === 2);

    reset(); STATE.fees = STATE.fees.filter((f) => f.block_id !== 2); a = addApp({ status: 'pending', fee_block_id: null });
    r = await call(server, 'PUT', `/api/admin/applications/${a.id}/approve`, { ...A, body: { fee_block_id: 2 } });
    check('block without an active fee this session -> 409, not approved', r.status === 409 && /No hostel fee/.test(r.json.message) && appOf(a.id).status === 'pending');

    reset(); a = addApp({ status: 'pending', fee_block_id: null });
    r = await call(server, 'PUT', `/api/admin/applications/${a.id}/approve`, { ...A, body: { fee_block_id: 'abc' } });
    check('non-numeric block -> 400', r.status === 400);

    reset(); a = addApp({ status: 'approved' });
    r = await call(server, 'PUT', `/api/admin/applications/${a.id}/approve`, { ...A, body: {} });
    check('approving an already-approved application -> 409', r.status === 409);

    reset(); STATE.feeBlockColumn = false; a = addApp({ status: 'pending' }); delete a.fee_block_id;
    r = await call(server, 'PUT', `/api/admin/applications/${a.id}/approve`, { ...A, body: {} });
    check('migration 019 not applied -> 503 with a clear message, nothing approved', r.status === 503 && /migration 019/.test(r.json.message) && appOf(a.id).status === 'pending', JSON.stringify(r.json));

    // ---- set fee block ----
    reset(); a = addApp({ fee_block_id: null, preferred_block_id: null });
    r = await call(server, 'PUT', `/api/admin/applications/${a.id}/fee-block`, { ...A, body: { fee_block_id: 1 } });
    check('legacy approved application with no block: admin confirms one -> 200', r.status === 200 && appOf(a.id).fee_block_id === 1 && r.json.data.fee_block.name === 'Block A');
    r = await call(server, 'PUT', `/api/admin/applications/${a.id}/fee-block`, { ...A, body: { fee_block_id: 2 } });
    check('...and may change it while unpaid', r.status === 200 && appOf(a.id).fee_block_id === 2);

    reset(); a = addApp({ fee_block_id: 1 }); addPayment(a, { status: 'success' });
    r = await call(server, 'PUT', `/api/admin/applications/${a.id}/fee-block`, { ...A, body: { fee_block_id: 2 } });
    check('SUCCESSFUL payment exists -> 409, block unchanged', r.status === 409 && /successful payment/.test(r.json.message) && appOf(a.id).fee_block_id === 1, JSON.stringify(r.json));

    reset(); a = addApp({ fee_block_id: 1 }); addPayment(a, { status: 'pending', verified_at: null, paid_at: null });
    r = await call(server, 'PUT', `/api/admin/applications/${a.id}/fee-block`, { ...A, body: { fee_block_id: 2 } });
    check('PENDING payment exists -> 409, block unchanged', r.status === 409 && /in progress/.test(r.json.message) && appOf(a.id).fee_block_id === 1);

    reset(); a = addApp({ fee_block_id: 1 }); addPayment(a, { status: 'failed', verified_at: null, paid_at: null });
    r = await call(server, 'PUT', `/api/admin/applications/${a.id}/fee-block`, { ...A, body: { fee_block_id: 2 } });
    check('only a FAILED attempt exists -> change allowed', r.status === 200 && appOf(a.id).fee_block_id === 2);

    reset(); a = addApp({ fee_block_id: 1 }); addPayment(a, { status: 'pending', payment_type: 'miscellaneous', verified_at: null, paid_at: null });
    r = await call(server, 'PUT', `/api/admin/applications/${a.id}/fee-block`, { ...A, body: { fee_block_id: 2 } });
    check('a pending MISCELLANEOUS charge does not block changing the hostel fee block', r.status === 200);

    reset(); a = addApp({ fee_block_id: 1, allocated_room_id: 24 });
    r = await call(server, 'PUT', `/api/admin/applications/${a.id}/fee-block`, { ...A, body: { fee_block_id: 2 } });
    check('application that already has a room -> 409 (its fee follows the room)', r.status === 409 && /already has a room/.test(r.json.message) && appOf(a.id).fee_block_id === 1);

    reset(); a = addApp({ status: 'pending', fee_block_id: null });
    r = await call(server, 'PUT', `/api/admin/applications/${a.id}/fee-block`, { ...A, body: { fee_block_id: 1 } });
    check('not approved -> 409', r.status === 409);
    r = await call(server, 'PUT', `/api/admin/applications/999/fee-block`, { ...A, body: { fee_block_id: 1 } });
    check('unknown application -> 404', r.status === 404);
    r = await call(server, 'PUT', `/api/admin/applications/${a.id}/fee-block`, { ...A, body: {} });
    check('missing fee_block_id -> 400', r.status === 400);

    // ---- options + advisory ----
    reset(); a = addApp({ fee_block_id: null, preferred_block_id: 2 });
    r = await call(server, 'GET', `/api/admin/applications/${a.id}/fee-block-options`, A);
    check('options: blocks with an active fee this session, with amounts, plus preference', r.status === 200 && r.json.data.blocks.length === 2 && r.json.data.preferred_block_id === 2 && r.json.data.fee_block_id === null && r.json.data.blocks[0].amount === '300000.00', JSON.stringify(r.json));

    reset(); a = addApp({ student_id: 7, fee_block_id: null });
    r = await call(server, 'GET', `/api/admin/applications/${a.id}/fee-block-advisory?block_id=1`, A);
    check('advisory: free spaces counted for room type + gender + block (24 and 25 free; 26 full excluded)', r.status === 200 && r.json.data.available === true && r.json.data.free_spaces === 2 && r.json.data.level === 'ok', JSON.stringify(r.json));
    check('advisory always states that payment does not guarantee a room', /does not guarantee a room/.test(r.json.data.disclaimer));
    check('advisory is read-only (no writes)', writesLog().length === 0);

    reset(); for (const rid of [24, 25]) STATE.rooms[rid].occupied_spaces = 1; a = addApp({ student_id: 7, fee_block_id: null });
    r = await call(server, 'GET', `/api/admin/applications/${a.id}/fee-block-advisory?block_id=1`, A);
    check('advisory: no free space -> level "none"', r.json.data.level === 'none' && r.json.data.free_spaces === 0 && /no free single room spaces/.test(r.json.data.message), r.json.data.message);

    reset(); a = addApp({ student_id: 7, fee_block_id: null });
    addApp({ student_id: 8, fee_block_id: 1 }); addApp({ student_id: 8, fee_block_id: 1 });
    r = await call(server, 'GET', `/api/admin/applications/${a.id}/fee-block-advisory?block_id=1`, A);
    check('advisory: 2 free but 2 other approved applicants already waiting -> "low"', r.json.data.level === 'low' && r.json.data.committed_applicants === 2 && r.json.data.remaining === 0, JSON.stringify(r.json.data));

    reset(); STATE.users[7].gender = null; a = addApp({ fee_block_id: null });
    r = await call(server, 'GET', `/api/admin/applications/${a.id}/fee-block-advisory?block_id=1`, A);
    check('advisory: unknown gender -> reported unavailable, not invented', r.json.data.available === false);

    r = await call(server, 'GET', `/api/admin/applications/${a.id}/fee-block-advisory`, A);
    check('advisory without block_id -> 400', r.status === 400);

    // ---- eligible rooms + payment-aware detail/list ----
    reset(); a = addApp();
    r = await call(server, 'GET', `/api/admin/applications/${a.id}/eligible-rooms`, A);
    check('eligible-rooms for an UNPAID student -> 409 (no room list offered)', r.status === 409 && /payment is required/.test(r.json.message), JSON.stringify(r.json));

    reset(); a = addApp(); addPayment(a, { status: 'pending', verified_at: null, paid_at: null });
    r = await call(server, 'GET', `/api/admin/applications/${a.id}/eligible-rooms`, A);
    check('eligible-rooms with a PENDING payment -> 409 mentioning pending', r.status === 409 && /not been verified/.test(r.json.message));

    reset(); a = addApp(); addPayment(a);
    r = await call(server, 'GET', `/api/admin/applications/${a.id}/eligible-rooms`, A);
    check('eligible-rooms for a PAID Block A student lists ONLY Block A male single rooms with space', r.status === 200 && r.json.data.rooms.map((x) => x.room_number).sort().join() === 'A-101,A-102' && r.json.data.rooms.every((x) => x.block_id === 1), JSON.stringify(r.json.data.rooms.map((x) => x.room_number)));

    reset(); a = addApp();
    r = await call(server, 'POST', `/api/admin/applications/${a.id}/allocate`, { ...A, body: { room_id: 24 } });
    check('HTTP allocate for an unpaid student -> 409 and no allocation', r.status === 409 && /has not paid/.test(r.json.message) && STATE.allocations.length === 0 && roomOf(24).occupied_spaces === 0, JSON.stringify(r.json));
    addPayment(a);
    r = await call(server, 'POST', `/api/admin/applications/${a.id}/allocate`, { ...A, body: { room_id: 24 } });
    check('HTTP allocate after a verified payment -> 201, allocated (existing status code)', r.status === 201 && r.json.data.allocation && r.json.data.allocation.room_number === 'A-101' && roomOf(24).occupied_spaces === 1, JSON.stringify(r.json));
    check('...detail then shows the payment as Paid', r.json.data.payment.status === 'paid' && r.json.data.payment.verified === true);

    reset(); a = addApp(); addPayment(a, { status: 'success', verified_at: null, paid_at: null, gateway_reference: null });
    r = await call(server, 'GET', `/api/admin/applications/${a.id}`, A);
    check('detail: success flag WITHOUT verification evidence is shown as "unverified", not paid', r.json.data.payment.status === 'unverified' && r.json.data.payment.verified === false && r.json.data.ready_for_allocation === false);

    reset(); a = addApp(); addPayment(a, { status: 'failed', verified_at: null, paid_at: null }); addPayment(a, { status: 'pending', verified_at: null, paid_at: null });
    r = await call(server, 'GET', `/api/admin/applications/${a.id}`, A);
    check('detail: latest attempt pending -> "pending"', r.json.data.payment.status === 'pending');

    reset(); a = addApp(); addPayment(a, { status: 'success' }); addPayment(a, { status: 'pending', verified_at: null, paid_at: null, payment_type: 'miscellaneous' });
    r = await call(server, 'GET', `/api/admin/applications/${a.id}`, A);
    check('detail: a newer pending MISCELLANEOUS row cannot hide a paid hostel fee', r.json.data.payment.status === 'paid' && r.json.data.ready_for_allocation === true);

    reset(); a = addApp(); const old = addApp({ hostel_session_id: 1, status: 'cancelled', fee_block_id: null });
    addPayment(a, { status: 'success' });
    r = await call(server, 'GET', `/api/admin/applications`, A);
    const rows = r.json.data;
    check('list: each application shows its own payment status (paid / unpaid)', r.status === 200 && rows.find((x) => x.id === a.id).payment.status === 'paid' && rows.find((x) => x.id === old.id).payment === null || rows.find((x) => x.id === old.id).payment.status === 'unpaid');

    reset(); addApp();
    SQL_LOG = [];
    r = await call(server, 'GET', `/api/admin/applications?payment_status=paid`, A);
    const filterSql = SQL_LOG.find((s) => /^SELECT a\.id, a\.status, a\.room_type/.test(s)) || '';
    check('list filter "paid" requires status success AND verified_at/paid_at/gateway_reference AND hostel type', r.status === 200 && /p\.status = 'success'/.test(filterSql) && /p\.verified_at IS NOT NULL/.test(filterSql) && /p\.paid_at IS NOT NULL/.test(filterSql) && /p\.gateway_reference IS NOT NULL/.test(filterSql) && /p\.payment_type = 'hostel'/.test(filterSql) && /p\.hostel_session_id = a\.hostel_session_id/.test(filterSql), filterSql.slice(0, 200));
    r = await call(server, 'GET', `/api/admin/applications?payment_status=bogus`, A);
    check('list filter with an invalid value -> 400', r.status === 400);
  } finally {
    console.warn = quiet.warn; console.error = quiet.error;
    server.close();
  }
}

/* ------------------------------------------------------------------ */
/* E. Student dashboard                                                 */
/* ------------------------------------------------------------------ */

async function testDashboard() {
  console.log('\n[E] student dashboard payment status + stage');
  let bcryptStubbed = false;
  try { require('bcrypt'); } catch (_) {
    const p = require.resolve('bcrypt');
    require.cache[p] = { id: p, filename: p, loaded: true, exports: { hash: async () => 'x', compare: async () => false } };
    bcryptStubbed = true;
  }
  console.log(`  (bcrypt ${bcryptStubbed ? 'could not load here - stubbed for this test only' : 'loaded normally'})`);
  const { getDashboard, resolvePaymentStage } = require('../controllers/studentController');

  async function dash(studentId) {
    // asyncHandler does not return its promise, so wait for res.json (or next(err)).
    const body = await new Promise((resolve, reject) => {
      getDashboard({ session: { user: { id: studentId, role: 'student' } } }, { json: resolve }, reject);
    });
    return body.data;
  }

  // pure stage rules
  const st = (o) => resolvePaymentStage({ status: 'approved', allocationState: 'awaiting_allocation', hasRoom: false, hasFeeBlock: true, paymentStatus: 'unpaid', ...o });
  check('stage: approved, no block yet -> awaiting_fee_block', st({ hasFeeBlock: false }) === 'awaiting_fee_block');
  check('stage: block confirmed, unpaid -> payment_required', st({}) === 'payment_required');
  check('stage: payment pending -> payment_pending', st({ paymentStatus: 'pending' }) === 'payment_pending');
  check('stage: failed attempt -> still payment_required', st({ paymentStatus: 'failed' }) === 'payment_required');
  check('stage: paid, no room -> paid_awaiting_room', st({ paymentStatus: 'paid' }) === 'paid_awaiting_room');
  check('stage: room allocated and paid -> allocated_paid', st({ paymentStatus: 'paid', hasRoom: true, allocationState: 'allocated' }) === 'allocated_paid');
  check('stage: legacy allocated first, unpaid -> allocated_unpaid (pay-after-allocation preserved)', st({ hasRoom: true, allocationState: 'allocated' }) === 'allocated_unpaid');
  check('stage: pending / rejected applications have no stage', st({ status: 'pending' }) === null && st({ status: 'rejected' }) === null);
  check('stage: revoked allocation keeps its existing dashboard behaviour', st({ allocationState: 'revoked' }) === null);

  reset(); let a = addApp({ student_id: 7 });
  addPayment(a, { status: 'success' });
  addPayment(a, { status: 'pending', verified_at: null, paid_at: null });  // newer, same hostel type
  let d = await dash(7);
  check('a SUCCESSFUL payment wins over a newer pending attempt (the reported discrepancy)', d.payment.status === 'paid', JSON.stringify(d.payment));
  check('...stage is paid_awaiting_room', d.application.payment_stage === 'paid_awaiting_room', d.application.payment_stage);

  reset(); a = addApp({ student_id: 7 });
  addPayment(a, { status: 'success' });
  addPayment(a, { status: 'pending', payment_type: 'miscellaneous', verified_at: null, paid_at: null });
  d = await dash(7);
  check('a newer pending MISCELLANEOUS charge cannot hide the paid hostel fee', d.payment.status === 'paid');

  reset(); a = addApp({ student_id: 7 });
  addPayment(a, { status: 'success', hostel_session_id: 1, hostel_fee_id: 12 });
  d = await dash(7);
  check("another session's payment on this application is ignored", d.payment.status === 'unpaid' && d.application.payment_stage === 'payment_required', JSON.stringify(d.payment));

  reset(); a = addApp({ student_id: 7 });
  addPayment(a, { status: 'success', verified_at: null, paid_at: null, gateway_reference: null });
  d = await dash(7);
  check('success without server verification evidence is NOT shown as paid', d.payment.status === 'pending');

  reset(); a = addApp({ student_id: 7, fee_block_id: null });
  d = await dash(7);
  check('approved with no confirmed block -> stage awaiting_fee_block, unpaid', d.application.payment_stage === 'awaiting_fee_block' && d.payment.status === 'unpaid');

  reset(); a = addApp({ student_id: 7, fee_block_id: 1 });
  d = await dash(7);
  check('block confirmed, unpaid -> stage payment_required, fee_block named', d.application.payment_stage === 'payment_required' && d.application.fee_block === 'Block A');

  reset(); STATE.feeBlockColumn = false; a = addApp({ student_id: 7 }); delete a.fee_block_id;
  d = await dash(7);
  check('migration 019 absent: dashboard still loads (awaiting_fee_block)', d.application.payment_stage === 'awaiting_fee_block');

  reset(); a = addApp({ student_id: 7, allocated_room_id: 24 });
  STATE.allocations.push({ id: 901, application_id: a.id, student_id: 7, room_id: 24, hostel_session_id: 2, status: 'active' });
  d = await dash(7);
  check('legacy: allocated, unpaid -> allocated_unpaid (can still pay after allocation)', d.application.payment_stage === 'allocated_unpaid' && d.room && d.room.room_number === 'A-101');
}

/* ------------------------------------------------------------------ */
/* F. Source hygiene                                                    */
/* ------------------------------------------------------------------ */

function testHygiene() {
  console.log('\n[F] source hygiene');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const gate = code('services/paymentGate.js');
  check('gate: no float parsing (money compared in minor units via utils/money)', !/parseFloat|toFixed/.test(gate) && /decimalToMinor\(/.test(gate));
  check('gate: reads nothing from a request (no req/body/query/session)', !/\breq\b|req\.body|req\.query|req\.session/.test(gate));
  check('gate: no write statements', !/\b(INSERT|UPDATE|DELETE)\b/.test(gate));
  check('payment schema helper is shared, not copied', /require\('\.\/paymentSchema'\)/.test(read('services/paymentService.js')) && /require\('\.\/paymentSchema'\)/.test(read('services/paymentGate.js')));
  check('one allocation writer: only allocationService inserts into allocations', !/INSERT INTO allocations/.test(read('controllers/adminApplicationController.js')) && /INSERT INTO allocations/.test(read('services/allocationService.js')));
  check('capacity advisory is read-only', !/\b(INSERT|UPDATE|DELETE)\b/.test(code('services/capacityAdvisory.js')));
}

(async () => {
  try {
    await testGate();
    await testAllocate();
    await testFeePath();
    await testAdminApi();
    await testDashboard();
    testHygiene();
  } catch (err) {
    fail += 1;
    console.log(`  FAIL unexpected exception :: ${err && err.stack ? err.stack : err}`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
