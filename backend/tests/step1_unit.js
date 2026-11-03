/**
 * tests/step1_unit.js - session -> application -> allocation.
 *
 * Runs WITHOUT a database: config/database is replaced by a small in-memory
 * fake that understands exactly the SQL the two services issue, and every
 * statement is checked against the live column names. It proves the service
 * LOGIC and the PARAMETERS (which session id is read, stored and copied).
 * It does NOT prove the SQL is valid MariaDB - that is the scratch-database
 * gate (tests/step1_scratch_verify.sql + the manual lifecycle run).
 *
 *   node tests/step1_unit.js
 */
const path = require('path');
const fs = require('fs');

const dbPath = require.resolve(path.join(__dirname, '..', 'config', 'database'));
let STATE, SQL_LOG;

function freshState() {
  return {
    sessions: [
      { id: 1, label: '2025/2026', status: 'closed', is_current: 0 },
      { id: 2, label: '2026/2027', status: 'open', is_current: 1 },
    ],
    users: { 7: { gender: 'male' }, 8: { gender: 'male' } },
    rooms: {
      24: { id: 24, room_number: 'R001', room_type: 'single', gender: 'male', capacity: 1, occupied_spaces: 0, is_active: 1, block_id: 1, block_name: 'Block A' },
      25: { id: 25, room_number: 'R002', room_type: 'single', gender: 'male', capacity: 1, occupied_spaces: 0, is_active: 1, block_id: 1, block_name: 'Block A' },
    },
    applications: [],
    allocations: [],
    // payment-before-allocation: allocateRoom now needs a verified successful payment
    blocks: { 1: 'Block A' },
    fees: [{ id: 14, hostel_session_id: 2, block_id: 1, amount: '300000.00', currency: 'NGN', active: 1 }],
    payments: [],
    nextPay: 500,
    nextApp: 100,
    nextAlloc: 200,
  };
}

