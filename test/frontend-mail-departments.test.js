const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function routingPage() {
  const document = { activeElement: null, addEventListener() {} };
  function node(tag = 'div') {
    return { tagName: tag.toUpperCase(), children: [], dataset: {}, attributes: {}, events: {}, value: '', textContent: '', hidden: false, disabled: false, open: false,
      classList: { add() {}, remove() {} },
      get isConnected() { return this === document.body || Boolean(this.parentElement?.isConnected); },
      setAttribute(key, value) { this.attributes[key] = String(value); }, getAttribute(key) { return this.attributes[key] || null; }, removeAttribute(key) { delete this.attributes[key]; },
      append(...children) { children.forEach(child => { child.parentElement = this; this.children.push(child); }); }, appendChild(child) { this.append(child); },
      remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; },
      get innerHTML() { return ''; }, set innerHTML(_) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; },
      addEventListener(name, listener) { this.events[name] = listener; },
      matches(selector) { if (selector.startsWith('#')) return this.id === selector.slice(1); if (selector.startsWith('.')) return String(this.className || '').split(' ').includes(selector.slice(1));
        if (selector === '[data-department]') return Boolean(this.dataset.department);
        if (selector === '[data-notification-group]') return Boolean(this.dataset.notificationGroup);
        if (selector === '[data-recipient-email]') return this.dataset.recipientEmail === 'true';
        return this.tagName.toLowerCase() === selector;
      },
      closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); },
      querySelectorAll(selector) { const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]); return selector === '*' ? descendants : descendants.filter(child => selector.split(',').map(value => value.trim()).some(value => child.matches(value))); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      focus() { document.activeElement = this; }, showModal() { this.open = true; }, close() { this.open = false; }, setCustomValidity(value) { this.validationMessage = value; },
    };
  }
  document.createElement = node; document.body = node('body');
  const window = { location: { hash: '#mail-routing' }, clearTimeout() {}, setTimeout() {}, scrollX: 0, scrollY: 0, scrollTo() {} };
  const source = fs.readFileSync(require.resolve('../admin.js'), 'utf8').replace(/\}\)\(\);\s*$/, `
    showAdminNotice = () => {}; renderRecipientValidation = () => {}; renderLegacyContacts = () => {};
    appendRecipientRow = (list, recipient) => {
      const row = document.createElement('div'); row.className = 'notification-person';
      const input = document.createElement('input'); input.dataset.recipientEmail = 'true'; input.value = typeof recipient === 'string' ? recipient : recipient.email;
      const remove = document.createElement('button'); remove.className = 'notification-remove-button'; row.append(input, remove); list.append(row); return row;
    };
    createNotificationGroup = (group) => {
      const card = document.createElement('section'); card.dataset.notificationGroup = group.key; card.setAttribute('aria-label', group.label);
      const list = document.createElement('div'); list.className = 'notification-person-list'; card.append(list);
      group.recipients.forEach(recipient => appendRecipientRow(list, recipient)); return card;
    };
    window.TEST = {state, els, renderNotificationSettings, getMailRoutingPayload, preservePortalPosition,
      openDepartmentRecipientDialog: typeof openDepartmentRecipientDialog === 'function' ? openDepartmentRecipientDialog : undefined,
      changeRecipientRole: typeof changeRecipientRole === 'function' ? changeRecipientRole : undefined,
      updateRecipientDialog, confirmRecipientDialog, closeRecipientDialog, directorySelections, directoryLookupControllers};
  })();`);
  vm.runInNewContext(source, { window, document });
  const page = window.TEST;
  const ids = ['notificationGroups', 'notificationRecipientDialog', 'notificationRecipientRoleField', 'notificationRecipientRole', 'notificationRecipientTitle', 'notificationRecipientEditor', 'notificationRecipientList', 'notificationRecipientValidation', 'notificationRecipientConfirmButton', 'adminSearchInput'];
  ids.forEach(id => { const element = node(id === 'notificationRecipientRole' ? 'select' : 'div'); element.id = id; page.els[id] = element; document.body.append(element); });
  page.els.notificationRecipientDialog.append(page.els.notificationRecipientRoleField, page.els.notificationRecipientEditor);
  page.els.notificationRecipientRoleField.append(page.els.notificationRecipientRole);
  page.els.notificationRecipientEditor.append(page.els.notificationRecipientList);
  page.state.isLoading = false;
  page.state.notificationSettings = { schemaVersion: 2, version: 'a'.repeat(64), directoryConfigured: true,
    groups: ['gscTet', 'prodEngTet', 'qaTet', 'gscTapbu', 'qaTapbu'].flatMap(department => ['prepared', 'checked', 'approved'].map(action => ({
      key: `department.${department}.${action}`, label: `${department} ${action}`, action, recipients: [{ email: `${department}-${action}@example.test` }],
    }))).concat({ key: 'supplierNotification', label: 'Supplier Notification', action: null, recipients: [] }) };
  return { ...page, document, window };
}

