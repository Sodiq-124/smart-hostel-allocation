/**
 * tests/step3_fee_unit.js - services/feeService.js
 *
 * Runs WITHOUT a database: `conn` is a small in-memory fake that understands
 * exactly the SQL feeService issues. It proves the service LOGIC, the
 * PARAMETERS (which session / block / application ids are used) and the
 * error mapping. It does NOT prove the SQL is valid MariaDB 10.4 against the
 * real schema - that is what tests/step3_scratch_verify.sql is for (run it
 * on smart_hostel_scratch, never on smart_hostel).
 *
 *   node tests/step3_fee_unit.js
 */
const fs = require('fs');
const path = require('path');
const feeService = require('../services/feeService');

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

// Mirrors the verified scratch data (hostel_fees ids 1,2,14-17; sessions 1 & 2; blocks A-D).
function freshState() {
  return {
    fees: [
      { id: 1, block_id: null, hostel_session_id: 1, room_type: 'single', amount: '150000.00', currency: 'NGN', active: 0 },
      { id: 2, block_id: null, hostel_session_id: 1, room_type: 'shared', amount: '100000.00', currency: 'NGN', active: 0 },
      { id: 14, block_id: 1, hostel_session_id: 2, room_type: null, amount: '300000.00', currency: 'NGN', active: 1 },
      { id: 15, block_id: 2, hostel_session_id: 2, room_type: null, amount: '250000.00', currency: 'NGN', active: 1 },
      { id: 16, block_id: 3, hostel_session_id: 2, room_type: null, amount: '200000.00', currency: 'NGN', active: 1 },
      { id: 17, block_id: 4, hostel_session_id: 2, room_type: null, amount: '150000.00', currency: 'NGN', active: 1 },
    ],
    blocks: { 1: 'Block A', 2: 'Block B', 3: 'Block C', 4: 'Block D' },
    rooms: {
      24: { id: 24, room_number: 'R001', room_type: 'single', block_id: 1 },
      30: { id: 30, room_number: 'R101', room_type: 'shared', block_id: 2 },
      40: { id: 40, room_number: 'R201', room_type: 'single', block_id: 3 },
      50: { id: 50, room_number: 'R301', room_type: 'shared', block_id: 4 },
    },
    applications: [
      { id: 101, student_id: 7, status: 'approved', allocated_room_id: 24, hostel_session_id: 2 },
      { id: 102, student_id: 8, status: 'approved', allocated_room_id: 30, hostel_session_id: 2 },
      { id: 103, student_id: 9, status: 'approved', allocated_room_id: 40, hostel_session_id: 2 },
      { id: 104, student_id: 10, status: 'approved', allocated_room_id: 50, hostel_session_id: 2 },
      { id: 105, student_id: 11, status: 'approved', allocated_room_id: null, hostel_session_id: 2 }, // revoked
      { id: 106, student_id: 12, status: 'approved', allocated_room_id: 24, hostel_session_id: 1 },   // old session
    ],
    allocations: [
      { id: 201, application_id: 101, student_id: 7, room_id: 24, hostel_session_id: 2, status: 'active' },
      { id: 202, application_id: 102, student_id: 8, room_id: 30, hostel_session_id: 2, status: 'active' },
      { id: 203, application_id: 103, student_id: 9, room_id: 40, hostel_session_id: 2, status: 'active' },
      { id: 204, application_id: 104, student_id: 10, room_id: 50, hostel_session_id: 2, status: 'active' },
      { id: 205, application_id: 105, student_id: 11, room_id: 24, hostel_session_id: 2, status: 'released' },
      { id: 206, application_id: 106, student_id: 12, room_id: 24, hostel_session_id: 1, status: 'active' },
    ],
  };
}

let STATE;
let SQL_LOG;