function exec(sqlRaw, params = []) {
  const sql = sqlRaw.replace(/\s+/g, ' ').trim();
  SQL_LOG.push(sql);
  const S = STATE;
  const cur = () => S.sessions.filter((x) => x.is_current === 1 && x.status === 'open');

  if (/FROM hostel_sessions WHERE is_current = 1 AND status = 'open'/.test(sql)) {
    return [cur().slice(0, 1).map((x) => ({ id: x.id, label: x.label }))];
  }
  if (/^SELECT id, student_id, room_type, status, allocated_room_id, hostel_session_id FROM applications WHERE id = \? FOR UPDATE/.test(sql)) {
    return [S.applications.filter((a) => a.id === params[0]).map((a) => ({ ...a }))];
  }
  if (/^SELECT id, allocated_room_id.* FROM applications WHERE id = \? FOR UPDATE/.test(sql) || /^SELECT .* FROM applications WHERE id = \? FOR UPDATE/.test(sql)) {
    return [S.applications.filter((a) => a.id === params[0]).map((a) => ({ ...a }))];
  }
  if (/FROM allocations WHERE student_id = \? AND hostel_session_id = \? AND status = 'active'/.test(sql)) {
    return [S.allocations.filter((a) => a.student_id === params[0] && a.hostel_session_id === params[1] && a.status === 'active').map((a) => ({ id: a.id }))];
  }
  if (/FROM rooms r JOIN blocks b ON b.id = r.block_id WHERE r.id = \? FOR UPDATE/.test(sql)) {
    const r = S.rooms[params[0]];
    return [r ? [{ ...r }] : []];
  }
  if (/^SELECT gender FROM users WHERE id = \?/.test(sql)) {
    const u = S.users[params[0]];
    return [u ? [{ gender: u.gender }] : []];
  }
  if (/^INSERT INTO allocations \(application_id, student_id, room_id, hostel_session_id, allocated_by\)/.test(sql)) {
    const [application_id, student_id, room_id, hostel_session_id, allocated_by] = params;
    const app = S.applications.find((a) => a.id === application_id);
    // emulate fk_allocations_application_session (composite FK)
    if (!app || app.hostel_session_id !== hostel_session_id) {
      const e = new Error('Cannot add or update a child row: a foreign key constraint fails'); e.code = 'ER_NO_REFERENCED_ROW_2'; throw e;
    }
    S.allocations.push({ id: S.nextAlloc, application_id, student_id, room_id, hostel_session_id, allocated_by, status: 'active' });
    return [{ insertId: S.nextAlloc++, affectedRows: 1 }];
  }
  if (/^UPDATE rooms SET occupied_spaces = occupied_spaces \+ 1 WHERE id = \?/.test(sql)) { S.rooms[params[0]].occupied_spaces += 1; return [{ affectedRows: 1 }]; }
  if (/^UPDATE rooms SET occupied_spaces = occupied_spaces - 1 WHERE id = \?/.test(sql)) { S.rooms[params[0]].occupied_spaces -= 1; return [{ affectedRows: 1 }]; }
  if (/^UPDATE applications SET allocated_room_id = \? WHERE id = \?/.test(sql)) { S.applications.find((a) => a.id === params[1]).allocated_room_id = params[0]; return [{ affectedRows: 1 }]; }
  if (/^UPDATE applications SET allocated_room_id = NULL WHERE id = \?/.test(sql)) { S.applications.find((a) => a.id === params[0]).allocated_room_id = null; return [{ affectedRows: 1 }]; }
  if (/^SELECT id, room_id FROM allocations WHERE application_id = \? AND status = 'active' FOR UPDATE/.test(sql)) {
    return [S.allocations.filter((a) => a.application_id === params[0] && a.status === 'active').map((a) => ({ id: a.id, room_id: a.room_id }))];
  }
  if (/^SELECT id FROM rooms WHERE id = \? FOR UPDATE/.test(sql)) { return [[{ id: params[0] }]]; }
  if (/^SELECT id, occupied_spaces FROM rooms WHERE id = \? FOR UPDATE/.test(sql)) { const r = S.rooms[params[0]]; return [r ? [{ id: r.id, occupied_spaces: r.occupied_spaces }] : []]; }
  if (/^UPDATE allocations SET status = 'released'/.test(sql)) {
    const a = S.allocations.find((x) => x.id === params[1]); a.status = 'released'; a.release_reason = params[0]; return [{ affectedRows: 1 }];
  }
  if (/FROM applications WHERE student_id = \? AND hostel_session_id = \? AND status IN \('pending', ?'approved'\) FOR UPDATE/.test(sql)) {
    return [S.applications.filter((a) => a.student_id === params[0] && a.hostel_session_id === params[1] && ['pending', 'approved'].includes(a.status)).map((a) => ({ id: a.id, status: a.status, allocated_room_id: a.allocated_room_id }))];
  }
  if (/^SELECT status FROM allocations WHERE application_id = \? ORDER BY allocated_at DESC LIMIT 1/.test(sql)) {
    const list = S.allocations.filter((a) => a.application_id === params[0]);
    return [list.length ? [{ status: list[list.length - 1].status }] : []];
  }
  if (/^UPDATE applications SET status = 'cancelled'/.test(sql)) {
    // the application id is the LAST parameter (reapply supersede: [reason, id]; admin cancel: [reason, adminId, id])
    const a = S.applications.find((x) => x.id === params[params.length - 1]);
    if (!a || a.status !== 'approved') return [{ affectedRows: 0 }];
    a.status = 'cancelled';
    if (/allocated_room_id = NULL/.test(sql)) a.allocated_room_id = null;
    a.rejection_reason = params[0];
    return [{ affectedRows: 1 }];
  }
  if (/^INSERT INTO applications \( ?student_id, room_type, preferred_block_id, special_request, hostel_session_id, session_year ?\) VALUES \(\?, \?, \?, \?, \?, \?\)/.test(sql)) {
    const [student_id, room_type, preferred_block_id, special_request, hostel_session_id, session_year] = params;
    // emulate the unique "one live application" key within a session
    if (S.applications.some((a) => a.student_id === student_id && a.hostel_session_id === hostel_session_id && ['pending', 'approved'].includes(a.status))) {
      const e = new Error("Duplicate entry for key 'uq_active_application'"); e.code = 'ER_DUP_ENTRY'; throw e;
    }
    S.applications.push({ id: S.nextApp, student_id, room_type, preferred_block_id, special_request, hostel_session_id, session_year, status: 'pending', allocated_room_id: null });
    return [{ insertId: S.nextApp++, affectedRows: 1 }];
  }
  if (/^SELECT COLUMN_NAME AS column_name FROM information_schema\.COLUMNS WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME = 'payments'/.test(sql)) {
    return [['student_id', 'application_id', 'hostel_session_id', 'hostel_fee_id', 'amount', 'currency', 'payment_reference', 'gateway_reference',
      'payment_gateway', 'payment_channel', 'status', 'verified_at', 'paid_at', 'payment_type', 'original_amount', 'late_fine_applied'].map((c) => ({ column_name: c }))];
  }
  if (/^SELECT fee_block_id FROM applications WHERE id = \?$/.test(sql)) {
    const a = S.applications.find((x) => x.id === params[0]);
    return [a ? [{ fee_block_id: a.fee_block_id === undefined ? null : a.fee_block_id }] : []];
  }
  if (/^SELECT p\.id, p\.student_id, p\.application_id, p\.hostel_session_id, p\.hostel_fee_id, p\.amount, p\.currency, p\.status, p\.payment_reference, p\.gateway_reference, p\.verified_at, p\.paid_at, f\.hostel_session_id AS fee_session_id/.test(sql)) {
    return [S.payments
      .filter((p) => p.application_id === params[0] && p.hostel_session_id === params[1] && p.status === 'success' && p.payment_type === 'hostel')
      .map((p) => {
        const f = S.fees.find((x) => x.id === p.hostel_fee_id);
        return { ...p, fee_session_id: f.hostel_session_id, fee_block_id: f.block_id, fee_amount: f.amount, fee_currency: f.currency, fee_block_name: S.blocks[f.block_id] };
      })];
  }
  if (/^SELECT p\.status FROM payments p WHERE p\.application_id = \? AND p\.hostel_session_id = \? AND p\.payment_type = 'hostel' ORDER BY p\.id DESC LIMIT 1$/.test(sql)) {
    const list = S.payments.filter((p) => p.application_id === params[0] && p.hostel_session_id === params[1] && p.payment_type === 'hostel');
    return [list.length ? [{ status: list[list.length - 1].status }] : []];
  }
  throw new Error('UNMODELLED SQL (the services issued a statement this test does not know): ' + sql);
}

