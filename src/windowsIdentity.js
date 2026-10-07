const crypto = require('node:crypto');
const { ApiError } = require('./apiError');
const { SAM_PATTERN } = require('./employeeAccounts');

const USER_HEADER = 'x-pcn-windows-user';
const KEY_HEADER = 'x-pcn-windows-auth-key';

function readWindowsIdentity(req, { mode, domain = 'KEMET', proxyKey } = {}) {
  if (mode !== 'windows') return null;
  const fail = () => { throw new ApiError(401, 'Windows sign-in could not be verified'); };
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) fail();
  if (typeof proxyKey !== 'string' || proxyKey.length < 32 || proxyKey.length > 256) fail();
  if (typeof domain !== 'string' || !/^[a-zA-Z0-9.-]{1,100}$/.test(domain)) fail();
  for (const name of [USER_HEADER, KEY_HEADER]) {
    const values = [];
    if (!Array.isArray(req.rawHeaders)) fail();
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      if (String(req.rawHeaders[index]).toLowerCase() === name) values.push(req.rawHeaders[index + 1]);
    }
    if (values.length !== 1 || typeof req.headers?.[name] !== 'string' || values[0] !== req.headers[name]) fail();
  }
  const provided = req.headers[KEY_HEADER];
  const expected = Buffer.from(proxyKey);
  const actual = Buffer.from(provided);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) fail();
  const identity = req.headers[USER_HEADER];
  if (identity.length > 202 || /[\s,\x00-\x1f\x7f]/.test(identity)) fail();
  const parts = identity.split('\\');
  if (parts.length !== 2 || parts[0].toLowerCase() !== domain.toLowerCase() || !SAM_PATTERN.test(parts[1])) fail();
  return { domain: domain.toUpperCase(), samAccountName: parts[1] };
}

module.exports = { readWindowsIdentity, SAM_PATTERN };
