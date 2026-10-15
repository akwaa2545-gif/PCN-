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
