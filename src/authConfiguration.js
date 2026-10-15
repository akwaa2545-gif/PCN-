function readAuthConfiguration(env = process.env) {
  const mode = env.AUTH_MODE ?? 'employee-code';
  if (!['employee-code', 'password'].includes(mode)) throw new Error('Invalid AUTH_MODE');
  if (!env.PCN_DEVELOPER_PASSWORD_HASH) return { mode };
  const hash = env.PCN_DEVELOPER_PASSWORD_HASH;
  const valid = typeof hash === 'string' && /^\$argon2id\$v=19\$m=65536,(?:t=3,p=1|p=1,t=3)\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/.test(hash);
  return { mode, developerPasswordHash:valid ? hash : null };
}
module.exports = { readAuthConfiguration };
