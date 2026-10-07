const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWorkflowNotificationMessage, buildPcnUpdateNotificationMessage } = require('../src/notificationTemplate');

const record = { id: 'PCN-2026-0001', supplierName: 'Supplier ไทย', materialName: 'Copper strip', riskLevel: 'RL2' };
const notification = { completedGroup: 'GSC/TET', nextGroup: 'Prod.Eng/TET', pcnUrl: 'https://pcn.example/form.html?id=PCN-2026-0001' };

test('workflow email restores the original rich HTML with status, details and an Open PCN button', () => {
  const message = buildWorkflowNotificationMessage(record, notification);
  for (const label of ['Supplier PCN Workflow', 'requires next action', 'Current Status', 'Next To Check', 'PCN Code', 'Supplier', 'Material', 'Risk Level', 'Open PCN']) assert.ok(message.includes(label), label);
  for (const value of [...Object.values(record), notification.completedGroup, notification.nextGroup]) assert.ok(message.includes(value), value);
  assert.match(message, /background:#001a7a/);
  assert.match(message, /<a href="https:\/\/pcn\.example\/form\.html\?id=PCN-2026-0001"/);
  assert.ok(message.length < 20000);
});

test('workflow email escapes Unicode record fields, status labels and link attributes', () => {
  const hostile = '<img src=x onerror="alert(1)"> ไทย🙂 & \'quoted\'';
  const message = buildWorkflowNotificationMessage(Object.fromEntries(Object.keys(record).map(key => [key, hostile])),
    { completedGroup: hostile, nextGroup: hostile, pcnUrl: 'https://pcn.example/form.html?x="onclick="evil&y=<tag>' });
  assert.doesNotMatch(message, /<img|<tag>|href="[^"]*"onclick=/);
  assert.ok(message.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; ไทย🙂 &amp; &#39;quoted&#39;'));
  assert.match(message, /href="https:\/\/pcn\.example\/form\.html\?x=&quot;onclick=&quot;evil&amp;y=&lt;tag&gt;"/);
});

test('missing record details use placeholders and missing links omit the access button', () => {
  for (const optional of [undefined, null, '']) {
    const message = buildWorkflowNotificationMessage({ id: record.id, supplierName: optional }, { completedGroup: notification.completedGroup, nextGroup: notification.nextGroup, pcnUrl: optional });
    assert.doesNotMatch(message, /<a |Open PCN|undefined|null/);
    assert.ok(message.includes('>-</td>'));
  }
});

test('template rejects unsafe links, invalid input types and oversized escaped messages safely', () => {
  for (const pcnUrl of ['javascript:alert(1)', 'data:text/html,x', 'https://user:secret@pcn.example/', 'not a url', 3]) {
    assert.throws(() => buildWorkflowNotificationMessage(record, { ...notification, pcnUrl }), { statusCode: 503 });
  }
  for (const value of [null, [], 'bad', 5]) {
    assert.throws(() => buildWorkflowNotificationMessage(value, notification), { statusCode: 503 });
    assert.throws(() => buildWorkflowNotificationMessage(record, value), { statusCode: 503 });
  }
  assert.throws(() => buildWorkflowNotificationMessage({ ...record, supplierName: {} }, notification), { statusCode: 503 });
  assert.throws(() => buildWorkflowNotificationMessage({ ...record, supplierName: '<'.repeat(10000) }, notification), { statusCode: 503 });
  assert.ok(buildWorkflowNotificationMessage({ ...record, supplierName: '"'.repeat(200), materialName: '<'.repeat(200) }, notification).length < 20000);
});

test('message length accepts the exact transport limit and rejects one character over it', () => {
  const baseline = buildWorkflowNotificationMessage({ ...record, supplierName: 'x' }, notification).length;
  const supplierName = 'x'.repeat(20000 - baseline + 1);
  assert.equal(buildWorkflowNotificationMessage({ ...record, supplierName }, notification).length, 20000);
  assert.throws(() => buildWorkflowNotificationMessage({ ...record, supplierName: `${supplierName}x` }, notification), { statusCode: 503 });
});

test('update email informs recipients without instructing them to take the next action', () => {
  const message = buildPcnUpdateNotificationMessage({ ...record, status: 'in_review' }, {
    pcnUrl: notification.pcnUrl, updateSummary: 'GSC/TET Prepared completed'
  });
  for (const label of ['PCN updated', 'For your information', 'Current Status', 'in_review', 'Update Summary', 'GSC/TET Prepared completed', 'Open PCN']) {
    assert.ok(message.includes(label), label);
  }
  assert.doesNotMatch(message, /requires next action|Your action is required|Next To Check|Responsible Department|PCN Role/);
});

test('action email identifies the completed action, responsible department and PCN role', () => {
  const message = buildWorkflowNotificationMessage(record, {
    ...notification, completedGroup: 'GSC/TET Prepared completed', nextDepartment: 'GSC/TET', nextRole: 'Checked',
    updateSummary: 'Prepared signoff saved'
  });
  for (const label of ['Your action is required', 'Completed Action', 'GSC/TET Prepared completed', 'Responsible Department', 'GSC/TET', 'PCN Role', 'Checked', 'Prepared signoff saved']) {
    assert.ok(message.includes(label), label);
  }
  assert.match(message, />Open PCN to take action<\/a>/);
});

test('both notification variants escape all added data and validate summary types and message limits', () => {
  const hostile = '<script>bad</script> & "quoted"';
  const update = buildPcnUpdateNotificationMessage({ ...record, status: hostile }, { pcnUrl: notification.pcnUrl, updateSummary: hostile });
  const action = buildWorkflowNotificationMessage(record, { ...notification, nextDepartment: hostile, nextRole: hostile, updateSummary: hostile });
  for (const message of [update, action]) {
    assert.doesNotMatch(message, /<script>/);
    assert.ok(message.includes('&lt;script&gt;bad&lt;/script&gt; &amp; &quot;quoted&quot;'));
  }
  for (const template of [buildWorkflowNotificationMessage, buildPcnUpdateNotificationMessage]) {
    for (const updateSummary of [{}, [], 5]) assert.throws(() => template(record, { ...notification, updateSummary }), { statusCode: 503 });
    assert.throws(() => template(record, { ...notification, updateSummary: '<'.repeat(10000) }), { statusCode: 503 });
  }
  for (const field of ['nextDepartment', 'nextRole']) {
    for (const value of [false, 0, {}, []]) assert.throws(() => buildWorkflowNotificationMessage(record, { ...notification, [field]: value }), { statusCode: 503 });
  }
});

test('update template validates record, notification and URLs and handles missing optional values', () => {
  for (const value of [null, [], 'bad', 5]) {
    assert.throws(() => buildPcnUpdateNotificationMessage(value, notification), { statusCode: 503 });
    assert.throws(() => buildPcnUpdateNotificationMessage(record, value), { statusCode: 503 });
  }
  for (const pcnUrl of ['javascript:alert(1)', 'data:text/html,x', 'https://user:secret@pcn.example/', 'not a url', 3]) {
    assert.throws(() => buildPcnUpdateNotificationMessage(record, { pcnUrl }), { statusCode: 503 });
  }
  assert.throws(() => buildPcnUpdateNotificationMessage({ ...record, status: {} }, {}), { statusCode: 503 });
  const message = buildPcnUpdateNotificationMessage(record, {});
  assert.doesNotMatch(message, /<a |Open PCN|undefined|null/);
  const baseline = buildPcnUpdateNotificationMessage(record, { updateSummary: 'x' }).length;
  const updateSummary = 'x'.repeat(20000 - baseline + 1);
  assert.equal(buildPcnUpdateNotificationMessage(record, { updateSummary }).length, 20000);
  assert.throws(() => buildPcnUpdateNotificationMessage(record, { updateSummary: `${updateSummary}x` }), { statusCode: 503 });
});
