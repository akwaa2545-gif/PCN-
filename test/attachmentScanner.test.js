const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createAttachmentScanner, readScannerConfiguration } = require('../src/attachmentScanner');

const executable = 'C:\\Program Files\\Windows Defender\\MpCmdRun.exe';
const temp = 'C:\\Users\\service\\AppData\\Local\\Temp';
const env = { PCN_ATTACHMENT_SCANNER: 'windows-defender', PCN_ATTACHMENT_SCANNER_PATH: executable, PCN_ATTACHMENT_SCAN_ROOT: temp };
const directory = path.win32.join(temp, 'pcn-attachment-random123');
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function adapter(options = {}) {
  const calls = [];
  const fileSystem = {
    async realpath(value) { calls.push(['realpath', value]); return options.realpath ? options.realpath(value) : value; },
    async lstat(value) { return { isFile: () => [executable,powershell].includes(value), isDirectory: () => ![executable,powershell].includes(value), isSymbolicLink: () => Boolean(options.symlink) }; },
    async mkdtemp(prefix, settings) { calls.push(['mkdtemp', prefix, settings]); return options.directory || directory; },
    async chmod(value, mode) { calls.push(['chmod', value, mode]); },
    async writeFile(value, bytes, settings) { calls.push(['writeFile', value, bytes, settings]); if (options.writeError) throw new Error('write failed'); },
    async rm(value, settings) { calls.push(['rm', value, settings]); if (options.cleanupError) throw new Error('cleanup failed'); }
  };
  const execute = async (program, args, settings) => {
    calls.push(['execute', program, args, settings]);
    if (program === powershell) {
      if (options.onAcl) return options.onAcl(settings);
      if (options.aclError) throw options.aclError;
      return options.aclResult === undefined ? { exitCode: 0, stdout: '{"safe":true}' } : options.aclResult;
    }
    if (options.error) throw options.error;
    return options.result === undefined ? { exitCode: 0 } : options.result;
  };
  return { calls, scanner: createAttachmentScanner(env, { platform: 'win32', fileSystem, execute }) };
}

test('scanner is disabled by default and opt-in rejects unsafe provider or executable paths', () => {
  assert.equal(createAttachmentScanner({}), null);
  assert.throws(() => readScannerConfiguration({ PCN_ATTACHMENT_SCANNER: 'remote-tool' }, 'win32'));
  assert.throws(() => readScannerConfiguration(env, 'linux'));
  for (const scanRoot of [undefined, 'relative', 'C:\\', '\\\\host\\share', 'C:\\private\\..\\other']) {
    assert.throws(() => readScannerConfiguration({ ...env, PCN_ATTACHMENT_SCAN_ROOT: scanRoot }, 'win32'));
  }
  for (const value of ['', 'MpCmdRun.exe', '\\\\host\\share\\MpCmdRun.exe', 'C:\\other\\MpCmdRun.exe',
    'C:\\Program Files\\Windows Defender\\cmd.exe', 'C:\\Program Files\\Windows Defender\\..\\MpCmdRun.exe',
    'C:\\Program Files\\Windows Defender\\subdir\\MpCmdRun.exe']) {
    assert.throws(() => readScannerConfiguration({ ...env, PCN_ATTACHMENT_SCANNER_PATH: value }, 'win32'));
  }
  assert.equal(readScannerConfiguration(env, 'win32').executable, executable);
  const platformPath = 'C:\\ProgramData\\Microsoft\\Windows Defender\\Platform\\4.18.25090.3009-0\\MpCmdRun.exe';
  assert.equal(readScannerConfiguration({ ...env, PCN_ATTACHMENT_SCANNER_PATH: platformPath }, 'win32').executable, platformPath);
});

