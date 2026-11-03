/**
 * tests/payment_integrity_unit.js - how database integrity errors reach the client
 *
 * No database, no network. Calls middleware/errorMiddleware.js with the error
 * shapes the real drivers produce.
 *
 * Why this exists: migration 020 added CHECK constraints
 * (ck_payments_amount_breakdown, ck_payments_type_links) and replaced the old
 * unique key uq_paid_application with uq_successful_hostel_payment /
 * uq_successful_misc_payment. MariaDB reports a failed CHECK as errno 4025 /
 * SQLSTATE 23000, and mysql2 labels errno 4025 with an unrelated MySQL-8 name,
 * so a code-string match alone never fires on MariaDB.
 *
 *   node tests/payment_integrity_unit.js
 */

const errorMiddleware = require('../middleware/errorMiddleware');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail !== undefined ? ` :: ${detail}` : ''}`); }
}

function run(err) {
  const out = { status: null, body: null };
  const res = {
    headersSent: false,
    status(code) { out.status = code; return this; },
    json(body) { out.body = body; return this; },
  };
  const quiet = { warn: console.warn, error: console.error };
  console.warn = () => {}; console.error = () => {};
  try { errorMiddleware(err, { method: 'POST', originalUrl: '/api/payments/initialize' }, res, () => {}); }
  finally { console.warn = quiet.warn; console.error = quiet.error; }
  return out;
}

function dbError(fields) {
  const e = new Error(fields.message);
  Object.assign(e, fields);
  return e;
}

const INVALID_STATE = 'This action would leave the data in an invalid state.';

/* ---- CHECK constraint failures ---- */

// Exactly what mysql2 produces for MariaDB 10.4: errno 4025, SQLSTATE 23000,
// and a code string borrowed from an unrelated MySQL 8 error.
const mariaCheck = (name) => dbError({
  message: `CONSTRAINT \`${name}\` failed for \`smart_hostel\`.\`payments\``,
  code: 'ER_INNODB_AUTOEXTEND_SIZE_OUT_OF_RANGE',
  errno: 4025,
  sqlState: '23000',
  sqlMessage: `CONSTRAINT \`${name}\` failed for \`smart_hostel\`.\`payments\``,
});

for (const name of ['ck_payments_amount_breakdown', 'ck_payments_type_links', 'ck_misc_charges_fine']) {
  const r = run(mariaCheck(name));
  check(`MariaDB CHECK failure (${name}) -> 409 "invalid state", not a generic 500`,
    r.status === 409 && r.body.message === INVALID_STATE, JSON.stringify(r));
  check(`  ...and the constraint/table name is not leaked to the client (${name})`,
    !/ck_|payments|smart_hostel|CONSTRAINT/i.test(JSON.stringify(r.body)), JSON.stringify(r.body));
}

let r = run(dbError({ message: 'Check constraint failed', code: 'ER_CHECK_CONSTRAINT_VIOLATED', errno: 3819, sqlState: 'HY000' }));
check('MySQL 8 CHECK failure (ER_CHECK_CONSTRAINT_VIOLATED) -> still 409 "invalid state"', r.status === 409 && r.body.message === INVALID_STATE);

r = run(dbError({ message: 'autoextend size out of range', code: 'ER_INNODB_AUTOEXTEND_SIZE_OUT_OF_RANGE', errno: 4025, sqlState: 'HY000' }));
check('errno 4025 with MySQL 8\'s own SQLSTATE (HY000) is NOT treated as a CHECK failure -> generic 500',
  r.status === 500 && r.body.message === 'Something went wrong. Please try again.', JSON.stringify(r));

r = run(dbError({ message: 'weird', code: undefined, errno: 4025, sqlState: '' }));
check('errno 4025 with no SQLSTATE is not guessed to be a CHECK failure -> generic 500', r.status === 500);

/* ---- duplicate successful payments (keys renamed by migration 020) ---- */

const dup = (key) => dbError({ message: `Duplicate entry 'H:12:2' for key '${key}'`, code: 'ER_DUP_ENTRY', errno: 1062, sqlState: '23000' });

r = run(dup('uq_successful_hostel_payment'));
check('duplicate on uq_successful_hostel_payment -> 409 "hostel fee ... already paid"',
  r.status === 409 && /hostel fee for this application has already been paid/.test(r.body.message), JSON.stringify(r));

r = run(dup('uq_successful_misc_payment'));
check('duplicate on uq_successful_misc_payment -> 409 "charge ... already paid"',
  r.status === 409 && /This charge has already been paid/.test(r.body.message), JSON.stringify(r));

r = run(dup('uq_paid_application'));
check('legacy key name uq_paid_application (database not yet migrated) -> still 409 "already paid"',
  r.status === 409 && /already been paid for/.test(r.body.message), JSON.stringify(r));

r = run(dup('uq_payment_reference'));
check('duplicate payment_reference -> existing message unchanged', r.status === 409 && /payment reference has already been used/.test(r.body.message), JSON.stringify(r));

r = run(dup('some_other_key'));
check('unknown duplicate key -> generic 409 "record already exists"', r.status === 409 && /already exists/.test(r.body.message));

r = run(dbError({ message: "Duplicate entry 'x' for key 'email'", code: 'ER_DUP_ENTRY', errno: 1062, sqlState: '23000' }));
check('existing mapping (duplicate email) unchanged', r.status === 409 && /email address already exists/.test(r.body.message));

/* ---- neighbouring mappings still work after removing the old switch case ---- */

r = run(dbError({ message: 'fk', code: 'ER_NO_REFERENCED_ROW_2', errno: 1452, sqlState: '23000' }));
check('foreign-key failure still -> 400', r.status === 400);
r = run(dbError({ message: 'dead', code: 'ER_LOCK_DEADLOCK', errno: 1213, sqlState: '40001' }));
check('deadlock still -> 409', r.status === 409);
r = run(dbError({ message: 'conn', code: 'ECONNREFUSED' }));
check('connection refused still -> 503', r.status === 503);
r = run(dbError({ message: 'trigger says no', code: 'ER_SIGNAL_EXCEPTION', errno: 1644, sqlState: '45000', sqlMessage: 'A session label must be unique.' }));
check('trigger SIGNAL 45000 still surfaces its own message as 409', r.status === 409 && r.body.message === 'A session label must be unique.');
r = run(new Error('plain bug'));
check('an ordinary error is still a generic 500', r.status === 500 && r.body.message === 'Something went wrong. Please try again.');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
