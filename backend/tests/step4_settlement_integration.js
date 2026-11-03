
'use strict';

// Settlement integration test.
// Real paymentService + real MariaDB; mocked Paystack.
// Never targets the live smart_hostel database.

const assert = require('node:assert/strict');
const path = require('node:path');

require('dotenv').config({
  path: path.resolve(__dirname, '..', '.env'),
});

const TEST_DATABASE = 'smart_hostel_settlement_test2';
const STUDENT_ID = 12;
const APPLICATION_ID = 14;
const SESSION_ID = 2;
const FEE_ID = 3;
const AMOUNT = '300000.00';
const AMOUNT_MINOR = 30000000;

process.env.PAYSTACK_SECRET_KEY = 'sk_test_disposable_only';
process.env.PAYMENT_CALLBACK_URL =
  'http://localhost:3000/payment-callback';

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: TEST_DATABASE,
  waitForConnections: true,
  connectionLimit: 2,
  decimalNumbers: false,
  dateStrings: true,
});

async function withTransaction(callback) {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();
    const result = await callback(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

let expectedReference = null;
let initializationCalls = 0;
let verificationCalls = 0;

const fakeAxios = {
  create() {
    return {
      async post(url, body) {
        assert.ok(
          url.includes('/transaction/initialize'),
          `Unexpected initialization URL: ${url}`
        );
assert.ok(body.reference, 'Initialization reference is missing');

        expectedReference = body.reference;
        initializationCalls += 1;

        return {
          status: 200,
          data: {
            status: true,
            message: 'Authorization URL created',
            data: {
              authorization_url: 'https://checkout.paystack.com/test-payment',
              access_code: 'test_access_code_only',
              reference: expectedReference,
            },
          },
        };
      },

      async get(url) {
        assert.ok(
          url.includes('/transaction/verify/'),
          `Unexpected verification URL: ${url}`
        );

        assert.ok(expectedReference, 'No initialization reference captured');
        assert.ok(
          url.includes(encodeURIComponent(expectedReference)),
          'Verification URL does not contain the generated reference'
        );

        verificationCalls += 1;

        return {
          status: 200,
          data: {
            status: true,
            message: 'Verification successful',
            data: {
              id: 987654321,
              status: 'success',
              reference: expectedReference,
              amount: AMOUNT_MINOR,
              currency: 'NGN',
              channel: 'card',
              gateway_response: 'Successful',
            },
          },
        };
      },
    };
  },
};

// Inject the test-only database module before loading paymentService.
const dbPath = require.resolve('../config/database');

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: { pool, withTransaction },
};

// Inject mocked Axios before loading the real payment service.
const axiosPath = require.resolve('axios');

require.cache[axiosPath] = {
  id: axiosPath,
  filename: axiosPath,
  loaded: true,
  exports: fakeAxios,
};

const paymentService = require('../services/paymentService');

async function main() {
  try {
    const [dbRows] = await pool.query('SELECT DATABASE() AS db');

    assert.equal(
      dbRows[0].db,
      TEST_DATABASE,
      'Refusing to run against an unexpected database'
    );

    console.log(`Database target confirmed: ${TEST_DATABASE}`);

    // Confirm the expected fixture before creating a payment.
    const [applicationRows] = await pool.execute(
      `SELECT id, student_id, hostel_session_id,
              status, allocated_room_id
         FROM applications
        WHERE id = ?
        LIMIT 1`,
      [APPLICATION_ID]
    );

    assert.equal(applicationRows.length, 1, 'Application not found');

    const application = applicationRows[0];

    assert.equal(Number(application.student_id), STUDENT_ID);
    assert.equal(Number(application.hostel_session_id), SESSION_ID);
    assert.equal(application.status, 'approved');
    assert.equal(Number(application.allocated_room_id), 25);

    const [allocationRows] = await pool.execute(
      `SELECT id, status, student_id, application_id,
              hostel_session_id, room_id
         FROM allocations
        WHERE application_id = ?
          AND student_id = ?
          AND hostel_session_id = ?
          AND status = 'active'
        LIMIT 1`,
      [APPLICATION_ID, STUDENT_ID, SESSION_ID]
    );

    assert.equal(allocationRows.length, 1, 'Active allocation not found');
    assert.equal(Number(allocationRows[0].room_id), 25);

    const [feeRows] = await pool.execute(
      `SELECT id, amount, currency, hostel_session_id,
              block_id, active
         FROM hostel_fees
        WHERE id = ?
        LIMIT 1`,
      [FEE_ID]
    );

    assert.equal(feeRows.length, 1, 'Hostel fee not found');
    assert.equal(String(feeRows[0].amount), AMOUNT);
    assert.equal(feeRows[0].currency, 'NGN');
    assert.equal(Number(feeRows[0].hostel_session_id), SESSION_ID);
    assert.equal(Number(feeRows[0].block_id), 1);
    assert.equal(Number(feeRows[0].active), 1);

    // Ensure this application/session has no previous successful
    // hostel-fee payment before calling the real service.
    const [paidRows] = await pool.execute(
      `SELECT id
         FROM payments
        WHERE application_id = ?
          AND hostel_session_id = ?
          AND status = 'success'
          AND (payment_type = 'hostel' OR payment_type IS NULL)
        LIMIT 1`,
      [APPLICATION_ID, SESSION_ID]
    );

    assert.equal(
      paidRows.length,
      0,
      'Application already has a successful payment; refusing to proceed'
    );

    console.log('PASS: approved application and active allocation confirmed');
    console.log('PASS: active ₦300,000 hostel fee confirmed');

    // Exercise the real payment initialization and database INSERT.
    const initialized = await paymentService.initializePayment({
      studentId: STUDENT_ID,
    });

    assert.equal(initializationCalls, 1);
    assert.ok(expectedReference, 'Generated payment reference is missing');
    assert.equal(initialized.reference, expectedReference);
    assert.equal(initialized.authorization_url, 'https://checkout.paystack.com/test-payment');
    assert.equal(String(initialized.amount), AMOUNT);
    assert.equal(initialized.currency, 'NGN');

    const [pendingRows] = await pool.execute(
      `SELECT id, student_id, application_id, hostel_session_id,
              hostel_fee_id, amount, currency, payment_reference,
              gateway_reference, payment_channel, status,
              verified_at, paid_at
         FROM payments
        WHERE payment_reference = ?
        LIMIT 1`,
      [expectedReference]
    );

    assert.equal(pendingRows.length, 1, 'New payment row was not created');

    const before = pendingRows[0];

    assert.equal(Number(before.student_id), STUDENT_ID);
    assert.equal(Number(before.application_id), APPLICATION_ID);
    assert.equal(Number(before.hostel_session_id), SESSION_ID);
    assert.equal(Number(before.hostel_fee_id), FEE_ID);
    assert.equal(String(before.amount), AMOUNT);
    assert.equal(before.currency, 'NGN');
    assert.equal(before.status, 'pending');
    assert.equal(before.gateway_reference, null);
    assert.equal(before.payment_channel, null);
    assert.equal(before.verified_at, null);
    assert.equal(before.paid_at, null);

    console.log(`PASS: real service created pending payment ID ${before.id}`);
    console.log(`Reference: ${expectedReference}`);

    // Exercise real verification and settlement with mocked Paystack data.
    const result = await paymentService.verifyAndSettle(
      expectedReference,
      { studentId: STUDENT_ID }
    );

    assert.equal(result.status, 'success');
    assert.equal(verificationCalls, 1);

    const [afterRows] = await pool.execute(
      `SELECT id, student_id, application_id, hostel_session_id,
              hostel_fee_id, amount, currency, payment_reference,
              gateway_reference, payment_channel, status,
              verified_at, paid_at
         FROM payments
        WHERE payment_reference = ?
        LIMIT 1`,
      [expectedReference]
    );

    assert.equal(afterRows.length, 1);

    const after = afterRows[0];

    assert.equal(after.status, 'success');
    assert.equal(after.payment_reference, expectedReference);
    assert.equal(Number(after.gateway_reference), 987654321);
    assert.equal(after.payment_channel, 'card');
    assert.ok(after.verified_at, 'verified_at was not persisted');
    assert.ok(after.paid_at, 'paid_at was not persisted');
    assert.equal(Number(after.student_id), STUDENT_ID);
    assert.equal(Number(after.application_id), APPLICATION_ID);
    assert.equal(Number(after.hostel_session_id), SESSION_ID);
    assert.equal(Number(after.hostel_fee_id), FEE_ID);
    assert.equal(String(after.amount), AMOUNT);
    assert.equal(after.currency, 'NGN');

    console.log('PASS: Paystack initialization was mocked successfully');
    console.log('PASS: provider verification called exactly once');
    console.log('PASS: paymentService returned success');
    console.log('PASS: MariaDB persisted status=success');
    console.log('PASS: gateway reference and channel persisted');
    console.log('PASS: verified_at and paid_at are populated');
    console.log(`Verified payment ID: ${after.id}`);
    console.log('RESULT: SETTLEMENT INTEGRATION TEST PASSED');
    console.log(`Test payment remains in ${TEST_DATABASE}.`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('RESULT: SETTLEMENT INTEGRATION TEST FAILED');
  console.error(error.stack || error);
  process.exitCode = 1;
});