test('trusted clean result scans random private bytes with bounded shell-free process and cleans temporary files', async () => {
  const { scanner, calls } = adapter();
  assert.equal(await scanner.scan(Buffer.from('trusted bytes')), 'clean');
  const write = calls.find(call => call[0] === 'writeFile');
  assert.equal(path.win32.dirname(write[1]), directory);
  assert.match(path.win32.basename(write[1]), /^[a-f0-9-]+\.bin$/);
  assert.equal(write[3].mode, 0o600);
  assert.equal(write[3].flag, 'wx');
  assert.ok(calls.some(call => call[0] === 'chmod' && call[2] === 0o700));
  const execute = calls.find(call => call[0] === 'execute' && call[1] === executable);
  assert.equal(execute[1], executable);
  assert.deepEqual(execute[2], ['-Scan', '-ScanType', '3', '-File', write[1], '-DisableRemediation']);
  assert.equal(execute[3].shell, false);
  assert.equal(execute[3].windowsHide, true);
  assert.equal(execute[3].timeout, 60000);
  assert.equal(execute[3].maxBuffer, 64 * 1024);
  assert.deepEqual(calls.at(-1), ['rm', directory, { recursive: true, force: true }]);
});

test('nonzero, missing, malformed and subprocess failure results never mark an attachment clean', async () => {
  for (const options of [{ result: { exitCode: 2 } }, { result: { exitCode: 1 } }, { result: {} }, { result: null },
    { error: Object.assign(new Error('timeout'), { killed: true }) },
    { error: Object.assign(new Error('large output'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }) },
    { error: Object.assign(new Error('missing executable'), { code: 'ENOENT' }) }]) {
    const { scanner, calls } = adapter(options);
    await assert.rejects(scanner.scan(Buffer.from('bytes')), { statusCode: 503 });
    assert.equal(calls.at(-1)[0], 'rm');
  }
});

test('scanner rejects symlinks and escaped directories without recursive deletion outside the temp root', async () => {
  for (const options of [{ symlink: true }, { directory: 'C:\\important' },
    { realpath: value => value === directory ? 'C:\\outside\\pcn-attachment-random123' : value }]) {
    const { scanner, calls } = adapter(options);
    await assert.rejects(scanner.scan(Buffer.from('bytes')), { statusCode: 503 });
    assert.equal(calls.some(call => call[0] === 'execute' && call[1] === executable), false);
    assert.equal(calls.some(call => call[0] === 'rm' && call[1] !== directory), false);
  }
});

test('temporary write and cleanup failures fail closed, and scanner only accepts bounded buffers', async () => {
  for (const options of [{ writeError: true }, { cleanupError: true }]) {
    const { scanner } = adapter(options);
    await assert.rejects(scanner.scan(Buffer.from('bytes')), { statusCode: 503 });
  }
  const { scanner, calls } = adapter();
  for (const bytes of ['', Buffer.alloc(0), Buffer.alloc(10 * 1024 * 1024 + 1)]) {
    await assert.rejects(scanner.scan(bytes), { statusCode: 400 });
  }
  assert.equal(calls.length, 0);
});

test('scanner readiness checks the configured executable and private root without running Defender or writing files', async () => {
  const { scanner, calls } = adapter();
  assert.deepEqual(await scanner.ready(), { root: temp, executable });
  assert.equal(calls.some(call => call[0] === 'execute' && call[1] === executable || call[0] === 'writeFile'), false);
  const unsafe = adapter({ realpath: value => value === temp ? 'C:\\other' : value });
  await assert.rejects(unsafe.scanner.ready(), /Unsafe scan root/);
});

test('unsafe root ACL, unknown ownership and missing restricted inheritance fail before bytes are written', async () => {
  for (const reason of ['broadPublicAllow','unknownOwner','missingInheritance']) {
    const { scanner, calls } = adapter({ aclResult: { exitCode: 0, stdout: JSON.stringify({ safe: false }) } });
    await assert.rejects(scanner.ready(), /private.*access|ACL/i, reason);
    await assert.rejects(scanner.scan(Buffer.from('bytes')), { statusCode: 503 });
    assert.equal(calls.some(call => call[0] === 'writeFile' || call[0] === 'mkdtemp'), false);
    assert.equal(calls.some(call => call[0] === 'execute' && call[1] === executable), false);
  }
});

