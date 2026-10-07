const { ApiError } = require('./apiError');
const { validateSigningAssignment } = require('./signingPermissions');
const employeeDepartments = Object.freeze([
  { key: 'gscTet', label: 'GSC/TET' }, { key: 'prodEngTet', label: 'Prod.Eng/TET' },
  { key: 'qaTet', label: 'QA/TET' }, { key: 'gscTapbu', label: 'GSC/TaPBU' },
  { key: 'qaTapbu', label: 'QA/TaPBU' }, { key: 'it', label: 'IT' }, { key: 'other', label: 'Other' }
].map(Object.freeze));
const employeeRoles = Object.freeze(['admin', 'reviewer', 'supplier', 'gsc', 'productionengineering', 'qa', 'tapbu']);
const EMPLOYEE_CODE_PATTERN = /^[A-Za-z0-9._-]{1,10}$/;
function normalizeUserId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new ApiError(400, 'Invalid user identity');
  return value.toLowerCase();
}
function normalizeEmployeeCode(value) {
  if (typeof value !== 'string' || !EMPLOYEE_CODE_PATTERN.test(value.trim())) throw new ApiError(400, 'Invalid employee code');
  return value.trim();
}
function validateEmployeeIdentity(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new ApiError(400, 'Invalid employee identity');
  normalizeEmployeeCode(profile.employeeCode);
  if (profile.displayName != null && (typeof profile.displayName !== 'string' || profile.displayName.length > 200)) throw new ApiError(400, 'Invalid display name');
  if (profile.email != null && (typeof profile.email !== 'string' || profile.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email))) throw new ApiError(400, 'Invalid email address');
  if (profile.department != null && !employeeDepartments.some(entry => entry.key === profile.department)) throw new ApiError(400, 'Invalid department');
}
function validateEmployeeAccount(account) {
  validateEmployeeIdentity(account);
  if (!employeeDepartments.some(entry => entry.key === account.department)) throw new ApiError(400, 'Invalid department');
  if (!Array.isArray(account.roles) || !account.roles.length || account.roles.some(role => !employeeRoles.includes(role))) throw new ApiError(400, 'Invalid user roles');
  validateUserAssignment(account);
}
function validateUserAssignment(account) {
  validateSigningAssignment(account);
}
function validateVerifiedMail(account) {
  const hasMail = account.mailDirectoryId != null || account.mailVerifiedAt != null || account.mailProfile != null;
  if (!hasMail) {
    if (account.signingStep != null) throw new ApiError(400,'Select a directory email for the signing step');
    return;
  }
  const profile = account.mailProfile;
  if (typeof account.mailDirectoryId !== 'string' || !account.mailDirectoryId.trim() || account.mailDirectoryId.length > 200
    || account.mailVerifiedAt == null || !Number.isFinite(new Date(account.mailVerifiedAt).getTime()) || !profile || typeof profile !== 'object' || Array.isArray(profile)
    || profile.id !== account.mailDirectoryId || typeof profile.email !== 'string'
    || typeof account.email !== 'string' || profile.email.toLowerCase() !== account.email.toLowerCase()) throw new ApiError(400,'Invalid verified directory email');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email) || account.email.length > 320) throw new ApiError(400,'Invalid verified directory email');
}
module.exports = { EMPLOYEE_CODE_PATTERN, employeeDepartments, employeeRoles, normalizeUserId, normalizeEmployeeCode, validateEmployeeIdentity, validateEmployeeAccount, validateUserAssignment, validateVerifiedMail };
