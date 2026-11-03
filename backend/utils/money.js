/**
 * utils/money.js
 * ---------------------------------------------------------------
 * Exact money handling. NEVER floating point.
 *
 * MariaDB DECIMAL(10,2) values reach Node as strings ("300000.00")
 * because config/database.js sets decimalNumbers:false. Paystack wants
 * an integer in the smallest currency unit (kobo for NGN). These
 * helpers convert between the two by parsing the decimal STRING and
 * doing the arithmetic on BigInt, so there is no multiplication of a
 * float anywhere (150000.50 * 100 is never computed).
 *
 * Currencies
 * ----------
 * hostel_fees.currency is CHAR(3) DEFAULT 'NGN'. Nothing in the
 * project restricts it to NGN, but every fee and the original design
 * use NGN only, so NGN (2 decimal places) is the only currency whose
 * precision has been established. Any other code is REJECTED rather
 * than guessed at; to support one, add it to CURRENCY_EXPONENTS
 * after confirming its minor-unit exponent with the payment gateway.
 *
 * Validation rules (decimalToMinor)
 * ---------------------------------
 *  - input: a string "digits[.digits]" or a safe INTEGER number.
 *    Fractional JS numbers are rejected (their decimal value is
 *    already an approximation); so are NaN, Infinity, BigInt,
 *    booleans, objects, null and undefined.
 *  - no sign, no whitespace, no exponent, no thousands separators,
 *    no leading zeros ("007"), no bare ".5" or "5."
 *  - at most `exponent` decimal places (NGN: 2); "1.234" and even
 *    "1.000" are rejected - excess precision is never silently cut
 *  - negative amounts are never accepted
 *  - zero is rejected unless { allowZero: true } is passed
 *  - the result must be <= Number.MAX_SAFE_INTEGER
 * ---------------------------------------------------------------
 */

const DEFAULT_CURRENCY = 'NGN';

/** ISO 4217 code -> number of decimal places in the minor unit. */
const CURRENCY_EXPONENTS = Object.freeze({
  NGN: 2, // naira -> kobo
});

const AMOUNT_RE = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * @param {string} currency ISO code, e.g. 'NGN'
 * @returns {number} decimal places of the minor unit
 * @throws {RangeError} when the currency's precision is not established
 */
function getCurrencyExponent(currency) {
  if (
    typeof currency !== 'string' ||
    !Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENTS, currency)
  ) {
    throw new RangeError(
      `Unsupported currency: ${JSON.stringify(currency)}. Supported: ${Object.keys(CURRENCY_EXPONENTS).join(', ')}.`
    );
  }
  return CURRENCY_EXPONENTS[currency];
}

/**
 * "300000.00" -> 30000000 (kobo)
 *
 * @param {string|number} amount decimal amount (see validation rules above)
 * @param {string} [currency='NGN']
 * @param {{allowZero?: boolean}} [options]
 * @returns {number} integer minor units
 * @throws {TypeError}  wrong input type
 * @throws {RangeError} bad syntax, negative, zero (unless allowed),
 *                      too many decimals, unsupported currency, or too large
 */
function decimalToMinor(amount, currency = DEFAULT_CURRENCY, options = {}) {
  const exponent = getCurrencyExponent(currency);
  const allowZero = Boolean(options && options.allowZero);

  let text;
  if (typeof amount === 'string') {
    text = amount;
  } else if (typeof amount === 'number') {
    if (!Number.isSafeInteger(amount)) {
      throw new RangeError(
        `Invalid money amount: ${String(amount)}. Pass decimals as strings; only safe integers may be passed as numbers.`
      );
    }
    text = String(amount);
  } else {
    throw new TypeError(
      `Invalid money amount: expected a string, got ${amount === null ? 'null' : typeof amount}.`
    );
  }

  if (text.charAt(0) === '-') {
    throw new RangeError(`Invalid money amount: "${text}" is negative.`);
  }

  const match = AMOUNT_RE.exec(text);
  if (!match) {
    throw new RangeError(`Invalid money amount: ${JSON.stringify(text)}.`);
  }

  const whole = match[1];
  const fraction = match[2] || '';
  if (fraction.length > exponent) {
    throw new RangeError(
      `Invalid money amount: "${text}" has more than ${exponent} decimal places for ${currency}.`
    );
  }

  const minor =
    BigInt(whole) * BigInt(10) ** BigInt(exponent) +
    BigInt(fraction.padEnd(exponent, '0') || '0');

  if (minor === BigInt(0) && !allowZero) {
    throw new RangeError('Invalid money amount: zero is not allowed.');
  }
  if (minor > MAX_SAFE) {
    throw new RangeError(`Money amount out of range: "${text}".`);
  }

  return Number(minor);
}

/**
 * 30000000 -> "300000.00"
 *
 * @param {number} minor a non-negative safe integer
 * @param {string} [currency='NGN']
 * @returns {string}
 * @throws {RangeError} not a non-negative safe integer, or unsupported currency
 */
function minorToDecimal(minor, currency = DEFAULT_CURRENCY) {
  const exponent = getCurrencyExponent(currency);
  if (!Number.isSafeInteger(minor) || minor < 0) {
    throw new RangeError(`Invalid minor-unit amount: ${String(minor)}.`);
  }
  if (exponent === 0) {
    return String(minor);
  }
  const base = BigInt(10) ** BigInt(exponent);
  const value = BigInt(minor);
  return `${value / base}.${String(value % base).padStart(exponent, '0')}`;
}

module.exports = { decimalToMinor, minorToDecimal, getCurrencyExponent };
