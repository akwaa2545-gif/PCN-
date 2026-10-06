const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWorkflowNotificationMessage } = require('../src/notificationTemplate');

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
