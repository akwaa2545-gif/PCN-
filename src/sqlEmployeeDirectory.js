const sql = require('mssql');
const { ApiError } = require('./apiError');

const EMPLOYEE_CODE_PATTERN = /^[a-zA-Z0-9._-]{1,10}$/;
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;
const EMPLOYEE_COLUMNS = 'EmpCode, PersonFNameEng, PersonLNameEng, PersonFNameThai, PersonLNameThai, PostNameEng, OrgID';
const EMPLOYEE_TABLE = '[KEY_Code_DB].[dbo].[tblEmployee]';
const SEARCH_SQL = `SELECT TOP (20) ${EMPLOYEE_COLUMNS} FROM ${EMPLOYEE_TABLE}
WHERE EmpCode LIKE @searchTerm ESCAPE N'~'
   OR PersonFNameEng LIKE @searchTerm ESCAPE N'~'
   OR PersonLNameEng LIKE @searchTerm ESCAPE N'~'
   OR PersonFNameThai LIKE @searchTerm ESCAPE N'~'
   OR PersonLNameThai LIKE @searchTerm ESCAPE N'~'
ORDER BY EmpCode;`;
const EXACT_SQL = `SELECT TOP (2) ${EMPLOYEE_COLUMNS} FROM ${EMPLOYEE_TABLE}
WHERE LOWER(LTRIM(RTRIM(EmpCode)))=@employeeCode;`;

function normalizeEmployeeCode(value) {
  if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value) || !EMPLOYEE_CODE_PATTERN.test(value.trim())) {
    throw new ApiError(400, 'Enter a valid employee code (maximum 10 characters)');
  }
  return value.trim();
}

function profileText(value, maxLength) {
  if (value === null) return '';
  if (typeof value !== 'string' || value.length > maxLength || CONTROL_CHARACTERS.test(value)) {
    throw new Error('Invalid employee profile');
  }
  return value.trim();
}

function normalizeEmployee(row) {
  if (!row || typeof row !== 'object') throw new Error('Invalid employee profile');
  const employeeCode = normalizeEmployeeCode(row.EmpCode);
  const englishName = [profileText(row.PersonFNameEng, 50), profileText(row.PersonLNameEng, 50)].filter(Boolean).join(' ');
  const thaiName = [profileText(row.PersonFNameThai, 50), profileText(row.PersonLNameThai, 50)].filter(Boolean).join(' ');
  return { employeeCode, displayName: englishName || thaiName || employeeCode, email: null,
    sourceDepartment: profileText(row.OrgID, 10) || null, jobTitle: profileText(row.PostNameEng, 50) || null,
    // The source has no enabled flag. PCN account grants determine whether this employee can sign in.
    isActive: true };
}

function escapeLikePattern(value) {
  return value.replace(/[~%_\[]/g, character => `~${character}`);
}

class SqlEmployeeDirectory {
  constructor(pool) {
    this.pool = pool;
  }

  async query(statement, parameter, type, value, limit) {
    try {
      const result = await this.pool.request().input(parameter, type, value).query(statement);
      if (!Array.isArray(result.recordset) || result.recordset.length > limit) throw new Error('Invalid employee result');
      const employees = result.recordset.map(normalizeEmployee);
      const codes = employees.map(employee => employee.employeeCode.toLowerCase());
      if (new Set(codes).size !== codes.length) throw new Error('Ambiguous employee code');
      return employees;
    } catch {
      throw new ApiError(503, 'Employee directory is unavailable. Try again later');
    }
  }

  async search(query) {
    if (typeof query !== 'string' || query.trim().length < 2 || query.length > 100 || CONTROL_CHARACTERS.test(query)) {
      throw new ApiError(400, 'Enter at least 2 characters for employee search (maximum 100)');
    }
    return this.query(SEARCH_SQL, 'searchTerm', sql.NVarChar(202), `%${escapeLikePattern(query.trim())}%`, 20);
  }

  async getByCode(value) {
    const code = normalizeEmployeeCode(value).toLowerCase();
    const employees = await this.query(EXACT_SQL, 'employeeCode', sql.NVarChar(10), code, 2);
    if (employees.length > 1 || (employees[0] && employees[0].employeeCode.toLowerCase() !== code)) {
      throw new ApiError(503, 'Employee directory is unavailable. Try again later');
    }
    return employees[0] || null;
  }
}

module.exports = { SqlEmployeeDirectory, normalizeEmployeeCode, EMPLOYEE_CODE_PATTERN };
