const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeNotificationStatus } = require('../src/notificationStatus');
test('receipt describes transport acceptance honestly and exposes only grouped safe counts', () => {
  const result = summarizeNotificationStatus([
    { Status: 'sent', JobCount: 2, Recipient: 'private@example.test', PayloadJson: '{secret}', LastError: 'signed-url' },
    { Status: 'pending', JobCount: 1 }, { Status: 'failed', JobCount: 1 }, { Status: 'cancelled', JobCount: 1 }
  ]);
  assert.equal(result.state, 'needs_attention');
  assert.equal(result.accepted, 2); assert.equal(result.queued, 1); assert.equal(result.needsAttention, 1);
  assert.match(result.message, /workflow/i); assert.doesNotMatch(result.message, /delivered/i);
  assert.doesNotMatch(JSON.stringify(result), /private|secret|signed-url|Recipient|PayloadJson|LastError/);
});

test('receipt distinguishes queued, processing, workflow acceptance and cancellation without promising mailbox delivery', () => {
  assert.equal(summarizeNotificationStatus([{ Status: 'pending', JobCount: 1 }]).state, 'queued');
  assert.match(summarizeNotificationStatus([{ Status: 'sending', JobCount: 1 }]).message, /processing/i);
  const accepted = summarizeNotificationStatus([{ Status: 'sent', JobCount: 1, LatestAcceptedAt: new Date('2026-10-15T00:00:00Z') }]);
  assert.equal(accepted.state, 'accepted'); assert.equal(accepted.latestAcceptedAt, '2026-10-15T00:00:00.000Z');
  assert.match(accepted.message, /accepted by workflow/i); assert.doesNotMatch(accepted.message, /delivered/i);
  assert.equal(summarizeNotificationStatus([{ Status: 'cancelled', JobCount: 1 }]).state, 'cancelled');
  assert.equal(summarizeNotificationStatus([{ Status: 'uncertain', JobCount: 1 }]).state, 'needs_attention');
  assert.equal(summarizeNotificationStatus([], { blocked: true }).state, 'needs_attention');
  assert.match(summarizeNotificationStatus([], { configurationStatus: 'not_configured' }).message, /not configured/i);
  assert.equal(summarizeNotificationStatus([]).state, 'not_queued');
});
