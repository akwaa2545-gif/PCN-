const path = require('node:path');
const net = require('node:net');
const { parseTrustProxy } = require('./src/clientAddress');
const { loadRuntimeEnv } = require('./src/runtimeEnv');
const { connectSql } = require('./src/sqlDatabase');
const { SqlPcnRepository } = require('./src/sqlPcnRepository');
const { AuthService } = require('./src/authService');
const { SqlAuthRepository } = require('./src/sqlAuthRepository');
const { IntegrationService } = require('./src/integrationService');
const { NotificationService } = require('./src/notificationService');
const { NotificationWorker } = require('./src/notificationWorker');
const { SqlDocuments } = require('./src/sqlDocuments');
const { createAttachmentScanner } = require('./src/attachmentScanner');
const { createApp } = require('./src/httpServer');
const { readAuthConfiguration } = require('./src/authConfiguration');
const { SqlEmployeeDirectory } = require('./src/sqlEmployeeDirectory');
const { COOKIE_NAME, HTTP_COOKIE_NAME } = require('./src/authHttp');

function parsePublicOrigin(value) {
  if (typeof value !== 'string' || !value) throw new Error('Invalid PUBLIC_ORIGIN: use a canonical HTTP or HTTPS origin');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('Invalid PUBLIC_ORIGIN: use a canonical HTTP or HTTPS origin'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || value !== parsed.origin) {
    throw new Error('Invalid PUBLIC_ORIGIN: use a canonical HTTP or HTTPS origin without credentials, path, query or fragment');
  }
  return parsed;
}

function isPrivateIpv4(hostname) {
  if (net.isIP(hostname) !== 4) return false;
  const [first, second] = hostname.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function readServerConfig(env = process.env) {
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const host = (env.HOST || '127.0.0.1').trim();
  if (host !== 'localhost' && !net.isIP(host)) throw new Error('Invalid HOST: use a bind IP address or localhost');
  const trustProxy = parseTrustProxy(env.TRUST_PROXY);
  if (env.ALLOW_INTERNAL_HTTP !== undefined && !['true', 'false'].includes(env.ALLOW_INTERNAL_HTTP)) throw new Error('ALLOW_INTERNAL_HTTP must be true or false');
  const allowInternalHttp = env.ALLOW_INTERNAL_HTTP === 'true';
  const publicOrigin = env.PUBLIC_ORIGIN === undefined ? `http://localhost:${port}` : env.PUBLIC_ORIGIN;
  const origin = parsePublicOrigin(publicOrigin);
  if (allowInternalHttp) {
    if (origin.protocol !== 'http:' || !isPrivateIpv4(origin.hostname)) throw new Error('PUBLIC_ORIGIN for internal HTTP must use an RFC1918 literal IPv4 address');
    const loopbackHost = host === 'localhost' || host === '::1' || (net.isIP(host) === 4 && host.startsWith('127.'));
    if (!loopbackHost || trustProxy !== 'loopback') throw new Error('Internal HTTP requires loopback HOST and TRUST_PROXY=loopback');
  } else if (env.NODE_ENV === 'production' && origin.protocol !== 'https:') throw new Error('Production requires HTTPS PUBLIC_ORIGIN');
  return {port,host,trustProxy,publicOrigin,runtimeEnvironment:env.NODE_ENV,secureCookies:env.NODE_ENV === 'production' && !allowInternalHttp,sessionCookieName:allowInternalHttp ? HTTP_COOKIE_NAME : COOKIE_NAME};
}

async function main() {
  await loadRuntimeEnv();
  const {port,host,trustProxy,publicOrigin,runtimeEnvironment,secureCookies,sessionCookieName} = readServerConfig();
  const authConfiguration = readAuthConfiguration(process.env,{host,trustProxy});
  const attachmentScanner = createAttachmentScanner();
  if (attachmentScanner) await attachmentScanner.ready();
  const pool = await connectSql();
  const employeeDirectory = new SqlEmployeeDirectory(pool);
  let timer;
  let server;
  try {
  const integrationService = new IntegrationService({mailUrl:process.env.POWER_AUTOMATE_MAIL_URL,directoryUrl:process.env.POWER_AUTOMATE_DIRECTORY_URL,allowedHosts:(process.env.INTEGRATION_ALLOWED_HOSTS || '').split(',').map(value=>value.trim()).filter(Boolean)});
  const atomicNotifications = new NotificationService(pool,{publicOrigin,mailUrl:process.env.POWER_AUTOMATE_MAIL_URL,mailConfigurationStatus:()=>integrationService.mailConfigurationStatus()});
  const repository = new SqlPcnRepository(pool,{notifications:atomicNotifications});
  await repository.readiness();
  const worker = new NotificationWorker(pool,{integrationService});
  const authService = new AuthService(new SqlAuthRepository(pool),{authMode:authConfiguration.mode,developerPasswordHash:authConfiguration.developerPasswordHash,employeeDirectory,integrationService});
  server = createApp({trustProxy,rootDir:path.resolve(__dirname),repository,authService,authMode:authConfiguration.mode,employeeDirectory,integrationService,notificationWorker:worker,notificationService:new NotificationService(pool,{repository,publicOrigin,mailUrl:process.env.POWER_AUTOMATE_MAIL_URL}),documents:new SqlDocuments(pool,{scanner:attachmentScanner}),publicOrigin,runtimeEnvironment,secureCookies,sessionCookieName});
  let sending = false;
  timer = setInterval(async()=>{
    if (sending || !process.env.POWER_AUTOMATE_MAIL_URL) return;
    sending = true;
    try { await worker.runOnce(); } catch (error) { console.error(JSON.stringify({level:'error',operation:'notification-worker',code:error.code || 'UNKNOWN'})); }
    finally { sending = false; }
  },5000);
  timer.unref();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  console.log(`Supplier PCN SQL server listening at ${publicOrigin}`);
  const close = async()=>{clearInterval(timer);await new Promise(resolve=>server.close(resolve));await pool.close();};
  process.once('SIGINT',()=>close().finally(()=>process.exit()));
  process.once('SIGTERM',()=>close().finally(()=>process.exit()));
  } catch (error) {
    clearInterval(timer);
    if (server?.listening) await new Promise(resolve=>server.close(resolve));
    try { await pool.close(); } catch (cleanupError) { console.error(JSON.stringify({operation:'startup-cleanup',code:cleanupError.code || 'UNKNOWN'})); }
    throw error;
  }
}
if (require.main === module) {
  main().catch(error=>{console.error(JSON.stringify({startup:'failed',code:error.code || 'CONFIGURATION',message:'SQL-backed startup failed; check configuration, database availability and applied migrations'}));process.exitCode=1;});
}

module.exports = { readServerConfig };
