(function (root, factory) {
  const api = factory(root, typeof module === 'object' && module.exports ? require('./pcn-readiness') : root.PCN_READINESS);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PCN_CREATE_DOCUMENTS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, readiness) {
  'use strict';
  const maxBytes = 10 * 1024 * 1024;
  const types = { 'application/pdf': ['pdf'], 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'text/plain': ['txt'] };
  const activeFiles = files => (Array.isArray(files) ? files : []).filter(file => !file.deletedAt && !file.DeletedAt && file.isDeleted !== true);
  const fileCategory = file => file.requirementName || file.RequirementName || 'supporting';
  const fileStatus = file => file.scanStatus || file.ScanStatus;
  const recordKey = record => `${record?.id || ''}:${record?.version || ''}`;
  function validateFile(file) {
    const extensions = types[file?.type];
    if (!extensions || !extensions.includes(String(file.name || '').split('.').pop().toLowerCase())) {
      throw new Error('Choose a supported PDF, PNG, JPG, or text file.');
    }
    if (!Number.isFinite(file.size) || file.size <= 0 || file.size > maxBytes) throw new Error('Choose a nonempty file up to 10 MiB.');
    if (file.name.length > 255 || /[\\/\x00-\x1f]/.test(file.name)) throw new Error('Choose a file with a valid name.');
  }
  async function readFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let start = 0; start < bytes.length; start += 32768) binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
    return root.btoa(binary);
  }
  function mount(options) {
    const { container, getContext, api, autosave } = options;
    if (!container?.ownerDocument || typeof getContext !== 'function' || typeof api !== 'function' || typeof autosave?.exclusive !== 'function') {
      throw new Error('Document cards require a container, context, API client and autosave queue.');
    }
    const doc = container.ownerDocument;
    let destroyed = false;
    let busy = null;
    let cached = { key: '', files: [] };
    let errors = {};
    let refreshGeneration = 0;
    let displayedId = '';
    let controls = new Map();
    const endpoint = (record, suffix = '') => `/api/pcns/${encodeURIComponent(record.id)}${suffix ? `/${suffix}` : ''}`;
    const contextRecord = context => context.savedRecord || context.record || {};
    function element(tag, className, value) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (value !== undefined) node.textContent = String(value);
      return node;
    }
    function remember(node, key, cardKey) {
      node.dataset.documentControl = key;
      controls.set(key, { node, cardKey });
    }
    function editable(context = getContext()) {
      const status = String(contextRecord(context).status || 'draft').toLowerCase();
      return context.editable === true && status === 'draft' && !destroyed;
    }
    function filesFor(context) {
      const record = contextRecord(context);
      if (cached.key === recordKey(record) && cached.source === record.documentAttachments) return activeFiles(cached.files);
      if (Array.isArray(record.documentAttachments)) return activeFiles(record.documentAttachments);
      return cached.key === recordKey(record) ? activeFiles(cached.files) : [];
    }
    function report(error, key, title = 'Document update failed') {
      if (destroyed) return;
      const message = error?.message || 'The document could not be updated. Try again.';
      errors = { ...errors, [key]: message };
      options.notify?.('error', title, message);
    }
    function updateRequirement(key, value) {
      const context = getContext();
      if (!editable(context) || context.canSetRequirements !== true || busy) return;
      const record = context.record || {};
      if (record.internalReview?.docs?.[key] === value) return;
      options.onChange?.({ ...record, internalReview: { ...(record.internalReview || {}),
        docs: { ...(record.internalReview?.docs || {}), [key]: value } } });
      render();
    }
    function statusFor(files, required, key, context) {
      if (busy?.key === key) return busy.kind === 'remove' ? 'Removing' : context.scannerConfigured ? 'Uploading / Scanning' : 'Uploading';
      if (files.some(file => fileStatus(file) === 'clean')) return 'Ready';
      if (files.some(file => fileStatus(file) === 'pendingScan')) return context.scannerConfigured ? 'Awaiting scan' : 'Awaiting scan — scanning unavailable';
      if (files.some(file => fileStatus(file) === 'infected')) return 'Rejected';
      if (files.length || errors[key]) return 'Needs attention';
      return required ? 'Missing' : 'Optional';
    }
    function appendFile(card, file, context, cardKey) {
      const row = element('li', 'create-file');
      row.append(element('span', 'create-file-name', file.fileName || file.FileName || 'Document'));
      const scan = fileStatus(file);
      const status = scan === 'clean' ? 'Ready' : scan === 'pendingScan' ? 'Awaiting scan' : scan === 'infected' ? 'Rejected' : 'Needs attention';
      row.append(element('span', 'create-file-status', status));
      if (scan === 'clean') {
        const download = element('a', 'create-file-download', 'Download');
        download.href = endpoint(contextRecord(context), `documents/${encodeURIComponent(file.id || file.Id)}`);
        download.setAttribute('aria-label', `Download ${file.fileName || file.FileName || 'document'}`);
        remember(download, `download:${file.id || file.Id}`, cardKey);
        row.append(download);
      }
      const remove = element('button', 'create-file-remove', 'Remove');
      remove.type = 'button'; remove.disabled = !editable(context) || Boolean(busy);
      remove.setAttribute('aria-label', `Remove ${file.fileName || file.FileName || 'document'}`);
      remember(remove, `remove:${file.id || file.Id}`, cardKey);
      remove.addEventListener('click', () => mutate(fileCategory(file), 'remove', file));
      row.append(remove); card.append(row);
    }
    function appendRequirement(card, requirement, context) {
      const docs = context.record?.internalReview?.docs || {};
      const label = element('label', 'create-document-request');
      const checkbox = element('input');
      checkbox.type = 'checkbox'; checkbox.checked = docs[requirement.key] === true;
      checkbox.disabled = !editable(context) || context.canSetRequirements !== true || Boolean(busy);
      checkbox.setAttribute('aria-label', `${requirement.label}: Required document`);
      remember(checkbox, `required:${requirement.key}`, requirement.key);
      checkbox.addEventListener('change', () => updateRequirement(requirement.key, checkbox.checked));
      label.append(checkbox, element('span', '', 'Required document'));
      card.append(label);
      if (['supplierDocument', 'otherRequirement'].includes(requirement.key)) {
        const noteLabel = element('label', 'create-document-note');
        const input = element('input');
        input.type = 'text'; input.value = docs[`${requirement.key}Note`] || ''; input.maxLength = 2000;
        input.disabled = !editable(context) || context.canSetRequirements !== true || Boolean(busy);
        input.dataset.documentNote = `${requirement.key}Note`;
        input.setAttribute('aria-label', `${requirement.label} description`);
        input.addEventListener('input', () => updateRequirement(`${requirement.key}Note`, input.value));
        input.addEventListener('change', () => updateRequirement(`${requirement.key}Note`, input.value));
        remember(input, `note:${requirement.key}`, requirement.key);
        noteLabel.append(element('span', '', 'Description'), input); card.append(noteLabel);
      }
    }
    function appendPicker(card, key, title, context, requested) {
      const label = element('label', 'create-document-picker');
      label.append(element('span', '', 'Add file'));
      const input = element('input');
      input.type = 'file'; input.accept = '.pdf,.png,.jpg,.jpeg,.txt';
      input.disabled = !editable(context) || Boolean(busy) || !requested;
      input.setAttribute('aria-label', `Add file for ${title}`);
      remember(input, `picker:${key}`, key);
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (file) await mutate(key, 'upload', file);
        input.value = '';
      });
      label.append(input); card.append(label);
    }
    function renderCard(requirement, context, files) {
      const key = requirement.key;
      const required = key !== 'supporting' && context.record?.internalReview?.docs?.[key] === true;
      const matches = files.filter(file => [key, requirement.label].includes(fileCategory(file))
        || key === 'supporting' && !readiness.documentRequirements.some(item => [item.key, item.label].includes(fileCategory(file))));
      const card = element('section', 'create-document-card');
      card.dataset.requirement = key;
      card.setAttribute('tabindex', '-1');
      card.setAttribute('aria-label', requirement.label);
      remember(card, `card:${key}`, key);
      card.append(element('h3', 'create-document-title', requirement.label));
      if (key !== 'supporting') appendRequirement(card, requirement, context);
      const status = statusFor(matches, required, key, context);
      const statusNode = element('p', 'create-document-status', status);
      statusNode.setAttribute('role', 'status'); card.append(statusNode);
      if (matches.some(file => fileStatus(file) === 'pendingScan') && !context.scannerConfigured) {
        card.append(element('p', 'create-document-help', 'This file cannot satisfy a required document until a trusted malware scan is available. Ask the administrator for assistance.'));
      }
      if (errors[key]) { const error = element('p', 'create-document-error', errors[key]); error.setAttribute('role', 'alert'); card.append(error); }
      const list = element('ul', 'create-document-files');
      matches.forEach(file => appendFile(list, file, context, key)); card.append(list);
      appendPicker(card, key, requirement.label, context, required || key === 'supporting');
      return card;
    }
    function render() {
      if (destroyed) return;
      const context = getContext();
      const id = contextRecord(context).id || '';
      const active = doc.activeElement;
      const key = active?.dataset?.documentControl;
      const control = controls.get(key);
      const selection = control?.node === active && displayedId === id
        ? { key, cardKey: control.cardKey, start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection } : null;
      controls = new Map();
      if (displayedId !== id) { displayedId = id; errors = {}; }
      const files = filesFor(context);
      container.replaceChildren(element('p', 'create-document-limits', 'PDF, PNG, JPG or text. Up to 10 MiB per file, 20 files and 50 MiB total. Only files cleared by scanning are ready.'));
      if (!context.canSetRequirements) container.append(element('p', 'create-document-help', 'Document requirements are managed by the PCN review team.'));
      [...readiness.documentRequirements, { key: 'supporting', label: 'Other supporting files' }]
        .forEach(requirement => container.append(renderCard(requirement, context, files)));
      const candidate = selection && controls.get(selection.key)?.node;
      const replacement = candidate && !candidate.disabled ? candidate : selection && controls.get(`card:${selection.cardKey}`)?.node;
      if (replacement) {
        replacement.focus({ preventScroll: true });
        if (replacement === candidate && Number.isInteger(selection.start)) replacement.setSelectionRange(selection.start, selection.end, selection.direction);
      }
    }
    async function canonical(record) {
      const next = await api(endpoint(record));
      const files = await api(endpoint(record, 'documents'));
      return { ...next, documentAttachments: activeFiles(files) };
    }
    function stillCurrent(startId, record) {
      const current = contextRecord(getContext());
      return !destroyed && (!startId || current.id === startId) && (!current.id || current.id === record.id);
    }
    async function mutate(key, kind, file) {
      if (busy || !editable()) return;
      const startId = contextRecord(getContext()).id;
      try {
        if (kind === 'upload') validateFile(file);
        busy = { key, kind }; errors = { ...errors, [key]: '' }; render();
        const base64 = kind === 'upload' ? await (options.readFile || readFile)(file) : null;
        const result = await autosave.exclusive(async record => {
          if (!stillCurrent(startId, record) || !editable()) throw new Error('The selected draft has changed. Reload its documents.');
          if (record.status !== 'draft') throw new Error('Only an unsigned draft can change attachments.');
          const payload = kind === 'upload' ? { fileName: file.name, contentType: file.type, base64, version: record.version,
            ...(key === 'supporting' ? {} : { requirementName: key }) } : { version: record.version };
          const response = await api(endpoint(record, kind === 'upload' ? 'documents' : `documents/${encodeURIComponent(file.id || file.Id)}`),
            { method: kind === 'upload' ? 'POST' : 'DELETE', body: JSON.stringify(payload) });
          let next;
          try { next = await canonical(record); }
          catch (error) {
            if (!response?.version) throw error;
            const files = filesFor(getContext());
            next = { ...record, version: response.version, documentAttachments: kind === 'upload'
              ? [...files, response] : files.filter(item => (item.id || item.Id) !== (file.id || file.Id)) };
            if (stillCurrent(startId, record)) report(new Error('The file update was saved, but document details could not be refreshed. Reload the draft before continuing.'), key);
          }
          return { record: next };
        });
        if (stillCurrent(startId, result.record)) {
          cached = { key: recordKey(result.record), source: result.record.documentAttachments, files: result.record.documentAttachments || [] };
          options.onSaved?.(result.record);
        }
      } catch (error) { if (!destroyed && (!startId || contextRecord(getContext()).id === startId)) report(error, key); }
      finally { busy = null; render(); }
    }
    async function refresh() {
      if (destroyed) return;
      const record = contextRecord(getContext());
      const key = recordKey(record);
      const generation = ++refreshGeneration;
      render();
      if (!record.id) return;
      try {
        const files = await api(endpoint(record, 'documents'));
        if (destroyed || generation !== refreshGeneration || key !== recordKey(contextRecord(getContext()))) return;
        cached = { key, source: record.documentAttachments, files: activeFiles(files) };
        options.onAttachments?.(cached.files, { id: record.id, version: record.version });
        render();
      } catch (error) {
        if (!destroyed && generation === refreshGeneration && key === recordKey(contextRecord(getContext()))) {
          report(error, 'supporting', 'Documents could not be loaded'); render();
        }
      }
    }
    function focusRequirement(field) {
      const key = String(field || '').split('.').pop();
      const node = Array.from(container.children).find(child => child.dataset?.requirement === key);
      node?.focus();
    }
    render();
    return { render, refresh, focusRequirement, destroy() { destroyed = true; refreshGeneration += 1; } };
  }
  return { mount };
});
