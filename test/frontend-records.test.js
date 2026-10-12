const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element(tag = 'div') {
  return {
    tag, hidden: true, disabled: false, value: '', textContent: '', children: [], events: {},
    append(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
    addEventListener(name, callback) { this.events[name] = callback; }
  };
}

async function recordsPage(session, result = []) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'records.html'), 'utf8');
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], element()]));
  const requests = [];
  const redirects = [];
  const profiles = [];
  let automatic;
  let init;
  const document = {
    addEventListener(name, callback) { if (name === 'DOMContentLoaded') init = callback; },
    getElementById: (id) => elements.get(id) || null,
    createElement: element
  };
  const window = {
    PCN_AUTO_REFRESH: {start(options) {automatic=options;}},
    location: { assign: (url) => redirects.push(url) },
    PCN_SESSION: {
      require: async () => {
        if (session instanceof Error) throw session;
        return session;
      },
      mountProfile: (user) => profiles.push(user),
      fetch: async (url) => {
        requests.push(url);
        if (result instanceof Error) throw result;
        return typeof result === 'function' ? result() : result;
      }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'records.js'), 'utf8'), { document, window });
  await init();
  return { elements, requests, redirects, profiles, automatic };
}

test('automatic Records refresh preserves search and unchanged row identity, replacing only changed results',async()=>{
  let data=[{id:'PCN-2026-0001',supplierName:'Acme'}];
  const page=await recordsPage({user:{identityProvider:'employee-code',employeeCode:'EMP001',roles:[]}},()=>data);
  const search=page.elements.get('recordsSearch');search.value='acme';search.events.input();
  const row=page.elements.get('recordsRows').children[0];
  await page.automatic.refresh();assert.equal(page.elements.get('recordsRows').children[0],row);
  data=[...data,{id:'PCN-2026-0002',supplierName:'Other'}];
  await page.automatic.refresh();assert.equal(search.value,'acme');assert.equal(page.elements.get('recordsCount').textContent,'1');
  assert.equal(page.automatic.intervalMs,5000);
});

test('lost Records access clears visible stale records and stops subsequent polling',async()=>{
  let revoked=false;
  const page=await recordsPage({user:{identityProvider:'employee-code',employeeCode:'EMP001',roles:[]}},()=>{
    if(revoked)throw Object.assign(new Error('Forbidden'),{status:403});
    return [{id:'PCN-2026-0001',supplierName:'Acme'}];
  });
  revoked=true;
  await assert.rejects(page.automatic.refresh(),{status:403});
  assert.equal(page.elements.get('recordsRows').children.length,0);
  assert.equal(page.elements.get('recordsWorkspace').hidden,true);
  assert.equal(page.automatic.canRefresh(),false);
});

test('roleless employee can list records and open read-only details', async () => {
  const page = await recordsPage({ user: { identityProvider: 'employee-code', employeeCode: 'EMP001', roles: [] } }, [
    { id: 'PCN-2026-0001', status: 'Submitted', riskLevel: 'Low', supplierName: 'Supplier', materialName: 'Material' }
  ]);
  assert.deepEqual(page.requests, ['/api/pcns']);
  assert.equal(page.elements.get('recordsWorkspace').hidden, false);
  assert.equal(page.elements.get('recordsCount').textContent, '1');
  assert.match(page.elements.get('recordsAccessMessage').textContent, /read.only/i);
  const rows = page.elements.get('recordsRows').children;
  assert.equal(rows[0].children[0].children[0].href, '/PCN-2026-0001');
  assert.equal(page.profiles.length, 1);
});

test('any assigned role redirects Records visitors to the Portal without requesting records', async () => {
  for (const roles of [['supplier'], ['reviewer'], ['gsc'], ['qa'], ['admin'], ['qa', 'gsc']]) {
    const page = await recordsPage({ user: { identityProvider: 'employee-code', roles } });
    assert.deepEqual(page.redirects, ['/admin']);
    assert.deepEqual(page.requests, []);
    assert.equal(page.elements.get('recordsWorkspace').hidden, true);
  }
});

