const PRESENCE_TTL_MS = 90000;
const MAX_PRESENCE_SESSIONS = 10000;

// Presence describes recent authenticated activity in this process, not account access.
class UserPresence {
  constructor({clock = Date.now, maxSessions = MAX_PRESENCE_SESSIONS} = {}) {
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > MAX_PRESENCE_SESSIONS) throw new Error('Invalid presence session limit');
    this.clock = clock;
    this.maxSessions = maxSessions;
    this.sessions = new Map();
  }
  prune() {
    const now = Number(this.clock());
    for (const [hash,session] of this.sessions) {
      if (session.expiresAt <= now || now - session.observedAt >= PRESENCE_TTL_MS) this.sessions.delete(hash);
    }
  }
  touch(tokenHash,session) {
    this.prune();
    const now = Number(this.clock());
    const expiresAt = new Date(session?.expiresAt).getTime();
    if (!/^[a-f0-9]{64}$/.test(tokenHash) || !session?.userId || !session.securityStamp || !Number.isFinite(expiresAt) || expiresAt <= now) return;
    this.sessions.delete(tokenHash);
    this.sessions.set(tokenHash,{tokenHash,userId:session.userId,securityStamp:session.securityStamp,expiresAt,observedAt:now});
    if (this.sessions.size > this.maxSessions) this.sessions.delete(this.sessions.keys().next().value);
  }
  forget(tokenHash) { this.sessions.delete(tokenHash); }
  candidates() {
    this.prune();
    return [...this.sessions.values()].map(session => ({...session}));
  }
  project(users,candidates,validSessions) {
    const observed = new Map(candidates.map(candidate => [candidate.tokenHash,candidate]));
    const now = Number(this.clock());
    const valid = new Set(validSessions.filter(session => {
      const candidate = observed.get(session.tokenHash);
      return candidate && candidate.userId === session.userId && candidate.securityStamp === session.securityStamp
        && !session.revokedAt && new Date(session.expiresAt).getTime() > now;
    }).map(session => session.tokenHash));
    for (const candidate of candidates) {
      if (!valid.has(candidate.tokenHash) && this.sessions.get(candidate.tokenHash)?.observedAt === candidate.observedAt) this.forget(candidate.tokenHash);
    }
    const online = new Set(this.candidates().filter(session => valid.has(session.tokenHash)).map(session => session.userId));
    return users.map(user => ({status:user.isActive === true && online.has(user.id) ? 'online' : 'offline'}));
  }
}

module.exports = {UserPresence,PRESENCE_TTL_MS,MAX_PRESENCE_SESSIONS};
