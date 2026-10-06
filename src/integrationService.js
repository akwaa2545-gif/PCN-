const { ApiError } = require('./apiError');

function text(value, field, max, required = true) {
  if (value !== undefined && typeof value !== 'string') throw new ApiError(400, `${field} must be text`);
  const result = (value || '').trim();
  if ((required && !result) || result.length > max) throw new ApiError(400, `${field} is invalid`);
  return result;
}

function emailList(value) {
  const emails = text(value, 'Recipient', 1000).split(/[;,]/).map((email) => email.trim());
  if (emails.length > 30 || emails.some((email) => !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(email))) {
    throw new ApiError(400, 'Notification recipient is invalid');
  }
  return [...new Set(emails)].join('; ');
}

function directoryProfileText(value) {
  return typeof value === 'string' ? value.trim().slice(0, 120) : '';
}

function directoryPhoto(value) {
  if (typeof value !== 'string') return '';
  const match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/= \t\r\n]+)$/i.exec(value.trim());
  if (!match) return '';
  const encoded = match[2].replace(/[ \t\r\n]/g, '');
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return '';
  const photo = `data:image/${match[1].toLowerCase()};base64,${encoded}`;
  return photo.length <= 100 * 1024 ? photo : '';
}

class IntegrationService {
  constructor(options = {}) {
    this.mailUrl = options.mailUrl || '';
    this.directoryUrl = options.directoryUrl || '';
    this.allowedHosts = (options.allowedHosts || []).map((host) => String(host).toLowerCase());
    this.fetchImpl = options.fetchImpl || fetch;
  }

  endpoint(value) {
    let url;
    try { url = new URL(value); } catch { throw new ApiError(503, 'Integration endpoint is not configured'); }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !this.allowedHosts.includes(url.hostname.toLowerCase())) {
      throw new ApiError(503, 'Integration endpoint is not approved');
    }
    return url.toString();
  }

  mailConfigurationStatus() {
    if (!this.mailUrl) return 'not_configured';
    try { this.endpoint(this.mailUrl); return 'configured'; }
    catch { return 'invalid'; }
  }

  async request(url, payload, parseResult = false) {
    const endpoint = this.endpoint(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
      });
      if (!response.ok) throw new ApiError(502, 'Integration request failed');
      if (!parseResult) { await response.body?.cancel(); return {}; }
      const reader = response.body.getReader();
      let size = 0;
      const chunks = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 256 * 1024) { await reader.cancel(); throw new ApiError(502, 'Directory response is too large'); }
        chunks.push(Buffer.from(value));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, 'Integration outcome is unknown');
    } finally { clearTimeout(timeout); }
  }

  async sendMail(input) {
    const payload = {
      to: emailList(input.to), subject: text(input.subject, 'Subject', 180),
      message: text(input.message, 'Message', 20000),
      senderName: text(input.senderName || 'Supplier PCN Workflow', 'Sender', 120)
    };
    await this.request(this.mailUrl, payload);
    return { sent: true, to: payload.to, subject: payload.subject };
  }

  async testMail(input, settings = {}) {
    const group = (settings.groups || []).find((entry) => entry.key === input.groupId);
    // This method is exposed only through the authenticated administrator route.
    const to = input.to ? emailList(input.to) : emailList(group?.emails);
    return this.sendMail({ to, subject: '[PCN] Notification test', message: 'Supplier PCN notification configuration test.' });
  }

  async directory(query) {
    const search = text(query, 'Search', 100);
    if (search.length < 2) throw new ApiError(400, 'Search must contain at least two characters');
    const result = await this.request(this.directoryUrl, { query: search, searchTerm: search }, true);
    const entries = Array.isArray(result) ? result : result?.users || result?.value || result?.results;
    if (!Array.isArray(entries)) throw new ApiError(502, 'Directory returned an invalid response');
    const users = entries.slice(0, 50).filter((entry) => entry && typeof entry === 'object').flatMap((entry) => {
      try {
        const email = emailList(entry.email || entry.mail || entry.userPrincipalName);
        if (email.includes(';')) return [];
        return [{
          id: text(entry.id || '', 'Id', 200, false), displayName: text(entry.displayName || email, 'Name', 200), email,
          jobTitle: directoryProfileText(entry.jobTitle), department: directoryProfileText(entry.department),
          photo: directoryPhoto(entry.photo)
        }];
      } catch { return []; }
    });
    return { users };
  }
}

module.exports = { IntegrationService, emailList };
