const fs = require('node:fs/promises');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { ApiError } = require('./apiError');
const { PcnService } = require('./pcnService');
const { handleApi } = require('./apiRoutes');
const { ApiRateLimiter } = require('./apiRateLimit');
const { getClientAddress, parseTrustProxy } = require('./clientAddress');

const assets = new Set(['admin.html','form.html','index.html','login.html','app.js','admin.js','login.js','session-client.js','auth.css','styles.css','tokin-header-logo.png','compic20220308153715_T3zHf.png','CairoliClassic-Bold.otf']);
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.otf':'font/otf' };

function createRequestHandler(options = {}) {
  if (!options.repository && !options.service) throw new Error('A SQL repository is required');
  if (!options.authService) throw new Error('A SQL authentication service is required');
  const context = { ...options, trustProxy: parseTrustProxy(options.trustProxy), service: options.service || new PcnService(options.repository, options.clock), publicOrigin: options.publicOrigin || process.env.PUBLIC_ORIGIN || 'http://localhost:3000', secureCookies: options.secureCookies ?? process.env.NODE_ENV === 'production' };
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  const rateLimiter = options.rateLimiter || new ApiRateLimiter();
  return async (req, res) => {
    const requestId = crypto.randomUUID();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        const clientAddress = getClientAddress(req, {trustProxy:context.trustProxy});
        rateLimiter.check(req, {clientAddress});
        await handleApi(req, res, url, {...context,clientAddress}, requestId);
      }
      else await serveStatic(req, res, url, rootDir);
    } catch (error) {
      const status = error instanceof ApiError ? error.statusCode : 500;
      if (status === 500) console.error(JSON.stringify({level:'error',requestId,code:error.code || 'INTERNAL_ERROR'}));
      writeJson(res, status, {success:false,error:error instanceof ApiError ? error.message : 'Internal server error',code:error instanceof ApiError ? error.code : undefined,details:error instanceof ApiError ? error.details : undefined,requestId});
    }
  };
}

function createApp(options = {}) { return http.createServer(createRequestHandler(options)); }

async function serveStatic(req, res, url, rootDir) {
  if (!['GET','HEAD'].includes(req.method)) throw new ApiError(405, 'Method not allowed');
  let route;
  try { route = decodeURIComponent(url.pathname); } catch { throw new ApiError(400, 'Invalid URL'); }
  let file = route.replace(/^\/+/, '');
  if (['/','/admin'].includes(route)) file = 'admin.html';
  if (route === '/login') file = 'login.html';
  if (route === '/create' || /^\/P(?:CN|NC)-\d{4}-\d{3,4}$/i.test(route)) file = 'form.html';
  if (!assets.has(file)) throw new ApiError(404, 'File not found');
  let content;
  try { content = await fs.readFile(path.join(rootDir, file)); } catch (error) {
    if (error.code === 'ENOENT') throw new ApiError(404, 'File not found');
    throw error;
  }
  res.writeHead(200, {'content-type':mime[path.extname(file)] || 'application/octet-stream','cache-control':'no-store'});
  res.end(req.method === 'HEAD' ? undefined : content);
}

async function readJsonBody(req, limit = 1000000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new ApiError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (!total) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch { throw new ApiError(400, 'Invalid JSON object'); }
}

function writeJson(res, status, payload) {
  if (res.headersSent) return;
  res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
  res.end(JSON.stringify(payload));
}

module.exports = { createApp, createRequestHandler, readJsonBody, writeJson };
