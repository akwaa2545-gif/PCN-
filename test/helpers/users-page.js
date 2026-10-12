const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const employee = { employeeCode: '001234', displayName: 'Employee', email: null, sourceDepartment: 'ORG001', jobTitle: 'Engineer', isActive: true };
const verifiedMail = { id: 'mail-id', email: 'person@example.test', displayName: 'Employee' };
async function usersPage(assignedUsers = [], options = {}) {
  let init;
  const elements = new Map();
  const pendingTimers = new Map();
  const calls = [];
  const confirmations = [];
  const windowEvents = {};
  let autoRefresh;
  const document = {
    activeElement: null,
    getElementById: element, createElement,
    addEventListener(name, handler) { if (name === 'DOMContentLoaded') init = handler; }
  };
  function setConnected(node, connected) {
    node.isConnected = connected;
    node.children.forEach(child => setConnected(child, connected));
  }
  function createElement(tagName = 'div') {
    return {
      value: '', hidden: true, disabled: false, required: false, open: false, isConnected: false, tagName: tagName.toUpperCase(), textContent: '', innerHTML: '', children: [], events: {}, options: [], attributes: {},
      addEventListener(name, handler) { this.events[name] = handler; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return this.attributes[name] ?? null; },
      focus() { if (this.isConnected) { this.focused = true; document.activeElement = this; } },
      scrollIntoView() { this.scrolledIntoView = true; },
      showModal() { this.open = true; },
      close() { this.open = false; this.events.close?.(); },
      getBoundingClientRect() { return { left: 100, right: 500, top: 100, bottom: 600 }; },
      replaceChildren() { this.children.forEach(child => setConnected(child, false)); this.children = []; },
      appendChild(child) { this.children.push(child); setConnected(child, this.isConnected); },
      querySelectorAll(selector) {
        const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
        if (selector === '*') return descendants;
        if (selector === 'button') return descendants.filter(child => child.tagName === 'BUTTON');
        if (selector === '[data-user-id]') return descendants.filter(child => child.getAttribute('data-user-id') !== null);
        return descendants;
      },
      get firstElementChild() { return this.children[0]; }, get lastElementChild() { return this.children.at(-1); }
    };
  }
  function element(id) {
    if (!elements.has(id)) { const node = createElement(); node.isConnected = true; elements.set(id, node); }
    return elements.get(id);
  }
  element('employeeUserForm').reset = () => {
    for (const id of ['employeeSearch', 'employeeCode', 'employeeRole', 'employeeDepartment', 'employeeMailSearch', 'employeeManualCode', 'employeeManualName']) element(id).value = '';
  };
  const window = {
    PCN_AUTO_REFRESH: { start(options) { autoRefresh = options; return () => {}; } },
    location: { hash: '#users' }, addEventListener(name, handler) { windowEvents[name] = handler; }, confirm: (message) => { confirmations.push(message); return pageOptions.confirm !== false; },
    PCN_SESSION: {
      require: async () => pageOptions.unauthorized ? null : ({ authenticated: true, user: { roles: ['admin'] } }),
      async fetch(url, options) {
        calls.push({ url, options });
        if (pageOptions.fetch) {
          const override = pageOptions.fetch(url, options);
          if (override !== undefined) return override;
        }
        if (url === '/api/auth/config') return { mode: 'employee-code', employeeProvisioningConfigured: pageOptions.configured !== false };
        if (url.startsWith('/api/admin/employees?')) return [pageOptions.employee || employee];
        if (url.startsWith('/api/admin/directory-users?')) return { users: pageOptions.mailProfiles || [verifiedMail, { ...verifiedMail, id: 'another-id', email: 'another@example.test' }] };
        if (url === '/api/admin/users' && !options) return assignedUsers;
        if (options?.method === 'PATCH' && pageOptions.conflict) { const error = new Error('Conflict'); error.status = 409; throw error; }
        return { id: 'created', ...employee, roles: ['admin'], department: 'it', identityProvider: 'employee-code' };
      }
    }
  };
  const pageOptions = options;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', '..', 'admin-users.js'), 'utf8'), {
    window, AbortController,
    document,
    setTimeout(callback) { const id = pendingTimers.size + 1; pendingTimers.set(id, callback); return id; },
    clearTimeout(id) { pendingTimers.delete(id); }
  });
  await init();
  async function select() {
    element('employeeSearch').value = '001';
    element('employeeSearch').events.input();
    const timer = [...pendingTimers.values()].at(-1);
    assert.ok(timer, 'employee input starts lookup');
    await timer();
    element('employeeResults').firstElementChild.events.click();
  }
  function openCreate() {
    element('usersAddRoleButton').focus();
    element('usersAddRoleButton').events.click();
  }
  return { get autoRefresh() { return autoRefresh; }, firstUserRow() { return element('adminUsersRows').firstElementChild || element('pendingUsersRows').firstElementChild; },
    openManual() { element('usersCreateButton').focus(); element('usersCreateButton').events.click(); }, element, calls, confirmations, select, openCreate, document,
    async changeHash(hash) { window.location.hash = hash; await windowEvents.hashchange(); },
    async runMailTimer() { await [...pendingTimers.values()].at(-1)?.(); } };
}


module.exports = { usersPage, employee, verifiedMail };
