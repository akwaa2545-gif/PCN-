const crypto = require('node:crypto');
const { ApiError } = require('./apiError');
const { hashPassword, verifyPassword, validatePassword } = require('./passwords');
const { employeeRoles, employeeDepartments, validateEmployeeIdentity, normalizeEmployeeCode, validateUserAssignment, validateVerifiedMail } = require('./employeeAccounts');
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const providerOf = user => user?.identityProvider || (user?.directoryId ? 'retired-windows' : 'password');
const safeUser = user => ({ id: user.id, username: user.username, email: user.email || null, roles: [...user.roles], isActive: user.isActive,
  signingStep:user.signingStep || null,mailProfile:user.mailProfile || null,version:user.version || null,
  mustChangePassword: providerOf(user) === 'employee-code' ? false : Boolean(user.mustChangePassword), identityProvider: providerOf(user),
  ...(user.employeeCode ? { employeeCode: user.employeeCode, displayName: user.displayName || user.employeeCode, department: user.department || null } : {}) });
function sessionPrincipal(user, session, tokenHash) {
  const principal = { user: safeUser(user), csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() };
  Object.defineProperty(principal.user,'sessionSecurityStamp',{value:session.securityStamp});
  Object.defineProperties(principal, { sessionSecurityStamp: { value: session.securityStamp }, sessionTokenHash: { value: tokenHash } });
  return principal;
}
function assertFields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) throw new ApiError(400, 'Unexpected request fields');
}
class AuthService {
  constructor(repository, options = {}) {
    this.repository = repository;
    this.clock = options.clock || (() => new Date());
    this.hashPassword = options.passwordHasher || hashPassword;
    this.verifyPassword = options.passwordVerifier || verifyPassword;
    this.dummyHash = null;
    this.attempts = new Map();
    this.authMode = options.authMode || 'employee-code';
    if (!['employee-code', 'password'].includes(this.authMode)) throw new Error('Invalid authentication mode');
    this.employeeDirectory = options.employeeDirectory;
    this.integrationService = options.integrationService;
  }
  now() { return new Date(this.clock()); }
  throttle(address) {
    const now = this.now().getTime();
    const key = String(address || 'unknown').slice(0, 100);
    const prior = this.attempts.get(key);
    const next = prior && prior.until > now ? { ...prior, count: prior.count + 1 } : { count: 1, until: now + 60000 };
    this.attempts.set(key, next);
    if (this.attempts.size > 10000) {
      for (const [item, value] of this.attempts) if (value.until <= now) this.attempts.delete(item);
      if (this.attempts.size > 10000) this.attempts.delete(this.attempts.keys().next().value);
    }
    if (next.count > 15) throw new ApiError(429, 'Too many sign-in attempts. Try again shortly');
  }
  async createUser({ username, email = null, password, roles = ['supplier'], mustChangePassword = false, bootstrap = false }) {
    if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]{3,100}$/.test(username)) throw new ApiError(400, 'Username must contain 3 to 100 letters, numbers, dots, underscores or hyphens');
    if (email !== null && (typeof email !== 'string' || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new ApiError(400, 'Invalid email address');
    if (!Array.isArray(roles) || !roles.length || roles.some(role => !employeeRoles.includes(role))) throw new ApiError(400, 'Invalid user roles');
    if (bootstrap && !mustChangePassword) throw new ApiError(400, 'Bootstrap users must change their password');
    validatePassword(password);
    return safeUser(await this.repository.createUser({ username, email, passwordHash: await this.hashPassword(password), roles: [...new Set(roles)], mustChangePassword }));
  }
  async login(body = {}, requestInfo = {}) {
    this.throttle(requestInfo.ip);
    if (this.authMode === 'employee-code') return this.loginEmployee(body);
    assertFields(body, ['username','password','remember']);
    const {username,password,remember=false}=body;
    if (typeof username !== 'string' || username.length > 320 || typeof password !== 'string' || password.length > 128) throw new ApiError(401, 'Invalid username or password');
    const user = await this.repository.getUserByLogin(username.trim().toLowerCase());
    if (!this.dummyHash) this.dummyHash = this.hashPassword(crypto.randomBytes(32).toString('hex'));
    const verified = await this.verifyPassword(user?.passwordHash || await this.dummyHash, password);
    const locked = user?.lockoutUntil && new Date(user.lockoutUntil) > this.now();
    if (!user || !verified || !user.isActive || locked || providerOf(user) !== 'password') {
      if (user && user.isActive && !locked) await this.repository.recordLoginFailure(user.id, this.now());
      throw new ApiError(401, 'Invalid username or password');
    }
    await this.repository.resetLoginFailures(user.id);
    return this.issueSession(user, remember === true);
  }
  async lookupEmployee(employeeCode, directory = this.employeeDirectory) {
    if (!directory) throw new ApiError(503, 'Employee service is unavailable');
    try {
      const profile = await directory.getByCode(employeeCode);
      if (!profile) return null;
      validateEmployeeIdentity(profile);
      if (profile.isActive !== true || normalizeEmployeeCode(profile.employeeCode).toLowerCase() !== employeeCode.toLowerCase()) return null;
      return profile;
    } catch { throw new ApiError(503, 'Employee service is unavailable'); }
  }
  async loginEmployee(body) {
    assertFields(body, ['employeeCode','remember']);
    if (body.remember !== undefined && typeof body.remember !== 'boolean') throw new ApiError(400, 'Invalid remember option');
    let code;
    try { code = normalizeEmployeeCode(body.employeeCode); } catch { throw new ApiError(401, 'Employee access could not be verified'); }
    const profile = await this.lookupEmployee(code);
    if (!profile) throw new ApiError(401, 'Employee access could not be verified');
    let user = await this.repository.getUserByEmployeeCode(code.toLowerCase());
    if (!user) {
      try { user = await this.repository.createEmployeeViewer(profile); }
      catch (error) {
        if (error.statusCode !== 409) throw error;
        user = await this.repository.getUserByEmployeeCode(code.toLowerCase());
        if (!user) throw error;
      }
    }
    if (!this.matchesEmployee(user, profile)) throw new ApiError(401, 'Employee access could not be verified');
    return this.issueSession(user, body.remember === true);
  }
  matchesEmployee(user, profile) {
    if (!user?.isActive || providerOf(user) !== 'employee-code') return false;
    try {
      const code = normalizeEmployeeCode(user.employeeCode).toLowerCase();
      return user.normalizedEmployeeCode === code && code === normalizeEmployeeCode(profile.employeeCode).toLowerCase();
    } catch { return false; }
  }
  async issueSession(user, remember = false) {
    const token = crypto.randomBytes(32).toString('hex');
    const csrfToken = crypto.randomBytes(32).toString('hex');
    const ttl = remember === true ? 30 * 86400000 : 8 * 3600000;
    const expiresAt = new Date(this.now().getTime() + ttl).toISOString();
    await this.repository.saveSession({ id: crypto.randomUUID(), userId: user.id, tokenHash: hashToken(token), csrfToken, securityStamp: user.securityStamp, createdAt: this.now().toISOString(), expiresAt });
    return { user: safeUser(user), token, csrfToken, expiresAt };
  }
  async resolveEmployee(employeeCode, directory = this.employeeDirectory) {
    const code=normalizeEmployeeCode(employeeCode);
    const profile=await this.lookupEmployee(code,directory);
    if(!profile)throw new ApiError(400,'Select an employee from the employee database');
    return profile;
  }
  validateAssignments({roles,department,signingStep=null}) {
    if (!Array.isArray(roles) || !roles.length || roles.some(role => !employeeRoles.includes(role))) throw new ApiError(400, 'Invalid user roles');
    if (!employeeDepartments.some(item => item.key === department)) throw new ApiError(400, 'Select a valid department');
    validateUserAssignment({roles,department,signingStep});
  }
  async resolveMail(selection,prior={}) {
    if (selection === undefined) {
      if (!prior.mailDirectoryId || !prior.mailVerifiedAt || !prior.mailProfile) return {email:null,mailDirectoryId:null,mailVerifiedAt:null,mailProfile:null};
      const mail={email:prior.email,mailDirectoryId:prior.mailDirectoryId,mailVerifiedAt:prior.mailVerifiedAt,mailProfile:prior.mailProfile};
      validateVerifiedMail(mail); return mail;
    }
    if(selection===null) return {email:null,mailDirectoryId:null,mailVerifiedAt:null,mailProfile:null};
    assertFields(selection,['id','email']);
    if(typeof selection.id!=='string'||!selection.id.trim()||selection.id.length>200||typeof selection.email!=='string'
      ||selection.email.length>100||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(selection.email)) throw new ApiError(400,'Select an email from directory results');
    if(!this.integrationService) throw new ApiError(503,'Directory lookup is unavailable');
    let result;
    try {result=await this.integrationService.directory(selection.email);} catch {throw new ApiError(503,'Directory lookup is unavailable');}
    const matches=(result?.users||[]).filter(profile=>profile.id===selection.id&&typeof profile.email==='string'&&profile.email.toLowerCase()===selection.email.toLowerCase());
    if(matches.length!==1)throw new ApiError(400,'Select an email from directory results');
    const selected=matches[0];
    const mailProfile={id:selected.id,email:selected.email,displayName:selected.displayName||selected.email,jobTitle:selected.jobTitle||'',department:selected.department||'',photo:selected.photo||''};
    const mail={email:selected.email,mailDirectoryId:selected.id,mailVerifiedAt:this.now().toISOString(),mailProfile};
    validateVerifiedMail(mail);return mail;
  }
  async createEmployee(body = {}, directory = this.employeeDirectory, actor='administrator',user) {
    assertFields(body,['employeeCode','roles','department','signingStep','mailSelection']);
    const {employeeCode,roles,department,signingStep=null}=body;
    this.validateAssignments({roles,department,signingStep});
    const profile=await this.resolveEmployee(employeeCode,directory);
    const mail=await this.resolveMail(body.mailSelection);
    validateVerifiedMail({...mail,signingStep});
    return safeUser(await this.repository.createEmployeeUser({ employeeCode: normalizeEmployeeCode(profile.employeeCode), displayName: profile.displayName, roles: [...new Set(roles)], department,signingStep,...mail },actor,user));
  }
  async updateEmployee(body={},actor='administrator',user) {
    assertFields(body,['userId','roles','department','signingStep','mailSelection','isActive','version']);
    if(typeof body.version!=='string'||!/^[a-fA-F0-9]{16}$/.test(body.version))throw new ApiError(400,'The current account version is required');
    if(typeof body.isActive!=='boolean'||!Object.hasOwn(body,'signingStep'))throw new ApiError(400,'Complete account assignments are required');
    this.validateAssignments(body);
    const prior=await this.repository.getUserById(body.userId);
    if(!prior)throw new ApiError(404,'User not found');
    if(body.signingStep!==null&&providerOf(prior)!=='employee-code')throw new ApiError(400,'Link an employee before assigning a signing step');
    const mail=await this.resolveMail(body.mailSelection,prior);
    validateVerifiedMail({...mail,signingStep:body.signingStep});
    return safeUser(await this.repository.updateEmployeeAccount(body.userId,{roles:[...new Set(body.roles)],department:body.department,signingStep:body.signingStep,isActive:body.isActive,version:body.version,...mail},actor,user));
  }
  async linkEmployee(body = {}, directory = this.employeeDirectory,actor='administrator',user) {
    assertFields(body,['userId','employeeCode']);
    const {userId,employeeCode}=body;
    const prior=await this.repository.getUserById(userId);
    if(!prior)throw new ApiError(404,'User not found');
    if(!prior.isActive)throw new ApiError(400,'Only active users can be linked to an employee');
    if(this.authMode === 'password' && prior.roles.includes('admin')) throw new ApiError(409,'Switch to employee-code mode before linking an administrator');
    const profile=await this.resolveEmployee(employeeCode,directory);
    return safeUser(await this.repository.linkEmployeeIdentity(userId,profile,actor,user));
  }
  async session(token,{skipEmployeeLookup=false}={}) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const tokenHash = hashToken(token);
    const session = await this.repository.getSession(tokenHash);
    if (!session || session.revokedAt || new Date(session.expiresAt) <= this.now()) return null;
    const user = await this.repository.getUserById(session.userId);
    if (!user?.isActive || session.securityStamp !== user.securityStamp || providerOf(user) !== this.authMode) return null;
    if (this.authMode === 'employee-code' && !skipEmployeeLookup) {
      let code;
      try {code=normalizeEmployeeCode(user.employeeCode);}catch{return null;}
      const profile=await this.lookupEmployee(code);
      if (!profile) return null;
      // Employee lookup can be slow. Re-read grants so concurrent revocation,
      // relinking or a role change cannot authorize the earlier SQL principal.
      const latestSession = await this.repository.getSession(tokenHash);
      if (!latestSession || latestSession.revokedAt || new Date(latestSession.expiresAt) <= this.now()
        || latestSession.userId !== session.userId || latestSession.securityStamp !== session.securityStamp) return null;
      const latestUser = await this.repository.getUserById(latestSession.userId);
      if (latestUser?.securityStamp !== latestSession.securityStamp || !this.matchesEmployee(latestUser, profile)) return null;
      return sessionPrincipal(latestUser, latestSession, tokenHash);
    }
    return sessionPrincipal(user, session, tokenHash);
  }
  async logout(token) {
    if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) await this.repository.revokeSession(hashToken(token));
  }
  async changePassword(token, { currentPassword, newPassword } = {}) {
    if (this.authMode !== 'password') throw new ApiError(403, 'Employee-code sign-in does not use a password');
    const principal = await this.session(token);
    if (!principal) throw new ApiError(401, 'Sign in required');
    validatePassword(newPassword);
    if (typeof currentPassword !== 'string' || currentPassword.length > 128) throw new ApiError(400, 'Invalid current password');
    const user = await this.repository.getUserById(principal.user.id);
    if (!await this.verifyPassword(user.passwordHash, currentPassword)) throw new ApiError(400, 'Invalid current password');
    if (currentPassword === newPassword) throw new ApiError(400, 'Choose a different password');
    await this.repository.updatePassword(user.id, await this.hashPassword(newPassword), crypto.randomUUID(), user.securityStamp);
  }
}
module.exports = { AuthService, hashToken, safeUser };
