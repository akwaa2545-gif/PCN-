const crypto = require('node:crypto');
const { ApiError } = require('./apiError');
const COOKIE_NAME = 'pcn_session';

function readSessionToken(req) {
  const cookie = String(req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE_NAME}=`));
  return cookie ? cookie.slice(COOKIE_NAME.length + 1) : null;
}

function setSessionCookie(res, session, { secure = true } = {}) {
  const maxAge = Math.max(0, Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000));
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${session.token}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}; Max-Age=${maxAge}`);
}

function clearSessionCookie(res, { secure = true } = {}) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}; Max-Age=0`);
}

function enforceSameOrigin(req, publicOrigin) {
  if (!publicOrigin || req.headers.origin !== new URL(publicOrigin).origin) throw new ApiError(403, 'Request origin is not allowed');
}

function enforceCsrf(req, principal) {
  const actual = req.headers['x-csrf-token'];
  const expected = principal?.csrfToken;
  if (typeof actual !== 'string' || typeof expected !== 'string' || actual.length > 128) throw new ApiError(403, 'Invalid CSRF token');
  const supplied = Buffer.from(actual);
  const wanted = Buffer.from(expected);
  if (supplied.length !== wanted.length || !crypto.timingSafeEqual(supplied, wanted)) throw new ApiError(403, 'Invalid CSRF token');
}

function requirePrincipal(principal, { roles = [], allowPasswordChange = false } = {}) {
  if (!principal?.user) throw new ApiError(401, 'Sign in required');
  if (principal.user.mustChangePassword && !allowPasswordChange) {
    const error = new ApiError(403, 'Change your password before accessing PCN data');
    error.code = 'PASSWORD_CHANGE_REQUIRED';
    throw error;
  }
  if (roles.length && !roles.some(role => principal.user.roles.includes(role))) throw new ApiError(403, 'You do not have permission for this action');
  return principal.user;
}

module.exports = { COOKIE_NAME, readSessionToken, setSessionCookie, clearSessionCookie, enforceSameOrigin, enforceCsrf, requirePrincipal };
