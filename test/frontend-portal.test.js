const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function portal(options = {}) {
  const { authenticated = true, hash = '', mustChangePassword = false } = options;
  const roles = Object.prototype.hasOwnProperty.call(options, 'roles') ? options.roles : ['supplier'];
  const calls = [];
  const redirects = [];
  const gates = [];
  const profiles = [];
  const nodes = new Map();
  const records = [{ id: 'PCN-2026-0001', supplierName: 'Assigned requester', status: 'draft' }];
  const user = { id: 'portal-user', roles, mustChangePassword };
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      hidden: false, disabled: false, textContent: '', value: '', dataset: {}, style: {}, children: [],
      events: {}, classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(name, handler) { this.events[name] = handler; },
      setAttribute() {}, removeAttribute() {}, querySelectorAll() { return []; },
      appendChild(child) { this.children.push(child); },
      querySelector(selector) {
        if (selector !== "input[type='checkbox']") return null;
        const checkbox = element(`checkbox-${nodes.size}`);
        checkbox.disabled = /<input\b[^>]*\bdisabled\b/.test(this.innerHTML);
        this.checkbox = checkbox;
        return checkbox;
      },
      getClientRects() { return []; }
    });
    return nodes.get(id);
  };
  const window = {
    location: { hash, pathname: '/admin', search: '', assign: (url) => redirects.push(url) },
    addEventListener() {},
    PCN_SESSION: {
      async require(role, options = {}) {
        gates.push({ role, options });
        if (!authenticated || mustChangePassword) {
          redirects.push('/login');
          return null;
        }
        const validRoles = Array.isArray(roles) ? roles : [];
        if (options.requireRole && !validRoles.length) {
          redirects.push('/records');
          return null;
        }
        if (role && !validRoles.some(value => value.toLowerCase() === role.toLowerCase())) {
          throw new Error('Your account does not have access to this page.');
        }
        return { authenticated: true, user };
      },
      mountProfile(value) { profiles.push(value); },
      async fetch(url) {
        calls.push(url);
        if (url === '/api/pcns') return records;
        if (!roles.some(value => typeof value === 'string' && value.toLowerCase() === 'admin')) {
          throw new Error('Administrator access required');
        }
        if (url === '/api/notification-settings') return { groups: [], directoryConfigured: false };
        if (url === '/api/admin/notifications/health') return {
          configuration: { status: 'not_configured' }, worker: { lastOutcome: null },
          queue: { pending: 0, sending: 0, accepted: 0, uncertain: 0 }, deliveryVerified: false
        };
        throw new Error(`Unexpected API request: ${url}`);
      }
    }
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'admin.js'), 'utf8')
    .replace(/\}\)\(\);\s*$/, `
      render = function () { renderAdminView(); };
      renderNotificationHealth = function () {};
      showAdminToast = function () {};
      window.PORTAL_TEST = {
        state, els, loadPcns, setAdminView, syncViewFromHash, renderProgress, renderStatusControl,
        checkPortalSession: typeof checkPortalSession === 'function' ? checkPortalSession : checkAdminSession
      };
    })();`);
  vm.runInNewContext(source, {
    window, URL, document: {
      addEventListener() {}, getElementById: element, createElement: () => element(`created-${nodes.size}`),
      querySelectorAll() { return []; },
      body: { classList: { add() {}, remove() {}, toggle() {} } }
    }
  });
  for (const id of fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8').matchAll(/id="([^"]+)"/g)) {
    window.PORTAL_TEST.els[id[1]] = element(id[1]);
  }
  return { ...window.PORTAL_TEST, window, user, records, calls, redirects, gates, profiles, element };
}

test('every assigned PCN role opens the Portal and loads records without administrator requests', async () => {
  for (const role of ['supplier', 'reviewer', 'gsc', 'productionengineering', 'qa', 'tapbu', 'QA']) {
    const page = portal({ roles: [role] });
    await page.checkPortalSession();
    assert.deepEqual(JSON.parse(JSON.stringify(page.gates)), [{ role: null, options: { requireRole: true } }], role);
    assert.deepEqual(page.calls, ['/api/pcns'], role);
    assert.deepEqual(page.redirects, [], role);
    assert.deepEqual(page.state.pcns, page.records, role);
    assert.equal(page.profiles.length, 1, role);
    assert.equal(page.element('adminMailRoutingButton').hidden, true, role);
    assert.equal(page.element('adminUsersButton').hidden, true, role);
  }
});

