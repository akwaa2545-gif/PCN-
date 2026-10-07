(function () {
  let session = { authenticated: false, user: null, csrfToken: '' };

  function safeReturnTo(value) {
    const fallback = '/create';
    try {
      const raw = String(value || '');
      const decoded = decodeURIComponent(raw);
      if (!raw.startsWith('/') || /^[/\\]{2}/.test(decoded) || decoded.includes('\\') || /[\x00-\x1f]/.test(decoded)) return fallback;
      const url = new URL(raw, window.location.origin);
      if (url.origin !== window.location.origin || url.pathname === '/login' || url.pathname === '/login.html') return fallback;
      return url.pathname + url.search + url.hash;
    } catch (_) {
      return fallback;
    }
  }

  function redirectToLogin(changePassword = false) {
    const current = safeReturnTo(window.location.pathname + window.location.search + window.location.hash);
    window.location.assign(`/login?returnTo=${encodeURIComponent(current)}${changePassword ? '&changePassword=1' : ''}`);
  }

  async function apiFetch(path, options = {}) {
    const url = new URL(path, window.location.origin);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) throw new Error('API requests must use a same-origin /api/ destination.');
    const method = String(options.method || 'GET').toUpperCase();
    const headers = new Headers(options.headers || {});
    headers.delete('x-user-role');
    headers.delete('x-csrf-token');
    headers.set('accept', 'application/json');
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && session.csrfToken) headers.set('X-CSRF-Token', session.csrfToken);
    const response = await fetch(url.pathname + url.search, { ...options, method, headers, credentials: 'same-origin', mode: 'same-origin', cache: 'no-store' });
    let body;
    try {
      body = await response.json();
    } catch (_) {
      throw new Error('The server returned an unreadable response. Please try again.');
    }
    if (!response.ok || !body.success) {
      const rawError = typeof body.error === 'string' ? body.error : body.error?.message;
      const isEditConflict = response.status === 409 && ['PATCH', 'PUT', 'DELETE'].includes(method) && /^\/api\/pcns\/[^/]+$/.test(url.pathname);
      const message = isEditConflict ? 'This record changed since you loaded it. Refresh the record before saving again; your edits have not been overwritten.' : rawError || 'API request failed.';
      const error = new Error(message);
      error.status = response.status;
      error.code = body.code || body.error?.code;
      const authRoute = url.pathname === '/api/session' || url.pathname.startsWith('/api/auth/');
      if (response.status === 401 && !authRoute) redirectToLogin();
      if (error.code === 'PASSWORD_CHANGE_REQUIRED' && !authRoute) redirectToLogin(true);
      throw error;
    }
    if (body.data && Object.prototype.hasOwnProperty.call(body.data, 'authenticated')) {
      session = { ...body.data, csrfToken: body.data.csrfToken || '' };
    }
    return body.data;
  }

  async function load() {
    try { return await apiFetch('/api/session'); }
    catch (error) {
      if (error.status !== 401) throw error;
      session = { authenticated: false, user: null, csrfToken: '' };
      return session;
    }
  }

  async function requireSession(role) {
    const current = await load();
    if (!current.authenticated) {
      redirectToLogin();
      return null;
    }
    if (current.user?.mustChangePassword) {
      redirectToLogin(true);
      return null;
    }
    if (role && !(current.user?.roles || []).some((value) => String(value).toLowerCase() === role.toLowerCase())) throw new Error('Your account does not have access to this page.');
    return current;
  }

  async function logout() {
    await apiFetch('/api/auth/logout', { method: 'POST', body: '{}' });
    session = { authenticated: false, user: null, csrfToken: '' };
    window.location.assign('/login');
  }

  function mountProfile(user, onLogoutError) {
    const container = document.getElementById('accountMenu');
    if (!container || !user) return;
    const username = String(user.displayName || user.fullName || user.username || 'User').trim();
    const fullName = String(user.displayName || user.fullName || '').trim();
    const roleNames = {
      admin: 'Admin', reviewer: 'Reviewer', supplier: 'Supplier',
      gsc: 'GSC/TET', productionengineering: 'Prod. Eng./TET',
      qa: 'QA/TET', tapbu: 'TaPBU'
    };
    const roles = (Array.isArray(user.roles) ? user.roles : []).map(role => roleNames[String(role).toLowerCase()] || String(role));
    const roleText = roles.join(', ') || 'No role assigned';
    const nameParts = (fullName || username).split(/[\s._-]+/).filter(Boolean);
    const initials = (nameParts.length > 1 ? nameParts[0][0] + nameParts[nameParts.length - 1][0] : (nameParts[0] || 'U').slice(0, 2)).toUpperCase();
    const element = (tag, className, value) => {
      const node = document.createElement(tag);
      node.className = className;
      if (value !== undefined) node.textContent = value;
      return node;
    };
    const avatar = (className) => {
      const node = element('span', className, initials);
      node.setAttribute('aria-hidden', 'true');
      return node;
    };

    const trigger = element('button', 'account-trigger');
    trigger.type = 'button';
    trigger.setAttribute('aria-label', `Open profile for ${username}`);
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', 'accountProfilePanel');
    trigger.append(avatar('account-avatar'));

    const panel = element('div', 'account-panel');
    panel.id = 'accountProfilePanel';
    panel.hidden = true;
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', 'User profile');
    const heading = element('div', 'account-panel-heading');
    const headingText = element('div', 'account-panel-heading-copy');
    headingText.append(element('strong', 'account-panel-username', username), element('span', 'account-panel-caption', roleText));
    const signOut = element('button', 'account-sign-out', 'Sign Out');
    signOut.type = 'button';
    heading.append(avatar('account-avatar account-avatar-large'), headingText, signOut);
    panel.append(heading);
    container.replaceChildren(trigger, panel);

    const close = (returnFocus = false) => {
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (returnFocus) trigger.focus();
    };
    trigger.addEventListener('click', () => {
      const opening = panel.hidden;
      panel.hidden = !opening;
      trigger.setAttribute('aria-expanded', String(opening));
    });
    document.addEventListener('click', (event) => {
      if (!container.contains(event.target)) close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !panel.hidden) close(true);
    });
    signOut.addEventListener('click', async () => {
      signOut.disabled = true;
      try { await logout(); }
      catch (error) {
        signOut.disabled = false;
        if (onLogoutError) onLogoutError(error);
      }
    });
  }

  window.PCN_SESSION = Object.freeze({ fetch: apiFetch, load, require: requireSession, safeReturnTo, logout, mountProfile });
})();
