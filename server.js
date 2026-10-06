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
const { createApp } = require('./src/httpServer');

function readServerConfig(env = process.env) {
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const host = (env.HOST || '127.0.0.1').trim();
  if (host !== 'localhost' && !net.isIP(host)) throw new Error('Invalid HOST: use a bind IP address or localhost');
  const trustProxy = parseTrustProxy(env.TRUST_PROXY);
  const publicOrigin = env.PUBLIC_ORIGIN || `http://localhost:${port}`;
  if (env.NODE_ENV === 'production' && new URL(publicOrigin).protocol !== 'https:') throw new Error('Production requires HTTPS PUBLIC_ORIGIN');
  return {port,host,trustProxy,publicOrigin};
}

async function main() {
  await loadRuntimeEnv();
  const {port,host,trustProxy,publicOrigin} = readServerConfig();
  const pool = await connectSql();
  let timer;
  let server;
  try {
  const repository = new SqlPcnRepository(pool);
  await repository.readiness();
  const integrationService = new IntegrationService({mailUrl:process.env.POWER_AUTOMATE_MAIL_URL,directoryUrl:process.env.POWER_AUTOMATE_DIRECTORY_URL,allowedHosts:(process.env.INTEGRATION_ALLOWED_HOSTS || '').split(',').map(value=>value.trim()).filter(Boolean)});
  const worker = new NotificationWorker(pool,{integrationService});
  server = createApp({trustProxy,rootDir:path.resolve(__dirname),repository,authService:new AuthService(new SqlAuthRepository(pool)),integrationService,notificationWorker:worker,notificationService:new NotificationService(pool,{repository,publicOrigin,mailUrl:process.env.POWER_AUTOMATE_MAIL_URL}),documents:new SqlDocuments(pool),publicOrigin,secureCookies:process.env.NODE_ENV === 'production'});
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
