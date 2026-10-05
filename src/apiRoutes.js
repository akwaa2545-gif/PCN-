const { ApiError } = require('./apiError');
const { readSessionToken, setSessionCookie, clearSessionCookie, enforceSameOrigin, enforceCsrf, requirePrincipal } = require('./authHttp');
const { hasRole, isInternal, assertRecordAccess } = require('./workflowAccess');
const { buildWorkflow } = require('./masterData');

async function handleApi(req, res, url, context, requestId) {
  const { readJsonBody, writeJson } = require('./httpServer');
  const { service, repository, authService } = context;
  const send = (data, status = 200) => writeJson(res, status, {success:true,data});
  const route = url.pathname;
  const method = req.method;
  const token = readSessionToken(req);
  if (route === '/api/health' && method === 'GET') return send({status:'ok',service:'supplier-pcn-workflow',requestId});
  if (route === '/api/ready' && method === 'GET') {
    try { await repository.readiness(); return send({status:'ready'}); }
    catch { throw new ApiError(503, 'Database is unavailable'); }
  }
  if (['/api/auth/login','/api/admin/login'].includes(route) && method === 'POST') {
    enforceSameOrigin(req, context.publicOrigin);
    const body = await readJsonBody(req);
    const session = await authService.login(body, {ip:req.socket.remoteAddress});
    if (route === '/api/admin/login' && !hasRole(session.user, 'admin')) {
      await authService.logout(session.token);
      throw new ApiError(403, 'Administrator access required');
    }
    setSessionCookie(res, session, {secure:context.secureCookies});
    return send({authenticated:true,user:session.user,csrfToken:session.csrfToken,expiresAt:session.expiresAt});
  }
  const principal = await authService.session(token);
  if (['/api/session','/api/admin/session'].includes(route) && method === 'GET') {
    return send(principal ? {authenticated:route === '/api/admin/session' ? hasRole(principal.user,'admin') : true,...principal} : {authenticated:false});
  }
  if (['/api/auth/logout','/api/admin/logout'].includes(route) && method === 'POST') {
    enforceSameOrigin(req, context.publicOrigin);
    if (principal) enforceCsrf(req, principal);
    await authService.logout(token);
    clearSessionCookie(res, {secure:context.secureCookies});
    return send({authenticated:false});
  }
  const user = requirePrincipal(principal, {allowPasswordChange:route === '/api/auth/change-password'});
  if (!['GET','HEAD'].includes(method)) {
    enforceSameOrigin(req, context.publicOrigin);
    enforceCsrf(req, principal);
  }
  if (route === '/api/auth/change-password' && method === 'POST') {
    await authService.changePassword(token, await readJsonBody(req));
    clearSessionCookie(res, {secure:context.secureCookies});
    return send({authenticated:false,passwordChanged:true});
  }
  const actor = `user:${user.id}`;
  const admin = () => { if (!hasRole(user,'admin')) throw new ApiError(403,'Administrator access required'); };
  if (route.startsWith('/api/admin/')) {
    admin();
    if (route === '/api/admin/users' && method === 'GET') return send(await authService.repository.listUsers());
    if (route === '/api/admin/users' && method === 'POST') {
      const body = await readJsonBody(req);
      return send(await authService.createUser({username:body.username,email:body.email || null,password:body.password,roles:body.roles,bootstrap:false,mustChangePassword:true}),201);
    }
    if (route === '/api/admin/directory-users' && method === 'GET') {
      if (!context.integrationService) throw new ApiError(503,'Directory lookup is not configured');
      return send(await context.integrationService.directory(url.searchParams.get('query') || ''));
    }
    if (route === '/api/admin/notifications/test' && method === 'POST') {
      if (!context.integrationService) throw new ApiError(503,'Mail integration is not configured');
      const body = await readJsonBody(req);
      return send(await context.integrationService.testMail({to:body.recipient,groupId:body.groupId},await service.getNotificationSettings()));
    }
    throw new ApiError(404,'API route not found');
  }
  if (route === '/api/master-data' && method === 'GET') return send(await repository.getMasterData());
  if (route === '/api/notification-settings') {
    admin();
    if (method === 'GET') return send(await service.getNotificationSettings());
    if (['PUT','PATCH'].includes(method)) return send(await service.updateNotificationSettings(await readJsonBody(req),actor));
  }
  if (route === '/api/pcns') {
    if (method === 'GET') return send(await service.list({status:url.searchParams.get('status') || undefined},user));
    if (method === 'POST') return send(await service.create(await readJsonBody(req),actor,user),201);
  }
  const match = /^\/api\/pcns\/(PCN-\d{4}-\d{4})(?:\/(.*))?$/.exec(route);
  if (!match) throw new ApiError(404,'API route not found');
  const [,code,subroute] = match;
  const record = await service.getById(code,user);
  if (!subroute && method === 'GET') return send(record);
  if (!subroute && ['PATCH','PUT'].includes(method)) {
    const body = await readJsonBody(req);
    requireVersion(body);
    return send(await service.update(code,body,actor,user));
  }
  if (!subroute && method === 'DELETE') {
    admin();
    const body = await readJsonBody(req);
    requireVersion(body);
    return send(await service.remove(code,actor,body.version));
  }
  if (subroute === 'progress' && method === 'GET') return send(await service.getProgress(code));
  if (subroute === 'workflow' && method === 'GET') return send(buildWorkflow(record.riskLevel));
  if (subroute === 'audit' && method === 'GET') {
    if (!isInternal(user)) throw new ApiError(403,'Audit access requires an internal reviewer');
    return send(await repository.getAudit(code));
  }
  if (['comments','approvals'].includes(subroute) && method === 'POST') {
    const body = await readJsonBody(req);
    requireVersion(body);
    return send(await service[subroute === 'comments' ? 'addComment' : 'addApproval'](code,body,actor,user),201);
  }
  if (subroute === 'notifications/workflow' && method === 'POST') {
    if (!isInternal(user)) throw new ApiError(403,'Workflow notification requires an internal reviewer');
    if (!context.notificationService) throw new ApiError(503,'Mail integration is not configured');
    return send(await context.notificationService.workflow(record,await readJsonBody(req),user),202);
  }
  if (subroute === 'documents' && method === 'POST') {
    assertDocumentEdit(record,user);
    if (!context.documents) throw new ApiError(503,'Document storage is unavailable');
    const body = await readJsonBody(req,15000000);
    requireVersion(body);
    return send(await context.documents.save(code,body,{user,actor,version:body.version}),201);
  }
  const doc = /^documents\/([0-9a-f-]{36})$/i.exec(subroute || '');
  if (doc && ['GET','DELETE'].includes(method)) {
    if (!context.documents) throw new ApiError(503,'Document storage is unavailable');
    if (method === 'DELETE') {
      assertDocumentEdit(record,user);
      const body = await readJsonBody(req);
      requireVersion(body);
      return send(await context.documents.delete(code,doc[1],{user,actor,version:body.version}));
    }
    const file = await context.documents.get(code,doc[1]);
    res.writeHead(200,{'content-type':file.ContentType,'content-disposition':`attachment; filename="${file.FileName.replace(/[^a-zA-Z0-9._-]/g,'_')}"`,'cache-control':'no-store'});
    return res.end(file.Bytes);
  }
  throw new ApiError(405,'Method not allowed');
}

function requireVersion(body) {
  if (typeof body.version !== 'string' || !/^[a-fA-F0-9]{16}$/.test(body.version)) throw new ApiError(400,'The current PCN version is required');
}
function assertDocumentEdit(record,user) {
  assertRecordAccess(record,user);
  if (['approved','rejected','closed'].includes(record.status) || !isInternal(user) && !['draft','supplier_action'].includes(record.status)) throw new ApiError(403,'Document edits are not allowed at this stage');
}
module.exports = { handleApi, requireVersion };
