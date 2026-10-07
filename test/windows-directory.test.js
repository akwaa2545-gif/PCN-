const test = require('node:test');
const assert = require('node:assert/strict');
const { WindowsDirectoryService } = require('../src/windowsDirectoryService');
const directoryId = '11111111-2222-3333-4444-555555555555';
const person = { directoryId, adSid: 'S-1-5-21-123-456-789-1001', samAccountName: '2172172512501', displayName: 'Example Employee', email: 'employee@example.com', adDepartment: 'Information Technology', isActive: true };

test('directory search and exact resolution expose SamAccountName as employee code', async () => {
  const calls = [];
  const directory = new WindowsDirectoryService({ domain: 'KEMET.COM', runner: async request => { calls.push(request); return [person]; } });
  const results = await directory.search('2172');
  assert.equal(results[0].employeeCode, person.samAccountName);
  assert.equal(results[0].directoryId, directoryId);
  assert.equal((await directory.getById(directoryId)).adSid, person.adSid);
  assert.equal((await directory.getBySamAccountName(person.samAccountName)).employeeCode, person.samAccountName);
  assert.deepEqual(calls.map(call => call.operation), ['search', 'id', 'sam']);
  assert.equal(calls[0].domain, 'KEMET.COM');
});

test('directory is bounded, validates inputs and rejects inactive or ambiguous identities', async () => {
  const directory = new WindowsDirectoryService({ runner: async () => [person, { ...person, directoryId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }] });
  await assert.rejects(directory.getBySamAccountName(person.samAccountName), /Directory/i);
  await assert.rejects(directory.getById('bad-id'), /directory employee/i);
  await assert.rejects(directory.search('x'), /at least 2/i);
  await assert.rejects(directory.search('x'.repeat(101)), /search/i);
  const inactive = new WindowsDirectoryService({ runner: async () => [{ ...person, isActive: false }] });
  assert.deepEqual(await inactive.search('employee'), []);
  assert.equal(await inactive.getById(directoryId), null);
  const unavailable = new WindowsDirectoryService({ runner: async () => { throw new Error('sensitive LDAP server details'); } });
  await assert.rejects(unavailable.search('employee'), error => error.statusCode === 503 && !error.message.includes('LDAP'));
});

test('directory concurrency is bounded and capacity recovers after completion and failure', async () => {
  const completions = [];
  const directory = new WindowsDirectoryService({ runner: () => new Promise((resolve, reject) => completions.push({ resolve, reject })) });
  const pending = [0, 1, 2, 3].map(() => directory.search('employee'));
  await assert.rejects(directory.search('fifth employee'), error => error.statusCode === 503);
  completions.forEach(item => item.resolve([person]));
  await Promise.all(pending);
  const next = directory.search('employee');
  completions[4].reject(new Error('lookup failed'));
  await assert.rejects(next, error => error.statusCode === 503);
  const recovered = directory.search('employee');
  completions[5].resolve([person]);
  assert.equal((await recovered).length, 1);
});

test('malformed directory attributes cannot become provisionable employee identities', async () => {
  for (const invalid of [{ ...person, samAccountName: [person.samAccountName] }, { ...person, adSid: [person.adSid] }, { ...person, directoryId: [directoryId] }, { ...person, samAccountName: 'a'.repeat(21) }]) {
    const directory = new WindowsDirectoryService({ runner: async () => [invalid] });
    assert.deepEqual(await directory.search('employee'), []);
    assert.equal(await directory.getById(directoryId), null);
  }
});
