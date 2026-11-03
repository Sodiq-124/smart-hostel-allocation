/**
 * utils/sessionRules.js
 * ---------------------------------------------------------------
 * Pure validation rules for hostel sessions.
 * No database access, so both the validator and the service use the
 * same rules and they can be unit tested without a database.
 *
 * These mirror the CHECK constraints in migration 010
 * (ck_hs_label_format, ck_hs_label_consecutive, ck_hs_dates). The
 * backend enforces them itself because the constraint/trigger state of
 * a given database must not be assumed.
 * ---------------------------------------------------------------
 */

const ApiError = require('./ApiError');

const LABEL_PATTERN = /^\d{4}\/\d{4}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MIN_START_YEAR = 2000;
const MAX_START_YEAR = 2099;

/** "2026/2027" -> { startYear: 2026, endYear: 2027 }. Throws 400 otherwise. */
function parseSessionLabel(label) {
  if (typeof label !== 'string' || !LABEL_PATTERN.test(label)) {
    throw ApiError.badRequest('Session label must look like 2026/2027.');
  }
  const startYear = Number(label.slice(0, 4));
  const endYear = Number(label.slice(5, 9));
  if (endYear !== startYear + 1) {
    throw ApiError.badRequest('The two years in a session label must be consecutive, for example 2026/2027.');
  }
  if (startYear < MIN_START_YEAR || startYear > MAX_START_YEAR) {
    throw ApiError.badRequest(`The session start year must be between ${MIN_START_YEAR} and ${MAX_START_YEAR}.`);
  }
  return { startYear, endYear };
}

/** Optional YYYY-MM-DD -> the same string, or null when absent. Throws 400 on anything else. */
function normaliseDate(value, fieldLabel) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw ApiError.badRequest(`${fieldLabel} must be a date in YYYY-MM-DD format.`);
  }
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw ApiError.badRequest(`${fieldLabel} is not a real calendar date.`);
  }
  return value;
}

/** Both dates optional; when both are present the end may not precede the start. */
function validateSessionDates({ starts_on, ends_on } = {}) {
  const start = normaliseDate(starts_on, 'Start date');
  const end = normaliseDate(ends_on, 'End date');
  if (start && end && end < start) {
    throw ApiError.badRequest('End date cannot be earlier than the start date.');
  }
  return { starts_on: start, ends_on: end };
}

module.exports = { parseSessionLabel, normaliseDate, validateSessionDates, LABEL_PATTERN };
