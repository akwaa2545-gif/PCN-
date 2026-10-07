const { spawn } = require('node:child_process');
const path = require('node:path');
const { ApiError } = require('./apiError');
const { SAM_PATTERN } = require('./windowsIdentity');
const { windowsPowerShellEnvironment } = require('./runtimeEnv');

const GUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SCRIPT_PATH = path.resolve(__dirname, '../scripts/ad-directory.ps1');
const MAX_OUTPUT = 256 * 1024;

function runDirectoryRequest(request, { spawnProcess = spawn, platform = process.platform, env = process.env, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    if (platform !== 'win32') return reject(new Error('Windows directory requires a Windows host'));
    const child = spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH], { windowsHide: true, env: windowsPowerShellEnvironment(env), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Directory request timed out')), timeoutMs);
    child.on('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      if (settled) return;
      output += data.toString('utf8');
      if (Buffer.byteLength(output) > MAX_OUTPUT) finish(new Error('Directory response too large'));
    });
    // Drain diagnostics without exposing domain infrastructure or employee data.
    child.stderr.on('data', () => {});
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) return finish(new Error('Directory request failed'));
      try { finish(null, JSON.parse(output.replace(/^\uFEFF/, ''))); } catch { finish(new Error('Invalid directory response')); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function normalizeEmployee(value) {
  if (!value || value.isActive !== true || typeof value.directoryId !== 'string' || !GUID_PATTERN.test(value.directoryId)
    || typeof value.adSid !== 'string' || value.adSid.length > 184 || !/^S-1-\d+(?:-\d+){1,15}$/.test(value.adSid)
    || typeof value.samAccountName !== 'string' || !SAM_PATTERN.test(value.samAccountName)) return null;
  const text = (field, length) => typeof value[field] === 'string' && value[field].length <= length && !/[\x00-\x1f\x7f]/.test(value[field]) ? value[field] : '';
  const email = text('email', 320);
  return {
    directoryId: value.directoryId.toLowerCase(), adSid: value.adSid,
    samAccountName: value.samAccountName, employeeCode: value.samAccountName,
    displayName: text('displayName', 200) || value.samAccountName,
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
    adDepartment: text('adDepartment', 100) || null, isActive: true
  };
}

class WindowsDirectoryService {
  constructor({ domain = 'KEMET.COM', runner = runDirectoryRequest } = {}) {
    if (typeof domain !== 'string' || !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/.test(domain)) throw new Error('Invalid directory domain');
    this.domain = domain;
    this.runner = runner;
    this.activeQueries = 0;
  }

  async query(operation, value) {
    if (this.activeQueries >= 4) throw new ApiError(503, 'Directory service is busy. Try again shortly');
    this.activeQueries += 1;
    try {
      const result = await this.runner({ domain: this.domain, operation, value, limit: operation === 'search' ? 20 : 2 });
      if (!Array.isArray(result) || result.length > (operation === 'search' ? 20 : 2)) throw new Error('Invalid directory result');
      const employees = result.map(normalizeEmployee).filter(Boolean);
      if (operation !== 'search' && employees.length > 1) throw new Error('Ambiguous directory account');
      return employees;
    } catch { throw new ApiError(503, 'Directory service is unavailable. Try again later'); }
    finally { this.activeQueries -= 1; }
  }

  async search(query) {
    if (typeof query !== 'string' || query.trim().length < 2 || query.length > 100 || /[\x00-\x1f\x7f]/.test(query)) throw new ApiError(400, 'Enter at least 2 characters for directory search (maximum 100)');
    return this.query('search', query.trim());
  }

  async getById(id) {
    if (typeof id !== 'string' || !GUID_PATTERN.test(id)) throw new ApiError(400, 'Select a valid directory employee');
    const employees = await this.query('id', id.toLowerCase());
    const person = employees[0];
    if (person && person.directoryId !== id.toLowerCase()) throw new ApiError(503, 'Directory service returned an unexpected employee');
    return person || null;
  }

  async getBySamAccountName(code) {
    if (typeof code !== 'string' || !SAM_PATTERN.test(code)) throw new ApiError(401, 'Windows account could not be verified');
    const employees = await this.query('sam', code);
    const person = employees[0];
    if (person && person.samAccountName.toLowerCase() !== code.toLowerCase()) throw new ApiError(503, 'Directory service returned an unexpected employee');
    return person || null;
  }
}

module.exports = { WindowsDirectoryService, runDirectoryRequest, normalizeEmployee, GUID_PATTERN };
