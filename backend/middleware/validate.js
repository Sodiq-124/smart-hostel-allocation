

const { validationResult } = require('express-validator');
const ApiError = require('../utils/ApiError');

function validate(req, res, next) {
  const result = validationResult(req);

  if (result.isEmpty()) {
    return next();
  }

  
  
  
  const seen = new Set();
  const details = [];

  for (const err of result.array()) {
    const field = err.path || err.param;
    if (seen.has(field)) continue;
    seen.add(field);
    details.push({ field, message: err.msg });
  }

  next(ApiError.badRequest('Please correct the highlighted fields.', details));
}

module.exports = validate;
