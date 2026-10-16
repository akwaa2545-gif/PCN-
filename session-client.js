(function () {
  let session = { authenticated: false, user: null, csrfToken: '' };

  let sessionGeneration = 0;
  let heartbeatTimer = null;
  let heartbeatPending = false;
  let heartbeatSuspended = false;
  let logoutPending = false;
  const sessionDocument = window.document || (typeof document !== 'undefined' ? document : null);
  const heartbeatVisible = () => session.authenticated === true && !logoutPending && !heartbeatSuspended
    && sessionDocument?.visibilityState !== 'hidden' && window.navigator?.onLine !== false;
  function clearHeartbeat() {
    if (heartbeatTimer !== null) window.clearTimeout?.(heartbeatTimer);
    heartbeatTimer = null;
  }
  function scheduleHeartbeat(delay = 30000) {
    clearHeartbeat();
    if (heartbeatVisible() && !heartbeatPending && typeof window.setTimeout === 'function') heartbeatTimer = window.setTimeout(heartbeat, delay);
  }
  function clearAuthentication() {
    sessionGeneration++;
    session = { authenticated: false, user: null, csrfToken: '' };
    clearHeartbeat();
  }
  async function heartbeat() {
    heartbeatTimer = null;
    if (!heartbeatVisible() || heartbeatPending) return;
    heartbeatPending = true;
    try { await apiFetch('/api/session'); }
    catch (_) { /* Network failures retry; authentication failures clear the session in apiFetch. */ }
    finally { heartbeatPending = false; scheduleHeartbeat(); }
  }
  const resumeHeartbeat = () => scheduleHeartbeat(0);
  sessionDocument?.addEventListener?.('visibilitychange', resumeHeartbeat);
  window.addEventListener?.('online', resumeHeartbeat);
  window.addEventListener?.('offline', resumeHeartbeat);
  window.addEventListener?.('pagehide', () => { heartbeatSuspended = true; clearHeartbeat(); });
  window.addEventListener?.('pageshow', () => { heartbeatSuspended = false; resumeHeartbeat(); });

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
    const requestGeneration = sessionGeneration;
    const response = await fetch(url.pathname + url.search, { ...options, method, headers, credentials: 'same-origin', mode: 'same-origin', cache: 'no-store' });
    let body;
    try {
      body = await response.json();
    } catch (_) {
      if (response.status === 401 && requestGeneration === sessionGeneration) clearAuthentication();
      throw new Error('The server returned an unreadable response. Please try again.');
    }
    if (!response.ok || !body.success) {
      const currentResponse = requestGeneration === sessionGeneration;
      if (response.status === 401 && currentResponse) clearAuthentication();
      const rawError = typeof body.error === 'string' ? body.error : body.error?.message;
      const isEditConflict = response.status === 409 && ['PATCH', 'PUT', 'DELETE'].includes(method) && /^\/api\/pcns\/[^/]+$/.test(url.pathname);
      const message = isEditConflict ? 'This record changed since you loaded it. Refresh the record before saving again; your edits have not been overwritten.' : rawError || 'API request failed.';
      const error = new Error(message);
      error.status = response.status;
      error.details = body.details;
      error.code = body.code || body.error?.code;
      const authRoute = url.pathname === '/api/session' || url.pathname.startsWith('/api/auth/');
      if (response.status === 401 && currentResponse && !authRoute) redirectToLogin();
      if (error.code === 'PASSWORD_CHANGE_REQUIRED' && currentResponse && !authRoute) redirectToLogin(true);
      throw error;
    }
    if (requestGeneration === sessionGeneration && body.data && Object.prototype.hasOwnProperty.call(body.data, 'authenticated')) {
      if (body.data.authenticated === true) {
        if (url.pathname === '/api/auth/login') logoutPending = false;
        session = { ...body.data, csrfToken: body.data.csrfToken || '' };
        scheduleHeartbeat();
      } else clearAuthentication();
    }
    return body.data;
  }

  async function load() {
    try { return await apiFetch('/api/session'); }
    catch (error) {
      if (error.status !== 401) throw error;
      return session;
    }
  }

  async function requireSession(role, { requireRole = false } = {}) {
    const current = await load();
    if (!current.authenticated) {
      redirectToLogin();
      return null;
    }
    if (current.user?.mustChangePassword) {
      redirectToLogin(true);
      return null;
    }
    const roles = Array.isArray(current.user?.roles) ? current.user.roles : [];
    if (requireRole && !roles.length) {
      window.location.assign('/records');
      return null;
    }
    if (role && !roles.some((value) => String(value).toLowerCase() === role.toLowerCase()
      || (role.toLowerCase() === 'admin' && String(value).toLowerCase() === 'developer'))) throw new Error('Your account does not have access to this page.');
    return current;
  }

  async function logout() {
    sessionGeneration++; logoutPending = true; clearHeartbeat();
    try {
      await apiFetch('/api/auth/logout', { method: 'POST', body: '{}' });
      clearAuthentication();
      window.location.assign('/login');
    } catch (error) {
      logoutPending = false; scheduleHeartbeat();
      throw error;
    }
  }

  function profilePhoto(value) {
    if (typeof value !== 'string') return '';
    const photo = value.trim();
    const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(photo);
    return photo.length <= 100 * 1024 && match && match[1].length % 4 === 0 ? photo : '';
  }

  function mountProfile(user, onLogoutError) {
    const container = document.getElementById('accountMenu');
    if (!container || !user) return;
    const username = String(user.displayName || user.fullName || user.username || 'User').trim();
    const fullName = String(user.displayName || user.fullName || '').trim();
    const email = String(user.email || user.mailProfile?.email || '').trim();
    const roleNames = {
      admin: 'Administrator', developer: 'Developer', reviewer: 'Reviewer', supplier: 'Supplier',
      gsc: 'GSC/TET', productionengineering: 'Prod. Eng./TET',
      qa: 'QA/TET', tapbu: 'TaPBU'
    };
    const departmentNames = {
      gscTet: 'GSC/TET', prodEngTet: 'Prod. Eng./TET', qaTet: 'QA/TET',
      gscTapbu: 'GSC/TaPBU', qaTapbu: 'QA/TaPBU', it: 'IT', other: 'Other', developer: 'Developer'
    };
    const roles = (Array.isArray(user.roles) ? user.roles : []).map(role => roleNames[String(role).toLowerCase()] || String(role));
    const noPcnRole = ['employee-code', 'pcn-local'].includes(user.identityProvider) && roles.length === 0;
    const roleText = roles.join(', ') || 'Not assigned';
    const signingSteps = { approved: 'Approved', checked: 'Checked', prepared: 'Prepared' };
    const pcnStepText = roles.some(role => ['Administrator', 'Developer'].includes(role)) ? 'All signing steps' : signingSteps[user.signingStep] || 'Not assigned';
    const departmentText = departmentNames[user.department] || 'Not assigned';
    const nameParts = (fullName || username).split(/[\s._-]+/).filter(Boolean);
    const initials = (nameParts.length > 1 ? nameParts[0][0] + nameParts[nameParts.length - 1][0] : (nameParts[0] || 'U').slice(0, 2)).toUpperCase();
    const element = (tag, className, value) => {
      const node = document.createElement(tag);
      node.className = className;
      if (value !== undefined) node.textContent = value;
      return node;
    };
    const avatars = [];
    const avatar = (className) => {
      const node = element('span', className, initials);
      node.setAttribute('aria-hidden', 'true');
      avatars.push(node);
      return node;
    };

    const trigger = element('button', 'account-trigger');
    trigger.type = 'button';
    trigger.setAttribute('aria-label', noPcnRole ? `Open profile for ${username}; PCN role not assigned` : `Open profile for ${username}`);
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', 'accountProfilePanel');
    if (noPcnRole) trigger.classList.add('account-trigger-pending');
    trigger.append(avatar('account-avatar'));

    const panel = element('div', 'account-panel');
    panel.id = 'accountProfilePanel';
    panel.hidden = true;
    panel.inert = true;
    if (noPcnRole) panel.classList.add('account-panel-pending');
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', 'User profile');
    const heading = element('div', 'account-panel-heading');
    const headingText = element('div', 'account-panel-heading-copy');
    headingText.append(element('strong', 'account-panel-username', username));
    const emailLine = element('span', 'account-panel-email', email || 'No email on file');
    const positionLine = element('span', 'account-panel-position', user.mailProfile?.jobTitle || '');
    positionLine.hidden = !positionLine.textContent;
    const photoStatus = element('span', 'account-photo-status');
    photoStatus.setAttribute('role', 'status');
    photoStatus.setAttribute('aria-live', 'polite');
    photoStatus.hidden = true;
    headingText.append(positionLine, emailLine, photoStatus);
    const signOut = element('button', 'account-sign-out', 'Sign out');
    signOut.type = 'button';
    heading.append(avatar('account-avatar account-avatar-large'), headingText);
    if (noPcnRole) {
      const warning = element('div', 'account-access-warning');
      warning.id = 'accountAccessWarning';
      warning.setAttribute('role', 'alert');
      const icon = element('span', 'account-access-warning-icon', '!');
      icon.setAttribute('aria-hidden', 'true');
      const copy = element('div', 'account-access-warning-copy');
      copy.append(element('strong', '', 'No PCN role assigned'),
        element('p', '', 'Contact an administrator to assign your PCN role.'));
      warning.append(icon, copy);
      panel.append(warning);
    }
    const details = element('dl', 'account-profile-details');
    const addDetail = (label, value) => {
      const row = element('div', 'account-profile-detail');
      row.append(element('dt', 'account-profile-label', label), element('dd', 'account-profile-value', value));
      details.append(row);
    };
    addDetail('Employee ID', user.employeeCode || 'Not linked');
    addDetail('PCN role', roleText);
    addDetail('Signing step', pcnStepText);
    addDetail('Department', departmentText);
    panel.prepend(heading);
    const footer = element('div', 'account-panel-footer');
    footer.append(signOut);
    panel.append(details, footer);
    container.replaceChildren(trigger, panel);

    const showPhotoUnavailable = () => {
      photoStatus.textContent = 'Profile photo unavailable';
      photoStatus.hidden = false;
    };
    const setPhoto = (photo) => {
      if (!photo) return showPhotoUnavailable();
      photoStatus.hidden = true;
      avatars.forEach(node => {
        const image = element('img', 'account-avatar-photo');
        image.alt = '';
        image.decoding = 'async';
        image.addEventListener('error', () => {
          if (!node.contains(image)) return;
          node.replaceChildren();
          node.textContent = initials;
          showPhotoUnavailable();
        }, { once: true });
        image.src = photo;
        node.replaceChildren(image);
      });
    };
    const savedPhoto = profilePhoto(user.mailProfile?.photo);
    if (savedPhoto) setPhoto(savedPhoto);
    else {
      photoStatus.textContent = 'Loading profile photo…';
      photoStatus.hidden = false;
      apiFetch('/api/profile').then(profile => {
        if (!container.contains(panel)) return;
        if (profile?.status !== 'available') return showPhotoUnavailable();
        if (typeof profile.email === 'string' && profile.email) emailLine.textContent = profile.email;
        if (typeof profile.jobTitle === 'string' && profile.jobTitle) {
          positionLine.textContent = profile.jobTitle;
          positionLine.hidden = false;
        }
        setPhoto(profilePhoto(profile.photo));
      }).catch(() => {
        if (container.contains(panel)) showPhotoUnavailable();
      });
    }

    const close = (returnFocus = false) => {
      panel.hidden = true;
      panel.inert = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (returnFocus) trigger.focus();
    };
    trigger.addEventListener('click', () => {
      const opening = panel.hidden;
      panel.hidden = !opening;
      panel.inert = !opening;
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
  window.PCN_UI_MOTION = Object.freeze({ afterExit });

  // Only presentation cleanup waits; callers close and invalidate their work first.
  function afterExit(element, cleanup, { current = () => true } = {}) {
    let timer = null; let finished = false;
    const cancel = () => {
      if (timer !== null) window.clearTimeout?.(timer);
      element?.removeEventListener?.('transitionend', ended);
      timer = null; finished = true;
    };
    const finish = () => { if (finished) return; cancel(); if (current()) cleanup(); };
    const ended = event => { if (event.target === element && event.propertyName === 'opacity') finish(); };
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const supported = window.CSS?.supports?.('transition-behavior', 'allow-discrete');
    const style = supported && !reduced ? window.getComputedStyle?.(element) : null;
    const seconds = value => value.trim().endsWith('ms') ? parseFloat(value) : parseFloat(value) * 1000;
    const durations = style?.transitionDuration?.split(',').map(seconds) || [];
    const delays = style?.transitionDelay?.split(',').map(seconds) || [0];
    const duration = Math.max(0, ...durations.map((value, index) => value + (delays[index % delays.length] || 0)));
    if (!duration || !window.setTimeout || !element?.addEventListener) finish();
    else {
      element.addEventListener('transitionend', ended);
      timer = window.setTimeout(finish, Math.min(duration + 40, 240));
    }
    return { cancel };
  }
})();

(function (root) {
  'use strict';
  function start({ refresh, canRefresh = () => true, onError, intervalMs = 5000 }) {
    if (typeof refresh !== 'function' || typeof canRefresh !== 'function' || !Number.isFinite(intervalMs) || intervalMs < 1000 || intervalMs > 60000) {
      throw new Error('Automatic updates require a refresh function and an interval between one and sixty seconds.');
    }
    const doc = root.document;
    let timer = null, stopped = false, pending = false, failures = 0, generation = 0, suspended = false;
    const visible = () => !stopped && !suspended && doc.visibilityState !== 'hidden';
    function clear() { if (timer !== null) root.clearTimeout(timer); timer = null; }
    function schedule(delay) { clear(); if (visible() && !pending) timer = root.setTimeout(tick, delay); }
    async function tick() {
      timer = null;
      if (!visible() || pending) return;
      const captured = generation;
      const isCurrent = () => visible() && generation === captured;
      pending = true;
      try {
        if (canRefresh()) { await refresh({ isCurrent }); failures = 0; }
      } catch (error) {
        failures = Math.min(failures + 1, 3);
        try {
          if (onError) onError(error);
          else root.console?.warn('Automatic updates could not complete.', error);
        } catch (reportError) { root.console?.error('Automatic update error reporting failed.', reportError); }
      } finally {
        pending = false;
        schedule(Math.min(intervalMs * (2 ** failures), 30000));
      }
    }
    function visibilityChanged() { generation++; clear(); if (visible() && !pending) schedule(0); }
    function pagehide(event) {
      if (event?.persisted) { suspended = true; generation++; clear(); }
      else stop();
    }
    function pageshow() { suspended = false; visibilityChanged(); }
    function stop() {
      stopped = true; generation++; clear();
      doc.removeEventListener('visibilitychange', visibilityChanged);
      root.removeEventListener('pagehide', pagehide);
      root.removeEventListener('pageshow', pageshow);
    }
    doc.addEventListener('visibilitychange', visibilityChanged);
    root.addEventListener('pagehide', pagehide);
    root.addEventListener('pageshow', pageshow);
    schedule(intervalMs);
    return stop;
  }
  root.PCN_AUTO_REFRESH = { start };
})(window);