const conn = {
  async execute(sqlRaw, params = []) {
    const sql = sqlRaw.replace(/\s+/g, ' ').trim();
    SQL_LOG.push({ sql, params });
    const S = STATE;

    if (/^SELECT id, hostel_session_id, block_id, amount, currency FROM hostel_fees WHERE hostel_session_id = \? AND block_id = \? AND active = 1/.test(sql)) {
      return [S.fees
        .filter((f) => f.hostel_session_id === params[0] && f.block_id === params[1] && f.active === 1)
        .map((f) => ({ id: f.id, hostel_session_id: f.hostel_session_id, block_id: f.block_id, amount: f.amount, currency: f.currency }))];
    }
    if (/^SELECT id, student_id, status, allocated_room_id, hostel_session_id FROM applications WHERE id = \?/.test(sql)) {
      return [S.applications.filter((a) => a.id === params[0]).map((a) => ({ ...a }))];
    }
    if (/^SELECT id, application_id, student_id, room_id, hostel_session_id FROM allocations WHERE application_id = \? AND hostel_session_id = \? AND status = 'active'/.test(sql)) {
      return [S.allocations
        .filter((a) => a.application_id === params[0] && a.hostel_session_id === params[1] && a.status === 'active')
        .map((a) => ({ ...a }))];
    }
    if (/^SELECT r\.id AS room_id, r\.room_number, r\.room_type, r\.block_id, b\.name AS block_name FROM rooms r JOIN blocks b ON b\.id = r\.block_id WHERE r\.id = \?/.test(sql)) {
      const r = S.rooms[params[0]];
      return [r && S.blocks[r.block_id] ? [{ room_id: r.id, room_number: r.room_number, room_type: r.room_type, block_id: r.block_id, block_name: S.blocks[r.block_id] }] : []];
    }
    if (/^SELECT fee_block_id FROM applications WHERE id = \?$/.test(sql)) {
      const a = S.applications.find((x) => x.id === params[0]);
      return [a ? [{ fee_block_id: a.fee_block_id === undefined ? null : a.fee_block_id }] : []];
    }
    if (/^SELECT id, name FROM blocks WHERE id = \?$/.test(sql)) {
      return [S.blocks[params[0]] ? [{ id: params[0], name: S.blocks[params[0]] }] : []];
    }
    throw new Error(`FAKE CONN: unexpected SQL: ${sql}`);
  },
};

