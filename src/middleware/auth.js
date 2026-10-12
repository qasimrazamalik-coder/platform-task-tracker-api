const jwt = require('jsonwebtoken');
const config = require('../config');
const { unauthorized } = require('../errors');

// There are no global roles here: what you may do depends on your role in
// each project, which is checked per request (see modules/projects/access.js).
function signToken(user) {
  return jwt.sign({ sub: String(user.id), handle: user.handle }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

function authenticate(req, _res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) return next(unauthorized());
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.user = { id: Number(payload.sub), handle: payload.handle };
    next();
  } catch {
    next(unauthorized('Your session has expired. Sign in again.'));
  }
}

module.exports = { signToken, authenticate };
