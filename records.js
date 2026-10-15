(function () {
  const columns = { id: 'PCN code', status: 'Status', riskLevel: 'Risk', supplierName: 'Supplier', materialName: 'Material', progress: 'Progress', next: 'Next responsible', documents: 'Documents', pending: 'Pending time', updatedAt: 'Updated' };
  const defaults = Object.keys(columns);
  const filterKeys = ['summary', 'search', 'status', 'risk', 'supplier', 'department', 'from', 'to'];
  const departments = { gscTet: 'GSC/TET', prodEngTet: 'Prod.Eng/TET', qaTet: 'QA/TET', gscTapbu: 'GSC/TaPBU', qaTapbu: 'QA/TaPBU' };
  const terminal = status => ['approved', 'rejected', 'closed'].includes(status);
  const text = value => value === null || value === undefined || value === '' ? '—' : String(value);
  const label = value => text(value).replace(/_/g, ' ').replace(/\b\w/g, character => character.toUpperCase());
  const validDate = value => Boolean(value) && Number.isFinite(Date.parse(value));
  const dayFilter = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && validDate(value);
  const action = record => record.dashboard?.action || {};
  const personNames = record => (action(record).people || []).map(person => person.displayName).filter(Boolean).join(', ');
  const departmentName = record => departments[action(record).department] || action(record).department || '';
  const attention = record => !terminal(record.status) && record.dashboard?.pending?.needsAttention === true;
  const inReview = record => ['submitted', 'gsc_review', 'technical_review', 'qa_review', 'tapbu_review', 'qualification'].includes(record.status);

  function summaryCounts(records) {
    return { all: records.length, review: records.filter(inReview).length, approved: records.filter(record => record.status === 'approved').length, attention: records.filter(attention).length };
  }

  function filterRecords(records, filters = {}) {
    const query = String(filters.search || '').trim().toLowerCase();
    return records.filter(record => {
      if (filters.summary === 'review' && !inReview(record)) return false;
      if (filters.summary === 'approved' && record.status !== 'approved') return false;
      if (filters.summary === 'attention' && !attention(record)) return false;
      if (filters.status && record.status !== filters.status) return false;
      if (filters.risk && record.riskLevel !== filters.risk) return false;
      if (filters.supplier && record.supplierName !== filters.supplier) return false;
      if (filters.department && ![action(record).department, departmentName(record)].includes(filters.department)) return false;
      const updated = record.updatedAt || record.createdAt;
      const date = validDate(updated) ? new Date(updated).toISOString().slice(0, 10) : '';
      if (dayFilter(filters.from) && (!date || date < filters.from)) return false;
      if (dayFilter(filters.to) && (!date || date > filters.to)) return false;
      return !query || [record.id, record.status, record.riskLevel, record.supplierName, record.materialName, action(record).label, personNames(record)]
        .some(value => String(value ?? '').toLowerCase().includes(query));
    });
  }

  function documentLabel(record) {
    const value = record.dashboard?.documents;
    if (!value || !['ready', 'missing'].includes(value.state)) return 'Not available';
    const count = Array.isArray(value.missing) ? value.missing.length : Math.max(0, Number(value.requiredCount) - Number(value.completeCount));
    return count > 0 ? `Missing ${count} required document${count === 1 ? '' : 's'}` : 'Documents ready';
  }

  function pendingLabel(record, now = Date.now()) {
    const pending = record.dashboard?.pending || {};
    if (pending.overdue === true && validDate(pending.reviewDueAt)) return `Overdue · due ${new Date(pending.reviewDueAt).toLocaleDateString()}`;
    const date = pending.since || record.updatedAt || record.createdAt;
    if (!validDate(date)) return 'Time not available';
    const days = Math.max(0, Math.floor((now - Date.parse(date)) / 86400000));
    const waiting = pending.source === 'status_transition' && !terminal(record.status);
    const age = days ? `${days} day${days === 1 ? '' : 's'}${waiting ? '' : ' ago'}` : 'today';
    return `${waiting ? 'Waiting' : 'Updated'} ${age}`;
  }

  function columnValue(record, key) {
    if (key === 'progress') return record.dashboard?.progress?.currentStepTitle || 'Not available';
    if (key === 'next') return [action(record).label, personNames(record)].filter(Boolean).join(' · ') || 'Not available';
    if (key === 'documents') return documentLabel(record);
    if (key === 'pending') return pendingLabel(record);
    if (key === 'updatedAt') return validDate(record.updatedAt || record.createdAt) ? new Date(record.updatedAt || record.createdAt).toLocaleDateString() : '—';
    return text(record[key]);
  }

  function sortRecords(records, key = 'updatedAt', direction = 'desc') {
    const multiplier = direction === 'asc' ? 1 : -1;
    return [...records].sort((left, right) => {
      if (key === 'pending') {
        const age = record => validDate(record.dashboard?.pending?.since || record.updatedAt || record.createdAt) ? Date.now() - Date.parse(record.dashboard?.pending?.since || record.updatedAt || record.createdAt) : -1;
        return multiplier * (age(left) - age(right)) || String(left.id).localeCompare(String(right.id));
      }
      if (key === 'progress') return multiplier * ((left.dashboard?.progress?.progressPercent ?? -1) - (right.dashboard?.progress?.progressPercent ?? -1)) || String(left.id).localeCompare(String(right.id));
      const a = key === 'updatedAt' ? (left.updatedAt || left.createdAt || '') : columnValue(left, key);
      const b = key === 'updatedAt' ? (right.updatedAt || right.createdAt || '') : columnValue(right, key);
      return multiplier * String(a).localeCompare(String(b), undefined, { numeric: true }) || String(left.id).localeCompare(String(right.id));
    });
  }

  function paginate(records, page = 1, size = 25) {
    const pageSize = [10, 25, 50, 100].includes(size) ? size : 25;
    const pages = Math.max(1, Math.ceil(records.length / pageSize));
    const current = Math.min(pages, Math.max(1, Number(page) || 1));
    return { page: current, pages, items: records.slice((current - 1) * pageSize, current * pageSize) };
  }

  function csvCell(value) {
    let result = value === null || value === undefined ? '' : String(value);
    if (/^[\s]*[=+@-]/.test(result) || /^[\s]*[\t\r]/.test(result)) result = `'${result}`;
    return `"${result.replace(/"/g, '""')}"`;
  }

  function exportCsv(records, selected = defaults) {
    const keys = selected.filter(key => Object.hasOwn(columns, key));
    return '\ufeff' + [keys.map(key => csvCell(columns[key])).join(','), ...records.map(record => keys.map(key => csvCell(columnValue(record, key))).join(','))].join('\r\n');
  }

  function cleanFilters(value = {}) {
    return Object.fromEntries(filterKeys.map(key => [key, typeof value[key] === 'string' ? value[key].slice(0, 200) : '']));
  }

  function readPreferences(raw) {
    const fallback = { views: [], columns: [...defaults], pageSize: 25, sort: 'updatedAt', direction: 'desc' };
    if (typeof raw !== 'string' || raw.length > 20000) return fallback;
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
      const saved = (Array.isArray(value.views) ? value.views : []).slice(0, 10).filter(view => typeof view?.name === 'string' && view.name.trim().length && view.name.length <= 50 && view.filters && typeof view.filters === 'object');
      const selected = Array.isArray(value.columns) ? [...new Set(value.columns.filter(key => Object.hasOwn(columns, key)))] : defaults;
      return { ...fallback, views: saved.map(view => ({ name: view.name.trim(), filters: cleanFilters(view.filters) })),
        columns: ['id', ...selected.filter(key => key !== 'id')], pageSize: [10, 25, 50, 100].includes(value.pageSize) ? value.pageSize : 25,
        sort: Object.hasOwn(columns, value.sort) ? value.sort : 'updatedAt', direction: value.direction === 'asc' ? 'asc' : 'desc' };
    } catch { return fallback; }
  }

  function timelinePoints(revisions) {
    const names = { 'signoff.gscTet': 'GSC/TET', 'signoff.prodEngTet': 'Prod.Eng/TET', 'signoff.qaTet': 'QA/TET', 'tapbu.gsc': 'GSC/TaPBU', 'tapbu.qa': 'QA/TaPBU', 'qateFinal.signoff': 'QA/TET Final Judgment' };
    return [...revisions].sort((a, b) => Number(a.revision) - Number(b.revision)).flatMap(item => {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const points = item.isBaseline ? [] : changes.flatMap(change => {
        const internal = /^internalReview\.(signoff\.(?:gscTet|prodEngTet|qaTet)|tapbu\.(?:gsc|qa)|qateFinal\.signoff)\.(approved|checked|prepared)$/.exec(change.path);
        const supplier = /^internalReview\.supplierSignoff\.(approved|checked|prepared)\.checked$/.exec(change.path);
        const cleared = change.before === true && (change.after === false || change.after === null);
        if ((!internal && !supplier) || (change.after !== true && !cleared)) return [];
        const namePath = internal ? `${change.path}Name` : change.path.replace(/\.checked$/, '.name');
        const name = changes.find(candidate => candidate.path === namePath)?.after;
        return [{ ...item, signed: !cleared, label: `${internal ? names[internal[1]] : 'Supplier'} — ${label(internal ? internal[2] : supplier[1])}${cleared ? ' cleared' : ''}`, person: !cleared && typeof name === 'string' && name.trim() ? name : item.actor || 'Actor not recorded', cleared }];
      });
      return points.length ? points : [{ ...item, label: item.isBaseline ? 'History baseline' : item.revision === 1 ? 'PCN created' : label(item.status || 'Status not recorded'), person: item.actor || 'Actor not recorded' }];
    });
  }

  function timelineTone(point) {
    if (point.isBaseline) return { marker: '○', tone: 'neutral' };
    if (point.cleared || point.status === 'rejected') return { marker: point.cleared ? '↶' : '!', tone: 'danger' };
    if (point.signed || ['approved', 'closed'].includes(point.status)) return { marker: '✓', tone: 'complete' };
    return { marker: '•', tone: 'active' };
  }

  function currentSummary(record, summary) {
    return record.version !== undefined && record.version === summary.version ? summary : record;
  }

  function currentProgress(record, summary) {
    if (currentSummary(record, summary) !== summary) return null;
    const progress = summary.dashboard?.progress;
    return progress?.status === record.status && typeof record.status === 'string' ? progress : null;
  }

  function workflowSummary(value, id) {
    const actions = ['prepared', 'checked', 'approved'];
    const invalid = () => { throw new Error('The department timeline returned an invalid response.'); };
    if (!value || value.id !== id || !['string', 'number'].includes(typeof value.version) || !String(value.version).trim()
      || typeof value.status !== 'string' || !Array.isArray(value.stages) || value.stages.length > 20
      || typeof value.nextAction?.label !== 'string' || typeof value.nextAction.terminal !== 'boolean') invalid();
    const keys = new Set();
    value.stages.forEach(stage => {
      if (!stage || typeof stage.key !== 'string' || !stage.key || keys.has(stage.key) || typeof stage.label !== 'string'
        || !['completed', 'current', 'waiting', 'stopped'].includes(stage.state) || stage.total !== 3
        || !Number.isInteger(stage.completed) || stage.completed < 0 || stage.completed > 3
        || !Array.isArray(stage.steps) || stage.steps.length !== 3 || !(stage.currentStep == null || typeof stage.currentStep === 'string')) invalid();
      keys.add(stage.key);
      stage.steps.forEach((step, index) => {
        if (!step || step.action !== actions[index] || typeof step.label !== 'string' || typeof step.completed !== 'boolean'
          || !(step.person == null || typeof step.person === 'string') || !(step.signedAt == null || typeof step.signedAt === 'string')) invalid();
      });
      if (stage.steps.filter(step => step.completed).length !== stage.completed || stage.state === 'completed' && stage.completed !== 3) invalid();
    });
    return value;
  }

  function workflowStageCaption(stage) {
    return stage.state === 'current' && stage.currentStep ? `Waiting for ${stage.currentStep}`
      : stage.state === 'waiting' && stage.completed > 0 ? 'Waiting for earlier departments'
        : { completed: 'Completed', stopped: 'Review stopped', waiting: 'Not started', current: 'Current department' }[stage.state];
  }

  function create(options) {
    const { root, rows, count, search, message } = options;
    const node = (tag, value, className) => {
      const result = document.createElement(tag);
      if (value !== undefined) result.textContent = value;
      if (className) result.className = className;
      return result;
    };
    const button = (value, callback, className = 'rd-button') => {
      const result = node('button', value, className); result.type = 'button'; result.dataset.rdFocus = `${className}:${value}`; result.addEventListener('click', callback); return result;
    };
    const icon = (target, paths, titleText) => {
      target.textContent = '';
      target.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`;
      target.title = titleText;
    };
    const identity = options.user?.id || options.user?.employeeCode || options.user?.username;
    const storageKey = identity ? `pcn-records-dashboard:v1:${encodeURIComponent(identity)}` : null;
    let preferences;
    try { preferences = readPreferences(storageKey ? window.localStorage?.getItem(storageKey) : null); } catch { preferences = readPreferences(null); }
    let state = { records: [], filters: cleanFilters({ search: search.value }), page: 1, preferences, accessible: true };
    let preview = { record: null, tab: 'overview', request: 0, cache: {}, opener: null };
    let rowMenus = [];
    const closeRowMenus = (restoreFocus = false, except = null) => {
      rowMenus.forEach(menu => {
        if (!menu.details.open || menu.details === except) return;
        menu.details.open = false;
        if (restoreFocus) menu.summary.focus({ preventScroll: true });
      });
    };
    const outsideRowMenu = event => {
      rowMenus.forEach(menu => { if (menu.details.open && !menu.details.contains(event.target)) menu.details.open = false; });
    };
    document.addEventListener('click', outsideRowMenu);
    const toolbar = node('section', undefined, 'rd-controls'); toolbar.setAttribute('aria-label', 'Record controls');
    const cards = node('div', undefined, 'rd-summary');
    const fields = node('div', undefined, 'rd-filters');
    const footer = node('div', undefined, 'rd-pagination');
    const table = rows.closest?.('table');
    const tableHead = table?.querySelector?.('thead');
    const refs = {};
    const savePrefs = () => {
      if (!storageKey) return;
      try { window.localStorage?.setItem(storageKey, JSON.stringify(state.preferences)); }
      catch { message.textContent = 'Preferences are available for this visit. Browser storage is unavailable.'; }
    };
    const setFilter = (key, value) => { state = { ...state, filters: { ...state.filters, [key]: value }, page: 1 }; render(); };
    const selectField = (key, title, external) => {
      const input = external || node('select'); refs[key] = input;
      input.setAttribute('aria-label', title); if (!external) { input.id = `rdFilter-${key}`; const wrapper = node('label', title); wrapper.append(input); fields.append(wrapper); }
      input.addEventListener('change', () => setFilter(key, input.value)); return input;
    };
    selectField('status', 'Status', options.statusFilter); selectField('risk', 'Risk', options.riskFilter);
    selectField('supplier', 'Supplier'); selectField('department', 'Department');
    ['from', 'to'].forEach(key => {
      const wrapper = node('label', key === 'from' ? 'Updated from (UTC)' : 'Updated to (UTC)'); const input = node('input'); input.type = 'date'; input.id = `rdFilter-${key}`; refs[key] = input;
      input.addEventListener('change', () => setFilter(key, input.value)); wrapper.append(input); fields.append(wrapper);
    });
    const tools = node('div', undefined, 'rd-tools');
    const saved = selectField('saved', 'Saved views');
    saved.addEventListener('change', () => {
      const view = state.preferences.views.find(item => item.name === saved.value);
      if (view) { state = { ...state, filters: { ...view.filters }, page: 1 }; search.value = state.filters.search; render(); }
    });
    const viewEditor = node('details', undefined, 'rd-editor'); viewEditor.id = 'rdViewEditor'; viewEditor.append(node('summary', 'Save view'));
    const viewName = node('input'); viewName.id = 'rdViewName'; viewName.type = 'text'; viewName.maxLength = 50; viewName.placeholder = 'View name'; viewName.setAttribute('aria-label', 'View name'); viewEditor.append(viewName);
    viewEditor.append(button('Save current view', () => {
      const name = viewName.value.trim();
      if (!name || name.length > 50) { message.textContent = 'Enter a view name of 1–50 characters.'; return; }
      const views = state.preferences.views.filter(view => view.name !== name);
      if (views.length >= 10) { message.textContent = 'You can save up to 10 views. Delete a view before adding another.'; return; }
      state = { ...state, preferences: { ...state.preferences, views: [...views, { name, filters: cleanFilters(state.filters) }] } }; savePrefs(); viewEditor.open = false; render(); saved.value = name;
    }));
    tools.append(viewEditor);
    tools.append(button('Delete selected view', () => {
      if (!saved.value) return;
      state = { ...state, preferences: { ...state.preferences, views: state.preferences.views.filter(view => view.name !== saved.value) } }; savePrefs(); render();
    }));
    tools.append(button('Reset filters', () => { state = { ...state, filters: cleanFilters(), page: 1 }; search.value = ''; render(); }));
    const chooser = node('details', undefined, 'rd-editor'); chooser.id = 'rdColumnChooser'; chooser.append(node('summary', 'Columns'));
    const choices = node('div', undefined, 'rd-column-options'); chooser.append(choices);
    Object.entries(columns).forEach(([key, title]) => {
      const wrapper = node('label'); const input = node('input'); input.type = 'checkbox'; input.checked = state.preferences.columns.includes(key); input.disabled = key === 'id';
      input.addEventListener('change', () => {
        const selected = defaults.filter(item => item === 'id' || (item === key ? input.checked : state.preferences.columns.includes(item)));
        state = { ...state, preferences: { ...state.preferences, columns: selected } }; savePrefs(); render();
      }); wrapper.append(input); wrapper.append(node('span', title)); choices.append(wrapper);
    });
    tools.append(chooser);
    [chooser, viewEditor].forEach(editor => editor.addEventListener('toggle', () => { if (editor.open) options.onOpen?.(); }));
    tools.append(button('Export filtered CSV', () => {
      const csv = exportCsv(sortRecords(filterRecords(state.records, state.filters), state.preferences.sort, state.preferences.direction), state.preferences.columns);
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' })); const link = node('a'); link.href = url; link.download = 'pcn-records.csv'; link.click(); URL.revokeObjectURL(url);
    }));
    toolbar.append(cards); toolbar.append(fields); toolbar.append(tools);
    const wrap = rows.closest?.('.admin-table-wrap'); if (wrap?.parentNode) wrap.parentNode.insertBefore(toolbar, wrap); else root.prepend?.(toolbar);
    if (wrap?.parentNode) wrap.after(footer); else root.append?.(footer);
    const dialog = node('dialog', undefined, 'rd-preview'); dialog.id = 'rdPreviewDialog'; dialog.setAttribute('aria-labelledby', 'rdPreviewTitle');
    const header = node('div', undefined, 'rd-preview-header'); const title = node('h2'); title.id = 'rdPreviewTitle';
    const testBadge = node('span', 'TESTING DOC', 'rd-test-badge'); testBadge.hidden = true;
    const closeButton = button('Close', closePreview); closeButton.setAttribute('aria-label', 'Close preview'); header.append(title); header.append(testBadge); header.append(closeButton);
    const tabs = node('div', undefined, 'rd-preview-tabs'); tabs.setAttribute('role', 'tablist');
    const content = node('div', undefined, 'rd-preview-content'); content.setAttribute('role', 'tabpanel'); content.id = 'rdPreviewContent'; content.tabIndex = 0;
    const tabButtons = {};
    ['overview', 'timeline', 'documents', 'history'].forEach(tab => {
      const item = button(tab === 'history' ? 'Change history' : label(tab), () => { preview = { ...preview, tab }; loadPreview(); }, 'rd-tab'); item.id = `rdPreviewTab-${tab}`; item.setAttribute('role', 'tab'); item.setAttribute('aria-controls', content.id); tabButtons[tab] = item; tabs.append(item);
    });
    tabs.addEventListener('keydown', event => {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const keys = Object.keys(tabButtons); const index = keys.indexOf(preview.tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length;
      preview = { ...preview, tab: keys[next] }; tabButtons[keys[next]].focus(); loadPreview();
    });
    dialog.append(header); dialog.append(tabs); dialog.append(content); document.body?.append(dialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); closePreview(); });
    dialog.addEventListener('close', finishPreview);
    dialog.addEventListener('click', event => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closePreview(); } });
    search.addEventListener('input', () => setFilter('search', search.value));

    function updateOptions(ref, values, allLabel, selected, preserveSelected = false) {
      ref.replaceChildren(); const all = node('option', allLabel); all.value = ''; ref.append(all);
      [...new Set([...values, ...(preserveSelected && selected ? [selected] : [])].filter(Boolean))].sort().forEach(value => { const item = node('option', label(value)); item.value = value; ref.append(item); }); ref.value = selected || '';
    }

    function render() {
      const focused = document.activeElement;
      const focusKey = focused?.dataset?.rdFocus;
      const focusId = focused?.id;
      const totals = summaryCounts(state.records); cards.replaceChildren();
      [['all', 'All records'], ['review', 'In review'], ['approved', 'Approved'], ['attention', 'Needs attention']].forEach(([key, titleText]) => {
        const item = button('', () => setFilter('summary', key), `rd-summary-card rd-summary-${key}`); item.dataset.summary = key; item.dataset.rdFocus = `summary:${key}`; item.setAttribute('aria-pressed', String(state.filters.summary === key || key === 'all' && !state.filters.summary));
        item.append(node('strong', String(totals[key]))); item.append(node('span', titleText)); cards.append(item);
      });
      updateOptions(refs.status, state.records.map(record => record.status), 'All statuses', state.filters.status, true);
      updateOptions(refs.risk, state.records.map(record => record.riskLevel), 'All risks', state.filters.risk, true);
      updateOptions(refs.supplier, state.records.map(record => record.supplierName), 'All suppliers', state.filters.supplier, true);
      updateOptions(refs.department, state.records.map(departmentName), 'All departments', state.filters.department, true);
      updateOptions(saved, state.preferences.views.map(view => view.name), 'Select saved view', saved.value);
      refs.from.value = state.filters.from; refs.to.value = state.filters.to;
      if (tableHead) {
        tableHead.replaceChildren(); const heading = node('tr');
        state.preferences.columns.forEach(key => { const cell = node('th'); cell.scope = 'col'; cell.setAttribute('aria-sort', state.preferences.sort === key ? state.preferences.direction === 'asc' ? 'ascending' : 'descending' : 'none'); const sort = button(`${columns[key]}${state.preferences.sort === key ? state.preferences.direction === 'asc' ? ' ↑' : ' ↓' : ''}`, () => { state = { ...state, preferences: { ...state.preferences, sort: key, direction: state.preferences.sort === key && state.preferences.direction === 'asc' ? 'desc' : 'asc' }, page: 1 }; savePrefs(); render(); }, 'rd-sort'); sort.dataset.rdFocus = `sort:${key}`; cell.append(sort); heading.append(cell); });
        const actions = node('th', 'Actions'); actions.scope = 'col'; heading.append(actions); tableHead.append(heading);
      }
      const filtered = sortRecords(filterRecords(state.records, state.filters), state.preferences.sort, state.preferences.direction);
      const page = paginate(filtered, state.page, state.preferences.pageSize); state = { ...state, page: page.page }; count.textContent = String(filtered.length); closeRowMenus(); rowMenus = []; rows.replaceChildren();
      if (!page.items.length) { const row = node('tr'); const cell = node('td', state.records.length ? 'No records match these filters. Reset filters to see all records.' : 'No PCN records are available.', 'records-empty'); cell.colSpan = state.preferences.columns.length + 1; row.append(cell); rows.append(row); }
      page.items.forEach(record => renderRow(record)); renderFooter(page, filtered.length);
      if (focusKey || focusId) {
        const target = Array.from(root.querySelectorAll?.('[data-rd-focus], [id]') || []).find(item => focusKey ? item.dataset.rdFocus === focusKey : item.id === focusId);
        target?.focus({ preventScroll: true });
      }
    }

    function renderRow(record) {
      const row = node('tr'); row.dataset.pcnId = record.id; row.dataset.rdFocus = `row:${record.id}`;
      const selected = options.selectedId?.() === record.id;
      if (selected) row.className = 'is-selected';
      row.setAttribute('aria-selected', String(selected));
      state.preferences.columns.forEach(key => {
        const cell = node('td'); cell.dataset.column = key;
        if (key === 'id') {
          const identity = node('div', undefined, 'rd-code-cell');
          const href = options.codeHref?.(record) || `/${encodeURIComponent(record.id)}`;
          const link = node('a', record.id, 'rd-code-link'); link.dataset.rdFocus = `code:${record.id}`; link.href = href;
          identity.append(link);
          if (record.isTestDocument === true) identity.append(node('span', 'TESTING DOC', 'rd-test-badge'));
          const openLink = node('a', 'Open PCN', 'rd-button rd-open-button');
          openLink.href = href; openLink.dataset.rdFocus = `open:${record.id}`; openLink.setAttribute('aria-label', `Open ${record.id}`);
          identity.append(openLink); cell.append(identity);
        }
        else if (key === 'status') cell.append(node('span', label(record.status), `rd-badge rd-status-${String(record.status || '').replace(/[^a-z_]/g, '')}`));
        else if (key === 'progress') renderProgress(cell, record);
        else if (key === 'next') { cell.append(node('strong', action(record).label || 'Not available')); cell.append(node('small', personNames(record) || (terminal(record.status) ? 'Review finished' : 'Assignee not available'))); }
        else if (key === 'documents') cell.append(node('span', documentLabel(record), `rd-badge rd-doc-${record.dashboard?.documents?.state || 'unknown'}`));
        else { cell.textContent = columnValue(record, key); if (key === 'pending' && record.dashboard?.pending?.overdue === true) cell.className = 'rd-overdue'; }
        row.append(cell);
      });
      const actionsCell = node('td', undefined, 'rd-row-actions');
      const secondary = node('div', undefined, 'rd-secondary-actions');
      const previewButton = button('Quick view', () => openPreview(record, previewButton), 'rd-button rd-preview-button');
      previewButton.dataset.rdFocus = `preview:${record.id}`; previewButton.setAttribute('aria-label', `Quick view ${record.id}`);
      icon(previewButton, '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"></path><circle cx="12" cy="12" r="2.8"></circle>', `Quick view ${record.id}`); secondary.append(previewButton);
      const extra = options.actions?.(record); const overflow = [];
      (Array.isArray(extra) ? extra : extra ? [extra] : []).forEach(item => {
        if (item.dataset) item.dataset.rdFocus = `action:${record.id}:${item.getAttribute?.('aria-label') || item.textContent}`;
        if (item.dataset?.rdOverflow === 'true') overflow.push(item); else secondary.append(item);
      });
      if (overflow.length) secondary.append(renderRowMenu(record, overflow));
      actionsCell.append(secondary); row.append(actionsCell);
      if (options.onRowSelect) { row.tabIndex = 0; row.addEventListener('click', event => { if (!event.target.closest('a,button,input,select,summary,details')) options.onRowSelect(record); }); row.addEventListener('keydown', event => { if (event.target !== row || !['Enter', ' '].includes(event.key)) return; event.preventDefault(); options.onRowSelect(record); }); }
      rows.append(row);
    }

    function renderRowMenu(record, items) {
      const details = node('details', undefined, 'rd-row-more');
      const summary = node('summary', 'More', 'rd-more-summary');
      summary.dataset.rdFocus = `more:${record.id}`; summary.setAttribute('aria-label', `More actions for ${record.id}`);
      icon(summary, '<circle cx="5" cy="12" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle>', `More actions for ${record.id}`);
      const panel = node('div', undefined, 'rd-more-panel'); items.forEach(item => panel.append(item)); details.append(summary, panel);
      rowMenus.push({ details, summary });
      summary.addEventListener('click', () => {
        if (!details.open) { closeRowMenus(false, details); options.onOpen?.(); }
      });
      details.addEventListener('toggle', () => { if (details.open) { closeRowMenus(false, details); options.onOpen?.(); } });
      details.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !details.open) return;
        event.preventDefault(); event.stopPropagation(); details.open = false; summary.focus({ preventScroll: true });
      });
      details.addEventListener('focusout', event => { if (!details.contains(event.relatedTarget)) details.open = false; });
      // Close before the existing action opens its confirmation dialog; never cancel the action.
      details.addEventListener('click', event => {
        if (event.target.closest('button')) { details.open = false; summary.focus({ preventScroll: true }); }
      }, true);
      return details;
    }

    function renderProgress(cell, record) {
      const progress = record.dashboard?.progress;
      if (!progress) { cell.textContent = 'Not available'; return; }
      cell.append(node('strong', progress.terminal ? label(record.status) : progress.currentStepTitle));
      if (record.status === 'rejected') {
        cell.append(node('small', 'Review ended with rejection'));
        if (Number.isFinite(progress.totalSignatures)) cell.append(node('small', `${progress.completedSignatures}/${progress.totalSignatures} signing steps`));
        return;
      }
      const bar = node('progress'); bar.max = 100; bar.value = Math.min(100, Math.max(0, Number(progress.progressPercent) || 0)); bar.setAttribute('aria-label', `${record.id}: workflow stage progress`); cell.append(bar);
      cell.append(node('small', Number.isFinite(progress.totalSignatures) ? `${progress.completedSignatures}/${progress.totalSignatures} signing steps` : `${bar.value}% of workflow stages`));
    }

    function renderFooter(page, total) {
      footer.replaceChildren(); const previous = button('Previous', () => { state = { ...state, page: state.page - 1 }; render(); }); previous.disabled = page.page <= 1;
      const next = button('Next', () => { state = { ...state, page: state.page + 1 }; render(); }); next.disabled = page.page >= page.pages;
      footer.append(node('span', `${total} matching record${total === 1 ? '' : 's'} · Page ${page.page} of ${page.pages}`)); footer.append(previous); footer.append(next);
      const wrapper = node('label', 'Rows per page'); const size = node('select'); size.id = 'rdPageSize'; [10, 25, 50, 100].forEach(value => { const item = node('option', String(value)); item.value = String(value); size.append(item); }); size.value = String(state.preferences.pageSize);
      size.addEventListener('change', () => { state = { ...state, page: 1, preferences: { ...state.preferences, pageSize: Number(size.value) } }; savePrefs(); render(); }); wrapper.append(size); footer.append(wrapper);
    }

    async function openPreview(record, opener) {
      if (!state.accessible || options.isBusy?.()) return;
      closeRowMenus(); options.onOpen?.(); preview = { record, tab: 'overview', request: preview.request + 1, cache: {}, opener }; title.textContent = `PCN preview · ${record.id}`; content.replaceChildren();
      testBadge.hidden = record.isTestDocument !== true;
      if (!dialog.open) dialog.showModal(); closeButton.focus(); await loadPreview();
    }

    async function loadPreview() {
      if (!preview.record || !dialog.open || !state.accessible) return;
      const { record, tab } = preview; const request = preview.request + 1; preview = { ...preview, request };
      Object.entries(tabButtons).forEach(([key, item]) => { item.setAttribute('aria-selected', String(key === tab)); item.tabIndex = key === tab ? 0 : -1; }); content.setAttribute('aria-labelledby', tabButtons[tab].id); content.setAttribute('aria-busy', 'true'); content.replaceChildren(node('p', 'Loading preview…', 'rd-preview-message'));
      const current = () => dialog.open && state.accessible && preview.request === request && preview.record?.id === record.id && preview.tab === tab;
      try {
        const base = `/api/pcns/${encodeURIComponent(record.id)}`;
        const endpoints = tab === 'overview' ? [base, `${base}/progress`] : tab === 'timeline' ? [`${base}/workflow-summary`] : tab === 'history' ? [`${base}/revisions`] : [`${base}/documents`, `${base}/checks`];
        const data = preview.cache[tab] || await Promise.all(endpoints.map(endpoint => options.fetch(endpoint)));
        if (!current()) return;
        const cacheable = renderPreview(data, tab, record);
        if (cacheable !== false) preview = { ...preview, cache: { ...preview.cache, [tab]: data } };
      } catch (error) {
        if ([401, 403].includes(error.status)) { state = { ...state, accessible: false }; closePreview(); clear(); options.onAccessLost?.(error); message.textContent = 'Your access has changed. Reload the page to continue.'; return; }
        if (!current()) return;
        content.replaceChildren(node('p', `Preview unavailable. ${error.message}`, 'rd-preview-message')); content.append(button('Retry', loadPreview));
      } finally { if (current()) content.setAttribute('aria-busy', 'false'); }
    }

    function renderPreview(data, tab, summary) {
      content.replaceChildren();
      if (tab === 'overview') {
        const [record, fetchedProgress] = data; if (!record || !fetchedProgress) throw new Error('The overview returned an invalid response.');
        testBadge.hidden = record.isTestDocument !== true;
        const overview = node('dl', undefined, 'rd-overview'); const consistent = currentSummary(record, summary); const progress = currentProgress(record, summary);
        [['Supplier', record.supplierName], ['Material', record.materialName], ['Status', label(record.status)], ['Risk', record.riskLevel], ['Current stage', progress?.currentStepTitle || 'Not available'], ['Next responsible', columnValue(consistent, 'next')], ['Documents', documentLabel(consistent)], ['Pending time', pendingLabel(consistent)], ['Reason for change', record.reason], ['Target start', record.desiredStart]].forEach(([key, value]) => { overview.append(node('dt', key)); overview.append(node('dd', text(value))); }); content.append(overview);
        if (!progress) content.append(node('p', 'Refresh the records list to reload current progress and responsibility.', 'rd-preview-message'));
        if (record.status === 'rejected') {
          content.append(node('p', 'Review ended with rejection.', 'rd-preview-message'));
          if (Number.isFinite(progress?.totalSignatures)) content.append(node('p', `${progress.completedSignatures}/${progress.totalSignatures} signing steps recorded.`, 'rd-preview-message'));
        } else {
          const steps = node('ol', undefined, 'rd-workflow'); (progress?.steps || []).forEach(step => { const item = node('li', `${step.title} · ${label(step.state)}`); item.className = `rd-step-${step.state}`; steps.append(item); }); content.append(steps);
        }
        return Boolean(progress);
      } else if (tab === 'timeline') {
        renderDepartmentPreview(workflowSummary(data[0], summary.id));
      } else if (tab === 'history') {
        if (!Array.isArray(data[0]?.items)) throw new Error('The timeline returned an invalid response.');
        const points = timelinePoints(data[0].items); if (!points.length) { content.append(node('p', 'No recorded changes are available for this PCN.', 'rd-preview-message')); return; }
        const track = node('ol', undefined, 'rd-timeline');
        points.forEach(point => { const item = node('li'); const appearance = timelineTone(point); item.append(node('time', validDate(point.createdAt) ? new Date(point.createdAt).toLocaleString() : 'Time not recorded')); item.append(node('span', appearance.marker, `rd-timeline-point rd-tone-${appearance.tone}`)); item.append(node('strong', point.label)); item.append(node('span', point.person)); if (point.isBaseline) item.append(node('small', 'Earlier changes were not recorded.')); track.append(item); }); content.append(track);
      } else {
        if (!Array.isArray(data[0]) || !Array.isArray(data[1]?.items)) throw new Error('The documents returned an invalid response.');
        const missing = data[1].items.filter(item => item.blocking && !item.complete);
        content.append(node('p', missing.length ? `Missing required information: ${missing.map(item => item.label).join(', ')}` : 'All required information is complete.', 'rd-preview-message'));
        if (!data[0].length) content.append(node('p', 'No documents have been uploaded.', 'rd-preview-message'));
        const list = node('ul', undefined, 'rd-documents');
        data[0].filter(file => !file.deletedAt && !file.DeletedAt && file.isDeleted !== true).forEach(file => { const item = node('li'); item.append(node('strong', file.fileName || 'Document')); item.append(node('span', `${file.requirementName || 'Attachment'} · ${label(file.scanStatus || 'unknown')}`));
          if (file.scanStatus === 'clean' && /^[0-9a-f-]{36}$/i.test(file.id)) { const link = node('a', 'Download'); link.href = `/api/pcns/${encodeURIComponent(summary.id)}/documents/${encodeURIComponent(file.id)}`; link.setAttribute('download', ''); item.append(link); }
          else item.append(node('small', 'Download unavailable until the document is clean.')); list.append(item); }); content.append(list);
      }
    }

    function renderDepartmentPreview(snapshot) {
      content.append(node('p', snapshot.nextAction.label, 'rd-preview-message'));
      const track = node('ol', undefined, 'rd-timeline rd-department-timeline'); track.setAttribute('aria-label', 'Signing departments');
      const details = node('section', undefined, 'rd-workflow-details'); details.id = 'rdWorkflowDetails'; details.setAttribute('aria-live', 'polite');
      const selected = snapshot.stages.find(stage => stage.state === 'current') || snapshot.stages.find(stage => stage.state !== 'completed') || snapshot.stages[0];
      let selectedKey = selected?.key;
      const points = new Map();
      const select = (key, focus = false) => {
        const stage = snapshot.stages.find(item => item.key === key); if (!stage) return;
        selectedKey = key; points.forEach((point, pointKey) => point.setAttribute('aria-pressed', String(pointKey === key)));
        details.replaceChildren(node('h3', `${stage.label} \u00b7 ${stage.completed}/${stage.total} signed`));
        details.append(node('p', workflowStageCaption(stage)));
        const table = node('table', undefined, 'rd-signatures'); const head = node('thead'); const headings = node('tr');
        ['Step', 'Status', 'Signed by', 'Date'].forEach(heading => headings.append(node('th', heading))); head.append(headings); table.append(head);
        const body = node('tbody');
        stage.steps.forEach(step => {
          const row = node('tr'); const waiting = stage.state === 'current' && !step.completed && step.label === stage.currentStep;
          [step.label, step.completed ? 'Signed' : waiting ? 'Waiting for signature' : 'Not signed', step.completed ? step.person || 'Not recorded' : '\u2014', step.completed ? step.signedAt || 'Not recorded' : '\u2014'].forEach(value => row.append(node('td', value)));
          if (waiting) row.className = 'is-current'; body.append(row);
        });
        table.append(body); const scroll = node('div', undefined, 'rd-signatures-scroll'); scroll.append(table); details.append(scroll);
        const point = points.get(key); if (focus) point?.focus({ preventScroll: true });
        if (point?.parentElement) track.scrollTo?.({ left: Math.max(0, point.parentElement.offsetLeft - track.offsetLeft - (track.clientWidth - point.clientWidth) / 2), behavior: 'auto' });
      };
      snapshot.stages.forEach(stage => {
        const item = node('li'); const point = button('', () => select(stage.key), `rd-department-point rd-stage-${stage.state}`); point.dataset.workflowStage = stage.key;
        point.setAttribute('aria-label', `${stage.label}, ${stage.completed}/${stage.total} signed, ${workflowStageCaption(stage)}`); point.setAttribute('aria-controls', details.id);
        point.append(node('span', workflowStageCaption(stage), 'rd-department-caption'));
        point.append(node('span', stage.state === 'completed' ? '\u2713' : stage.state === 'current' ? '\u2022' : '\u25cb', 'rd-timeline-point'));
        point.append(node('strong', `${stage.label} \u00b7 ${stage.completed}/${stage.total} signed`)); points.set(stage.key, point); item.append(point); track.append(item);
      });
      track.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !snapshot.stages.length) return;
        event.preventDefault(); const index = snapshot.stages.findIndex(stage => stage.key === selectedKey);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? snapshot.stages.length - 1 : Math.max(0, Math.min(snapshot.stages.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)));
        select(snapshot.stages[next].key, true);
      });
      content.append(track); content.append(details); select(selectedKey);
      if (!snapshot.stages.length) details.append(node('p', 'No signing departments apply to this PCN.'));
    }

    function finishPreview() {
      if (!preview.record) return;
      const { opener } = preview; preview = { record: null, tab: 'overview', request: preview.request + 1, cache: {}, opener: null }; content.replaceChildren(); title.textContent = ''; testBadge.hidden = true; options.onClose?.();
      (opener?.isConnected ? opener : search).focus?.({ preventScroll: true });
    }
    function closePreview() { if (dialog.open) dialog.close(); finishPreview(); }
    function clear() {
      state = { ...state, records: [] }; closeRowMenus(); rowMenus = []; closePreview(); rows.replaceChildren(); count.textContent = '0'; cards.replaceChildren(); footer.replaceChildren();
      ['status', 'risk', 'supplier', 'department'].forEach(key => updateOptions(refs[key], [], `All ${key === 'status' ? 'statuses' : `${key}s`}`, ''));
      chooser.open = false; viewEditor.open = false; toolbar.hidden = true;
    }
    return {
      setRecords(records) { if (!state.accessible) return; toolbar.hidden = false; state = { ...state, records: [...records] }; render(); }, clear,
      canRefresh: () => state.accessible && !dialog.open && !chooser.open && !viewEditor.open && !rowMenus.some(menu => menu.details.open) && !options.isBusy?.(),
      destroy() { document.removeEventListener?.('click', outsideRowMenu); state = { ...state, accessible: false }; clear(); toolbar.remove?.(); footer.remove?.(); dialog.remove?.(); },
      getState: () => ({ filters: { ...state.filters }, page: state.page, preferences: { ...state.preferences }, preview: preview.record?.id || null }),
    };
  }

  window.PCN_RECORDS_DASHBOARD = { create, filterRecords, summaryCounts, documentLabel, pendingLabel, sortRecords, paginate, csvCell, exportCsv, readPreferences, timelinePoints, timelineTone, currentSummary, currentProgress, workflowSummary, workflowStageCaption };
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    const workspace = document.getElementById('recordsWorkspace'); if (!workspace) return;
    const rows = document.getElementById('recordsRows'); const count = document.getElementById('recordsCount'); const message = document.getElementById('recordsMessage');
    const search = document.getElementById('recordsSearch'); const refresh = document.getElementById('recordsRefreshButton');
    let controller; let loading = false; let accessible = true; let fingerprint; let generation = 0;
    const accessLost = error => { accessible = false; generation++; controller?.clear(); workspace.hidden = true; const gate = document.getElementById('recordsGateError'); gate.textContent = error.message || 'Your access has changed. Reload the page to continue.'; gate.hidden = false; };
    const load = async ({ quiet = false, isCurrent = () => true } = {}) => {
      if (loading || !accessible) return; const requestGeneration = generation; loading = true; refresh.disabled = true; if (!quiet) message.textContent = 'Loading records…';
      const current = () => isCurrent() && requestGeneration === generation && accessible;
      try {
        const response = await window.PCN_SESSION.fetch('/api/pcns/overview'); if (!current()) return;
        if (!Array.isArray(response?.items)) throw new Error('The records list returned an invalid response.');
        const nextFingerprint = JSON.stringify(response.items);
        if (nextFingerprint !== fingerprint) { const focusKey = document.activeElement?.dataset?.rdFocus; const href = document.activeElement?.closest?.('a')?.getAttribute('href'); const scroll = { x: window.scrollX, y: window.scrollY }; fingerprint = nextFingerprint; controller.setRecords(response.items); if (!focusKey && href) Array.from(rows.querySelectorAll?.('a') || []).find(link => link.getAttribute('href') === href)?.focus({ preventScroll: true }); window.scrollTo?.(scroll.x, scroll.y); }
        message.textContent = `${response.items.length} PCN record${response.items.length === 1 ? '' : 's'} available.`;
      } catch (error) { if (!current()) return; if ([401, 403].includes(error.status)) accessLost(error); message.textContent = error.message; if (quiet) throw error; }
      finally { loading = false; refresh.disabled = false; }
    };
    try {
      const session = await window.PCN_SESSION.require(); if (!session) return;
      if (Array.isArray(session.user?.roles) && session.user.roles.length) { window.location.assign('/admin'); return; }
      if (!['employee-code', 'pcn-local'].includes(session.user?.identityProvider) || !session.user.employeeCode || session.user.isActive === false) throw new Error('Records access requires verified employee sign-in.');
      window.PCN_SESSION.mountProfile(session.user, error => { message.textContent = error.message; }); workspace.hidden = false;
      document.getElementById('recordsAccessMessage').textContent = 'You have read-only access. Select Open PCN to read the document, or Quick view for a summary.';
      controller = create({ root: workspace, rows, count, search, message, user: session.user, fetch: window.PCN_SESSION.fetch, onOpen: () => { generation++; }, onAccessLost: accessLost });
      refresh.addEventListener('click', () => load()); await load();
      window.PCN_AUTO_REFRESH?.start({ refresh: context => load({ ...context, quiet: true }), canRefresh: () => !loading && accessible && controller.canRefresh(), intervalMs: 5000 });
    } catch (error) { const gate = document.getElementById('recordsGateError'); gate.textContent = error.message; gate.hidden = false; }
  }
})();