test('each department has one header assignment control and collapsing preserves all saved mail groups', () => {
  const page = routingPage(); page.renderNotificationSettings();
  const departments = page.els.notificationGroups.querySelectorAll('[data-department]');
  assert.equal(departments.length, 5);
  for (const department of departments) {
    assert.equal(department.querySelectorAll('.notification-department-add').length, 1);
    assert.match(department.querySelector('.notification-department-add').getAttribute('aria-label'), /^Assign user to .* mail list$/);
    const toggle = department.querySelector('.notification-department-toggle');
    const body = department.querySelector('.notification-department-body');
    assert.equal(toggle.getAttribute('aria-controls'), body.id);
    toggle.events.click(); assert.equal(body.hidden, true); assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(department.querySelectorAll('[data-notification-group]').length, 3);
  }
  const payload = JSON.stringify(page.getMailRoutingPayload());
  assert.equal(JSON.parse(payload).groups.length, 16); assert.equal(page.state.hasMailChanges, false);
  page.renderNotificationSettings();
  assert.equal(JSON.stringify(page.getMailRoutingPayload()), payload);
  assert.ok(page.els.notificationGroups.querySelectorAll('.notification-department-body').every(body => body.hidden));
});

test('department recipient popup requires a role and clears verified selection and old lookup on role change', () => {
  const page = routingPage(); page.renderNotificationSettings();
  page.openDepartmentRecipientDialog('qaTet', 'QA/TET');
  assert.equal(page.state.recipientTargetKey, null);
  assert.equal(page.els.notificationRecipientRole.value, '');
  assert.equal(page.els.notificationRecipientConfirmButton.disabled, true);
  assert.equal(page.els.notificationRecipientList.querySelector('input').disabled, true);
  page.els.notificationRecipientRole.value = 'prepared'; page.changeRecipientRole();
  const previous = page.els.notificationRecipientList.querySelector('input');
  previous.value = 'chosen@example.test'; previous.dataset.directoryLookupState = 'verified';
  page.directorySelections.set(previous, { targetKey: 'department.qaTet.prepared', email: previous.value });
  let aborted = false; page.directoryLookupControllers.set(previous, { abort() { aborted = true; } });
  page.updateRecipientDialog(); assert.equal(page.els.notificationRecipientConfirmButton.disabled, false);
  page.els.notificationRecipientRole.value = 'checked'; page.changeRecipientRole();
  const current = page.els.notificationRecipientList.querySelector('input');
  assert.equal(aborted, true); assert.equal(page.directorySelections.has(previous), false);
  assert.equal(previous.isConnected, false); assert.notEqual(current, previous);
  assert.equal(current.value, ''); assert.equal(page.state.recipientTargetKey, 'department.qaTet.checked');
  assert.equal(page.els.notificationRecipientConfirmButton.disabled, true);
});

test('closing before a role is chosen clears department context and returns focus to header assignment', () => {
  const page = routingPage(); page.renderNotificationSettings();
  const department = page.els.notificationGroups.querySelectorAll('[data-department]')[0];
  const assign = department.querySelector('.notification-department-add');
  page.openDepartmentRecipientDialog('gscTet', 'GSC/TET'); page.closeRecipientDialog();
  assert.equal(page.state.recipientDepartment, null); assert.equal(page.state.recipientTargetKey, null);
  assert.equal(page.document.activeElement, assign);
});

test('a quiet routing repaint preserves focused department assignment and collapsed state', () => {
  const page = routingPage(); page.renderNotificationSettings();
  const department = page.els.notificationGroups.querySelectorAll('[data-department]')[0];
  department.querySelector('.notification-department-toggle').events.click();
  const assign = department.querySelector('.notification-department-add'); assign.focus();
  page.preservePortalPosition(page.renderNotificationSettings);
  assert.notEqual(page.document.activeElement, assign);
  assert.equal(page.document.activeElement.className.includes('notification-department-add'), true);
  assert.equal(page.els.notificationGroups.querySelector('.notification-department-body').hidden, true);
});

test('confirming a recipient expands its collapsed department while cancellation keeps it collapsed', () => {
  const page = routingPage(); page.renderNotificationSettings();
  const department = page.els.notificationGroups.querySelectorAll('[data-department]')[0];
  const toggle = department.querySelector('.notification-department-toggle'); const body = department.querySelector('.notification-department-body');
  toggle.events.click();
  page.openDepartmentRecipientDialog('gscTet', 'GSC/TET'); page.closeRecipientDialog();
  assert.equal(body.hidden, true, 'cancelling does not change the department');
  page.openDepartmentRecipientDialog('gscTet', 'GSC/TET');
  page.els.notificationRecipientRole.value = 'checked'; page.changeRecipientRole();
  const input = page.els.notificationRecipientList.querySelector('input');
  input.value = 'new-checker@example.test'; input.dataset.directoryLookupState = 'verified'; input.dataset.verifiedEmail = input.value;
  page.directorySelections.set(input, { targetKey: 'department.gscTet.checked', email: input.value, recipient: { email: input.value } });
  page.confirmRecipientDialog();
  assert.equal(body.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  const saved = page.getMailRoutingPayload().groups.find(group => group.key === 'department.gscTet.checked');
  assert.match(saved.emails, /new-checker@example.test/);
  page.renderNotificationSettings();
  assert.equal(page.els.notificationGroups.querySelector('.notification-department-body').hidden, false, 'the expanded state survives repaint');
});
