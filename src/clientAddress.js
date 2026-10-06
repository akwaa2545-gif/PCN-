const net = require('node:net');
const { ApiError } = require('./apiError');
const CLIENT_IP_HEADER = 'x-pcn-client-ip';

function parseTrustProxy(value) {
  if (value === undefined || value === false || ['', 'off', 'false', '0'].includes(value)) return false;
  if (value === 'loopback') return 'loopback';
  throw new Error('TRUST_PROXY must be off or loopback');
}

function isLoopback(address) {
  const family = net.isIP(address);
  if (family === 4) return address.startsWith('127.');
  if (family !== 6 || address.includes('%')) return false;
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  return normalized === '::1' || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(normalized);
}

function getClientAddress(req, { trustProxy = false } = {}) {
  const remoteAddress = req.socket?.remoteAddress || 'unknown';
  if (trustProxy !== 'loopback' || !isLoopback(remoteAddress)) return remoteAddress;
  const value = req.headers?.[CLIENT_IP_HEADER];
  const rawHeaders = req.rawHeaders;
  let count = 0;
  if (Array.isArray(rawHeaders)) {
    for (let index = 0; index < rawHeaders.length; index += 2) {
      if (String(rawHeaders[index]).toLowerCase() === CLIENT_IP_HEADER) count += 1;
    }
  }
  if (typeof value !== 'string' || value.length > 64 || !net.isIP(value) || value.includes('%') || (Array.isArray(rawHeaders) && count !== 1)) {
    throw new ApiError(400, 'The trusted proxy must supply one valid X-PCN-Client-IP header');
  }
  return value;
}

module.exports = { getClientAddress, parseTrustProxy };
