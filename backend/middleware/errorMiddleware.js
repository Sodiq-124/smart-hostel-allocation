const ApiError = require('../utils/ApiError');

/**
 * A failed CHECK constraint (for example ck_payments_amount_breakdown,
 * ck_payments_type_links, ck_misc_charges_fine).
 *
 * MySQL 8 reports it as errno 3819 and the driver names it
 * ER_CHECK_CONSTRAINT_VIOLATED. MariaDB (this project's database) reports it as
 * errno 4025 with SQLSTATE 23000, and mysql2 labels errno 4025 with an unrelated
 * MySQL-8 name (ER_INNODB_AUTOEXTEND_SIZE_OUT_OF_RANGE), so on MariaDB the code
 * string alone never matches. MySQL 8's own errno 4025 uses SQLSTATE HY000, which
 * is why both the number and the state are checked.
 */
function isCheckConstraintViolation(error) {
  return (
    error.code === 'ER_CHECK_CONSTRAINT_VIOLATED' ||
    (error.errno === 4025 && error.sqlState === '23000')
  );
}

function translateDatabaseError(error) {
  if (error.sqlState === '45000' && error.sqlMessage) {
    return ApiError.conflict(error.sqlMessage);
  }

  // Deliberately generic: the constraint name and table must not reach the client.
  if (isCheckConstraintViolation(error)) {
    return ApiError.conflict(
      'This action would leave the data in an invalid state.'
    );
  }

  switch (error.code) {
    case 'ER_DUP_ENTRY': {
      const key = String(error.message).split("for key '")[1] || '';

      if (key.includes('email')) {
        return ApiError.conflict(
          'An account with this email address already exists.'
        );
      }

      if (key.includes('student_id')) {
        return ApiError.conflict(
          'An account with this Student ID already exists.'
        );
      }

      if (key.includes('room_number')) {
        return ApiError.conflict(
          'A room with this room number already exists.'
        );
      }

      if (key.includes('uq_active_application')) {
        return ApiError.conflict(
          'You already have an active hostel application.'
        );
      }

      // Migration 020 replaced uq_paid_application with one unique key per kind of
      // successful payment. The old name stays for databases not yet migrated.
      if (key.includes('uq_paid_application')) {
        return ApiError.conflict(
          'This hostel allocation has already been paid for.'
        );
      }

      if (key.includes('uq_successful_hostel_payment')) {
        return ApiError.conflict(
          'The hostel fee for this application has already been paid.'
        );
      }

      if (key.includes('uq_successful_misc_payment')) {
        return ApiError.conflict(
          'This charge has already been paid.'
        );
      }

      if (key.includes('payment_reference')) {
        return ApiError.conflict(
          'This payment reference has already been used.'
        );
      }

      return ApiError.conflict('This record already exists.');
    }

    case 'ER_NO_REFERENCED_ROW':
    case 'ER_NO_REFERENCED_ROW_2':
      return ApiError.badRequest(
        'A related record referenced by this request does not exist.'
      );

    case 'ER_ROW_IS_REFERENCED':
    case 'ER_ROW_IS_REFERENCED_2':
      return ApiError.conflict(
        'This record cannot be deleted because other records still depend on it.'
      );

    case 'ER_LOCK_DEADLOCK':
      return new ApiError(
        409,
        'The system was busy processing another request. Please try again.'
      );

    case 'ER_LOCK_WAIT_TIMEOUT':
      return new ApiError(
        503,
        'The system is busy. Please try again in a moment.'
      );

    case 'ECONNREFUSED':
    case 'PROTOCOL_CONNECTION_LOST':
    case 'ER_ACCESS_DENIED_ERROR':
    case 'ER_BAD_DB_ERROR':
      return new ApiError(
        503,
        'The service is temporarily unavailable. Please try again shortly.'
      );

    default:
      return null;
  }
}

function errorMiddleware(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  let error = err;

  if (!(error instanceof ApiError)) {
    const translated = translateDatabaseError(error);
    error =
      translated ||
      new ApiError(500, 'Something went wrong. Please try again.');
  }

  const level = error.statusCode >= 500 ? 'error' : 'warn';

  console[level](
    `[${new Date().toISOString()}] ${error.statusCode} ${req.method} ${req.originalUrl} :: ${err.message}`
  );

  if (error.statusCode >= 500) {
    console.error(err.stack);
  }

  const body = {
    success: false,
    message: error.message,
  };

  if (error.details) {
    body.errors = error.details;
  }

  if (process.env.NODE_ENV !== 'production' && error.statusCode >= 500) {
    body.stack = err.stack;
  }

  res.status(error.statusCode).json(body);
}

module.exports = errorMiddleware;