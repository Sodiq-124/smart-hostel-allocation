/**
 * tests/step2_session_unit.js - admin session management
 *
 * Runs WITHOUT a database. config/database is replaced by a small in-memory
 * fake that understands exactly the SQL services/adminSessionService.js
 * issues (and throws on any SQL it does not recognise, so a changed query
 * cannot pass silently). It serialises transactions the way
 * "SELECT ... FOR UPDATE" would, so the concurrency tests are meaningful.
 *
 * What this proves: the rules (label, dates, forward-only lifecycle, one open
 * session, no back-dated sessions), transaction/rollback behaviour, that only
 * hostel_sessions is ever written, and the HTTP layer (401/403/400/404/409,
 * validation, mass-assignment) through the real router, validators,
 * requireRole and errorMiddleware.
 *
 * What it does NOT prove: that the SQL is valid MariaDB 10.4 against the real
 * hostel_sessions table, or how any real trigger/constraint behaves. That
 * needs read-only checks against the real database, run by you.
 *
 *   node tests/step2_session_unit.js
 */

const path = require('path');
const http = require('http');

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

/* ------------------------------------------------------------------ */
/* In-memory fake database                                             */
/* ------------------------------------------------------------------ */

function freshState() {
  return {
    sessions: [
      { id: 1, label: '2025/2026', status: 'closed', is_current: 0, starts_on: null, ends_on: null,
        created_at: '2025-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' },
      { id: 2, label: '2026/2027', status: 'open', is_current: 1, starts_on: null, ends_on: null,
        created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' },
    ],
    nextId: 3,
    counts: { 1: { total: 5, pending: 0, noRoom: 0, active: 2 }, 2: { total: 9, pending: 3, noRoom: 2, active: 4 } },
    forceDupOnInsert: false, // simulate the database's unique key firing
    raceOnUpdate: false,     // simulate another writer changing the row first
  };
}

let STATE;
let SQL_LOG;       // every statement, in order, with its transaction number
let TX_COUNT;
let COMMITS;
let ROLLBACKS;
let txChain = Promise.resolve();

function norm(sql) { return sql.replace(/\s+/g, ' ').trim(); }

function withCounts(s) {
  const c = STATE.counts[s.id] || { total: 0, pending: 0, noRoom: 0, active: 0 };
  return {
    ...s,
    applications_total: c.total,
    applications_pending: c.pending,
    applications_awaiting_room: c.noRoom,
    active_allocations: c.active,
  };
}

function makeConn(txId) {
  return {
    async execute(sqlRaw, params = []) {
      const sql = norm(sqlRaw);
      SQL_LOG.push({ tx: txId, sql });

      if (sql === 'SELECT id, label, status, is_current FROM hostel_sessions ORDER BY label FOR UPDATE') {
        const rows = STATE.sessions
          .map((s) => ({ id: s.id, label: s.label, status: s.status, is_current: s.is_current }))
          .sort((a, b) => (a.label < b.label ? -1 : 1));
        return [rows];
      }

      if (sql === "INSERT INTO hostel_sessions (label, status, is_current, starts_on, ends_on) VALUES (?, 'upcoming', 0, ?, ?)") {
        if (STATE.forceDupOnInsert || STATE.sessions.some((s) => s.label === params[0])) {
          const err = new Error("Duplicate entry for key 'uq_hostel_sessions_label'");
          err.code = 'ER_DUP_ENTRY';
          throw err;
        }
        const row = {
          id: STATE.nextId++, label: params[0], status: 'upcoming', is_current: 0,
          starts_on: params[1], ends_on: params[2],
          created_at: '2026-10-10 10:00:00', updated_at: '2026-10-10 10:00:00',
        };
        STATE.sessions.push(row);
        return [{ insertId: row.id, affectedRows: 1 }];
      }

      if (sql === "UPDATE hostel_sessions SET status = 'open', is_current = 1 WHERE id = ? AND status = 'upcoming'") {
        const row = STATE.sessions.find((s) => s.id === params[0]);
        if (STATE.raceOnUpdate || !row || row.status !== 'upcoming') return [{ affectedRows: 0 }];
        row.status = 'open'; row.is_current = 1;
        return [{ affectedRows: 1 }];
      }

      if (sql === "UPDATE hostel_sessions SET status = 'closed', is_current = 0 WHERE id = ? AND status = 'open'") {
        const row = STATE.sessions.find((s) => s.id === params[0]);
        if (STATE.raceOnUpdate || !row || row.status !== 'open') return [{ affectedRows: 0 }];
        row.status = 'closed'; row.is_current = 0;
        return [{ affectedRows: 1 }];
      }

      if (sql.startsWith('SELECT s.id, s.label, s.status, s.starts_on, s.ends_on, s.is_current,') &&
          sql.includes('FROM hostel_sessions s')) {
        if (sql.endsWith('WHERE s.id = ?')) {
          return [STATE.sessions.filter((s) => s.id === params[0]).map(withCounts)];
        }
        if (sql.endsWith('ORDER BY s.label DESC')) {
          return [[...STATE.sessions].sort((a, b) => (a.label < b.label ? 1 : -1)).map(withCounts)];
        }
        if (sql.endsWith("WHERE s.is_current = 1 AND s.status = 'open' LIMIT 1")) {
          return [STATE.sessions.filter((s) => s.is_current === 1 && s.status === 'open').slice(0, 1).map(withCounts)];
        }
      }

      throw new Error(`step2 fake database: unrecognised SQL: ${sql}`);
    },
  };
}

const fakePool = { execute: (sql, params) => makeConn(0).execute(sql, params) };

async function fakeWithTransaction(callback) {
  // Serialise transactions: this is what the FOR UPDATE row locks achieve.
  const run = txChain.then(async () => {
    TX_COUNT += 1;
    const txId = TX_COUNT;
    const snapshot = JSON.parse(JSON.stringify(STATE.sessions));
    try {
      const result = await callback(makeConn(txId));
      COMMITS += 1;
      return result;
    } catch (err) {
      STATE.sessions = snapshot; // rollback
      ROLLBACKS += 1;
      throw err;
    }
  });
  txChain = run.catch(() => {});
  return run;
}

// Inject the fake BEFORE the service (or the routes) load config/database.
const dbPath = require.resolve('../config/database');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    pool: fakePool,
    query: async () => [],
    // answers the per-request role/activity re-check in middleware/authMiddleware.js (id 1 = admin, id 7 = student)
    queryOne: async (sql, p) => (/FROM users WHERE id = \?/.test(sql) ? { role: Number(p[0]) === 1 ? 'admin' : 'student', is_active: 1 } : null),
    withTransaction: fakeWithTransaction,
    testConnection: async () => true,
  },
};

