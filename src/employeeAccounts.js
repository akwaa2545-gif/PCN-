const { ApiError } = require('./apiError');

const employeeDepartments = Object.freeze([
  { key: 'gscTet', label: 'GSC/TET' }, { key: 'prodEngTet', label: 'Prod.Eng/TET' },
  { key: 'qaTet', label: 'QA/TET' }, { key: 'gscTapbu', label: 'GSC/TaPBU' },
  { key: 'qaTapbu', label: 'QA/TaPBU' }, { key: 'it', label: 'IT' }, { key: 'other', label: 'Other' }
].map(Object.freeze));
const employeeRoles = Object.freeze(['admin', 'reviewer', 'supplier', 'gsc', 'productionengineering', 'qa', 'tapbu']);
const SAM_PATTERN = /^[A-Za-z0-9._-]{1,20}$/;

function normalizeAdObjectGuid(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new ApiError(400, 'Invalid directory identity');
  return value.toLowerCase();
}

function validateEmployeeIdentity(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new ApiError(400, 'Invalid employee identity');
  const employeeCode = profile.employeeCode ?? profile.samAccountName;
  if (typeof employeeCode !== 'string' || !SAM_PATTERN.test(employeeCode)) throw new ApiError(400, 'Invalid employee code');
  normalizeAdObjectGuid(profile.adObjectGuid ?? profile.directoryId);
  if (typeof profile.adSid !== 'string' || profile.adSid.length > 184 || !/^S-1-\d+(?:-\d+){1,15}$/.test(profile.adSid)) throw new ApiError(400, 'Invalid directory identity');
  if (profile.displayName != null && (typeof profile.displayName !== 'string' || profile.displayName.length > 200)) throw new ApiError(400, 'Invalid display name');
  if (profile.email != null && (typeof profile.email !== 'string' || profile.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email))) throw new ApiError(400, 'Invalid email address');
  if (profile.department != null && !employeeDepartments.some(entry => entry.key === profile.department)) throw new ApiError(400, 'Invalid department');
}

function validateEmployeeAccount(account) {
  validateEmployeeIdentity(account);
  if (typeof account.employeeCode !== 'string') throw new ApiError(400, 'Invalid employee code');
  normalizeAdObjectGuid(account.adObjectGuid);
  if (!employeeDepartments.some(entry => entry.key === account.department)) throw new ApiError(400, 'Invalid department');
  if (!Array.isArray(account.roles) || !account.roles.length || account.roles.some(role => !employeeRoles.includes(role))) throw new ApiError(400, 'Invalid user roles');
}

module.exports = { SAM_PATTERN, employeeDepartments, employeeRoles, normalizeAdObjectGuid, validateEmployeeIdentity, validateEmployeeAccount };