test('ACL checks are fixed read-only bounded commands and reject unavailable or malformed success reports', async () => {
  const { scanner, calls } = adapter();
  await scanner.ready();
  const check = calls.find(call => call[0] === 'execute' && call[1] === powershell);
  assert.ok(check);
  assert.equal(check[3].shell, false);
  assert.equal(check[3].timeout, 10000);
  assert.equal(check[3].maxBuffer, 8192);
  assert.equal(check[3].env.PCN_SCAN_ACL_PATH, temp);
  assert.match(check[2].at(-1), /Get-Acl -LiteralPath \$env:PCN_SCAN_ACL_PATH/);
  assert.match(check[2].at(-1), /WindowsIdentity\]::GetCurrent\(\)\.User\.Value/);
  assert.match(check[2].at(-1), /S-1-5-18/);
  assert.match(check[2].at(-1), /S-1-5-32-544/);
  assert.match(check[2].at(-1), /ContainerInherit/);
  assert.match(check[2].at(-1), /ObjectInherit/);
  assert.doesNotMatch(check[2].at(-1), /Set-Acl|icacls|Invoke-Expression/);
  for (const options of [{ aclError: new Error('unavailable') }, { aclResult: { exitCode: 2, stdout: '{"safe":true}' } },
    { aclResult: { exitCode: 0, stdout: '{"safe":"true"}' } }, { aclResult: { exitCode: 0, stdout: '{"safe":true,"extra":1}' } },
    { aclResult: { exitCode: 0, stdout: 'unstructured' } }, { aclResult: {} }]) {
    const unsafe = adapter(options);
    await assert.rejects(unsafe.scanner.scan(Buffer.from('bytes')), { statusCode: 503 });
    assert.equal(unsafe.calls.some(call => call[0] === 'writeFile'), false);
  }
});

test('at most two scans retain work and the third is rejected before ACL, temporary files or subprocesses', async () => {
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const twoEntered = new Promise(resolve => { entered = resolve; });
  let aclCalls = 0;
  let block = true;
  const fixture = adapter({ async onAcl() {
    if (block) {
      aclCalls += 1;
      if (aclCalls === 2) entered();
      await gate;
    }
    return { exitCode: 0, stdout: '{"safe":true}' };
  } });
  const first = fixture.scanner.scan(Buffer.from('first'));
  const second = fixture.scanner.scan(Buffer.from('second'));
  await twoEntered;
  const callCount = fixture.calls.length;
  await assert.rejects(fixture.scanner.scan(Buffer.from('third')), { statusCode: 503 });
  assert.equal(fixture.calls.length, callCount);
  assert.equal(fixture.calls.some(call => call[0] === 'writeFile' || call[0] === 'mkdtemp'), false);
  block = false;
  release();
  assert.deepEqual(await Promise.all([first, second]), ['clean', 'clean']);
  assert.equal(await fixture.scanner.scan(Buffer.from('next')), 'clean');
});

test('failed readiness and cleanup always release concurrency capacity', async () => {
  for (const fixture of [adapter({ aclResult: { exitCode: 0, stdout: '{"safe":false}' } }), adapter({ cleanupError: true })]) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const callsBefore = fixture.calls.length;
      await assert.rejects(fixture.scanner.scan(Buffer.from('bytes')), { statusCode: 503 });
      assert.ok(fixture.calls.length > callsBefore);
    }
  }
});