(async () => {
  // ---------------- getBlockFee ----------------
  STATE = freshState(); SQL_LOG = [];
  const expected = [[1, '300000.00', 30000000, 14], [2, '250000.00', 25000000, 15], [3, '200000.00', 20000000, 16], [4, '150000.00', 15000000, 17]];
  for (const [blockId, amount, minor, feeId] of expected) {
    const fee = await feeService.getBlockFee(conn, 2, blockId);
    check(`F1  session 2, block ${blockId}: fee ${feeId}, "${amount}", ${minor} kobo, NGN`,
      fee.hostel_fee_id === feeId && fee.amount === amount && fee.amount_minor === minor && fee.currency === 'NGN' &&
      fee.hostel_session_id === 2 && fee.block_id === blockId, JSON.stringify(fee));
  }
  check('F1  exact return shape (6 keys, no extras)', Object.keys(await feeService.getBlockFee(conn, 2, 1)).sort().join() ===
    'amount,amount_minor,block_id,currency,hostel_fee_id,hostel_session_id');

  let e = await rejects(feeService.getBlockFee(conn, 1, 1));
  check('F2  session 1 (only inactive legacy rows) -> 409, not a guess', e && e.statusCode === 409 && /No hostel fee has been set/.test(e.message), e && e.message);
  e = await rejects(feeService.getBlockFee(conn, 3, 1));
  check('F2  session with no fees -> 409', e && e.statusCode === 409);
  e = await rejects(feeService.getBlockFee(conn, 2, 99));
  check('F2  unknown block -> 409', e && e.statusCode === 409);

  STATE = freshState();
  STATE.fees.push({ id: 90, block_id: 1, hostel_session_id: 2, room_type: null, amount: '1.00', currency: 'NGN', active: 0 });
  const only = await feeService.getBlockFee(conn, 2, 1);
  check('F3  an inactive fee for the same session+block is ignored', only.hostel_fee_id === 14 && only.amount_minor === 30000000);

  STATE = freshState();
  STATE.fees.push({ id: 91, block_id: 1, hostel_session_id: 2, room_type: null, amount: '1.00', currency: 'NGN', active: 1 });
  e = await rejects(feeService.getBlockFee(conn, 2, 1));
  check('F4  two ACTIVE fees for one session+block -> 500, no arbitrary pick', e && e.statusCode === 500 && /More than one active hostel fee/.test(e.message), e && e.message);

  for (const [label, patch] of [
    ['unsupported currency', { currency: 'USD' }],
    ['zero amount', { amount: '0.00' }],
    ['negative amount', { amount: '-1.00' }],
    ['negative full-size amount', { amount: '-300000.00' }],
    ['malformed amount', { amount: '12abc' }],
    ['3-decimal amount', { amount: '100.001' }],
  ]) {
    STATE = freshState();
    Object.assign(STATE.fees.find((f) => f.id === 14), patch);
    e = await rejects(feeService.getBlockFee(conn, 2, 1));
    check(`F5  ${label} -> 500 "fee is not valid"`, e && e.statusCode === 500 && /not valid/.test(e.message), e && e.message);
  }

  STATE = freshState(); SQL_LOG = [];
  for (const [label, s, b] of [['session 0', 0, 1], ['session -1', -1, 1], ['session "2"', '2', 1], ['session 1.5', 1.5, 1], ['block null', 2, null], ['block undefined', 2, undefined], ['block "1"', 2, '1']]) {
    e = await rejects(feeService.getBlockFee(conn, s, b));
    check(`F6  ${label} -> 400, no SQL issued`, e && e.statusCode === 400, e && e.message);
  }
  check('F6  invalid ids never reached the database', SQL_LOG.length === 0);

  // ---------------- getHostelFeeForApplication ----------------
  STATE = freshState(); SQL_LOG = [];
  const wanted = [[101, 7, 201, 24, 'R001', 'single', 1, 'Block A', 14, '300000.00', 30000000],
    [102, 8, 202, 30, 'R101', 'shared', 2, 'Block B', 15, '250000.00', 25000000],
    [103, 9, 203, 40, 'R201', 'single', 3, 'Block C', 16, '200000.00', 20000000],
    [104, 10, 204, 50, 'R301', 'shared', 4, 'Block D', 17, '150000.00', 15000000]];
  for (const [appId, studentId, allocId, roomId, roomNo, roomType, blockId, blockName, feeId, amount, minor] of wanted) {
    const r = await feeService.getHostelFeeForApplication(conn, appId);
    check(`F7  application ${appId} -> ${blockName}, fee ${feeId}, ${amount} (${minor} kobo)`,
      r.application_id === appId && r.student_id === studentId && r.allocation_id === allocId && r.room_id === roomId &&
      r.room_number === roomNo && r.room_type === roomType && r.block_id === blockId && r.block_name === blockName &&
      r.hostel_fee_id === feeId && r.amount === amount && r.amount_minor === minor && r.currency === 'NGN' &&
      r.hostel_session_id === 2 && r.application_status === 'approved', JSON.stringify(r));
  }
  STATE = freshState(); STATE.rooms[24].room_type = 'shared';
  const flipped = await feeService.getHostelFeeForApplication(conn, 101);
  check('F7  room_type does not influence the price (same Block A room flipped single -> shared: still 300000.00)', flipped.room_type === 'shared' && flipped.amount === '300000.00' && flipped.hostel_fee_id === 14);

  e = await rejects(feeService.getHostelFeeForApplication(conn, 9999));
  check('F8  unknown application -> 404', e && e.statusCode === 404, e && e.message);
  e = await rejects(feeService.getHostelFeeForApplication(conn, 105));
  check('F8  revoked application (only a released allocation) -> 409', e && e.statusCode === 409 && /active room allocation/.test(e.message), e && e.message);
  for (const bad of [0, -3, '101', 1.5, null, undefined]) {
    e = await rejects(feeService.getHostelFeeForApplication(conn, bad));
    check(`F8  invalid application id ${JSON.stringify(bad)} -> 400`, e && e.statusCode === 400);
  }

  // ---- session isolation ----
  STATE = freshState(); SQL_LOG = [];
  e = await rejects(feeService.getHostelFeeForApplication(conn, 106));
  check('F9  application in session 1 is priced from session 1 only: no session-1 block fee -> 409 (NOT the session-2 fee)',
    e && e.statusCode === 409 && /No hostel fee has been set/.test(e.message), e && e.message);
  const feeSql = SQL_LOG.find((x) => /FROM hostel_fees/.test(x.sql));
  check('F9  the fee query used the APPLICATION\'s session (1), not the current session (2)', feeSql && feeSql.params[0] === 1 && feeSql.params[1] === 1, JSON.stringify(feeSql && feeSql.params));

  STATE = freshState();
  STATE.allocations.push({ id: 300, application_id: 101, student_id: 7, room_id: 50, hostel_session_id: 1, status: 'active' }); // other-session row for same application
  const iso = await feeService.getHostelFeeForApplication(conn, 101);
  check('F9  an active allocation from another session for the same application is ignored', iso.room_id === 24 && iso.block_name === 'Block A' && iso.amount_minor === 30000000);

  STATE = freshState();
  STATE.fees.push({ id: 95, block_id: 1, hostel_session_id: 1, room_type: null, amount: '5.00', currency: 'NGN', active: 1 });
  const s1 = await feeService.getHostelFeeForApplication(conn, 106);
  check('F9  once session 1 has a Block A fee, application 106 gets that (5.00), never session 2\'s 300000.00', s1.hostel_fee_id === 95 && s1.amount === '5.00' && s1.amount_minor === 500);

  // ---- inconsistent / ambiguous data is rejected ----
  STATE = freshState();
  STATE.allocations.push({ id: 301, application_id: 101, student_id: 7, room_id: 30, hostel_session_id: 2, status: 'active' });
  e = await rejects(feeService.getHostelFeeForApplication(conn, 101));
  check('F10 two active allocations for one application+session -> 500, not the first row', e && e.statusCode === 500 && /more than one active room allocation/.test(e.message), e && e.message);

  STATE = freshState(); STATE.allocations.find((a) => a.id === 201).student_id = 99;
  e = await rejects(feeService.getHostelFeeForApplication(conn, 101));
  check('F10 allocation.student_id differs from application.student_id -> 500', e && e.statusCode === 500 && /inconsistent/.test(e.message), e && e.message);

  STATE = freshState(); STATE.applications.find((a) => a.id === 101).allocated_room_id = 30;
  e = await rejects(feeService.getHostelFeeForApplication(conn, 101));
  check('F10 applications.allocated_room_id differs from the active allocation room -> 500', e && e.statusCode === 500 && /inconsistent/.test(e.message), e && e.message);

  STATE = freshState(); STATE.applications.find((a) => a.id === 101).allocated_room_id = null;
  e = await rejects(feeService.getHostelFeeForApplication(conn, 101));
  check('F10 active allocation but allocated_room_id NULL -> 500', e && e.statusCode === 500 && /inconsistent/.test(e.message), e && e.message);

  STATE = freshState(); delete STATE.rooms[24];
  e = await rejects(feeService.getHostelFeeForApplication(conn, 101));
  check('F10 allocated room missing -> 500', e && e.statusCode === 500 && /room allocated/.test(e.message), e && e.message);

  STATE = freshState(); STATE.fees = STATE.fees.filter((f) => f.id !== 14);
  e = await rejects(feeService.getHostelFeeForApplication(conn, 101));
  check('F10 allocated block has no 2026/2027 fee -> 409', e && e.statusCode === 409 && /No hostel fee/.test(e.message), e && e.message);

  // ---------------- SQL hygiene (every statement captured above) ----------------
  STATE = freshState(); SQL_LOG = [];
  await feeService.getHostelFeeForApplication(conn, 101);
  await feeService.getBlockFee(conn, 2, 3);
  check('S1  statements captured', SQL_LOG.length === 5, SQL_LOG.length);
  for (const { sql, params } of SQL_LOG) {
    const marks = (sql.match(/\?/g) || []).length;
    check(`S1  parameterised (${marks} ? == ${params.length} params): ${sql.slice(0, 48)}...`, marks === params.length && !/\$\{|'\s*\+\s*|"\s*\+\s*/.test(sql));
    check('S1  no bare session_id (hostel_session_id only)', !/(?<!hostel_)\bsession_id\b/.test(sql));
    check('S1  no MySQL-8-only FOR SHARE', !/FOR SHARE/i.test(sql));
  }
  const locked = SQL_LOG.filter((x) => /LOCK IN SHARE MODE$/.test(x.sql)).map((x) => x.sql.match(/FROM (\w+)/)[1]);
  const lockedTables = [...new Set(locked)].sort().join();
  check('S2  shared locks only on hostel_fees, applications, allocations', lockedTables === 'allocations,applications,hostel_fees', lockedTables);
  check('S2  the rooms/blocks join is NOT locked (no stall on occupancy updates)', !SQL_LOG.some((x) => /FROM rooms/.test(x.sql) && /LOCK IN SHARE MODE/.test(x.sql)));
  const feeQ = SQL_LOG.find((x) => /FROM hostel_fees/.test(x.sql));
  check('S3  fee query filters hostel_session_id, block_id and active = 1', /hostel_session_id = \?/.test(feeQ.sql) && /block_id = \?/.test(feeQ.sql) && /active = 1/.test(feeQ.sql));
  const appFeeCall = SQL_LOG.find((x) => /FROM hostel_fees/.test(x.sql));
  check('S3  application 101 fee query used (session 2, block 1) taken from the database rows', appFeeCall.params.join() === '2,1', appFeeCall.params.join());

  // ---------------- source hygiene ----------------
  const code = fs.readFileSync(path.join(__dirname, '..', 'services', 'feeService.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('H1  feeService source: no bare session_id', !/(?<!hostel_)\bsession_id\b/.test(code));
  check('H1  feeService source: no hard-coded session label (20xx/20xx)', !/\b20\d{2}\/20\d{2}\b/.test(code));
  check('H1  feeService source: no room_type in any SQL (price is block-based)', !/room_type\s*=/.test(code));
  check('H1  feeService source: reuses decimalToMinor from utils/money', /require\('\.\.\/utils\/money'\)/.test(code) && /decimalToMinor\(/.test(code));
  check('H1  feeService source: no float parsing', !/parseFloat|toFixed|Number\(/.test(code));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('TEST HARNESS ERROR:', err); process.exit(2); });