test('PCN-only employees follow the same roleless Records gate and assigned-role Portal route', async () => {
  const user = { identityProvider: 'pcn-local', employeeCode: '0098765', roles: [], isActive: true };
  const viewer = await recordsPage({ user });
  assert.deepEqual(viewer.requests, ['/api/pcns']);
  assert.equal(viewer.elements.get('recordsWorkspace').hidden, false);
  const assigned = await recordsPage({ user: { ...user, roles: ['qa'] } });
  assert.deepEqual(assigned.redirects, ['/admin']);
  for (const patch of [{ isActive: false }, { employeeCode: '' }]) {
    const denied = await recordsPage({ user: { ...user, ...patch } });
    assert.deepEqual(denied.requests, []);
    assert.equal(denied.elements.get('recordsWorkspace').hidden, true);
  }
});

test('signed-out users remain behind the existing sign-in gate', async () => {
  const page = await recordsPage(null);
  assert.deepEqual(page.requests, []);
  assert.deepEqual(page.redirects, []);
  assert.equal(page.profiles.length, 0);
});

test('roleless accounts outside verified employee sign-in cannot load Records', async () => {
  const page = await recordsPage({ user: { identityProvider: 'local', roles: [] } });
  assert.deepEqual(page.requests, []);
  assert.equal(page.elements.get('recordsWorkspace').hidden, true);
  assert.equal(page.elements.get('recordsGateError').hidden, false);
  assert.match(page.elements.get('recordsGateError').textContent, /employee|access/i);
});

test('employee viewers require a code and an active account before records load', async () => {
  for (const user of [
    { identityProvider: 'employee-code', roles: [] },
    { identityProvider: 'employee-code', employeeCode: '', roles: [] },
    { identityProvider: 'employee-code', employeeCode: 'EMP001', isActive: false, roles: [] }
  ]) {
    const page = await recordsPage({ user });
    assert.deepEqual(page.requests, []);
    assert.equal(page.elements.get('recordsWorkspace').hidden, true);
    assert.equal(page.elements.get('recordsGateError').hidden, false);
    assert.match(page.elements.get('recordsGateError').textContent, /employee|access/i);
  }
});

test('session verification failures remain visible while the records workspace stays hidden', async () => {
  const page = await recordsPage(new Error('Employee service unavailable'));
  assert.deepEqual(page.requests, []);
  assert.equal(page.elements.get('recordsWorkspace').hidden, true);
  assert.equal(page.elements.get('recordsGateError').hidden, false);
  assert.equal(page.elements.get('recordsGateError').textContent, 'Employee service unavailable');
});

test('roleless employee can search and refresh the read-only list', async () => {
  const page = await recordsPage({ user: { identityProvider: 'employee-code', employeeCode: 'EMP001', roles: [] } }, [
    { id: 'PCN-2026-0001', supplierName: 'Acme' },
    { id: 'PCN-2026-0002', supplierName: 'Other' }
  ]);
  const search = page.elements.get('recordsSearch');
  search.value = 'acme';
  search.events.input();
  assert.equal(page.elements.get('recordsCount').textContent, '1');
  assert.equal(page.elements.get('recordsRows').children.length, 1);
  await page.elements.get('recordsRefreshButton').events.click();
  assert.deepEqual(page.requests, ['/api/pcns', '/api/pcns']);
});

test('records load failures are visible and refresh becomes available again', async () => {
  const page = await recordsPage({ user: { identityProvider: 'employee-code', employeeCode: 'EMP001', roles: [] } }, new Error('Records service unavailable'));
  assert.equal(page.elements.get('recordsMessage').textContent, 'Records service unavailable');
  assert.equal(page.elements.get('recordsRefreshButton').disabled, false);
});

test('Records page reserves header navigation for the viewer account menu', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'records.html'), 'utf8');
  assert.doesNotMatch(html, /id="(?:createPcnLink|adminRecordsLink|accessPending)"/);
  assert.match(html, /id="accountMenu"/);
});
