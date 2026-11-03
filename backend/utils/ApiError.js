

class ApiError extends Error {
  constructor(statusCode, message, details = null) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.details = details;          
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message = 'Invalid request.', details = null) {
    return new ApiError(400, message, details);
  }

  static unauthorized(message = 'Please log in to continue.') {
    return new ApiError(401, message);
  }

  static forbidden(message = 'You are not authorized to perform this action.') {
    return new ApiError(403, message);
  }

  static notFound(message = 'The requested resource was not found.') {
    return new ApiError(404, message);
  }

  
  static conflict(message = 'This action conflicts with existing records.') {
    return new ApiError(409, message);
  }
}

module.exports = ApiError;