// install the fake BEFORE the services are loaded
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    withTransaction: async (cb) => {
      const snap = JSON.stringify(STATE);
      try { return await cb({ execute: async (s, p) => exec(s, p) }); }
      catch (e) { STATE = JSON.parse(snap); throw e; }   // emulate ROLLBACK
    },
  },
};

const allocationService = require('../services/allocationService');
const { getCurrentSession } = require('../services/hostelSessionService');

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '   <-- ' + detail}`);
}
async function rejects(promise) { try { await promise; return null; } catch (e) { return e; } }
const approve = (id) => { STATE.applications.find((a) => a.id === id).status = 'approved'; };   // controller-level UPDATE, done directly here
// A server-verified successful hostel-fee payment, as paymentService.verifyAndSettle() leaves it.
// allocateRoom now requires one (payment-before-allocation); the tests below that allocate pay first.
const pay = (appId) => {
  const a = STATE.applications.find((x) => x.id === appId);
  STATE.payments.push({
    id: STATE.nextPay++, student_id: a.student_id, application_id: a.id, hostel_session_id: a.hostel_session_id, hostel_fee_id: 14,
    amount: '300000.00', currency: 'NGN', status: 'success', payment_reference: `LASU-${appId}`, gateway_reference: `gw-${appId}`,
    verified_at: '2026-10-10 10:00:00', paid_at: '2026-10-10 10:00:00', payment_type: 'hostel',
  });
};

(async () => {
  // ---- G1 current session ----
  STATE = freshState(); SQL_LOG = [];
  const s = await getCurrentSession({ execute: async (q, p) => exec(q, p) });
  check('G1  current session resolves to 2026/2027 (id 2) from hostel_sessions', s.id === 2 && s.label === '2026/2027', JSON.stringify(s));
  check('G1  query uses is_current / status (live columns)', /is_current = 1 AND status = 'open'/.test(SQL_LOG[0]), SQL_LOG[0]);

  // ---- G2 application stores hostel_session_id ----
  STATE = freshState(); SQL_LOG = [];
  const a1 = await allocationService.createApplication({ studentId: 7, roomType: 'single', preferredBlockId: null, specialRequest: null });
  const app1 = STATE.applications.find((a) => a.id === a1.id);
  check('G2  application stored with hostel_session_id = 2', app1 && app1.hostel_session_id === 2, JSON.stringify(app1));
  check('G2  legacy session_year mirrors the label (2026/2027), not the column default', app1 && app1.session_year === '2026/2027', app1 && app1.session_year);
  check('G2  no student-supplied session is possible (createApplication takes no session argument)', allocationService.createApplication.length === 1);

  // ---- no open session ----
  STATE = freshState(); STATE.sessions[1].status = 'closed'; STATE.sessions[1].is_current = 0; SQL_LOG = [];
  let e = await rejects(allocationService.createApplication({ studentId: 7, roomType: 'single', preferredBlockId: null, specialRequest: null }));
  check('G2b apply with NO open session -> 409 and nothing inserted', e && e.statusCode === 409 && STATE.applications.length === 0, e && e.message);

  // ---- G3/G4/G5 approve -> allocate: same session, room determines block ----
  STATE = freshState(); SQL_LOG = [];
  const a2 = await allocationService.createApplication({ studentId: 7, roomType: 'single', preferredBlockId: null, specialRequest: null });
  approve(a2.id); pay(a2.id);
  const r = await allocationService.allocateRoom({ applicationId: a2.id, roomId: 24, adminId: 1 });
  const alloc = STATE.allocations[0];
  check('G3  application approval precondition holds (status approved) and allocation succeeds', r && r.allocation_id === alloc.id);
  check('G4  allocation hostel_session_id equals the application\'s (2)', alloc.hostel_session_id === 2 && alloc.hostel_session_id === STATE.applications[0].hostel_session_id, JSON.stringify(alloc));
  check('G5  allocated room determines the block (R001 -> Block A, block_id 1)', r.room_number === 'R001' && r.block_id === 1 && r.block_name === 'Block A', JSON.stringify(r));
  check('G5  room occupancy 1 and application points at the room', STATE.rooms[24].occupied_spaces === 1 && STATE.applications[0].allocated_room_id === 24);

  // ---- G6 wrong session rejected ----
  STATE = freshState(); SQL_LOG = [];
  STATE.applications.push({ id: 50, student_id: 8, room_type: 'single', status: 'approved', allocated_room_id: null, hostel_session_id: 1, session_year: '2025/2026' });
  e = await rejects(allocationService.allocateRoom({ applicationId: 50, roomId: 25, adminId: 1 }));
  check('G6  application from the CLOSED session cannot be allocated (409, names 2026/2027)', e && e.statusCode === 409 && /current hostel session \(2026\/2027\)/.test(e.message), e && e.message);
  check('G6  nothing was written (no allocation, no occupancy change)', STATE.allocations.length === 0 && STATE.rooms[25].occupied_spaces === 0);
  STATE = freshState();
  STATE.applications.push({ id: 51, student_id: 8, room_type: 'single', status: 'approved', allocated_room_id: null, hostel_session_id: 2, session_year: '2026/2027' });
  STATE.sessions[1].status = 'closed'; STATE.sessions[1].is_current = 0;
  e = await rejects(allocationService.allocateRoom({ applicationId: 51, roomId: 25, adminId: 1 }));
  check('G6  allocation with NO open session -> 409', e && e.statusCode === 409 && /No hostel session is currently open/.test(e.message), e && e.message);

  // ---- G7 full lifecycle ----
  STATE = freshState(); SQL_LOG = [];
  const L1 = await allocationService.createApplication({ studentId: 7, roomType: 'single', preferredBlockId: null, specialRequest: null });  // apply
  approve(L1.id); pay(L1.id);                                                                                                          // approve + pay
  await allocationService.allocateRoom({ applicationId: L1.id, roomId: 24, adminId: 1 });                                              // allocate
  await allocationService.revokeAllocation({ applicationId: L1.id, reason: 'room not available', adminId: 1 });                         // revoke
  check('G7  after revoke: allocation released, room free, application still approved',
    STATE.allocations[0].status === 'released' && STATE.rooms[24].occupied_spaces === 0 && STATE.applications[0].status === 'approved' && STATE.applications[0].allocated_room_id === null);
  const L2 = await allocationService.createApplication({ studentId: 7, roomType: 'single', preferredBlockId: null, specialRequest: null });  // reapply
  check('G7  reapply: old revoked application superseded (cancelled), new one pending in session 2',
    STATE.applications.find((a) => a.id === L1.id).status === 'cancelled' && STATE.applications.find((a) => a.id === L2.id).status === 'pending' && STATE.applications.find((a) => a.id === L2.id).hostel_session_id === 2);
  approve(L2.id); pay(L2.id);
  await allocationService.allocateRoom({ applicationId: L2.id, roomId: 24, adminId: 1 });                                              // allocate again
  const act = STATE.allocations.filter((a) => a.status === 'active');
  check('G7  allocate again: one active allocation in session 2, room occupied 1, released history kept',
    act.length === 1 && act[0].hostel_session_id === 2 && act[0].application_id === L2.id && STATE.rooms[24].occupied_spaces === 1 && STATE.allocations.length === 2);

  // ---- G8 old-session history does not interfere ----
  STATE = freshState(); SQL_LOG = [];
  STATE.applications.push({ id: 60, student_id: 7, room_type: 'single', status: 'approved', allocated_room_id: null, hostel_session_id: 1, session_year: '2025/2026' });
  STATE.allocations.push({ id: 61, application_id: 60, student_id: 7, room_id: 24, hostel_session_id: 1, status: 'released' });
  const H = await allocationService.createApplication({ studentId: 7, roomType: 'single', preferredBlockId: null, specialRequest: null });
  check('G8  a closed-session approved/released application is NOT superseded by a new-session application',
    STATE.applications.find((a) => a.id === 60).status === 'approved' && STATE.applications.find((a) => a.id === H.id).hostel_session_id === 2);

  // ---- G9 no old names / hard-coded labels in the session and allocation services ----
  const files = ['services/hostelSessionService.js', 'services/allocationService.js'].map((f) => [f, fs.readFileSync(path.join(__dirname, '..', f), 'utf8')]);
  for (const [f, src] of files) {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check(`G9  ${f}: no bare session_id (only hostel_session_id)`, !/(?<!hostel_)\bsession_id\b/.test(code));
    check(`G9  ${f}: no hostel_sessions.name / is_active / getActiveSession`, !/getActiveSession|\bis_active\s*=\s*1.*hostel_sessions|hostel_sessions[^`]*\bname\b/.test(code) && !/session\.name/.test(code));
    check(`G9  ${f}: no hard-coded session label (20xx/20xx)`, !/\b20\d{2}\/20\d{2}\b/.test(code));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('TEST HARNESS ERROR:', err); process.exit(2); });
