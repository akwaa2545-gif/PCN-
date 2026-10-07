const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function app() {
  const calls = [];
  const window = { location: { pathname: '/form.html', search: '?id=PCN-2026-0007' }, PCN_SESSION: { fetch: async (route, options) => { calls.push({ route, options }); return { queued: false, reason: 'recipient_not_configured' }; } } };
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8').replace(/\}\)\(\);\s*$/, 'window.PCN_TEST = { state, getPcnIdFromPath, sendPendingWorkflowNotifications, toApiPayload };})();');
  vm.runInNewContext(source, { window, URLSearchParams, document: { addEventListener() {} } });
  return { app: window.PCN_TEST, calls };
}
test('notification links with query ID open their saved PCN', () => {
  assert.equal(app().app.getPcnIdFromPath(), 'PCN-2026-0007');
});
test('existing workbook edits carry saved SQL version for optimistic concurrency', () => {
  const c = app();
  assert.equal(c.app.toApiPayload({ version: '0000000000000001', internalReview: {} }).version, '0000000000000001');
});
test('partial signoff saves never try to notify next department', async () => {
  const c = app();
  c.app.state.pendingWorkflowNotifications.add('signoff.gscTet.approved');
  await c.app.sendPendingWorkflowNotifications({ id: 'PCN-2026-0007', internalReview: { signoff: { gscTet: { approved: true, checked: false, prepared: false } } } });
  assert.equal(c.calls.length, 0);
});
test('complete group queues once and empty email mapping never claims email was sent', async () => {
  const c = app();
  for (const field of ['approved', 'checked', 'prepared']) c.app.state.pendingWorkflowNotifications.add('signoff.gscTet.' + field);
  const message = await c.app.sendPendingWorkflowNotifications({ id: 'PCN-2026-0007', internalReview: { signoff: { gscTet: { approved: true, checked: true, prepared: true } } } });
  assert.equal(c.calls.length, 1);
  assert.equal(JSON.parse(c.calls[0].options.body).completedGroupKey, 'signoff.gscTet');
  assert.match(message, /no.*recipient|recipient.*not configured/i);
  assert.doesNotMatch(message, /submitted to Power Automate|email sent/i);
});

test('atomic saved handoff reports next action without a second HTTP write', async () => {
  const c = app();
  c.app.state.pendingWorkflowNotifications.add('signoff.gscTet.approved');
  const message = await c.app.sendPendingWorkflowNotifications({ id: 'PCN-2026-0007',
    notification: { queued: true, nextLabel: 'GSC/TET Checked' } });
  assert.equal(c.calls.length, 0);
  assert.equal(c.app.state.pendingWorkflowNotifications.size, 0);
  assert.match(message, /queued for GSC\/TET Checked/);
  assert.doesNotMatch(message, /email sent|delivered/i);
});

test('blocked or unchanged saved handoff never retries through the legacy endpoint', async () => {
  for (const reason of ['recipient_not_configured', 'mail_not_configured', 'tapbu_requirement_not_selected', 'notification_configuration_invalid', 'no_transition']) {
    const c = app();
    c.app.state.pendingWorkflowNotifications.add('signoff.gscTet.prepared');
    const message = await c.app.sendPendingWorkflowNotifications({ notification: { queued: false, reason } });
    assert.equal(c.calls.length, 0);
    assert.equal(c.app.state.pendingWorkflowNotifications.size, 0);
    if (reason !== 'no_transition') assert.match(message, /not queued/);
    else assert.equal(message, '');
  }
});
