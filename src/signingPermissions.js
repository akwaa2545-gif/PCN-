const { ApiError } = require('./apiError');

const actions = Object.freeze(['approved', 'checked', 'prepared']);
const departments = Object.freeze([
  { key: 'gscTet', label: 'GSC/TET' }, { key: 'prodEngTet', label: 'Prod.Eng/TET' },
  { key: 'qaTet', label: 'QA/TET' }, { key: 'gscTapbu', label: 'GSC/TaPBU' },
  { key: 'qaTapbu', label: 'QA/TaPBU' }
].map(Object.freeze));
const stageDepartments = Object.freeze({
  'signoff.gscTet': 'gscTet', 'signoff.prodEngTet': 'prodEngTet', 'signoff.qaTet': 'qaTet',
  'tapbu.gsc': 'gscTapbu', 'tapbu.qa': 'qaTapbu', 'qateFinal.signoff': 'qaTet'
});
const departmentRoles = Object.freeze({
  gscTet: 'gsc', prodEngTet: 'productionengineering', qaTet: 'qa',
  gscTapbu: 'tapbu', qaTapbu: 'tapbu'
});
const rolesOf = user => (Array.isArray(user?.roles) ? user.roles : []).map(role => String(role).replace(/[^a-z]/gi, '').toLowerCase());

function validateSigningAssignment({ roles, department, signingStep }) {
  if (signingStep === null || signingStep === undefined) return;
  if (!actions.includes(signingStep) || !Object.hasOwn(departmentRoles, department)) {
    throw new ApiError(400, 'Choose one signing step within a signing department');
  }
  const normalized = rolesOf({ roles });
  if (normalized.includes('supplier') || !['admin', 'reviewer', departmentRoles[department]].some(role => normalized.includes(role))) {
    throw new ApiError(400, 'The user role does not match the signing department');
  }
}

function canSign(user, department, action) {
  if (!user || user.isActive === false || !Object.hasOwn(departmentRoles, department) || !actions.includes(action)) return false;
  if (rolesOf(user).includes('admin')) return true;
  if (user.department !== department || user.signingStep !== action) return false;
  try { validateSigningAssignment(user); return true; } catch { return false; }
}

function signaturePath(path) {
  for (const [stage, department] of Object.entries(stageDepartments)) {
    if (!path.startsWith(`${stage}.`)) continue;
    const field = path.slice(stage.length + 1);
    const action = actions.find(value => [value, `${value}Name`, `${value}Date`].includes(field));
    if (action) return { department, action, stage, field };
  }
  return null;
}

module.exports = { actions, departments, stageDepartments, validateSigningAssignment, canSign, signaturePath };
