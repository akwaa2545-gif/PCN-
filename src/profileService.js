const crypto = require('node:crypto');
const { directoryPhoto, emailList } = require('./integrationService');

const unavailable = () => ({ status: 'unavailable', photo: '', email: '', jobTitle: '', directoryDepartment: '' });
const nameKey = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';
const profileText = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) : '';

function profileEmail(value) {
  if (typeof value !== 'string' || value.length > 320) return '';
  try {
    const email = emailList(value);
    return email.includes(';') ? '' : email;
  } catch { return ''; }
}

function displayProfile(profile) {
  const email = profileEmail(profile?.email);
  if (!email) return unavailable();
  return { status: 'available', photo: directoryPhoto(profile.photo), email,
    jobTitle: profileText(profile.jobTitle), directoryDepartment: profileText(profile.department) };
}

// Cosmetic enrichment only. The result never grants access or changes an account,
// a signing assignment, or a notification recipient.
class ProfileService {
  constructor({ integrationService, employeeDirectory, now = Date.now } = {}) {
    this.integrationService = integrationService;
    this.employeeDirectory = employeeDirectory;
    this.now = now;
    this.cache = new Map();
  }

  async get(user) {
    if (!user?.id || user.isActive === false) return unavailable();
    const key = crypto.createHash('sha256').update(JSON.stringify([user.id, user.identityProvider,
      user.employeeCode, user.version, user.sessionSecurityStamp, user.email,
      user.mailProfile?.id, user.mailProfile?.email])).digest('hex');
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return { ...await cached.result };
    for (const [id, entry] of this.cache) if (entry.expiresAt <= this.now()) this.cache.delete(id);
    if (this.cache.size >= 500) return unavailable();
    const result = this.resolve(user).catch(() => unavailable());
    this.cache.set(key, { expiresAt: this.now() + 300000, result });
    return { ...await result };
  }

  async resolve(user) {
    const saved = user.mailProfile;
    const linkedEmail = profileEmail(saved?.email);
    // SQL authentication exposes mailProfile only after validating the stored
    // verification timestamp, directory ID, and matching account email.
    if (saved) {
      if (typeof saved.id !== 'string' || !saved.id.trim() || saved.id.length > 200
        || !linkedEmail || linkedEmail.toLowerCase() !== profileEmail(user.email).toLowerCase()) return unavailable();
      if (directoryPhoto(saved.photo)) return displayProfile(saved);
      const result = await this.integrationService?.directory(linkedEmail);
      const matches = (Array.isArray(result?.users) ? result.users.slice(0, 50) : []).filter(entry =>
        entry?.id === saved.id && profileEmail(entry.email).toLowerCase() === linkedEmail.toLowerCase());
      return matches.length === 1 ? displayProfile(matches[0]) : unavailable();
    }
    if (user.identityProvider !== 'employee-code' || !user.employeeCode) return unavailable();
    const employee = await this.employeeDirectory?.getByCode(user.employeeCode);
    const search = typeof employee?.englishName === 'string' ? employee.englishName.trim().replace(/\s+/g, ' ') : '';
    if (employee?.employeeCode !== user.employeeCode || search.length < 2 || search.length > 100) return unavailable();
    const result = await this.integrationService?.directory(search);
    const matches = (Array.isArray(result?.users) ? result.users.slice(0, 50) : []).filter(entry =>
      nameKey(entry?.displayName) === nameKey(search));
    return matches.length === 1 ? displayProfile(matches[0]) : unavailable();
  }
}

module.exports = { ProfileService };
