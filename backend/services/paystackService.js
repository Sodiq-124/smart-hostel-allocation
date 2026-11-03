/**
 * services/paystackService.js
 * ---------------------------------------------------------------
 * The ONLY module that talks to Paystack. Server-side only:
 * the secret key is read from the environment here and never leaves
 * this process (not logged, not returned, not sent to the browser).
 *
 *   initializeTransaction()  POST /transaction/initialize
 *   verifyTransaction()      GET  /transaction/verify/:reference
 *   isValidWebhookSignature()  HMAC-SHA512 of the RAW request body
 *
 * Amounts are always INTEGER minor units (kobo) - see utils/money.js.
 * Provider failures are translated to generic ApiErrors; Paystack's
 * own error text is logged server-side but not shown to students.
 * ---------------------------------------------------------------
 */

const crypto = require('crypto');
const axios = require('axios');
const ApiError = require('../utils/ApiError');

const TIMEOUT_MS = 15000;

function getConfig() {
  const secretKey = process.env.PAYSTACK_SECRET_KEY || '';
  const baseURL = (process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co').replace(/\/+$/, '');
  // A public key (pk_...) pasted into the secret slot would only ever fail at Paystack.
  if (!/^sk_(test|live)_\S+$/.test(secretKey)) {
    console.error('[paystack] PAYSTACK_SECRET_KEY is missing or is not a Paystack secret key (sk_test_/sk_live_).');
    throw new ApiError(503, 'Online payment is temporarily unavailable. Please try again later.');
  }
  return { secretKey, baseURL };
}

function client() {
  const { secretKey, baseURL } = getConfig();
  return axios.create({
    baseURL,
    timeout: TIMEOUT_MS,
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
    // never follow redirects with the Authorization header attached
    maxRedirects: 0,
    validateStatus: () => true, // we classify every status ourselves
  });
}

function providerUnavailable(context, err) {
  // err.message from axios never contains the Authorization header
  console.error(`[paystack] ${context} failed: ${err && err.code ? err.code : ''} ${err && err.message ? err.message : ''}`.trim());
  return new ApiError(502, 'The payment provider could not be reached. Please try again in a moment.');
}

/**
 * @returns {Promise<{authorization_url:string, access_code:string, reference:string}>}
 */
async function initializeTransaction({ email, amountMinor, currency, reference, callbackUrl, metadata }) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new ApiError(500, 'Invalid payment amount.');
  }
  const http = client(); // configuration errors (503) must not be mistaken for network errors
  let res;
  try {
    res = await http.post('/transaction/initialize', {
      email,
      amount: amountMinor,
      currency,
      reference,
      callback_url: callbackUrl,
      metadata,
    });
  } catch (err) {
    throw providerUnavailable('initialize', err);
  }

  const body = res.data;
  if (res.status !== 200 || !body || body.status !== true || !body.data || typeof body.data.authorization_url !== 'string') {
    console.error(`[paystack] initialize rejected: HTTP ${res.status} ${body && body.message ? body.message : ''}`);
    throw new ApiError(502, 'The payment provider did not accept the request. Please try again later.');
  }
  // Only ever send the student to Paystack's own checkout host.
  let host;
  try { host = new URL(body.data.authorization_url).hostname; } catch { host = ''; }
  if (host !== 'checkout.paystack.com') {
    console.error(`[paystack] unexpected checkout host: ${host}`);
    throw new ApiError(502, 'The payment provider returned an unexpected response.');
  }
  return {
    authorization_url: body.data.authorization_url,
    access_code: body.data.access_code,
    reference: body.data.reference,
  };
}

/**
 * Ask Paystack what really happened to a reference.
 * @returns {Promise<null | {status:string, reference:string, amount:number, currency:string, id:string, channel:string|null}>}
 *          null when Paystack does not know the reference (HTTP 404).
 */
async function verifyTransaction(reference) {
  const http = client();
  let res;
  try {
    res = await http.get(`/transaction/verify/${encodeURIComponent(reference)}`);
  } catch (err) {
    throw providerUnavailable('verify', err);
  }
  if (res.status === 404) return null;
  const body = res.data;
  if (res.status !== 200 || !body || body.status !== true || !body.data) {
    console.error(`[paystack] verify rejected: HTTP ${res.status} ${body && body.message ? body.message : ''}`);
    throw new ApiError(502, 'The payment provider could not confirm this payment right now. Please try again shortly.');
  }
  const d = body.data;
  return {
    status: String(d.status),
    reference: String(d.reference),
    amount: d.amount,
    currency: String(d.currency),
    id: d.id === undefined || d.id === null ? null : String(d.id),
    channel: d.channel ? String(d.channel) : null,
  };
}

/** Paystack signs the exact raw body with the secret key (HMAC SHA-512, hex). */
function isValidWebhookSignature(rawBody, signature) {
  if (!Buffer.isBuffer(rawBody) || typeof signature !== 'string' || !/^[0-9a-f]{128}$/i.test(signature)) {
    return false;
  }
  const { secretKey } = getConfig();
  const expected = crypto.createHmac('sha512', secretKey).update(rawBody).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

/** Throws 503 when the secret key is missing/invalid. Lets callers fail BEFORE writing to the database. */
function assertConfigured() {
  getConfig();
}

module.exports = { initializeTransaction, verifyTransaction, isValidWebhookSignature, assertConfigured };
