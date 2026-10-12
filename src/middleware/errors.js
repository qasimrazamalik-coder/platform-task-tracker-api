const { AppError } = require('../errors');

const constraintMessages = {
  users_email_uq: ['EMAIL_TAKEN', 'An account with that email already exists.'],
  users_handle_uq: ['HANDLE_TAKEN', 'That handle is taken. Pick another.'],
  projects_key_key: ['KEY_TAKEN', 'Another project already uses that key.'],
  project_members_pkey: ['ALREADY_MEMBER', 'That person is already on the project.'],
  task_dependencies_pkey: ['DEPENDENCY_EXISTS', 'That dependency is already recorded.'],
};

function notFoundRoute(req, _res, next) {
  next(new AppError(404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.path}`));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, _req, res, _next) {
  if (err.type === 'entity.parse.failed') {
    err = new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON.');
  } else if (err.code === '23505') {
    const [code, message] = constraintMessages[err.constraint] || ['DUPLICATE', 'That record already exists.'];
    err = new AppError(409, code, message);
  } else if (err.code === '23503') {
    err = new AppError(409, 'REFERENCED', 'That record is still referenced by other data.');
  } else if (err.code === '23514') {
    err = new AppError(400, 'CONSTRAINT_FAILED', 'A value is outside the allowed range.');
  } else if (err.code === '40P01') {
    // Deadlocks should not happen given our lock ordering, but if one does the
    // client can safely retry: the transaction was rolled back.
    err = new AppError(503, 'RETRY', 'The server was busy. Try again.');
  }
  if (!(err instanceof AppError)) {
    console.error(err);
    err = new AppError(500, 'INTERNAL', 'Something went wrong on the server.');
  }
  res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
}

module.exports = { errorHandler, notFoundRoute };
