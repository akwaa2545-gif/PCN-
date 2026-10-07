function readAuthConfiguration(env = process.env, { host = '127.0.0.1', trustProxy = 'off' } = {}) {
  const mode = env.AUTH_MODE || 'password';
  if (!['password', 'windows'].includes(mode)) throw new Error('Invalid AUTH_MODE');
  const directoryDomain = env.AD_DOMAIN || null;
  if (directoryDomain && !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/.test(directoryDomain)) throw new Error('Invalid AD_DOMAIN');
  if (mode === 'password') return { mode, directoryDomain, windowsAuth: null };
  const domain = env.WINDOWS_AUTH_DOMAIN;
  const proxyKey = env.WINDOWS_AUTH_PROXY_KEY;
  if (!directoryDomain) throw new Error('Windows sign-in requires AD_DOMAIN');
  if (typeof domain !== 'string' || !/^[a-zA-Z0-9.-]{1,100}$/.test(domain)) throw new Error('Windows sign-in requires an explicit WINDOWS_AUTH_DOMAIN');
  if (typeof proxyKey !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(proxyKey)) throw new Error('Windows sign-in requires a private WINDOWS_AUTH_PROXY_KEY');
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) || trustProxy !== 'loopback') throw new Error('Windows sign-in requires loopback HOST and TRUST_PROXY=loopback');
  return { mode, directoryDomain, windowsAuth: { mode, domain, proxyKey } };
}

module.exports = { readAuthConfiguration };
