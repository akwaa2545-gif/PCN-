(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.PCN_SYSTEM_SETTINGS = api;
    root.document.addEventListener('DOMContentLoaded', () => api.mount(root));
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const RULES = Object.freeze([
    { key: 'gscTet', label: 'GSC/TET', defaultDays: null },
    { key: 'prodEngTet', label: 'Prod.Eng/TET', defaultDays: 3 },
    { key: 'prodEngTa', label: 'Prod.Eng/TA', defaultDays: 3 },
    { key: 'prodEngSc', label: 'Prod.Eng/SC', defaultDays: 3 },
    { key: 'qaTet', label: 'QA/TET', defaultDays: 3 },
    { key: 'gscTapbu', label: 'GSC/TaPBU', defaultDays: null },
    { key: 'qaTapbu', label: 'QA/TaPBU', defaultDays: null },
    { key: 'qaFinal', label: 'QA/TET Final Judgment', defaultDays: null }
  ].map(Object.freeze));
  function canManage(user) {
    if (user?.isActive !== true || !Array.isArray(user.roles)) return false;
    const roles = user.roles.map(role => String(role).toLowerCase());
    if (roles.includes('admin')) return true;
    if (roles.includes('developer')) return roles.length === 1 && user.department === 'developer' && user.signingStep == null;
    return false;
  }
  function dayValue(enabled, value) {
    if (!enabled) return null;
    if (!/^[0-9]+$/.test(String(value)) || Number(value) < 1 || Number(value) > 365) {
      throw new Error('Enter a whole number from 1 to 365.');
    }
    return Number(value);
  }
  async function mount(root) {
    const el = id => root.document.getElementById(id);
    const field = (key, suffix) => el(`${key}${suffix}`);
    let authorized = false, epoch = 0, busy = false, checking = false, baseline = null, sessionRetry = false, intervalStarted = false, reviewing = false, notifying = false;
    let notificationEditor = null;
    el('settingsEditor').hidden = true;
    el('settingsHome').hidden = true;
    function status(message, error = false) {
      el('settingsStatus').textContent = message;
      el('settingsStatus').setAttribute('data-state', error ? 'error' : 'info');
    }
    function snapshot() {
      return JSON.stringify(RULES.map(({ key }) => [field(key, 'Enabled').checked, field(key, 'Days').value]));
    }
    function dirty() { return authorized && (notifying ? Boolean(notificationEditor?.dirty()) : baseline !== null && snapshot() !== baseline); }
    function controls() {
      const working = busy || Boolean(notificationEditor?.isBusy());
      el('settingsFields').disabled = working || !authorized || !baseline;
      el('settingsSave').disabled = working || !authorized || !reviewing || !dirty();
      el('settingsReload').disabled = working || (!authorized && !sessionRetry);
      el('settingsReload').hidden = authorized && !reviewing && !notifying;
      el('settingsBack').hidden = !authorized || (!reviewing && !notifying);
      el('settingsBack').disabled = working;
      el('settingsReviewLimits').disabled = working || !authorized;
      el('settingsNotifications').disabled = working || !authorized || !notificationEditor;
      el('settingsEditor').setAttribute('aria-busy', String(busy));
      for (const { key } of RULES) field(key, 'Days').disabled = busy || !authorized || !field(key, 'Enabled').checked;
    }
    function clearErrors() {
      for (const { key } of RULES) {
        field(key, 'Error').textContent = '';
        field(key, 'Days').setAttribute('aria-invalid', 'false');
      }
    }
    function denyAccess() {
      const focusMessage = el('settingsMain')?.contains?.(root.document.activeElement);
      authorized = false; epoch++; busy = false; baseline = null; sessionRetry = false; reviewing = false; notifying = false;
      notificationEditor?.clear();
      el('settingsHome').hidden = true;
      el('settingsEditor').hidden = true; el('settingsSaved').textContent = '';
      el('accountMenu').replaceChildren?.();
      for (const { key } of RULES) { field(key, 'Days').value = ''; field(key, 'Enabled').checked = false; }
      clearErrors(); controls();
      status('Administrator access required. Sign in with an active Administrator account and reload this page.', true);
      if (focusMessage) { el('settingsStatus').setAttribute('tabindex', '-1'); el('settingsStatus').focus(); }
    }
    function apply(settings) {
      if (settings?.pendingDays && Object.keys(settings.pendingDays).length === 6
        && !Object.hasOwn(settings.pendingDays, 'prodEngTa') && !Object.hasOwn(settings.pendingDays, 'prodEngSc')) settings = { ...settings, pendingDays: {
        ...settings.pendingDays,
        prodEngTa: settings.pendingDays.prodEngTet,
        prodEngSc: settings.pendingDays.prodEngTet
      } };
      if (settings?.schemaVersion !== 1 || !Number.isSafeInteger(settings.version) || settings.version < 0
        || !settings.pendingDays || RULES.some(({ key }) => settings.pendingDays[key] !== null
          && (!Number.isInteger(settings.pendingDays[key]) || settings.pendingDays[key] < 1 || settings.pendingDays[key] > 365))) {
        throw new Error('The server returned invalid settings. Please reload and try again.');
      }
      for (const { key, defaultDays } of RULES) {
        const value = settings.pendingDays[key];
        field(key, 'Enabled').checked = value !== null;
        field(key, 'Days').value = String(value ?? defaultDays ?? 3);
      }
      el('settingsEditor').hidden = false;
      el('settingsEditor').setAttribute('data-version', String(settings.version));
      const time = Date.parse(settings.updatedAt);
      el('settingsSaved').textContent = settings.updatedAt
        ? `Last saved by ${settings.updatedBy || 'Unknown administrator'} · ${Number.isFinite(time) ? new Date(time).toLocaleString() : 'Time unavailable'}`
        : 'Default settings · No changes saved yet';
      baseline = snapshot(); clearErrors();
      return settings.version;
    }
    let version = 0;
    async function reload(confirmDiscard = true) {
      if (busy) return;
      if (!authorized) { if (sessionRetry) return initialize(); return; }
      if (notifying) return notificationEditor.reload(confirmDiscard);
      if (!reviewing) return checkAccess();
      if (confirmDiscard && dirty() && !root.confirm('Discard your unsaved changes and reload saved settings?')) return;
      busy = true; controls(); status('Loading settings…');
      const requestEpoch = epoch;
      try {
        const settings = await root.PCN_SESSION.fetch('/api/admin/workflow-settings');
        if (!authorized || epoch !== requestEpoch) return;
        version = apply(settings); status('Settings loaded.');
      } catch (error) {
        if (!authorized || epoch !== requestEpoch) return;
        if (error.status === 401 || error.status === 403) denyAccess();
        else status(`${error.message || 'Unable to load settings.'} Your edits are preserved; select Reload to try again.`, true);
      } finally { if (epoch === requestEpoch) { busy = false; controls(); } }
    }
    function showHome(focus = true) {
      if (!authorized || busy || notificationEditor?.isBusy()) return;
      if (dirty() && !root.confirm('Discard your unsaved changes and return to all settings?')) return;
      const notificationFocus = notifying;
      reviewing = false; notifying = false; baseline = null; notificationEditor?.clear();
      el('settingsEditor').hidden = true;
      el('settingsHome').hidden = false;
      el('settingsIntro').textContent = 'Choose a feature to configure.';
      clearErrors(); controls(); status('');
      if (focus) el(notificationFocus ? 'settingsNotifications' : 'settingsReviewLimits').focus();
    }
    async function openReviews() {
      if (!authorized || busy || reviewing || notifying || notificationEditor?.isBusy()) return;
      reviewing = true;
      el('settingsHome').hidden = true;
      el('settingsIntro').textContent = 'Configure the time allowed for department reviews.';
      await reload(false);
      if (authorized && reviewing && baseline) el('pendingDaysTitle').focus();
    }
    async function openNotifications() {
      if (!authorized || busy || reviewing || notifying || !notificationEditor) return;
      notifying = true;
      el('settingsHome').hidden = true;
      el('settingsIntro').textContent = 'Configure which notification emails each group and user receives.';
      await notificationEditor.open(); controls();
    }
    function pendingDays() {
      clearErrors();
      const values = {}, invalid = [];
      for (const { key, label } of RULES) {
        try { values[key] = dayValue(field(key, 'Enabled').checked, field(key, 'Days').value); }
        catch (error) {
          field(key, 'Error').textContent = `${label}: ${error.message}`;
          field(key, 'Days').setAttribute('aria-invalid', 'true'); invalid.push(key);
        }
      }
      if (invalid.length) {
        field(invalid[0], 'Days').focus(); status('Check the highlighted day limits before saving.', true); return null;
      }
      return values;
    }
    async function save() {
      if (notifying) return notificationEditor.save();
      if (!authorized || busy || !dirty()) return;
      const values = pendingDays(); if (!values) return;
      busy = true; controls(); status('Saving settings…');
      const requestEpoch = epoch;
      try {
        const settings = await root.PCN_SESSION.fetch('/api/admin/workflow-settings', {
          method: 'PUT', body: JSON.stringify({ schemaVersion: 1, version, pendingDays: values })
        });
        if (!authorized || epoch !== requestEpoch) return;
        version = apply(settings); status('Settings saved. New and ongoing reviews now use these limits.');
      } catch (error) {
        if (!authorized || epoch !== requestEpoch) return;
        if (error.status === 401 || error.status === 403) denyAccess();
        else status(error.status === 409
          ? 'Settings changed since you loaded them. Your edits are preserved. Select Reload to review the latest settings before saving again.'
          : `${error.message || 'Unable to save settings.'} Your edits are preserved.`, true);
      } finally { if (epoch === requestEpoch) { busy = false; controls(); } }
    }
    async function checkAccess() {
      if (!authorized || checking) return;
      checking = true;
      const requestEpoch = epoch;
      try {
        const session = await root.PCN_SESSION.fetch('/api/session');
        if (epoch === requestEpoch && (!session?.authenticated || !canManage(session.user))) denyAccess();
      } catch (error) {
        if (epoch === requestEpoch && (error.status === 401 || error.status === 403)) denyAccess();
        else if (epoch === requestEpoch) status('Unable to verify current access. Your edits are preserved; retry when connected.', true);
      } finally { checking = false; }
    }
    const notifications = root.PCN_NOTIFICATION_SETTINGS || (typeof module === 'object' && module.exports ? require('./notification-settings') : null);
    notificationEditor = notifications?.create(root, {
      canUse: () => authorized && notifying, status, onStateChange: controls, onDenied: denyAccess
    });
    for (const { key } of RULES) {
      field(key, 'Enabled').addEventListener('change', () => { field(key, 'Error').textContent = ''; controls(); });
      field(key, 'Days').addEventListener('input', () => { field(key, 'Error').textContent = ''; field(key, 'Days').setAttribute('aria-invalid', 'false'); controls(); });
    }
    el('settingsForm').addEventListener('submit', event => { event.preventDefault(); return save(); });
    el('settingsReload').addEventListener('click', () => reload());
    el('settingsReviewLimits').addEventListener('click', openReviews);
    el('settingsNotifications').addEventListener('click', openNotifications);
    el('notificationReviewLink').addEventListener('click', () => {
      if (!notifying) return;
      showHome(false); if (!notifying) return openReviews();
    });
    el('settingsBack').addEventListener('click', () => showHome());
    root.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
    root.addEventListener('focus', checkAccess);
    const controller = { reload, save, checkAccess, openReviews, openNotifications, showHome };
    async function initialize() {
      busy = true; sessionRetry = false; controls(); status('Checking Administrator access…');
      try {
        const session = await root.PCN_SESSION.require(null);
        if (!canManage(session?.user)) { denyAccess(); return; }
        authorized = true; busy = false;
        root.PCN_SESSION.mountProfile?.(session.user, error => status(error.message, true));
        showHome(false);
        if (!intervalStarted) { root.setInterval?.(checkAccess, 30000); intervalStarted = true; }
      } catch (error) {
        if (error.status === 401 || error.status === 403) denyAccess();
        else {
          busy = false; sessionRetry = true; controls();
          status('Unable to verify current access. Select Reload to try again when connected.', true);
        }
      }
    }
    await initialize();
    return controller;
  }
  return { RULES, canManage, dayValue, mount };
});
