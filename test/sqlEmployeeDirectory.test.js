const test = require('node:test');
const assert = require('node:assert/strict');
const { SqlEmployeeDirectory } = require('../src/sqlEmployeeDirectory');

const employee = Object.freeze({ EmpCode: '001Ab', PersonFNameEng: 'Example', PersonLNameEng: 'Employee',
  PersonFNameThai: null, PersonLNameThai: null, PostNameEng: 'Engineer', OrgID: 'IT' });

function fixture(rows = [employee]) {
  const calls = [];
  const pool = { request() {
    const inputs = {};
    return { input(name, type, value) { inputs[name] = { type, value }; return this; },
      async query(query) {
        calls.push({ query, inputs });
        if (rows instanceof Error) throw rows;
        return { recordset: rows };
      } };
  } };
  return { directory: new SqlEmployeeDirectory(pool), calls };
}

test('employee source uses the fixed readonly table and a parameterized exact employee code', async () => {
  const { directory, calls } = fixture();
  assert.deepEqual(await directory.getByCode(' 001aB '), { employeeCode: '001Ab', displayName: 'Example Employee',
    email: null, sourceDepartment: 'IT', jobTitle: 'Engineer', isActive: true });
  assert.equal(calls[0].inputs.employeeCode.value, '001ab');
  assert.match(calls[0].query, /SELECT TOP \(2\)/i);
  assert.match(calls[0].query, /\[KEY_Code_DB\]\.\[dbo\]\.\[tblEmployee\]/);
  assert.match(calls[0].query, /=\s*@employeeCode/);
  assert.doesNotMatch(calls[0].query, /\b(?:INSERT|UPDATE|DELETE|MERGE|EXEC)\b/i);
  assert.equal(calls[0].query.includes('001ab'), false);
});

test('exact lookup rejects blank, malformed or overlong employee codes before SQL', async () => {
  const { directory, calls } = fixture();
  for (const code of [null, 123, '', '   ', 'code\\name', "' OR 1=1", 'A'.repeat(11), 'ชื่อ', 'A\nB', 'a b']) {
    await assert.rejects(directory.getByCode(code), { statusCode: 400 });
  }
  assert.equal(calls.length, 0);
});

test('missing employees return null while duplicates and mismatched identities fail closed', async () => {
  assert.equal(await fixture([]).directory.getByCode('001ab'), null);
  for (const rows of [[employee, { ...employee, EmpCode: '001AB' }], [{ ...employee, EmpCode: 'different' }]]) {
    await assert.rejects(fixture(rows).directory.getByCode('001ab'), { statusCode: 503 });
  }
});

test('employee search bounds results and escapes SQL LIKE wildcards as literal Unicode input', async () => {
  const { directory, calls } = fixture();
  assert.equal((await directory.search(' ชื่อ%_[~ ')).length, 1);
  const { query, inputs } = calls[0];
  assert.equal(inputs.searchTerm.value, '%ชื่อ~%~_~[~~%');
  assert.match(query, /SELECT TOP \(20\)/i);
  for (const column of ['EmpCode', 'PersonFNameEng', 'PersonLNameEng', 'PersonFNameThai', 'PersonLNameThai']) {
    assert.match(query, new RegExp(column));
  }
  assert.match(query, /LIKE @searchTerm ESCAPE N'~'/);
  assert.equal(query.includes('ชื่อ'), false);
});

test('search accepts a 100-character query and rejects malformed search input without SQL', async () => {
  const { directory, calls } = fixture([]);
  await directory.search('x'.repeat(100));
  for (const query of [null, 42, '', 'x', ' x ', 'x'.repeat(101), 'a\nb', 'a\u0000b']) {
    await assert.rejects(directory.search(query), { statusCode: 400 });
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].inputs.searchTerm.value.length, 102);
});

test('profiles prefer English names, fall back to Thai or employee code, and have no invented email', async () => {
  const thai = { ...employee, PersonFNameEng: null, PersonLNameEng: ' ', PersonFNameThai: 'สมชาย',
    PersonLNameThai: 'ทดสอบ', PostNameEng: null, OrgID: null };
  assert.deepEqual(await fixture([thai]).directory.getByCode('001Ab'), { employeeCode: '001Ab',
    displayName: 'สมชาย ทดสอบ', email: null, sourceDepartment: null, jobTitle: null, isActive: true });
  const unnamed = { ...thai, PersonFNameThai: null, PersonLNameThai: null };
  assert.equal((await fixture([unnamed]).directory.getByCode('001Ab')).displayName, '001Ab');
});

test('corrupt employee profiles and unexpected result sets fail closed instead of skipping records', async () => {
  for (const change of [{ EmpCode: null }, { EmpCode: 1 }, { EmpCode: 'a b' }, { OrgID: 42 },
    { OrgID: 'x'.repeat(11) }, { PersonFNameEng: 'x'.repeat(51) }, { PersonLNameThai: 'a\u0000b' },
    { PostNameEng: {} }]) {
    await assert.rejects(fixture([{ ...employee, ...change }]).directory.search('Ex'), { statusCode: 503 });
  }
  for (const rows of [null, {}, Array.from({ length: 21 }, () => employee), [employee, employee]]) {
    await assert.rejects(fixture(rows).directory.search('Ex'), { statusCode: 503 });
  }
});

test('SQL outages expose only a sanitized service error', async () => {
  const { directory } = fixture(new Error('private server password connection details'));
  for (const operation of [() => directory.search('Ex'), () => directory.getByCode('001Ab')]) {
    await assert.rejects(operation(), error => error.statusCode === 503 &&
      !/private|password|connection details/.test(error.message) && error.details === undefined);
  }
});
