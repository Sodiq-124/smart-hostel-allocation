/**
 * tests/step3_money_unit.js - utils/money.js
 *
 * Pure unit test: no database, no network, no dependencies.
 *
 *   node tests/step3_money_unit.js
 */
const fs = require('fs');
const path = require('path');
const { decimalToMinor, minorToDecimal, getCurrencyExponent } = require('../utils/money');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail !== undefined ? ` :: ${detail}` : ''}`); }
}
function throwsType(fn, Type, re) {
  try { fn(); } catch (e) { return e instanceof Type && (!re || re.test(e.message)); }
  return false;
}

// ---- M1 the amounts the project actually uses ----
const REAL = [
  ['300000.00', 30000000], ['250000.00', 25000000], ['200000.00', 20000000],
  ['150000.00', 15000000], ['150000.50', 15000050], ['100000.00', 10000000],
];
for (const [text, minor] of REAL) {
  check(`M1  decimalToMinor("${text}") === ${minor}`, decimalToMinor(text) === minor, decimalToMinor(text));
}

// ---- M2 inputs where float multiplication is wrong, exact here ----
const TRAPS = [['0.29', 29], ['1.15', 115], ['4.35', 435], ['8.20', 820], ['19.99', 1999], ['0.07', 7], ['0.1', 10], ['5', 500], ['99999999.99', 9999999999]];
for (const [text, minor] of TRAPS) {
  check(`M2  decimalToMinor("${text}") === ${minor}  (float trap: ${Number(text)} * 100 = ${Number(text) * 100})`, decimalToMinor(text) === minor, decimalToMinor(text));
}
check('M2  safe-integer number input 150000 -> 15000000', decimalToMinor(150000) === 15000000);
check('M2  explicit currency argument NGN', decimalToMinor('150000.50', 'NGN') === 15000050);

// ---- M3 invalid syntax ----
const BAD_SYNTAX = ['', ' ', 'abc', '12abc', '1e5', '1,000.00', ' 100.00', '100.00 ', '+100.00', '.50', '5.', '1.2.3', '0x10', 'NaN', 'Infinity', '٣٠٠', '１００', '007', '00.50', '1_000'];
for (const text of BAD_SYNTAX) {
  check(`M3  rejects ${JSON.stringify(text)}`, throwsType(() => decimalToMinor(text), RangeError));
}

// ---- M4 input types ----
for (const [label, v, Type] of [
  ['null', null, TypeError], ['undefined', undefined, TypeError], ['true', true, TypeError],
  ['object', {}, TypeError], ['array', ['1'], TypeError], ['BigInt', BigInt(5), TypeError],
  ['NaN', NaN, RangeError], ['Infinity', Infinity, RangeError],
  ['fractional number 150000.5', 150000.5, RangeError], ['0.1+0.2', 0.1 + 0.2, RangeError],
  ['unsafe integer 2**53', 2 ** 53, RangeError],
]) {
  check(`M4  rejects ${label}`, throwsType(() => decimalToMinor(v), Type));
}

// ---- M5 precision ----
for (const text of ['1.234', '150000.001', '1.000', '0.001', '100.123456789']) {
  check(`M5  rejects ${text} (more than 2 decimal places for NGN)`, throwsType(() => decimalToMinor(text), RangeError, /decimal places/));
}
check('M5  accepts one decimal place "100.5" -> 10050', decimalToMinor('100.5') === 10050);

// ---- M6 zero and negative ----
check('M6  zero rejected by default ("0.00")', throwsType(() => decimalToMinor('0.00'), RangeError, /zero/));
check('M6  zero rejected by default ("0")', throwsType(() => decimalToMinor('0'), RangeError, /zero/));
check('M6  zero rejected by default (number 0)', throwsType(() => decimalToMinor(0), RangeError, /zero/));
check('M6  zero allowed with { allowZero: true } -> 0', decimalToMinor('0.00', 'NGN', { allowZero: true }) === 0);
check('M6  smallest positive "0.01" -> 1', decimalToMinor('0.01') === 1);
for (const text of ['-1', '-0.01', '-150000.00', '-0']) {
  check(`M6  rejects negative "${text}"`, throwsType(() => decimalToMinor(text), RangeError, /negative/));
}
check('M6  rejects negative number -5', throwsType(() => decimalToMinor(-5), RangeError));

// ---- M7 safe-integer range ----
const MAX = Number.MAX_SAFE_INTEGER; // 9007199254740991 minor units
check('M7  largest safe amount "90071992547409.91" -> MAX_SAFE_INTEGER', decimalToMinor('90071992547409.91') === MAX, decimalToMinor('90071992547409.91'));
check('M7  one kobo more "90071992547409.92" rejected', throwsType(() => decimalToMinor('90071992547409.92'), RangeError, /out of range/));
check('M7  huge "99999999999999999999.99" rejected', throwsType(() => decimalToMinor('99999999999999999999.99'), RangeError, /out of range/));
check('M7  1000-digit string rejected (no hang, no Infinity)', throwsType(() => decimalToMinor('9'.repeat(1000)), RangeError, /out of range/));

// ---- M8 currency handling ----
check('M8  getCurrencyExponent("NGN") === 2', getCurrencyExponent('NGN') === 2);
for (const cur of ['USD', 'ngn', '', 'NG', null, 'toString', '__proto__', 'constructor', 123]) {
  check(`M8  unsupported currency ${JSON.stringify(cur)} rejected`, throwsType(() => decimalToMinor('100.00', cur), RangeError, /Unsupported currency/));
}
check('M8  omitted/undefined currency uses the documented default NGN', decimalToMinor('100.00', undefined) === 10000);
check('M8  minorToDecimal rejects unsupported currency', throwsType(() => minorToDecimal(100, 'USD'), RangeError, /Unsupported currency/));

// ---- M9 minorToDecimal ----
for (const [minor, text] of [[30000000, '300000.00'], [15000050, '150000.50'], [7, '0.07'], [0, '0.00'], [100, '1.00'], [99, '0.99'], [MAX, '90071992547409.91']]) {
  check(`M9  minorToDecimal(${minor}) === "${text}"`, minorToDecimal(minor) === text, minorToDecimal(minor));
}
for (const [label, v] of [['-1', -1], ['1.5', 1.5], ['"100"', '100'], ['null', null], ['NaN', NaN], ['2**53', 2 ** 53]]) {
  check(`M9  minorToDecimal rejects ${label}`, throwsType(() => minorToDecimal(v), RangeError));
}

// ---- M10 round trips and an independent BigInt reference ----
let bad = 0;
for (let i = 1; i <= 300000; i += 1) {
  if (decimalToMinor(minorToDecimal(i)) !== i) { bad += 1; break; }
}
check('M10 round trip minor -> decimal -> minor for 1..300,000', bad === 0);
let seed = 123456789;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
bad = 0;
for (let i = 0; i < 20000; i += 1) {
  const whole = BigInt(rnd()) * BigInt(rnd()) % BigInt('90071992547409');
  const cents = rnd() % 100;
  const text = `${whole}.${String(cents).padStart(2, '0')}`;
  const ref = whole * BigInt(100) + BigInt(cents);
  if (BigInt(decimalToMinor(text)) !== ref || minorToDecimal(decimalToMinor(text)) !== text) { bad += 1; break; }
}
check('M10 20,000 random amounts equal an independent BigInt reference and round-trip', bad === 0);

// ---- M11 no floating-point money arithmetic in the source ----
const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'money.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('M11 source has no parseFloat / toFixed / Math.round', !/parseFloat|toFixed|Math\.round/.test(src));
check('M11 source has no "* 100" style float scaling', !/\*\s*100\b/.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
