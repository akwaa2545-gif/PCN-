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
  const CATEGORY_FORMS = Object.freeze({ rawMaterial: 'Raw Material', packaging: 'Packaging' });
  const CATEGORY_RISKS = Object.freeze(['RL3', 'RL2', 'RL1', 'RL0']);
  function parseCategorySettings(value) {
    const invalid = message => { throw new Error(message || 'The server returned invalid Content of Changes settings. Reload and try again.'); };
    if (!Number.isSafeInteger(value?.versionId) || value.versionId < 1 || !value.forms
      || Object.keys(value.forms).length !== 2 || Object.keys(CATEGORY_FORMS).some(key => !Object.hasOwn(value.forms, key))) invalid();
    const forms = Object.fromEntries(Object.keys(CATEGORY_FORMS).map(key => {
      const source = value.forms[key], seen = new Set();
      if (!Array.isArray(source) || !source.length || source.length > 100) invalid('Each form needs 1–100 change options.');
      const rows = source.map(row => {
        if (!row || typeof row.text !== 'string' || !row.text.trim() || row.text.trim().length > 500
          || !['RL0', 'RL1', 'RL2', 'RL3'].includes(row.risk) || typeof row.enabled !== 'boolean') invalid('Enter wording, a valid risk level and an enabled setting for every option.');
        const text = row.text.trim(), identity = text.toLowerCase();
        if (seen.has(identity)) invalid('Each option needs unique wording within its form.');
        seen.add(identity); return { text, risk: row.risk, enabled: row.enabled };
      });
      if (!rows.some(row => row.enabled)) invalid('Keep at least one enabled option in each form.');
      return [key, rows];
    }));
    return { versionId: value.versionId, forms };
  }
  function createCategoryEditor(root, hooks) {
    const el = id => root.document.getElementById(id);
    let active = false, busy = false, epoch = 0, snapshot = null, baseline = null;
    const expanded = new Map(), groupNodes = new Map();
    const allowed = () => active && hooks.canUse();
    const dirty = () => Boolean(allowed() && snapshot && JSON.stringify(snapshot.forms) !== baseline);
    const node = (tag, text, className) => {
      const item = root.document.createElement(tag);
      if (text !== undefined) item.textContent = text;
      if (className) item.className = className;
      return item;
    };
    el('changeCategoriesEditor').hidden = true;
    function controls() {
      el('changeCategoriesFields').disabled = busy || !allowed() || !snapshot;
      el('changeCategoriesSave').disabled = busy || !allowed() || !dirty();
      el('changeCategoriesEditor').setAttribute('aria-busy', String(busy));
      hooks.onStateChange();
    }
    function clear() {
      active = false; busy = false; epoch++; snapshot = null; baseline = null;
      expanded.clear(); groupNodes.clear();
      el('changeCategoriesEditor').hidden = true; el('changeCategoriesRows').replaceChildren();
      el('changeCategoriesVersion').textContent = ''; el('changeCategoriesReason').value = '';
      controls();
    }
    function edit(key, index, field, value) {
      if (!allowed() || busy || !snapshot) return;
      snapshot = { ...snapshot, forms: { ...snapshot.forms, [key]: snapshot.forms[key].map((row, position) => position === index ? { ...row, [field]: value } : row) } };
      controls();
    }
    function updateCategoryCounts(key) {
      const rows = snapshot.forms[key];
      el(`changeCategoriesFormCount-${key}`).textContent = `${rows.filter(row => row.enabled).length} enabled · ${rows.length} options`;
      for (const risk of CATEGORY_RISKS) {
        const matches = rows.filter(row => row.risk === risk);
        el(`changeCategoriesRiskCount-${key}-${risk}`).textContent = `${matches.length} ${matches.length === 1 ? 'option' : 'options'} · ${matches.filter(row => row.enabled).length} enabled`;
      }
    }
    function renderCategoryRow(key, title, index, row) {
      const item = node('div', undefined, 'change-category-row'); item.setAttribute('data-enabled', String(row.enabled));
      const wording = node('label', undefined, 'change-category-wording'); wording.append(node('span', `Option ${index + 1} wording`));
      const text = node('textarea'); text.id = `changeCategory-${key}-${index}-text`; text.value = row.text; text.rows = 2; text.maxLength = 500; text.required = true;
      text.setAttribute('aria-label', `${title} option ${index + 1} wording`);
      text.addEventListener('input', () => { text.setAttribute('aria-invalid', 'false'); edit(key, index, 'text', text.value); }); wording.append(text);
      const riskLabel = node('label', undefined, 'change-category-risk'); riskLabel.append(node('span', 'Risk level'));
      const risk = node('select'); risk.id = `changeCategory-${key}-${index}-risk`;
      for (const value of CATEGORY_RISKS) { const option = node('option', value); option.value = value; risk.append(option); }
      risk.value = row.risk; risk.setAttribute('aria-label', `${title} option ${index + 1} risk level`);
      risk.addEventListener('change', () => {
        if (!allowed() || busy) return;
        edit(key, index, 'risk', risk.value); render(`${key}-${risk.value}`); el(`changeCategory-${key}-${index}-risk`).focus();
      }); riskLabel.append(risk);
      const enabledLabel = node('label', undefined, 'change-category-enabled');
      const enabled = node('input'); enabled.type = 'checkbox'; enabled.id = `changeCategory-${key}-${index}-enabled`; enabled.checked = row.enabled;
      enabled.setAttribute('aria-label', `Enable ${title} option ${index + 1}`);
      const enabledText = node('span', row.enabled ? 'Enabled' : 'Disabled');
      enabled.addEventListener('change', () => {
        if (!allowed() || busy) return;
        edit(key, index, 'enabled', enabled.checked); item.setAttribute('data-enabled', String(enabled.checked)); enabledText.textContent = enabled.checked ? 'Enabled' : 'Disabled';
        updateCategoryCounts(key);
      });
      enabledLabel.append(enabled, enabledText); item.append(wording, riskLabel, enabledLabel);
      return item;
    }
    function render(forceOpen) {
      for (const [key, details] of groupNodes) expanded.set(key, details.open);
      if (forceOpen) expanded.set(forceOpen, true);
      groupNodes.clear();
      const parent = el('changeCategoriesRows'); parent.replaceChildren();
      for (const [key, title] of Object.entries(CATEGORY_FORMS)) {
        const section = node('section', undefined, 'change-categories-group');
        const heading = node('div', undefined, 'change-categories-group-heading'), count = node('span'); count.id = `changeCategoriesFormCount-${key}`;
        heading.append(node('h3', title), count); section.append(heading);
        for (const risk of CATEGORY_RISKS) {
          const groupKey = `${key}-${risk}`, details = node('details', undefined, 'change-categories-risk-group');
          details.id = `changeCategoriesRisk-${groupKey}`; details.open = expanded.get(groupKey) ?? risk === 'RL3';
          const summary = node('summary', undefined, 'change-categories-risk-heading');
          const riskTitle = node('span', undefined, 'change-categories-risk-title'); riskTitle.append(node('strong', risk), node('span', `Risk level ${risk.slice(-1)}`));
          const riskCount = node('span', undefined, 'change-categories-risk-count'); riskCount.id = `changeCategoriesRiskCount-${groupKey}`;
          summary.append(riskTitle, riskCount); details.append(summary); groupNodes.set(groupKey, details);
          const rows = node('div', undefined, 'change-categories-risk-options');
          for (const [index, row] of snapshot.forms[key].entries()) if (row.risk === risk) rows.append(renderCategoryRow(key, title, index, row));
          if (!snapshot.forms[key].some(row => row.risk === risk)) rows.append(node('p', `No ${risk} options yet. Add one below.`, 'change-categories-empty'));
          const add = node('button', `Add ${risk} option`, 'settings-button'); add.id = `changeCategoriesAdd-${groupKey}`; add.type = 'button';
          add.disabled = snapshot.forms[key].length >= 100;
          add.addEventListener('click', () => {
            if (!allowed() || busy || snapshot.forms[key].length >= 100) return;
            const index = snapshot.forms[key].length;
            snapshot = { ...snapshot, forms: { ...snapshot.forms, [key]: [...snapshot.forms[key], { text: '', risk, enabled: true }] } };
            render(groupKey); controls(); el(`changeCategory-${key}-${index}-text`).focus();
          });
          rows.append(add); details.append(rows); section.append(details);
        }
        parent.append(section); updateCategoryCounts(key);
      }
    }
    function focusCategoryError() {
      for (const [key, rows] of Object.entries(snapshot.forms)) {
        const seen = new Set();
        for (const [index, row] of rows.entries()) {
          const identity = row.text.trim().toLowerCase();
          if (!identity || row.text.trim().length > 500 || seen.has(identity)) {
            const group = groupNodes.get(`${key}-${row.risk}`); if (group) group.open = true;
            const control = el(`changeCategory-${key}-${index}-text`); control.setAttribute('aria-invalid', 'true'); control.focus(); return;
          }
          seen.add(identity);
        }
        if (!rows.some(row => row.enabled)) {
          const group = groupNodes.get(`${key}-${rows[0].risk}`); if (group) group.open = true;
          el(`changeCategory-${key}-0-enabled`).focus(); return;
        }
      }
    }
    function apply(value) {
      snapshot = parseCategorySettings(value); baseline = JSON.stringify(snapshot.forms);
      el('changeCategoriesReason').value = ''; el('changeCategoriesVersion').textContent = `Master data version ${snapshot.versionId}`;
      render(); controls();
    }
    async function reload(confirmDiscard = true) {
      if (!allowed() || busy) return;
      if (confirmDiscard && dirty() && !root.confirm('Discard your unsaved Content of Changes edits and reload the saved options?')) return;
      busy = true; controls(); hooks.status('Loading Content of Changes…');
      const requestEpoch = epoch;
      try {
        const value = await root.PCN_SESSION.fetch('/api/admin/change-categories');
        if (!allowed() || epoch !== requestEpoch) return;
        apply(value); hooks.status('Content of Changes loaded.');
      } catch (error) {
        if (!allowed() || epoch !== requestEpoch) return;
        if ([401, 403].includes(error.status)) hooks.onDenied();
        else hooks.status(`${error.message || 'Unable to load Content of Changes.'} Your edits are preserved; select Reload to try again.`, true);
      } finally { if (epoch === requestEpoch) { busy = false; controls(); } }
    }
    async function open() {
      active = true; el('changeCategoriesEditor').hidden = false;
      await reload(false); if (allowed() && snapshot) el('changeCategoriesTitle').focus();
    }
    async function save() {
      if (!allowed() || busy || !dirty()) return;
      let input;
      try {
        input = parseCategorySettings(snapshot);
        const reason = el('changeCategoriesReason').value.trim();
        if (!reason || reason.length > 1200) { el('changeCategoriesReason').focus(); throw new Error('Enter a reason of 1–1200 characters before saving.'); }
        input = { ...input, reason };
      } catch (error) { focusCategoryError(); hooks.status(error.message, true); return; }
      busy = true; controls(); hooks.status('Saving Content of Changes…'); const requestEpoch = epoch;
      try {
        const saved = await root.PCN_SESSION.fetch('/api/admin/change-categories', { method: 'PUT', body: JSON.stringify(input) });
        if (!allowed() || epoch !== requestEpoch) return;
        apply(saved); hooks.status('Content of Changes saved for new PCNs. Existing documents keep their original categories.');
      } catch (error) {
        if (!allowed() || epoch !== requestEpoch) return;
        if ([401, 403].includes(error.status)) hooks.onDenied();
        else hooks.status(error.status === 409 ? 'Content of Changes changed since you loaded it. Your edits are preserved. Select Reload to review the current options before saving again.'
          : `${error.message || 'Unable to save Content of Changes.'} Your edits are preserved.`, true);
      } finally { if (epoch === requestEpoch) { busy = false; controls(); } }
    }
    el('changeCategoriesForm').addEventListener('submit', event => { event.preventDefault(); return save(); });
    el('changeCategoriesReason').addEventListener('input', controls);
    return { open, reload, save, clear, dirty, isBusy: () => busy };
  }
  async function mount(root) {
    const el = id => root.document.getElementById(id);
    const field = (key, suffix) => el(`${key}${suffix}`);
    let authorized = false, epoch = 0, busy = false, checking = false, baseline = null, sessionRetry = false, intervalStarted = false, reviewing = false, notifying = false;
    let notificationEditor = null, categoryEditor = null, categorizing = false;
    el('settingsEditor').hidden = true;
    el('settingsHome').hidden = true;
    function status(message, error = false) {
      el('settingsStatus').textContent = message;
      el('settingsStatus').setAttribute('data-state', error ? 'error' : 'info');
    }
    function snapshot() {
      return JSON.stringify(RULES.map(({ key }) => [field(key, 'Enabled').checked, field(key, 'Days').value]));
    }
    function dirty() { return authorized && (categorizing ? Boolean(categoryEditor?.dirty()) : notifying ? Boolean(notificationEditor?.dirty()) : baseline !== null && snapshot() !== baseline); }
    function controls() {
      const working = busy || Boolean(notificationEditor?.isBusy()) || Boolean(categoryEditor?.isBusy());
      el('settingsFields').disabled = working || !authorized || !baseline;
      el('settingsSave').disabled = working || !authorized || !reviewing || !dirty();
      el('settingsReload').disabled = working || (!authorized && !sessionRetry);
      el('settingsReload').hidden = authorized && !reviewing && !notifying && !categorizing;
      el('settingsBack').hidden = !authorized || (!reviewing && !notifying && !categorizing);
      el('settingsBack').disabled = working;
      el('settingsReviewLimits').disabled = working || !authorized;
      el('settingsNotifications').disabled = working || !authorized || !notificationEditor;
      el('settingsChangeCategories').disabled = working || !authorized || !categoryEditor;
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
      authorized = false; epoch++; busy = false; baseline = null; sessionRetry = false; reviewing = false; notifying = false; categorizing = false;
      notificationEditor?.clear();
      categoryEditor?.clear();
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
      if (categorizing) return categoryEditor.reload(confirmDiscard);
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
      if (!authorized || busy || notificationEditor?.isBusy() || categoryEditor?.isBusy()) return;
      if (dirty() && !root.confirm('Discard your unsaved changes and return to all settings?')) return;
      const focusTarget = categorizing ? 'settingsChangeCategories' : notifying ? 'settingsNotifications' : 'settingsReviewLimits';
      reviewing = false; notifying = false; categorizing = false; baseline = null; notificationEditor?.clear(); categoryEditor?.clear();
      el('settingsEditor').hidden = true;
      el('settingsHome').hidden = false;
      el('settingsIntro').textContent = 'Choose a feature to configure.';
      clearErrors(); controls(); status('');
      if (focus) el(focusTarget).focus();
    }
    async function openReviews() {
      if (!authorized || busy || reviewing || notifying || categorizing || notificationEditor?.isBusy()) return;
      reviewing = true;
      el('settingsHome').hidden = true;
      el('settingsIntro').textContent = 'Configure the time allowed for department reviews.';
      await reload(false);
      if (authorized && reviewing && baseline) el('pendingDaysTitle').focus();
    }
    async function openNotifications() {
      if (!authorized || busy || reviewing || notifying || categorizing || !notificationEditor) return;
      notifying = true;
      el('settingsHome').hidden = true;
      el('settingsIntro').textContent = 'Configure which notification emails each group and user receives.';
      await notificationEditor.open(); controls();
    }
    async function openCategories() {
      if (!authorized || busy || reviewing || notifying || categorizing || !categoryEditor) return;
      categorizing = true; el('settingsHome').hidden = true;
      el('settingsIntro').textContent = 'Manage the change options used when creating new PCNs.';
      await categoryEditor.open(); controls();
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
      if (categorizing) return categoryEditor.save();
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
    categoryEditor = createCategoryEditor(root, { canUse: () => authorized && categorizing, status, onStateChange: controls, onDenied: denyAccess });
    for (const { key } of RULES) {
      field(key, 'Enabled').addEventListener('change', () => { field(key, 'Error').textContent = ''; controls(); });
      field(key, 'Days').addEventListener('input', () => { field(key, 'Error').textContent = ''; field(key, 'Days').setAttribute('aria-invalid', 'false'); controls(); });
    }
    el('settingsForm').addEventListener('submit', event => { event.preventDefault(); return save(); });
    el('settingsReload').addEventListener('click', () => reload());
    el('settingsReviewLimits').addEventListener('click', openReviews);
    el('settingsNotifications').addEventListener('click', openNotifications);
    el('settingsChangeCategories').addEventListener('click', openCategories);
    el('notificationReviewLink').addEventListener('click', () => {
      if (!notifying) return;
      showHome(false); if (!notifying) return openReviews();
    });
    el('settingsBack').addEventListener('click', () => showHome());
    root.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
    root.addEventListener('focus', checkAccess);
    const controller = { reload, save, checkAccess, openReviews, openNotifications, openCategories, showHome };
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
  return { RULES, canManage, dayValue, parseCategorySettings, mount };
});
