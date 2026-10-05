const crypto = require('node:crypto');
const { ApiError } = require('./apiError');
const { hashPassword, verifyPassword, validatePassword } = require('./passwords');

const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const safeUser = user => ({ id: user.id, username: user.username, email: user.email || null, roles: [...user.roles], isActive: user.isActive, mustChangePassword: user.mustChangePassword });

class AuthService {
  constructor(repository, options = {}) {
    this.repository = repository;
    this.clock = options.clock || (() => new Date());
    this.hashPassword = options.passwordHasher || hashPassword;
    this.verifyPassword = options.passwordVerifier || verifyPassword;
    this.dummyHash = null;
    this.attempts = new Map();
  }

  now() { return new Date(this.clock()); }

  throttle(address) {
    const now = this.now().getTime();
    const key = String(address || 'unknown').slice(0, 100);
    const prior = this.attempts.get(key);
    const next = prior && prior.until > now ? { ...prior, count: prior.count + 1 } : { count: 1, until: now + 60000 };
    this.attempts.set(key, next);
    if (this.attempts.size > 10000) {
      const expired = [...this.attempts].filter(([, v]) => v.until <= now).map(([k]) => k);
      for (const item of expired) this.attempts.delete(item);
      if (this.attempts.size > 10000) this.attempts.delete(this.attempts.keys().next().value);
    }
    if (next.count > 15) throw new ApiError(429, 'Too many sign-in attempts. Try again shortly');
  }

  async createUser({ username, email = null, password, roles = ['supplier'], mustChangePassword = false, bootstrap = false }) {
    if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]{3,100}$/.test(username)) throw new ApiError(400, 'Username must contain 3 to 100 letters, numbers, dots, underscores or hyphens');
    if (email !== null && (typeof email !== 'string' || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new ApiError(400, 'Invalid email address');
    if (!Array.isArray(roles) || !roles.length || roles.some(role => !['admin', 'reviewer', 'supplier', 'gsc', 'productionengineering', 'qa', 'tapbu'].includes(role))) throw new ApiError(400, 'Invalid user roles');
    if (bootstrap && !mustChangePassword) throw new ApiError(400, 'Bootstrap users must change their password');
    validatePassword(password);
    const user = await this.repository.createUser({ username, email, passwordHash: await this.hashPassword(password), roles: [...new Set(roles)], mustChangePassword });
    return safeUser(user);
  }

  async login({ username, password, remember = false } = {}, requestInfo = {}) {
    this.throttle(requestInfo.ip);
    if (typeof username !== 'string' || username.length > 320 || typeof password !== 'string' || password.length > 128) throw new ApiError(401, 'Invalid username or password');
    const user = await this.repository.getUserByLogin(username.trim().toLowerCase());
    if (!this.dummyHash) this.dummyHash = this.hashPassword(crypto.randomBytes(32).toString('hex'));
    const verified = await this.verifyPassword(user?.passwordHash || await this.dummyHash, password);
    const locked = user?.lockoutUntil && new Date(user.lockoutUntil) > this.now();
    if (!user || !verified || !user.isActive || locked) {
      if (user && user.isActive && !locked) await this.repository.recordLoginFailure(user.id, this.now());
      throw new ApiError(401, 'Invalid username or password');
    }
    await this.repository.resetLoginFailures(user.id);
    const token = crypto.randomBytes(32).toString('hex');
    const csrfToken = crypto.randomBytes(32).toString('hex');
    const ttl = remember === true ? 30 * 86400000 : 8 * 3600000;
    const expiresAt = new Date(this.now().getTime() + ttl).toISOString();
    await this.repository.saveSession({ id: crypto.randomUUID(), userId: user.id, tokenHash: hashToken(token), csrfToken, securityStamp: user.securityStamp, createdAt: this.now().toISOString(), expiresAt });
    return { user: safeUser(user), token, csrfToken, expiresAt };
  }

  async session(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const session = await this.repository.getSession(hashToken(token));
    if (!session || session.revokedAt || new Date(session.expiresAt) <= this.now()) return null;
    const user = await this.repository.getUserById(session.userId);
    if (!user?.isActive || session.securityStamp !== user.securityStamp) return null;
    return { user: safeUser(user), csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() };
  }

  async logout(token) {
    if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) await this.repository.revokeSession(hashToken(token));
  }

  async changePassword(token, { currentPassword, newPassword } = {}) {
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