function documentFixture(options = {}) {
  const { SqlDocuments } = require('../src/sqlDocuments');
  const version = '0000000000000001';
  const id = '00000000-0000-0000-0000-000000000001';
  const context = { version, user: { id, roles: ['supplier'], version, sessionSecurityStamp: id } };
  const calls = [];
  const request = () => {
    const inputs = {};
    return { input(name, type, value) { inputs[name] = value; return this; }, async query(statement) {
      calls.push({ statement, inputs });
      if (statement.includes('sys.sp_getapplock')) return { recordset: [{ LockResult: 0 }] };
      if (statement.startsWith('SELECT IsActive')) return { recordset: [{ IsActive: !options.revoked, SecurityStamp: id, AccessVersion: Buffer.from(version, 'hex') }] };
      if (statement.includes('FROM pcn.PcnRequests')) return { recordset: [{ PcnId: 1, PcnCode: 'PCN-2026-0001', OwnerUserId: id, Status: 'draft',
        RowVersion: Buffer.from(options.stale ? '0000000000000002' : version, 'hex'), LegacyExtrasJson: '{}' }] };
      if (statement.startsWith('SELECT ReviewJson')) return { recordsets: [[], [], [], [], [], []] };
      if (statement.includes('ORDER BY UploadedAt,Id')) return { recordset: [] };
      if (statement.includes('COUNT(*)')) return { recordset: [{ FileCount: 0, TotalBytes: 0 }] };
      if (statement.startsWith('UPDATE pcn.PcnRequests')) return { recordset: [{ RowVersion: Buffer.from('0000000000000002', 'hex') }] };
      if (statement.includes('FROM pcn.PcnRevisions')) return { recordset: [{ Revision: 1 }] };
      return { recordset: [], rowsAffected: [1] };
    } };
  };
  const db = { transaction() {
    return { request, async begin() { calls.push('begin'); }, async commit() { calls.push('commit'); }, async rollback() { calls.push('rollback'); } };
  } };
  const file = { fileName: 'safe.txt', contentType: 'text/plain', base64: Buffer.from('bytes').toString('base64'), scanStatus: 'clean' };
  return { calls, context, file, docs: new SqlDocuments(db, { scanner: options.scanner }) };
}

test('SQL default remains quarantined and client scanStatus cannot grant clean download status', async () => {
  const fixture = documentFixture();
  const result = await fixture.docs.save('PCN-2026-0001', fixture.file, fixture.context);
  assert.equal(result.scanStatus, 'pendingScan');
  assert.equal(fixture.calls.find(call => call.statement?.includes('INSERT pcn.PcnDocumentFiles')).inputs.scanStatus, 'pendingScan');
});

test('trusted scanner runs before SQL locks and only explicit clean results are inserted', async () => {
  let fixture;
  const scanner = { async scan(bytes) { assert.equal(fixture.calls.length, 0); assert.deepEqual(bytes, Buffer.from('bytes')); return 'clean'; } };
  fixture = documentFixture({ scanner });
  const result = await fixture.docs.save('PCN-2026-0001', fixture.file, fixture.context);
  assert.equal(result.scanStatus, 'clean');
  assert.equal(fixture.calls.find(call => call.statement?.includes('INSERT pcn.PcnDocumentFiles')).inputs.scanStatus, 'clean');
  for (const rejected of ['pendingScan', 'infected', undefined, { status: 'clean' }]) {
    const invalid = documentFixture({ scanner: { async scan() { return rejected; } } });
    await assert.rejects(invalid.docs.save('PCN-2026-0001', invalid.file, invalid.context), { statusCode: 503 });
    assert.equal(invalid.calls.length, 0);
  }
  const failed = documentFixture({ scanner: { async scan() { throw new Error('scanner failure path'); } } });
  await assert.rejects(failed.docs.save('PCN-2026-0001', failed.file, failed.context), { statusCode: 503 });
  assert.equal(failed.calls.length, 0);
});

test('SQL actor and document versions are revalidated after a successful scan', async () => {
  for (const options of [{ revoked: true, expected: 401 }, { stale: true, expected: 409 }]) {
    let scanned = false;
    const fixture = documentFixture({ ...options, scanner: { async scan() { scanned = true; return 'clean'; } } });
    await assert.rejects(fixture.docs.save('PCN-2026-0001', fixture.file, fixture.context), { statusCode: options.expected });
    assert.equal(fixture.calls.some(call => call.statement?.includes('INSERT pcn.PcnDocumentFiles')), false);
    assert.equal(fixture.calls.at(-1), 'rollback');
    assert.equal(scanned, true);
  }
});
