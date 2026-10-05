function integer(env, name, fallback, min, max) {
  const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function boolean(env, name, fallback) {
  if (env[name] === undefined || env[name] === '') return fallback;
  if (!['true', 'false'].includes(env[name])) throw new Error(`${name} must be true or false`);
  return env[name] === 'true';
}

function getSqlConfig(env = process.env) {
  for (const key of ['SQL_USER', 'SQL_PASSWORD']) if (!env[key]) throw new Error(`${key} is required`);
  return {
    server: env.SQL_SERVER || 'svr120a', database: env.SQL_DATABASE || 'Scn_DB',
    user: env.SQL_USER, password: env.SQL_PASSWORD,
    port: integer(env, 'SQL_PORT', 1433, 1, 65535),
    connectionTimeout: integer(env, 'SQL_CONNECTION_TIMEOUT_MS', 15000, 1000, 120000),
    requestTimeout: integer(env, 'SQL_REQUEST_TIMEOUT_MS', 30000, 1000, 120000),
    pool: { min: 0, max: integer(env, 'SQL_POOL_MAX', 10, 1, 100), idleTimeoutMillis: 30000 },
    options: { encrypt: true, trustServerCertificate: boolean(env, 'SQL_TRUST_SERVER_CERTIFICATE', false),
      enableArithAbort: true, appName: 'Supplier PCN Workflow', useUTC: true }
  };
}

module.exports = { getSqlConfig };
