/**
 * utils/lateFine.js
 * ---------------------------------------------------------------
 * The miscellaneous-charge amount, computed from TRUSTED values.
 * Pure: no database, no clock. The caller supplies `pastDeadline`, which the
 * service reads from the database itself (NOW() > deadline_at, see
 * services/miscPaymentService.js) so that the deadline an admin typed and the
 * clock it is compared with are in the SAME time zone (the database server's).
 *
 * Fine policy (already defined by migration 017/020, not invented here):
 *   hostel_misc_charges.deadline_at       DATETIME NULL
 *   hostel_misc_charges.late_fine_amount  DECIMAL(10,2) NOT NULL DEFAULT 0
 * i.e. ONE FIXED fine, added once, when payment is started AFTER the deadline.
 *   - no deadline                 -> never late, no fine
 *   - fine = 0                    -> never a fine (payment stays possible after the deadline)
 *   - now <= deadline_at          -> on time (the deadline instant itself is on time)
 *   - now >  deadline_at          -> late: amount = original + fixed fine
 * The fine is decided when the payment row is created and stored on it
 * (original_amount + late_fine_applied = amount, enforced by ck_payments_amount_breakdown).
 *
 * Arithmetic is in integer minor units (kobo) via utils/money.js - never floats.
 * ---------------------------------------------------------------
 */

const { decimalToMinor, minorToDecimal } = require('./money');

/**
 * @param {{amount:string, late_fine_amount?:string|null, currency:string}} charge
 * @param {boolean} pastDeadline true when the database says NOW() is after deadline_at
 * @returns {{original:string, fine:string, total:string, original_minor:number,
 *            fine_minor:number, total_minor:number, late:boolean}}
 * @throws {RangeError|TypeError} when a stored amount is not a valid money value
 */
function computeMiscAmount(charge, pastDeadline) {
  const currency = charge.currency;
  const originalMinor = decimalToMinor(charge.amount, currency); // > 0
  const configuredFineMinor = decimalToMinor(
    charge.late_fine_amount === undefined || charge.late_fine_amount === null ? '0.00' : charge.late_fine_amount,
    currency,
    { allowZero: true }
  );
  const late = Boolean(pastDeadline) && configuredFineMinor > 0;
  const fineMinor = late ? configuredFineMinor : 0;
  const totalMinor = originalMinor + fineMinor;
  if (!Number.isSafeInteger(totalMinor)) throw new RangeError('Amount out of range.');
  return {
    original: minorToDecimal(originalMinor, currency),
    fine: minorToDecimal(fineMinor, currency),
    total: minorToDecimal(totalMinor, currency),
    original_minor: originalMinor,
    fine_minor: fineMinor,
    total_minor: totalMinor,
    late,
  };
}

module.exports = { computeMiscAmount };
