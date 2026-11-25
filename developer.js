(function (root, factory) {
  'use strict';
  const api = factory(typeof module === 'object' && module.exports ? require('./pcn-types') : root.PCN_TYPES);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.PCN_DEVELOPER_TOOLS = api;
    root.document.addEventListener('DOMContentLoaded', () => api.mount(root));
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (pcnTypes) {
  'use strict';
  const validPcn = value => pcnTypes.isCode(value);
  const tabNames = ['workflow', 'transactions', 'corrections', 'adminTools'];
  const correctionFields = Object.freeze({ supplierName: 'Supplier name', manufacturerName: 'Manufacturer', materialName: 'Material / chemical',
    desiredStart: 'Target start date or lot', sampleSubmitted: 'Sample submitted', sampleSubmittedDate: 'Sample submitted date',
    currentCondition: 'Current condition', newCondition: 'New condition', reason: 'Reason for change',
    identification: 'How to identify the changed material', sampleLocation: 'Sample location', priceLevel: 'Price level',
    selectedChange: 'Selected change', changeRows: 'Content of Changes' });
  function correctionChanges(original, edited) {
    return Object.fromEntries(Object.keys(correctionFields).filter(key => JSON.stringify(original[key]) !== JSON.stringify(edited[key]))
      .map(key => [key, edited[key]]));
  }
  function editCorrectionRow(record, index, field, value) {
    if (!['text', 'currentCondition', 'newCondition'].includes(field) || !record.changeRows?.[index]) throw new Error('Invalid change row');
    const previous = record.changeRows[index];
    const selected = record.selectedChange === previous.text && (!record.riskLevel || record.riskLevel === previous.risk);
    return { ...record, ...(selected ? { [field === 'text' ? 'selectedChange' : field]: value } : {}),
      changeRows: record.changeRows.map((row, at) => at === index ? { ...row, [field]: value } : row) };
  }
  function editCorrectionField(record, field, value) {
    const next = { ...record, [field]: value };
    if (!['currentCondition', 'newCondition'].includes(field)) return next;
    return { ...next, changeRows: (record.changeRows || []).map(row => row.text === record.selectedChange
      && (!record.riskLevel || row.risk === record.riskLevel) ? { ...row, [field]: value } : row) };
  }
  function correctionPreview(entries) {
    return entries.map(({ original, edited }) => {
      const changes = correctionChanges(original, edited);
      return { id: original.id, version: original.version, changes,
        fields: Object.keys(changes).map(key => ({ key, label: correctionFields[key], before: original[key], after: changes[key] })) };
    }).filter(item => item.fields.length);
  }
  function correctedAfterSigning(record) {
    const checked = path => {
      const value = path.split('.').reduce((at, key) => at?.[key], record.internalReview);
      return value === true || value?.checked === true;
    };
    const control = record.documentControl || {};
    const marked = new Set(control.correctedSignatures || control.lastDeveloperCorrection?.retainedSignatures || []);
    return [...new Set([...marked, ...Object.keys(control.signatureBindings || {})])].some(path => {
      if (!checked(path)) return false;
      const hash = control.signatureBindings?.[path]?.contentHash;
      return hash && control.contentHash ? hash !== control.contentHash : marked.has(path);
    });
  }
  function isDeveloper(user) {
    return Boolean(user?.isActive === true && Array.isArray(user.roles) && user.roles.length === 1
      && typeof user.roles[0] === 'string' && user.roles[0].toLowerCase() === 'developer'
      && user.department === 'developer' && user.signingStep == null);
  }
  function requestedPcn(search) {
    const ids = new URLSearchParams(search).getAll('pcn');
    return ids.length === 1 && validPcn(ids[0]) ? ids[0] : '';
  }
  function displayValue(value) {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }
  function humanLabel(key) {
    const labels = { text: 'Change', optionText: 'Change category', risk: 'Risk', riskLevel: 'Risk level',
      currentCondition: 'Current condition', newCondition: 'New condition', selectedChange: 'Change',
      displayName: 'Name', createdAt: 'Created at', updatedAt: 'Updated at' };
    if (Object.hasOwn(labels, key)) return labels[key];
    const words = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
    return `${words.charAt(0).toUpperCase()}${words.slice(1)} (${key})`;
  }
  function readableValue(value, path = '') {
    if (value === undefined) return 'Not recorded';
    if (value === null) return 'Not set';
    if (value === '') return 'Empty value';
    if (typeof value === 'boolean') {
      const signature = /(?:^|\.)(?:prepared|checked|approved)$/.test(path);
      return signature ? value ? 'Signed' : 'Not signed' : value ? 'Yes' : 'No';
    }
    if (Array.isArray(value)) {
      if (!value.length) return 'Empty list';
      return value.map((item, index) => `Item ${index + 1}\n${readableValue(item, `${path}.${index}`)}`).join('\n\n');
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value);
      if (!entries.length) return 'Empty object';
      return entries.map(([key, item]) => {
        const content = readableValue(item, `${path}.${key}`);
        return `${humanLabel(key)}:${content.includes('\n') ? '\n' : ' '}${content}`;
      }).join('\n');
    }
    return String(value);
  }
  function valuePresentation(value) {
    const full = String(value);
    const expandable = full.length > 240 || full.split('\n').length > 4;
    const preview = expandable ? `${full.split('\n').slice(0, 3).join('\n').slice(0, 200)}…` : full;
    return { full, preview, expandable };
  }
  function flattenTransactions(items) {
    return (Array.isArray(items) ? items : []).flatMap((item, index) => {
      const common = { revision: item.revision, contentRevision: item.contentRevision,
        actor: item.actor || 'Unknown user', actorReference: item.actorReference || '',
        createdAt: item.createdAt || '', status: item.status || '', order: index };
      if (item.isBaseline) return [{ ...common, path: '', label: 'History baseline', before: '—', after: 'Earlier field changes are unavailable.' }];
      if (!item.changes?.length) return [{ ...common, path: '', label: 'Saved', before: '—', after: 'No document field changes recorded.' }];
      return item.changes.map(change => ({ ...common, path: change.path || '', label: change.label || change.path || 'Document',
        before: readableValue(change.before, change.path), after: readableValue(change.after, change.path),
        searchText: JSON.stringify([change.before, change.after]) }));
    }).sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)
      || Number(b.revision || 0) - Number(a.revision || 0) || a.order - b.order);
  }
  function filterTransactions(rows, { query = '', from = '', to = '' } = {}) {
    const text = String(query).trim().toLowerCase();
    return rows.filter(row => {
      const date = /^\d{4}-\d{2}-\d{2}/.exec(row.createdAt)?.[0] || '';
      return (!from || date >= from) && (!to || date <= to)
        && (!text || [row.actor, row.actorReference, row.label, row.path, row.before, row.after, row.revision, row.searchText]
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
  function mountCorrections(root, hooks) {
    const { el, node, deny, changed } = hooks;
    const state = { choices: [], selected: new Set(), entries: [], loadedSelection: [], stage: 'select', generation: 0, busy: false, active: false, pending: null, unsign: null };
    const fetch = (url, options) => root.PCN_SESSION.fetch(url, options);
    const message = text => { el('correctionResults').textContent = text; };
    const hasPendingEdits = () => state.entries.length > 0 && (correctionPreview(state.entries).length > 0 || Boolean(el('correctionReason').value.trim()));
    const sameSelection = () => state.entries.length > 0 && state.entries.length === state.selected.size && state.entries.every(entry => state.selected.has(entry.original.id));
    const canResume = () => state.entries.length > 0 && state.loadedSelection.length === state.selected.size && state.loadedSelection.every(id => state.selected.has(id));
    function updateProgress() {
      const changed = correctionPreview(state.entries).length, reason = el('correctionReason').value.trim();
      const selectionText = `${state.selected.size} selected`;
      if (el('correctionSelectionCount').textContent !== selectionText) el('correctionSelectionCount').textContent = selectionText;
      el('correctionLoadedSummary').textContent = `${state.entries.length} document${state.entries.length === 1 ? '' : 's'} loaded`;
      const changedText = `${changed} document${changed === 1 ? '' : 's'} changed`;
      if (el('correctionChangeCount').textContent !== changedText) el('correctionChangeCount').textContent = changedText;
      el('loadCorrections').disabled = state.busy || !state.active || !state.selected.size;
      el('previewCorrections').disabled = state.busy || !state.active || !changed || !reason;
      el('setSharedCorrection').disabled = state.busy || !state.active || !state.entries.length;
      el('resumeCorrectionEditing').hidden = !canResume();
      el('resumeCorrectionEditing').disabled = state.busy;
      el('changeCorrectionSelection').disabled = state.busy;
      el('discardCorrections').hidden = !hasPendingEdits(); el('discardCorrections').disabled = state.busy;
      el('correctionSelectionHelp').hidden = !hasPendingEdits();
      el('correctionReviewHint').textContent = !changed ? 'Change at least one field to review.' : !reason ? 'Enter a reason to review your changes.' : 'Ready to review. Signatures stay in place.';
      for (const entry of state.entries) if (entry.summaryNode) {
        const count = Object.keys(correctionChanges(entry.original, entry.edited)).length;
        const text = `${entry.original.id} · ${String(entry.original.documentType || 'Legacy').toUpperCase()} · ${String(entry.original.status).replace(/_/g, ' ')} · ${count ? `${count} field${count === 1 ? '' : 's'} changed` : 'No changes'}`;
        if (entry.summaryNode.textContent !== text) entry.summaryNode.textContent = text;
      }
    }
    function step(name) {
      for (const [id, value] of [['correctionStepSelect','select'],['correctionStepEdit','edit'],['correctionStepReview','review']]) el(id).setAttribute('aria-current', name === value ? 'step' : 'false');
    }
    function focusVisible(target) {
      target?.focus();
      const bounds = target?.getBoundingClientRect?.(), header = root.document.querySelector?.('.developer-topbar')?.getBoundingClientRect();
      if (bounds && header && bounds.top < header.bottom + 12) root.scrollBy?.(0, bounds.top - header.bottom - 12);
    }
    function stage(name, focus = false) {
      state.stage = name;
      el('correctionSelectionStage').hidden = name !== 'select'; el('correctionEditStage').hidden = name !== 'edit';
      step(name);
      renderChoices(); updateProgress();
      if (focus) focusVisible(el(name === 'select' ? 'correctionSelectionHeading' : 'correctionEditHeading'));
    }
    function busy(value) {
      state.busy = value;
      for (const id of ['correctionsControls', 'correctionPreviewDialog', 'unsignDialog']) {
        el(id).setAttribute('aria-busy', String(value));
        el(id).querySelectorAll?.('input,textarea,select,button').forEach(control => { control.disabled = value; });
      }
      updateProgress();
      if (!value && state.stage === 'select') renderChoices();
    }
    function renderChoices() {
      const query = el('correctionSearch').value.trim().toLowerCase();
      el('correctionChoices').replaceChildren();
      const matches = state.choices.filter(item => !query || [item.id, item.supplierName, item.materialName]
        .some(value => String(value || '').toLowerCase().includes(query)) || state.selected.has(item.id));
      if (!matches.length) el('correctionChoices').appendChild(node('p', 'No documents match your search.', 'developer-correction-help'));
      for (const record of matches) {
        const label = node('label', undefined, 'developer-correction-choice'), check = node('input');
        check.type = 'checkbox'; check.value = record.id; check.checked = state.selected.has(record.id); check.disabled = state.busy || hasPendingEdits();
        check.addEventListener('change', () => {
          if (state.busy) return;
          if (hasPendingEdits()) { check.checked = state.selected.has(record.id); message('Your edits are kept. Discard edits before choosing different documents.'); return; }
          if (check.checked && state.selected.size >= 20) { check.checked = false; message('Select up to 20 documents.'); return; }
          check.checked ? state.selected.add(record.id) : state.selected.delete(record.id);
          ++state.generation;
          updateProgress();
        });
        const identity = node('span', undefined, 'developer-correction-identity'), type = pcnTypes.typeOf(record);
        identity.appendChild(node('strong', record.id)); identity.appendChild(node('span', type?.toUpperCase() || 'Legacy', 'developer-correction-type'));
        const description = node('span', undefined, 'developer-correction-description');
        description.appendChild(node('strong', record.supplierName || 'No supplier')); description.appendChild(node('small', record.materialName || 'No material entered'));
        label.appendChild(check); label.appendChild(identity); label.appendChild(description);
        label.appendChild(node('span', String(record.status || 'Not recorded').replace(/_/g, ' '), 'developer-correction-status'));
        el('correctionChoices').appendChild(label);
      }
    }
    function editor(labelText, value, onInput, options = {}) {
      const label = node('label', labelText), input = node(options.values ? 'select' : options.single ? 'input' : 'textarea');
      if (options.values) for (const value of options.values) {
        const option = node('option', value); option.value = value; input.appendChild(option);
      }
      input.value = value ?? ''; input.maxLength = options.max || 2000;
      if (!options.values && !options.single) input.rows = 2;
      if (options.key) input.setAttribute('data-correction-field', options.key);
      if (options.row !== undefined) input.setAttribute('data-correction-row', String(options.row));
      input.addEventListener(options.values ? 'change' : 'input', () => { onInput(input.value); updateProgress(); });
      label.appendChild(input); return label;
    }
    function renderEntry(entry, entryIndex) {
      const { original } = entry;
      const section = node('details', undefined, 'developer-correction-document'); section.open = entryIndex === 0;
      section.setAttribute('data-pcn-id', original.id);
      entry.summaryNode = node('summary'); section.appendChild(entry.summaryNode);
      if (entry.correctionNotice) section.appendChild(node('p', 'Corrected after signing. Retained signatures refer to earlier content.', 'developer-correction-notice'));
      function group(key, title, open = false) {
        const details = node('details', undefined, `developer-correction-group${key === 'signatures' ? ' developer-correction-danger' : ''}`);
        details.setAttribute('data-correction-group', key); details.open = open; details.appendChild(node('summary', title)); return details;
      }
      function addFields(parent, keys) {
        const fields = node('div', undefined, 'developer-correction-fields');
        for (const key of keys) {
        const values = key === 'sampleSubmitted' ? ['yes', 'no', 'pending'] : key === 'priceLevel' ? ['no-change', 'decreasing', 'increasing'] : null;
        fields.appendChild(editor(correctionFields[key], entry.edited[key], value => { entry.edited = editCorrectionField(entry.edited, key, value); },
          { key, values, single: ['supplierName', 'manufacturerName', 'materialName', 'desiredStart', 'sampleSubmittedDate', 'sampleLocation'].includes(key) }));
        }
        parent.appendChild(fields);
      }
      function changeRow(row, index) {
        const rowFields = node('fieldset', undefined, 'developer-correction-row'); rowFields.appendChild(node('legend', `${row.risk} · ${row.optionText}`));
        for (const key of ['text', 'currentCondition', 'newCondition']) rowFields.appendChild(editor(
          key === 'text' ? 'Content of Changes' : correctionFields[key], row[key], value => { entry.edited = editCorrectionRow(entry.edited, index, key, value); }, { key, row: index, max: key === 'text' ? 500 : 2000 }));
        return rowFields;
      }
      const content = group('content', 'Content of Changes', true), rows = entry.edited.changeRows || [];
      let selected = rows.findIndex(row => row.text === entry.edited.selectedChange && (!entry.edited.riskLevel || row.risk === entry.edited.riskLevel));
      if (selected < 0 && rows.length) selected = 0;
      if (selected >= 0) content.appendChild(changeRow(rows[selected], selected));
      else addFields(content, ['currentCondition', 'newCondition']);
      if (rows.length > 1) {
        const others = group('otherChanges', `Other change items (${rows.length - 1})`);
        rows.forEach((row,index) => { if(index !== selected) others.appendChild(changeRow(row,index)); }); content.appendChild(others);
      }
      section.appendChild(content);
      const supplier = group('supplier', 'Supplier details'); addFields(supplier, ['supplierName', 'manufacturerName', 'materialName']); section.appendChild(supplier);
      const additional = group('additional', 'Additional information');
      addFields(additional, ['desiredStart', 'sampleSubmitted', 'sampleSubmittedDate', 'reason', 'identification', 'sampleLocation', 'priceLevel']); section.appendChild(additional);
      const signatures = group('signatures', `Signature management (${entry.signatures.length})`);
      if (entry.signatures.length) {
        const removal = node('div', undefined, 'developer-correction-unsign'), label = node('label', 'Signed step'), select = node('select');
        select.setAttribute('data-unsign-select', '');
        for (const signature of entry.signatures) { const option = node('option', signature.label); option.value = signature.path; select.appendChild(option); }
        label.appendChild(select); removal.appendChild(label);
        const button = node('button', 'Remove signature…', 'developer-button'); button.type = 'button'; button.setAttribute('data-unsign-preview', '');
        button.addEventListener('click', () => previewUnsign(entry, select.value, button)); removal.appendChild(button); signatures.appendChild(removal);
      } else signatures.appendChild(node('p', 'No signatures recorded.', 'developer-correction-help'));
      section.appendChild(signatures);
      return section;
    }
    function renderEditors() {
      el('correctionEditors').replaceChildren();
      state.entries.forEach((entry,index) => el('correctionEditors').appendChild(renderEntry(entry,index))); updateProgress();
    }
    async function loadSelected() {
      if (state.busy || !state.active) return;
      if (!state.selected.size) { message('Select at least one document.'); return; }
      if (sameSelection() || hasPendingEdits() && canResume()) { stage('edit',true); return; }
      if (hasPendingEdits()) { message('Your edits are kept. Discard edits before loading different documents.'); return; }
      const generation = ++state.generation, ids = [...state.selected]; busy(true); message('Loading selected documents…');
      try {
        const results = await Promise.allSettled(ids.map(id => fetch(`/api/developer/pcns/${encodeURIComponent(id)}/correction`)));
        if (generation !== state.generation) return;
        const entries = [], errors = [];
        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            if ([401, 403].includes(result.reason.status)) throw result.reason;
            errors.push(`${ids[index]}: ${result.reason.message || 'Could not load document.'}`); return;
          }
          const data = result.value;
          if (data?.record?.id !== ids[index]) { errors.push(`${ids[index]}: The server returned a different document.`); return; }
          entries.push({ original: data.record, edited: structuredClone(data.record), signatures: data.signatures || [], correctionNotice: data.correctionNotice });
        });
        state.entries = entries; state.loadedSelection = ids; renderEditors(); stage(entries.length ? 'edit' : 'select', true);
        message(errors.length ? errors.join('\n') : '');
      } catch (error) { if ([401, 403].includes(error.status)) deny(); else message(error.message); }
      finally { if (generation === state.generation) busy(false); }
    }
    function close(dialog, focus) { dialog.close(); step(state.stage); focusVisible(focus); }
    function preview() {
      if (state.busy || !state.active) return;
      const reason = el('correctionReason').value.trim(), items = correctionPreview(state.entries);
      if (!reason) { message('Enter a reason for the audit history.'); el('correctionReason').focus(); return; }
      if (!items.length) { message('Change at least one document field first.'); return; }
      state.pending = { reason, items };
      el('correctionPreviewReason').textContent = `Audit reason: ${reason}`; el('correctionPreviewChanges').replaceChildren();
      for (const item of items) {
        const section = node('section'); section.appendChild(node('h3', item.id));
        for (const field of item.fields) {
          const block = node('div', undefined, 'developer-correction-diff'); block.appendChild(node('h4', field.label));
          block.appendChild(node('p', `Before: ${readableValue(field.before)}`)); block.appendChild(node('p', `After: ${readableValue(field.after)}`)); section.appendChild(block);
        }
        el('correctionPreviewChanges').appendChild(section);
      }
      step('review'); el('correctionPreviewDialog').showModal(); el('cancelCorrectionPreview').focus();
    }
    async function apply() {
      if (state.busy || !state.active || !state.pending) return;
      const pending = state.pending; busy(true);
      try {
        const response = await fetch('/api/developer/pcns/corrections', { method: 'POST', body: JSON.stringify({ reason: pending.reason,
          items: pending.items.map(({ id, version, changes }) => ({ id, version, changes })) }) });
        if (!state.active) return;
        if (!Array.isArray(response?.results)) throw new Error('The save result is unavailable. Reload these documents and check audit history before trying again.');
        const results = new Map(response.results.map(result => [result.id, result])), output = [];
        for (const item of pending.items) {
          const result = results.get(item.id), entry = state.entries.find(entry => entry.original.id === item.id);
          if (result?.success && entry) {
            entry.original = { ...structuredClone(entry.edited), version: result.version }; entry.edited = structuredClone(entry.original);
            if (result.changed !== false) entry.correctionNotice = entry.signatures.length
              ? { retainedSignatures: entry.signatures.map(signature => signature.path) } : null;
            output.push(`${item.id}: ${result.changed === false ? 'No change needed.' : 'Saved. Signatures retained.'}`);
          } else output.push(`${item.id}: ${result?.error || 'Result unavailable; check audit history before retrying.'}${result?.status === 409 ? ' Your edits are kept. Discard edits and load the latest version to review the conflict.' : ''}`);
        }
        if (!correctionPreview(state.entries).length) el('correctionReason').value = '';
        message(output.join('\n')); renderEditors(); state.pending = null; busy(false);
        close(el('correctionPreviewDialog'), el('correctionResults')); changed();
      } catch (error) {
        if ([401, 403].includes(error.status)) deny();
        else { message(`${error.message || 'Could not save corrections.'} Your edits are kept.`); busy(false); close(el('correctionPreviewDialog'), el('previewCorrections')); }
      } finally { busy(false); }
    }
    function previewUnsign(entry, path, opener) {
      if (state.busy || !state.active) return;
      if (correctionPreview([entry]).length) { message('Apply or discard this document’s content edits before removing signatures.'); return; }
      const signature = entry.signatures.find(item => item.path === path); if (!signature) return;
      state.unsign = { entry, signature, opener };
      el('unsignImpact').replaceChildren(node('p', `${entry.original.id}: ${signature.label}`));
      const list = node('ul');
      for (const cleared of signature.clears || [path]) list.appendChild(node('li', entry.signatures.find(item => item.path === cleared)?.label || cleared));
      el('unsignImpact').appendChild(node('p', 'This removes the selected signature and these later sign-offs:')); el('unsignImpact').appendChild(list);
      if (signature.reopens) el('unsignImpact').appendChild(node('p', 'This completed document will reopen for review.', 'developer-correction-notice'));
      el('unsignReason').value = ''; el('unsignDialog').showModal(); el('unsignReason').focus();
    }
    async function unsign() {
      if (state.busy || !state.active || !state.unsign) return;
      const reason = el('unsignReason').value.trim(); if (!reason) { el('unsignReason').focus(); return; }
      const { entry, signature } = state.unsign; busy(true);
      try {
        const result = await fetch(`/api/developer/pcns/${encodeURIComponent(entry.original.id)}/unsign`, { method: 'POST',
          body: JSON.stringify({ version: entry.original.version, reason, path: signature.path }) });
        if (!state.active) return;
        if (result?.id !== entry.original.id || !Array.isArray(result.cleared) || !result.version) throw new Error('The removal result is unavailable. Check audit history before making another change.');
        entry.original = { ...entry.original, version: result.version, status: result.status }; entry.edited = structuredClone(entry.original);
        entry.signatures = entry.signatures.filter(item => !result.cleared.includes(item.path)).map(item => ({ ...item, reopens: false,
          clears: item.clears.filter(path => !result.cleared.includes(path)) }));
        if (entry.correctionNotice) {
          const retainedSignatures = (entry.correctionNotice.retainedSignatures || []).filter(path => !result.cleared.includes(path));
          entry.correctionNotice = retainedSignatures.length ? { ...entry.correctionNotice, retainedSignatures } : null;
        }
        renderEditors(); message(`${entry.original.id}: removed ${result.cleared.length} signatures.${result.reopened ? ' Document reopened for review.' : ''}`); busy(false);
        close(el('unsignDialog'), entry.summaryNode); state.unsign = null; changed();
      } catch (error) { if ([401, 403].includes(error.status)) deny(); else message(`${error.message || 'Could not remove signatures.'} Reload to verify the current signatures before retrying.`); }
      finally { busy(false); }
    }
    el('correctionSearch').addEventListener('input', renderChoices);
    el('loadCorrections').addEventListener('click', loadSelected);
    el('changeCorrectionSelection').addEventListener('click', () => { if (!state.busy) stage('select',true); });
    el('resumeCorrectionEditing').addEventListener('click', () => { if (!state.busy && canResume()) stage('edit',true); });
    el('correctionReason').addEventListener('input', updateProgress);
    el('discardCorrections').addEventListener('click', () => {
      if (state.busy) return; ++state.generation; state.entries = []; state.loadedSelection = []; state.pending = null; el('correctionReason').value = '';
      renderEditors(); stage('select',true); message('Edits discarded. Select documents to edit.');
    });
    for (const key of Object.keys(correctionFields).filter(key => !['selectedChange', 'changeRows', 'sampleSubmitted', 'priceLevel'].includes(key))) {
      const option = node('option', correctionFields[key]); option.value = key; el('sharedCorrectionField').appendChild(option);
    }
    el('setSharedCorrection').addEventListener('click', () => {
      if (state.busy) return;
      const key = el('sharedCorrectionField').value;
      if (!Object.hasOwn(correctionFields, key) || ['selectedChange', 'changeRows', 'sampleSubmitted', 'priceLevel'].includes(key)) return;
      state.entries.forEach(entry => { entry.edited = editCorrectionField(entry.edited, key, el('sharedCorrectionValue').value); }); renderEditors(); message(`Value set on ${state.entries.length} loaded documents. Preview to save.`);
    });
    el('previewCorrections').addEventListener('click', preview); el('applyCorrections').addEventListener('click', apply);
    el('cancelCorrectionPreview').addEventListener('click', () => { if (!state.busy) close(el('correctionPreviewDialog'), el('previewCorrections')); });
    el('confirmUnsign').addEventListener('click', unsign);
    el('cancelUnsign').addEventListener('click', () => { if (!state.busy) close(el('unsignDialog'), state.unsign?.opener); });
    for (const id of ['correctionPreviewDialog', 'unsignDialog']) {
      el(id).addEventListener('cancel', event => { if (state.busy) event.preventDefault(); else step(state.stage); });
      el(id).addEventListener('close', () => step(state.stage));
    }
    stage('select');
    return { state, loadSelected, setChoices(choices) { state.active = true; state.choices = choices; renderChoices(); updateProgress(); },
      clear() { ++state.generation; state.active = false; state.entries = []; state.loadedSelection = []; state.choices = []; state.selected.clear(); state.pending = null; state.unsign = null; renderChoices(); renderEditors();
        el('correctionReason').value = ''; stage('select');
        for (const id of ['correctionPreviewDialog', 'unsignDialog']) if (el(id).open) el(id).close(); } };
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
    const corrections = mountCorrections(root, { el, node, deny: denyAccess,
      changed: () => { if (state.selected) loadDetails(state.selected); } });
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
      corrections.clear();
      state.authorized = false;
      ++state.detailGeneration; ++state.listGeneration;
      state.list = []; state.selected = '';
      clearDetails('Developer access required.'); renderChoices();
      lock(true); el('developerMain').hidden = true;
      status('Developer access required. Sign in with an active Developer account and reload this page.', true);
    }
    function valueCell(value) {
      const cell = node('td', undefined, 'developer-value');
      const content = valuePresentation(displayValue(value));
      cell.appendChild(node('p', content.preview, 'developer-value-preview'));
      if (content.expandable) {
        const details = node('details', undefined, 'developer-value-details');
        details.appendChild(node('summary', 'Show full value'));
        details.appendChild(node('div', content.full, 'developer-value-full'));
        cell.appendChild(details);
      }
      return cell;
    }
    function actorCell(item) {
      const cell = node('td', undefined, 'developer-actor');
      cell.appendChild(node('strong', item.actor));
      if (item.actorReference && item.actorReference !== item.actor) {
        const details = node('details', undefined, 'developer-reference');
        details.appendChild(node('summary', 'User reference'));
        details.appendChild(node('div', item.actorReference, 'developer-reference-value'));
        cell.appendChild(details);
      }
      return cell;
    }
    function dateCell(value) {
      const cell = node('td', undefined, 'developer-time');
      const time = Date.parse(value);
      if (!Number.isFinite(time)) { cell.textContent = 'Not recorded'; return cell; }
      const date = new Date(time);
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      cell.appendChild(node('span', `${String(date.getUTCDate()).padStart(2, '0')} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`, 'developer-time-date'));
      cell.appendChild(node('span', `${date.toISOString().slice(11, 19)} UTC`, 'developer-time-clock'));
      return cell;
    }
    function revisionCell(item) {
      const cell = node('td', undefined, 'developer-revision');
      cell.appendChild(node('span', `Save ${displayValue(item.revision)}`, 'developer-save-badge'));
      if (item.contentRevision !== undefined && item.contentRevision !== null) cell.appendChild(node('span', `Document ${item.contentRevision}`, 'developer-document-revision'));
      return cell;
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
        row.appendChild(dateCell(item.createdAt)); row.appendChild(actorCell(item)); row.appendChild(revisionCell(item));
        row.appendChild(node('td', item.label, 'developer-field'));
        row.appendChild(valueCell(item.before)); row.appendChild(valueCell(item.after));
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
        state.list = (Array.isArray(data?.items) ? data.items : []).filter(item => validPcn(item.id));
        corrections.setChoices(state.list);
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
      el('developerPcnPicker').hidden = ['adminTools', 'corrections'].includes(target);
      el('refreshDeveloper').hidden = ['adminTools', 'corrections'].includes(target);
      for (const name of tabNames) {
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
      for (const [index, name] of tabNames.entries()) {
        el(`${name}Tab`).addEventListener('click', () => chooseTab(name));
        el(`${name}Tab`).addEventListener('keydown', event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const target = event.key === 'Home' ? 0 : event.key === 'End' ? tabNames.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabNames.length) % tabNames.length;
          chooseTab(tabNames[target], true);
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
      if (root.location.hash === '#corrections' && state.authorized) {
        chooseTab('corrections');
        const id = requestedPcn(root.location.search);
        if (id && state.list.some(record => record.id === id)) {
          corrections.state.selected.add(id); corrections.setChoices(state.list);
          el('correctionSelectionCount').textContent = '1 selected'; await corrections.loadSelected();
        }
      }
    } catch (error) {
      el('developerMain').hidden = true;
      status(error.message || 'Developer access could not be verified. Reload to try again.', true);
    }
    return { refresh, loadDetails, state, corrections };
  }
  return { isDeveloper, requestedPcn, readableValue, valuePresentation, flattenTransactions, filterTransactions, pageTransactions,
    correctionChanges, editCorrectionRow, editCorrectionField, correctionPreview, correctedAfterSigning, mount };
});