const svc = require('../services/adminSessionService');
const rules = require('../utils/sessionRules');

function reset() {
  STATE = freshState();
  SQL_LOG = [];
  TX_COUNT = 0;
  COMMITS = 0;
  ROLLBACKS = 0;
  txChain = Promise.resolve();
}

function currentCount() {
  return STATE.sessions.filter((s) => s.is_current === 1).length;
}
function writes() {
  return SQL_LOG.filter((e) => /^(INSERT|UPDATE|DELETE|REPLACE|TRUNCATE|DROP|ALTER)/i.test(e.sql));
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

async function testRules() {
  console.log('\n[pure rules] utils/sessionRules.js');
  check('2026/2027 parses', rules.parseSessionLabel('2026/2027').startYear === 2026);
  for (const bad of ['2026/2028', '2026/2026', '2027/2026', '2026-2027', '26/27', '2026/27', '', ' 2026/2027', '2026/2027 ', null, undefined, 20262027, '2026/2027/2028', 'abcd/efgh']) {
    const err = (() => { try { rules.parseSessionLabel(bad); return null; } catch (e) { return e; } })();
    check(`label ${JSON.stringify(bad)} rejected (400)`, err && err.statusCode === 400, err && err.message);
  }
  check('start year 1999 rejected', (() => { try { rules.parseSessionLabel('1999/2000'); return false; } catch (e) { return e.statusCode === 400; } })());
  check('start year 2100 rejected', (() => { try { rules.parseSessionLabel('2100/2101'); return false; } catch (e) { return e.statusCode === 400; } })());

  const ok = rules.validateSessionDates({ starts_on: '2027-09-01', ends_on: '2028-07-31' });
  check('valid date range accepted', ok.starts_on === '2027-09-01' && ok.ends_on === '2028-07-31');
  check('same-day range accepted', rules.validateSessionDates({ starts_on: '2027-09-01', ends_on: '2027-09-01' }).ends_on === '2027-09-01');
  check('both dates optional', rules.validateSessionDates({}).starts_on === null);
  check('empty strings treated as absent', rules.validateSessionDates({ starts_on: '', ends_on: '' }).ends_on === null);
  check('only start accepted', rules.validateSessionDates({ starts_on: '2027-09-01' }).ends_on === null);
  const throwsDates = (v) => { try { rules.validateSessionDates(v); return null; } catch (e) { return e; } };
  check('end before start rejected', throwsDates({ starts_on: '2027-09-02', ends_on: '2027-09-01' }).statusCode === 400);
  check('2027-02-30 rejected', throwsDates({ starts_on: '2027-02-30' }).statusCode === 400);
  check('2027-13-01 rejected', throwsDates({ starts_on: '2027-13-01' }).statusCode === 400);
  check('01/09/2027 format rejected', throwsDates({ starts_on: '01/09/2027' }).statusCode === 400);
  check('leap day 2028-02-29 accepted', rules.validateSessionDates({ starts_on: '2028-02-29' }).starts_on === '2028-02-29');
  check('2027-02-29 rejected (not a leap year)', throwsDates({ starts_on: '2027-02-29' }).statusCode === 400);
  check('non-string date rejected', throwsDates({ starts_on: 20270901 }).statusCode === 400);
}

async function testListAndCurrent() {
  console.log('\n[list / current]');
  reset();
  const list = await svc.listSessions();
  check('list returns both sessions, newest first', list.length === 2 && list[0].label === '2026/2027' && list[1].label === '2025/2026');
  check('is_current mapped to boolean', list[0].is_current === true && list[1].is_current === false);
  check('counts mapped to numbers', list[0].applications_total === 9 && list[0].applications_pending === 3 &&
    list[0].applications_awaiting_room === 2 && list[0].active_allocations === 4);
  check('list performs no writes and no transaction', writes().length === 0 && TX_COUNT === 0);

  const cur = await svc.getCurrentSessionSummary();
  check('current = 2026/2027, open', cur && cur.label === '2026/2027' && cur.status === 'open' && cur.is_current === true);

  STATE.sessions[1].status = 'closed'; STATE.sessions[1].is_current = 0;
  check('current is null when nothing is open (not an error)', (await svc.getCurrentSessionSummary()) === null);
}

async function testCreate() {
  console.log('\n[create]');
  reset();
  const created = await svc.createSession({ label: '2027/2028', starts_on: '2027-09-01', ends_on: '2028-07-31' });
  check('creates as upcoming', created.status === 'upcoming');
  check('created session is not current', created.is_current === false && currentCount() === 1);
  check('dates stored', created.starts_on === '2027-09-01' && created.ends_on === '2028-07-31');
  check('the open session is untouched', STATE.sessions.find((s) => s.id === 2).status === 'open');
  check('first statement of the write transaction is the row lock',
    SQL_LOG.find((e) => e.tx === 1).sql.endsWith('FOR UPDATE'));

  const noDates = await svc.createSession({ label: '2028/2029' });
  check('dates optional', noDates.starts_on === null && noDates.ends_on === null);

  reset();
  const before = JSON.stringify(STATE.sessions);

  let e = await rejects(svc.createSession({ label: '2026/2027' }));
  check('duplicate label -> 409', e && e.statusCode === 409);
  e = await rejects(svc.createSession({ label: '2025/2026' }));
  check('existing older label -> 409 (duplicate)', e && e.statusCode === 409 && /already exists/.test(e.message));
  e = await rejects(svc.createSession({ label: '2024/2025' }));
  check('back-dated label -> 409 (not later than latest)', e && e.statusCode === 409 && /later than/.test(e.message));
  check('rejected creates changed nothing', JSON.stringify(STATE.sessions) === before && writes().length === 0);

  const txBefore = TX_COUNT;
  e = await rejects(svc.createSession({ label: '2028/2030' }));
  check('non-consecutive years -> 400', e && e.statusCode === 400);
  e = await rejects(svc.createSession({ label: '2027/2028', starts_on: '2027-09-02', ends_on: '2027-09-01' }));
  check('end before start -> 400', e && e.statusCode === 400);
  e = await rejects(svc.createSession({ label: '2027/2028', starts_on: '2027-02-30' }));
  check('impossible date -> 400', e && e.statusCode === 400);
  check('validation failures never open a transaction', TX_COUNT === txBefore);

  STATE.forceDupOnInsert = true;
  const rollbacksBefore = ROLLBACKS;
  e = await rejects(svc.createSession({ label: '2027/2028' }));
  check('database duplicate-key error mapped to 409', e && e.statusCode === 409);
  check('...and the transaction rolled back', ROLLBACKS === rollbacksBefore + 1);

  reset();
  const results = await Promise.allSettled([
    svc.createSession({ label: '2027/2028' }),
    svc.createSession({ label: '2027/2028' }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const conflict = results.filter((r) => r.status === 'rejected' && r.reason.statusCode === 409).length;
  check('two simultaneous creates of one label: exactly one wins, one gets 409', ok === 1 && conflict === 1);
  check('only one 2027/2028 row exists', STATE.sessions.filter((s) => s.label === '2027/2028').length === 1);
}

async function testOpen() {
  console.log('\n[open]');
  reset();
  await svc.createSession({ label: '2027/2028' }); // id 3, upcoming

  let e = await rejects(svc.openSession(3));
  check('opening while another session is open -> 409 naming it', e && e.statusCode === 409 && /2026\/2027/.test(e.message));
  check('...and nothing changed', STATE.sessions.find((s) => s.id === 3).status === 'upcoming' && currentCount() === 1);

  e = await rejects(svc.openSession(1));
  check('opening a closed session -> 409', e && e.statusCode === 409 && /closed/.test(e.message));
  e = await rejects(svc.openSession(2));
  check('opening the already-open session -> 409', e && e.statusCode === 409);
  e = await rejects(svc.openSession(999));
  check('unknown session -> 404', e && e.statusCode === 404);

  await svc.closeSession(2);
  const opened = await svc.openSession(3);
  check('after closing, the upcoming session opens', opened.status === 'open' && opened.is_current === true);
  check('exactly one current session', currentCount() === 1);
  check('2026/2027 stays closed (not archived, not deleted)', STATE.sessions.find((s) => s.id === 2).status === 'closed' && STATE.sessions.length === 3);

  e = await rejects(svc.openSession(3));
  check('re-opening an open session -> 409', e && e.statusCode === 409);

  reset();
  await svc.closeSession(2);
  await svc.createSession({ label: '2027/2028' }); // id 3
  await svc.createSession({ label: '2028/2029' }); // id 4
  e = await rejects(svc.openSession(4));
  check('cannot skip ahead: earlier upcoming session must open first', e && e.statusCode === 409 && /2027\/2028/.test(e.message));
  const first = await svc.openSession(3);
  check('earliest upcoming opens', first.label === '2027/2028');

  reset();
  await svc.closeSession(2);
  await svc.createSession({ label: '2027/2028' }); // id 3
  const r = await Promise.allSettled([svc.openSession(3), svc.openSession(3)]);
  check('two simultaneous opens: exactly one succeeds', r.filter((x) => x.status === 'fulfilled').length === 1 &&
    r.filter((x) => x.status === 'rejected' && x.reason.statusCode === 409).length === 1);
  check('...leaving exactly one current session', currentCount() === 1);

  reset();
  await svc.closeSession(2);
  await svc.createSession({ label: '2027/2028' });
  STATE.raceOnUpdate = true;
  e = await rejects(svc.openSession(3));
  check('row changed under us (0 rows updated) -> 409 and rollback', e && e.statusCode === 409 && ROLLBACKS >= 1);
}

async function testClose() {
  console.log('\n[close]');
  reset();
  SQL_LOG = [];
  const closed = await svc.closeSession(2);
  check('open -> closed', closed.status === 'closed' && closed.is_current === false);
  check('no session is current afterwards', currentCount() === 0 && (await svc.getCurrentSessionSummary()) === null);
  check('close writes ONLY hostel_sessions (no application/allocation/payment/fee write)',
    writes().length === 1 && /^UPDATE hostel_sessions /.test(writes()[0].sql));
  check('close response still reports the untouched counts', closed.applications_total === 9 && closed.active_allocations === 4);

  let e = await rejects(svc.closeSession(2));
  check('closing an already-closed session -> 409', e && e.statusCode === 409);
  e = await rejects(svc.closeSession(999));
  check('unknown session -> 404', e && e.statusCode === 404);

  reset();
  await svc.createSession({ label: '2027/2028' });
  e = await rejects(svc.closeSession(3));
  check('closing an upcoming session -> 409', e && e.statusCode === 409);

  reset();
  const r = await Promise.allSettled([svc.closeSession(2), svc.closeSession(2)]);
  check('two simultaneous closes: exactly one succeeds', r.filter((x) => x.status === 'fulfilled').length === 1);

  reset();
  STATE.raceOnUpdate = true;
  e = await rejects(svc.closeSession(2));
  check('row changed under us -> 409, rolled back, still open',
    e && e.statusCode === 409 && STATE.sessions.find((s) => s.id === 2).status === 'open');
}

async function testLifecycleAndSurface() {
  console.log('\n[lifecycle + surface]');
  reset();
  const steps = [];
  await svc.createSession({ label: '2027/2028' }); steps.push(currentCount());
  await svc.closeSession(2); steps.push(currentCount());
  await svc.openSession(3); steps.push(currentCount());
  check('at most one current session after every step (1,0,1)', steps.join(',') === '1,0,1', steps.join(','));
  check('every write transaction began with the row lock', (() => {
    const txs = [...new Set(SQL_LOG.filter((e) => e.tx > 0).map((e) => e.tx))];
    return txs.every((tx) => SQL_LOG.find((e) => e.tx === tx).sql.endsWith('FOR UPDATE'));
  })());
  check('every write went to hostel_sessions only', writes().every((e) => /hostel_sessions/.test(e.sql)));

  const exported = Object.keys(svc).sort().join(',');
  check('service has no archive/delete/edit operation', !/archive|delete|remove|update/i.test(exported), exported);
  check('close/open cannot be reversed to upcoming (no such function)', !('reopenSession' in svc) && !('revertSession' in svc));
}

/* ------------------------------------------------------------------ */
/* HTTP layer: real router + validators + requireRole + errorMiddleware */
/* ------------------------------------------------------------------ */

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function call(server, method, url, { role, body } = {}) {
  const { port } = server.address();
  const headers = { Accept: 'application/json' };
  if (role) headers['x-test-role'] = role;
  const init = { method, headers };
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch(`http://127.0.0.1:${port}${url}`, init);
  let json = null;
  try { json = await res.json(); } catch (_) { /* no body */ }
  return { status: res.status, json };
}

async function testHttp() {
  console.log('\n[http] router, auth, validation');
  const express = require('express');
  const errorMiddleware = require('../middleware/errorMiddleware');

  // routes/index.js loads every route, including auth, which requires bcrypt.
  // bcrypt is a native module: if the installed binary was built for another OS
  // (e.g. a Windows node_modules opened on Linux) it cannot load. Stub it ONLY
  // in that case; no session route calls it, and on your machine the real
  // module loads normally.
  let bcryptStubbed = false;
  try { require('bcrypt'); } catch (_) {
    const bcryptPath = require.resolve('bcrypt');
    require.cache[bcryptPath] = {
      id: bcryptPath, filename: bcryptPath, loaded: true,
      exports: { hash: async () => 'stub', compare: async () => false },
    };
    bcryptStubbed = true;
  }
  console.log(`  (bcrypt native module ${bcryptStubbed ? 'could not load here - stubbed for this test only' : 'loaded normally'})`);

  const app = express();
  app.use(express.json());
  // Test stand-in for the login session: header decides who is logged in.
  app.use((req, res, next) => {
    const role = req.get('x-test-role');
    req.session = role ? { user: { id: role === 'admin' ? 1 : 7, role } } : {};
    next();
  });
  // The REAL index router, so the route mounting itself is exercised.
  app.use('/api', require('../routes/index'));
  app.use(errorMiddleware);

  const quiet = { warn: console.warn, error: console.error };
  console.warn = () => {}; console.error = () => {};
  const server = await listen(app);

  try {
    reset();
    let r = await call(server, 'GET', '/api/admin/sessions');
    check('GET list without login -> 401', r.status === 401);
    r = await call(server, 'GET', '/api/admin/sessions', { role: 'student' });
    check('GET list as student -> 403', r.status === 403);
    r = await call(server, 'GET', '/api/admin/sessions/current', { role: 'student' });
    check('GET current as student -> 403', r.status === 403);
    r = await call(server, 'POST', '/api/admin/sessions', { role: 'student', body: { label: '2027/2028' } });
    check('POST create as student -> 403', r.status === 403);
    r = await call(server, 'POST', '/api/admin/sessions/3/open', { role: 'student' });
    check('POST open as student -> 403', r.status === 403);
    r = await call(server, 'POST', '/api/admin/sessions/2/close', { role: 'student' });
    check('POST close as student -> 403', r.status === 403);
    r = await call(server, 'POST', '/api/admin/sessions', { body: { label: '2027/2028' } });
    check('POST create without login -> 401', r.status === 401);
    check('rejected callers caused no database activity', SQL_LOG.length === 0 && TX_COUNT === 0);

    r = await call(server, 'GET', '/api/admin/sessions', { role: 'admin' });
    check('GET list as admin -> 200 with 2 sessions', r.status === 200 && r.json.success === true && r.json.data.length === 2);
    r = await call(server, 'GET', '/api/admin/sessions/current', { role: 'admin' });
    check('GET current as admin -> 200 (2026/2027)', r.status === 200 && r.json.data.label === '2026/2027');

    r = await call(server, 'POST', '/api/admin/sessions', { role: 'admin', body: {} });
    check('create with no label -> 400 on field label', r.status === 400 && r.json.errors.some((x) => x.field === 'label'));
    r = await call(server, 'POST', '/api/admin/sessions', { role: 'admin', body: { label: '2027/2029' } });
    check('non-consecutive label -> 400', r.status === 400 && r.json.errors[0].field === 'label');
    r = await call(server, 'POST', '/api/admin/sessions', { role: 'admin', body: { label: 'next year' } });
    check('malformed label -> 400', r.status === 400);
    r = await call(server, 'POST', '/api/admin/sessions', { role: 'admin', body: { label: '2027/2028', starts_on: '2027-13-01' } });
    check('bad date -> 400 on starts_on', r.status === 400 && r.json.errors.some((x) => x.field === 'starts_on'));
    r = await call(server, 'POST', '/api/admin/sessions', { role: 'admin', body: { label: '2027/2028', starts_on: '2027-09-02', ends_on: '2027-09-01' } });
    check('end before start -> 400 on ends_on', r.status === 400 && r.json.errors.some((x) => x.field === 'ends_on'));
    check('invalid requests wrote nothing', writes().length === 0 && STATE.sessions.length === 2);

    r = await call(server, 'POST', '/api/admin/sessions', {
      role: 'admin',
      body: { label: '2027/2028', starts_on: '', ends_on: '', status: 'open', is_current: 1, id: 99 },
    });
    check('valid create (blank dates, extra fields) -> 201', r.status === 201 && r.json.data.label === '2027/2028');
    check('mass-assignment ignored: created upcoming, not current, id from database',
      r.json.data.status === 'upcoming' && r.json.data.is_current === false && r.json.data.id === 3);
    check('only one current session after create', currentCount() === 1);

    r = await call(server, 'POST', '/api/admin/sessions', { role: 'admin', body: { label: '2027/2028' } });
    check('duplicate label -> 409', r.status === 409);

    r = await call(server, 'POST', '/api/admin/sessions/3/open', { role: 'admin' });
    check('open while 2026/2027 is open -> 409', r.status === 409 && /2026\/2027/.test(r.json.message));
    r = await call(server, 'POST', '/api/admin/sessions/abc/open', { role: 'admin' });
    check('non-numeric id -> 400', r.status === 400);
    r = await call(server, 'POST', '/api/admin/sessions/0/close', { role: 'admin' });
    check('id 0 -> 400', r.status === 400);
    r = await call(server, 'POST', '/api/admin/sessions/999/open', { role: 'admin' });
    check('unknown id -> 404', r.status === 404);

    r = await call(server, 'POST', '/api/admin/sessions/2/close', { role: 'admin' });
    check('close current -> 200, closed', r.status === 200 && r.json.data.status === 'closed' && /No applications, allocations or payments were changed/.test(r.json.message));
    r = await call(server, 'POST', '/api/admin/sessions/2/close', { role: 'admin' });
    check('close again -> 409', r.status === 409);
    r = await call(server, 'GET', '/api/admin/sessions/current', { role: 'admin' });
    check('current is now null', r.status === 200 && r.json.data === null);
    r = await call(server, 'POST', '/api/admin/sessions/3/open', { role: 'admin' });
    check('open upcoming -> 200, open + current', r.status === 200 && r.json.data.status === 'open' && r.json.data.is_current === true);
    r = await call(server, 'POST', '/api/admin/sessions/2/open', { role: 'admin' });
    check('reopening a closed session -> 409', r.status === 409);
    check('single current session at the end', currentCount() === 1);
    check('HTTP flow wrote only to hostel_sessions', writes().every((e) => /hostel_sessions/.test(e.sql)));
  } finally {
    console.warn = quiet.warn; console.error = quiet.error;
    server.close();
  }
}

(async () => {
  try {
    await testRules();
    await testListAndCurrent();
    await testCreate();
    await testOpen();
    await testClose();
    await testLifecycleAndSurface();
    await testHttp();
  } catch (err) {
    fail += 1;
    console.log(`  FAIL unexpected exception :: ${err && err.stack ? err.stack : err}`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