test('roleless users return to records before Portal data or profile loads', async () => {
  for (const roles of [[], undefined, null]) {
    const page = portal({ roles });
    await page.checkPortalSession();
    assert.deepEqual(page.calls, [], String(roles));
    assert.deepEqual(page.redirects, ['/records'], String(roles));
    assert.equal(page.profiles.length, 0, String(roles));
  }
});

test('signed-out and temporary-password users stop before loading Portal data', async () => {
  for (const options of [{ authenticated: false }, { mustChangePassword: true }]) {
    const page = portal(options);
    await page.checkPortalSession();
    assert.deepEqual(page.calls, []);
    assert.deepEqual(page.redirects, ['/login']);
    assert.equal(page.profiles.length, 0);
  }
});

test('administrators retain Portal records, routing and notification health', async () => {
  for (const roles of [['admin'], ['AdMiN'], ['qa', 'admin']]) {
    const page = portal({ roles });
    await page.checkPortalSession();
    assert.deepEqual([...page.calls].sort(), ['/api/admin/notifications/health', '/api/notification-settings', '/api/pcns']);
    assert.deepEqual(page.state.pcns, page.records);
    assert.equal(page.element('adminMailRoutingButton').hidden, false);
    assert.equal(page.element('adminUsersButton').hidden, false);
    assert.deepEqual(page.redirects, []);
  }
});

test('non-administrators stay on records when opening or changing privileged Portal hashes', async () => {
  for (const hash of ['#mail-routing', '#users']) {
    const page = portal({ roles: ['qa'], hash });
    await page.checkPortalSession();
    assert.equal(page.state.view, 'pcns', `initial ${hash}`);
    page.window.location.hash = hash;
    page.syncViewFromHash();
    assert.equal(page.state.view, 'pcns', `hash change ${hash}`);
    page.setAdminView(hash === '#users' ? 'users' : 'mail');
    page.syncViewFromHash();
    assert.equal(page.state.view, 'pcns', `navigation ${hash}`);
    assert.deepEqual(page.calls, ['/api/pcns']);
  }
});

test('administrators retain direct Mail Routing and Users Portal destinations', async () => {
  for (const [hash, view] of [['#mail-routing', 'mail'], ['#users', 'users']]) {
    const page = portal({ roles: ['admin'], hash });
    await page.checkPortalSession();
    assert.equal(page.state.view, view);
    page.window.location.hash = '#records';
    page.syncViewFromHash();
    assert.equal(page.state.view, 'pcns');
    page.setAdminView(view);
    page.syncViewFromHash();
    assert.equal(page.state.view, view);
  }
});

test('Portal progress checkboxes allow only administrators to advance workflow status', async () => {
  for (const role of ['qa', 'supplier', 'admin']) {
    const page = portal({ roles: [role] });
    await page.checkPortalSession();
    page.state.selected = page.records[0];
    page.state.progress = {
      currentOwner: 'QA', nextAction: 'Review PCN', nextStatus: 'qa_review', progressPercent: 20,
      status: 'submitted', availableStatuses: [{ value: 'submitted', label: 'Submitted' }],
      steps: [{ state: 'active', title: 'QA review', copy: 'Check the proposed change', owner: 'QA' }]
    };
    page.renderProgress();
    page.renderStatusControl();
    const item = page.element('adminProgressSteps').children[0];
    const administrator = role === 'admin';
    assert.equal(item.checkbox.disabled, !administrator, `${role} workflow checkbox`);
    assert.equal(typeof item.checkbox.events.change === 'function', administrator, `${role} workflow mutation handler`);
    assert.equal(item.className.includes('is-checkable'), administrator, `${role} workflow action styling`);
    assert.equal(page.element('adminStatusControl').hidden, !administrator, `${role} status controls`);
  }
});
