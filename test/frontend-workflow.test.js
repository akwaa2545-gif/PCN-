const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function app(controls = [], workflow) {
  const calls = [];
  const window = { PCN_WORKFLOW_TEST: workflow, location: { pathname: '/form.html', search: '?id=PCN-2026-0007' }, PCN_SESSION: { fetch: async (route, options) => { calls.push({ route, options }); return workflow?.savedRecord || { queued: false, reason: 'recipient_not_configured' }; } } };
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8').replace(/\}\)\(\);\s*$/, `
    if (window.PCN_WORKFLOW_TEST) {
      refreshPcns = async () => { state.activeRequest = window.PCN_WORKFLOW_TEST.refreshedRecord; };
      renderAll = () => {};
      showNotice = (...args) => window.PCN_WORKFLOW_TEST.notices.push(args);
    }
    window.PCN_TEST = { state, getPcnIdFromPath, sendPendingWorkflowNotifications, advanceWorkflowStep, toApiPayload, canSignStep, updateApprovalCheckLocks };})();`);
  vm.runInNewContext(source, { window, URLSearchParams, document: { addEventListener() {},
    querySelector(selector) { const field = /data-internal-field="([^"]+)"/.exec(selector)?.[1]; return controls.find(control => control.dataset.internalField === field) || null; },
    querySelectorAll() { return controls; }
  } });
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

test('split saved notifications report update and action queues independently without sending again', async () => {
  const c = app();
  c.app.state.pendingWorkflowNotifications.add('signoff.gscTet.approved');
  const message = await c.app.sendPendingWorkflowNotifications({ notification: {
    queued: true, update: { queued: true, jobCount: 1 },
    actionRequired: { queued: true, nextLabel: 'GSC/TET Checked' }
  } });
  assert.match(message, /PCN update email.*queued/);
  assert.match(message, /Action-required email queued for GSC\/TET Checked/);
  assert.doesNotMatch(message, /email sent|delivered/i);
  assert.equal(c.calls.length, 0);
  assert.equal(c.app.state.pendingWorkflowNotifications.size, 0);
});

test('queued update does not hide a blocked action notification or invent an action for an ordinary edit', async () => {
  const c = app();
  const blocked = await c.app.sendPendingWorkflowNotifications({ notification: {
    queued: true, update: { queued: true },
    actionRequired: { queued: false, reason: 'recipient_not_configured' }
  } });
  assert.match(blocked, /PCN update email.*queued/);
  assert.match(blocked, /Action-required email not queued: next-step recipients are not configured/);
  const ordinary = await c.app.sendPendingWorkflowNotifications({ notification: {
    queued: true, update: { queued: true }, actionRequired: { queued: false, reason: 'no_transition' }
  } });
  assert.match(ordinary, /PCN update email.*queued/);
  assert.doesNotMatch(ordinary, /Action-required|next step/i);
  assert.equal(c.calls.length, 0);
});

test('workflow checkbox keeps saved notification outcomes after refreshing the PCN without a second write', async () => {
  const savedRecord = { id: 'PCN-2026-0007', status: 'technical_review', version: '0000000000000002',
    notification: { update: { queued: true }, actionRequired: { queued: false, reason: 'recipient_not_configured' } } };
  const { notification, ...refreshedRecord } = savedRecord;
  const workflow = { savedRecord, refreshedRecord, notices: [] };
  const c = app([], workflow);
  c.app.state.activeRequest = { id: savedRecord.id, status: 'submitted', version: '0000000000000001' };
  c.app.state.pendingWorkflowNotifications.add('signoff.gscTet.approved');
  await c.app.advanceWorkflowStep(savedRecord.status);
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0].options.method, 'PATCH');
  assert.equal(c.app.state.activeRequest.notification, undefined);
  const finalNotice = workflow.notices.at(-1);
  assert.equal(finalNotice[0], 'success');
  assert.match(finalNotice[2], /PCN update emails queued/);
  assert.match(finalNotice[2], /Action-required email not queued/);
  assert.doesNotMatch(finalNotice[2], /delivered|email sent/i);
  assert.equal(c.app.state.pendingWorkflowNotifications.size, 0);
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

test('browser signing matches the single assigned department and step', () => {
  const c = app();
  c.app.state.user = { roles: ['admin'] };
  assert.equal(c.app.canSignStep('signoff.gscTet', 'approved'), false);
  c.app.state.user = { roles: ['qa'], department: 'qaTet', signingStep: 'prepared' };
  assert.equal(c.app.canSignStep('signoff.qaTet', 'prepared'), true);
  assert.equal(c.app.canSignStep('qateFinal.signoff', 'prepared'), true);
  assert.equal(c.app.canSignStep('signoff.qaTet', 'checked'), false);
  assert.equal(c.app.canSignStep('tapbu.qa', 'prepared'), false);
});

test('unauthorized existing signatures and metadata stay disabled in the browser', () => {
  const controls = ['signoff.gscTet.approved', 'signoff.gscTet.approvedName', 'signoff.gscTet.date', 'qateFinal.approve'].map(field => ({
    dataset: { internalField: field }, checked: true, disabled: false, closest() { return null; }
  }));
  const c = app(controls);
  c.app.state.user = { roles: ['admin'] };
  c.app.updateApprovalCheckLocks();
  assert.ok(controls.every(control => control.disabled));
  assert.ok(controls.every(control => control.checked));
});
