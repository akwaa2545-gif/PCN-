function readAuthConfiguration(env = process.env) {
  const mode = env.AUTH_MODE ?? 'employee-code';
  if (!['employee-code', 'password'].includes(mode)) throw new Error('Invalid AUTH_MODE');
  return { mode };
}
module.exports = { readAuthConfiguration };
