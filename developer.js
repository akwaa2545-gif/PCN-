(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.PCN_DEVELOPER_TOOLS = api;
    root.document.addEventListener('DOMContentLoaded', () => api.mount(root));
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const pcnPattern = /^PCN-\d{4}-\d{4}$/;
  function isDeveloper(user) {
    return Boolean(user?.isActive === true && Array.isArray(user.roles) && user.roles.length === 1
      && typeof user.roles[0] === 'string' && user.roles[0].toLowerCase() === 'developer'
      && user.department === 'developer' && user.signingStep == null);
  }
  function requestedPcn(search) {
    const ids = new URLSearchParams(search).getAll('pcn');
    return ids.length === 1 && pcnPattern.test(ids[0]) ? ids[0] : '';
  }
  function displayValue(value) {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }
  function flattenTransactions(items) {
    return (Array.isArray(items) ? items : []).flatMap((item, index) => {
      const common = { revision: item.revision, contentRevision: item.contentRevision,
        actor: item.actor || 'Unknown user', actorReference: item.actorReference || '',
        createdAt: item.createdAt || '', status: item.status || '', order: index };
      if (item.isBaseline) return [{ ...common, path: '', label: 'History baseline', before: '—', after: 'Earlier field changes are unavailable.' }];
      if (!item.changes?.length) return [{ ...common, path: '', label: 'Saved', before: '—', after: 'No document field changes recorded.' }];
      return item.changes.map(change => ({ ...common, path: change.path || '', label: change.label || change.path || 'Document',
        before: displayValue(change.before), after: displayValue(change.after) }));
    }).sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)
      || Number(b.revision || 0) - Number(a.revision || 0) || a.order - b.order);
  }
  function filterTransactions(rows, { query = '', from = '', to = '' } = {}) {
    const text = String(query).trim().toLowerCase();
    return rows.filter(row => {
      const date = /^\d{4}-\d{2}-\d{2}/.exec(row.createdAt)?.[0] || '';
      return (!from || date >= from) && (!to || date <= to)
        && (!text || [row.actor, row.actorReference, row.label, row.path, row.before, row.after, row.revision]
          .some(value => String(value ?? '').toLowerCase().includes(text)));
    });
  }
  function pageTransactions(rows, requestedPage) {
    const pages = Math.max(1, Math.ceil(rows.length / 25));
    const page = Math.min(pages, Math.max(1, Math.floor(Number(requestedPage) || 1)));
    const offset = (page - 1) * 25;
    return { items: rows.slice(offset, offset + 25), page, pages, total: rows.length,
      first: rows.length ? offset + 1 : 0, last: Math.min(offset + 25, rows.length) };
  }
  function formatDate(value) {
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : 'Not recorded';
  }
  function personName(person) {
    return typeof person === 'string' ? person : person?.displayName || person?.name || 'Not signed';
  }
  async function mount(root) {
    const doc = root.document;
    const el = id => doc.getElementById(id);
    el('developerMain').hidden = true;
    const state = { list: [], selected: '', rows: [], page: 1, detailGeneration: 0, listGeneration: 0, loaded: false, authorized: false };
    const node = (tag, text, className) => {
      const element = doc.createElement(tag);
      if (text !== undefined) element.textContent = String(text);
      if (className) element.className = className;
      return element;
    };
    function status(message, error = false) {
      el('developerStatus').textContent = message;
      el('developerStatus').setAttribute('data-state', error ? 'error' : 'info');
    }
    function lock(loading) {
      el('refreshDeveloper').disabled = loading;
      el('pcnSearch').disabled = loading;
      el('pcnSelect').disabled = loading;
    }
    function transactionControls() {
      for (const id of ['transactionSearch', 'transactionFrom', 'transactionTo']) el(id).disabled = !state.loaded;
    }
    function clearDetails(message) {
      state.rows = []; state.page = 1; state.loaded = false;
      el('workflowEmpty').textContent = message; el('workflowEmpty').hidden = false;
      for (const id of ['workflowSummary', 'workflowStages', 'workflowChecks']) el(id).replaceChildren();
      el('historyMessage').textContent = message;
      transactionControls(); renderTransactions();
    }
    function denyAccess() {
      state.authorized = false;
      ++state.detailGeneration; ++state.listGeneration;
      state.list = []; state.selected = '';
      clearDetails('Developer access required.'); renderChoices();
      lock(true); el('developerMain').hidden = true;
      status('Developer access required. Sign in with an active Developer account and reload this page.', true);
    }
    function renderTransactions() {
      const filtered = filterTransactions(state.rows, { query: el('transactionSearch').value,
        from: el('transactionFrom').value, to: el('transactionTo').value });
      const page = pageTransactions(filtered, state.page);
      state.page = page.page;
      const body = el('transactionRows'); body.replaceChildren();
      if (!page.items.length) {
        const row = node('tr'), cell = node('td', state.loaded ? 'No changes match these filters.' : 'Select or refresh a PCN to view recorded changes.');
        cell.colSpan = 6; row.appendChild(cell); body.appendChild(row);
      }
      for (const item of page.items) {
        const row = node('tr');
        const actor = item.actorReference && item.actorReference !== item.actor ? `${item.actor}\n${item.actorReference}` : item.actor;
        const revision = item.contentRevision === undefined || item.contentRevision === null
          ? item.revision : `${item.revision}\nDocument ${item.contentRevision}`;
        for (const value of [formatDate(item.createdAt), actor, revision, item.label, item.before, item.after]) row.appendChild(node('td', displayValue(value)));
        body.appendChild(row);
      }
      el('transactionCount').textContent = `${page.first}–${page.last} of ${page.total} changes · Page ${page.page} of ${page.pages}`;
      el('transactionPrevious').disabled = !state.loaded || page.page <= 1;
      el('transactionNext').disabled = !state.loaded || page.page >= page.pages;
    }
    function summaryCard(title, value, detail) {
      const card = node('div', undefined, 'developer-summary-card');
      card.appendChild(node('h3', title)); card.appendChild(node('strong', value));
      if (detail) card.appendChild(node('p', detail));
      el('workflowSummary').appendChild(card);
    }
    function renderWorkflow(data) {
      const record = data.record, workflow = data.workflow || {}, next = workflow.nextAction || {};
      el('workflowEmpty').hidden = true;
      summaryCard('Document', record.id, [record.supplierName, record.materialName, record.isTestDocument ? 'TESTING DOC' : ''].filter(Boolean).join(' · '));
      summaryCard('Current status', record.status || 'Not recorded', `${record.riskLevel || 'No risk level'} · Updated ${formatDate(record.updatedAt)}`);
      const people = Array.isArray(next.people) ? next.people.map(personName).join(', ') : '';
      summaryCard('Next action', next.label || 'No pending signing action', people || (next.signingStep ? 'No assigned user' : ''));
      for (const stage of workflow.stages || []) {
        const section = node('section', undefined, 'developer-stage');
        section.appendChild(node('h3', stage.label || stage.key));
        const steps = node('ol');
        const order = { prepared: 0, checked: 1, approved: 2 };
        const sorted = [...(stage.steps || [])].sort((a, b) => (order[a.action] ?? 9) - (order[b.action] ?? 9));
        for (const step of sorted) {
          const item = node('li', undefined, 'developer-step');
          const stepState = ['completed', 'current', 'waiting'].includes(step.state) ? step.state : 'waiting';
          item.setAttribute('data-state', stepState);
          item.appendChild(node('h4', step.label || step.action));
          item.appendChild(node('p', { completed: 'Completed', current: 'Current step', waiting: 'Waiting' }[stepState], 'developer-step-state'));
          item.appendChild(node('p', step.person ? personName(step.person) : stepState === 'completed' ? 'Signer not recorded' : 'Not signed'));
          if (step.signedAt) item.appendChild(node('p', formatDate(step.signedAt)));
          steps.appendChild(item);
        }
        section.appendChild(steps); el('workflowStages').appendChild(section);
      }
      const checks = workflow.checks?.items || [];
      const missing = checks.filter(check => check.blocking && !check.complete);
      el('workflowChecks').appendChild(node('h3', missing.length ? `${missing.length} required items remaining` : 'Required document items'));
      if (!missing.length) el('workflowChecks').appendChild(node('p', 'No missing required items reported.'));
      else {
        const list = node('ul');
        for (const check of missing) list.appendChild(node('li', check.label || check.message || check.field || check.key || 'Required item'));
        el('workflowChecks').appendChild(list);
      }
    }
    async function loadDetails(id) {
      if (!state.authorized) return;
      const generation = ++state.detailGeneration;
      state.selected = id;
      clearDetails(id ? 'Loading PCN details…' : 'Select a PCN to inspect its workflow and changes.');
      if (!id) { lock(false); status(''); return; }
      el('refreshDeveloper').disabled = true; status(`Loading ${id}…`);
      try {
        const data = await root.PCN_SESSION.fetch(`/api/developer/pcns/${encodeURIComponent(id)}/inspect`);
        if (generation !== state.detailGeneration || id !== state.selected) return;
        if (!data?.record || data.record.id !== id) throw new Error('The server returned a different PCN. Refresh and try again.');
        renderWorkflow(data);
        state.rows = flattenTransactions(data.transactions?.items); state.loaded = true;
        el('historyMessage').textContent = data.transactions?.historyMessage || 'Recorded changes are shown newest first.';
        transactionControls(); renderTransactions(); status('');
      } catch (error) {
        if ([401, 403].includes(error.status)) { denyAccess(); return; }
        if (generation !== state.detailGeneration || id !== state.selected) return;
        clearDetails('PCN details could not be loaded. Select Refresh to try again.');
        status(error.message || 'Could not load the PCN. Refresh to try again.', true);
      } finally {
        if (state.authorized && generation === state.detailGeneration) lock(false);
      }
    }
    function renderChoices() {
      const query = el('pcnSearch').value.trim().toLowerCase();
      const matches = state.list.filter(item => !query || [item.id, item.supplierName, item.materialName].some(value => String(value || '').toLowerCase().includes(query)) || item.id === state.selected);
      const select = el('pcnSelect'); select.replaceChildren();
      const placeholder = node('option', matches.length ? 'Select a PCN' : 'No matching PCNs'); placeholder.value = ''; select.appendChild(placeholder);
      for (const item of matches) {
        const option = node('option', [item.id, item.supplierName, item.isTestDocument ? 'TESTING DOC' : ''].filter(Boolean).join(' · '));
        option.value = item.id; select.appendChild(option);
      }
      select.value = state.selected;
    }
    async function refresh(preferredId = state.selected) {
      if (!state.authorized) return;
      const generation = ++state.listGeneration;
      ++state.detailGeneration;
      clearDetails('Loading PCN list…'); lock(true); status('Loading PCN list…');
      try {
        const data = await root.PCN_SESSION.fetch('/api/developer/pcns');
        if (generation !== state.listGeneration) return;
        state.list = (Array.isArray(data?.items) ? data.items : []).filter(item => pcnPattern.test(item.id || ''));
        state.selected = state.list.some(item => item.id === preferredId) ? preferredId : '';
        renderChoices();
        lock(false);
        if (preferredId && !state.selected) status('That PCN is no longer available. Select another document.', true);
        else status(state.list.length ? '' : 'No PCN documents are available.');
        if (state.selected) await loadDetails(state.selected);
        else clearDetails('Select a PCN to inspect its workflow and changes.');
      } catch (error) {
        if ([401, 403].includes(error.status)) { denyAccess(); return; }
        if (generation !== state.listGeneration) return;
        state.list = []; state.selected = ''; renderChoices();
        clearDetails('PCN list could not be loaded. Select Refresh to try again.');
        status(error.message || 'Could not load PCN documents. Refresh to try again.', true);
      } finally {
        if (state.authorized && generation === state.listGeneration) lock(false);
      }
    }
    function chooseTab(target, focus = false) {
      for (const name of ['workflow', 'transactions']) {
        const active = name === target, tab = el(`${name}Tab`);
        tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
        el(`${name}Panel`).hidden = !active;
        if (active && focus) tab.focus();
      }
    }
    function bind() {
      el('refreshDeveloper').addEventListener('click', () => refresh());
      el('pcnSearch').addEventListener('input', renderChoices);
      el('pcnSelect').addEventListener('change', () => loadDetails(el('pcnSelect').value));
      for (const id of ['transactionSearch', 'transactionFrom', 'transactionTo']) {
        el(id).addEventListener('input', () => { state.page = 1; renderTransactions(); });
      }
      for (const [id, delta] of [['transactionPrevious', -1], ['transactionNext', 1]]) {
        el(id).addEventListener('click', () => { state.page += delta; renderTransactions(); });
      }
      for (const name of ['workflow', 'transactions']) {
        el(`${name}Tab`).addEventListener('click', () => chooseTab(name));
        el(`${name}Tab`).addEventListener('keydown', event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          chooseTab(event.key === 'Home' ? 'workflow' : event.key === 'End' ? 'transactions' : name === 'workflow' ? 'transactions' : 'workflow', true);
        });
      }
    }
    try {
      const session = await root.PCN_SESSION.require('developer');
      if (!session) { status('Sign in with a Developer account to open Developer Tools.'); return; }
      if (!isDeveloper(session.user)) throw new Error('Developer Tools are available only to active Developer accounts.');
      state.authorized = true; el('developerMain').hidden = false;
      root.PCN_SESSION.mountProfile?.(session.user, error => status(error.message, true));
      bind(); await refresh(requestedPcn(root.location.search));
    } catch (error) {
      el('developerMain').hidden = true;
      status(error.message || 'Developer access could not be verified. Reload to try again.', true);
    }
    return { refresh, loadDetails, state };
  }
  return { isDeveloper, requestedPcn, flattenTransactions, filterTransactions, pageTransactions, mount };
});
