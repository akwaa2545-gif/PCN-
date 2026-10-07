const sql = require('mssql');
const { ApiError } = require('./apiError');
const { canSign } = require('./signingPermissions');
const { emailList } = require('./integrationService');

const USER_MAIL_ROUTING_LOCK = 'pcn:user-mail-routing';
const assignmentsKey = Symbol('verifiedUserMailAssignments');

async function lockUserMailRouting(tx, mode = 'Shared') {
  const result = await tx.request().input('resource', sql.NVarChar(255), USER_MAIL_ROUTING_LOCK)
    .input('mode', sql.NVarChar(32), mode).query(`DECLARE @result int;
      EXEC @result=sys.sp_getapplock @Resource=@resource,@LockMode=@mode,@LockOwner=N'Transaction',@LockTimeout=10000;
      IF @result<0 THROW 51004, 'User assignments are busy; retry the operation', 1; SELECT @result AS LockResult;`);
  if (result.recordset[0]?.LockResult < 0) throw new ApiError(409, 'User assignments are busy; retry the operation');
}

async function readUserMailAssignments(tx) {
  return readMailUsers(tx, true);
}

async function readGeneralNotificationUsers(tx) {
  return readMailUsers(tx, false);
}

async function readMailUsers(tx, signingOnly) {
  const rows = await tx.request().query(`SELECT u.Id,u.EmployeeCode,u.IsActive,u.IdentityProvider,u.DepartmentKey,u.SigningStep,
    u.Email,u.MailDirectoryId,u.MailVerifiedAt,u.MailProfileJson,ur.UserId,r.Name AS RoleName
    FROM pcn.Users u LEFT JOIN pcn.UserRoles ur ON ur.UserId=u.Id LEFT JOIN pcn.Roles r ON r.Id=ur.RoleId
    WHERE u.IsActive=1 AND u.IdentityProvider=N'employee-code' ${signingOnly ? 'AND u.SigningStep IS NOT NULL' : ''}
      AND u.MailVerifiedAt IS NOT NULL AND u.MailDirectoryId IS NOT NULL ORDER BY u.Id,r.Name;`);
  const users = rows.recordset.reduce((list, row) => {
    const previous = list.find(user => user.id === row.Id);
    let profile = null;
    try { profile = row.MailProfileJson ? JSON.parse(row.MailProfileJson) : null; } catch { /* Invalid profiles cannot receive managed mail. */ }
    const user = previous || { id: row.Id, employeeCode: row.EmployeeCode, isActive: Boolean(row.IsActive),
      identityProvider: row.IdentityProvider, department: row.DepartmentKey, signingStep: row.SigningStep,
      email: row.Email, mailDirectoryId: row.MailDirectoryId, mailVerifiedAt: row.MailVerifiedAt, mailProfile: profile, roles: [] };
    const updated = { ...user, roles: [...user.roles, ...(row.RoleName ? [row.RoleName] : [])] };
    return [...list.filter(entry => entry.id !== row.Id), updated];
  }, []);
  return users;
}

function managedRecipient(user) {
  if (user.identityProvider !== 'employee-code' || !user.isActive || !user.mailVerifiedAt || !user.mailDirectoryId
    || !user.mailProfile || user.mailProfile.id !== user.mailDirectoryId || !canSign(user, user.department, user.signingStep)) return null;
  try {
    const email = emailList(user.email);
    if (email.includes(';') || email.toLowerCase() !== String(user.mailProfile.email).toLowerCase()) return null;
    return { ...user.mailProfile, email, userId: user.id, employeeCode: user.employeeCode, signingStep: user.signingStep };
  } catch { return null; }
}

function applyUserMailRouting(settings, users) {
  const value = { ...settings };
  Object.defineProperty(value, assignmentsKey, { value: users });
  return value;
}

function getUserMailAssignments(settings) { return settings?.[assignmentsKey] || []; }

function mergedEmails(manual, automatic) {
  const values = [manual, ...automatic].flatMap(value => String(value || '').split(/[;,]/)).map(value => value.trim()).filter(Boolean);
  const unique = values.filter((value, index) => values.findIndex(entry => entry.toLowerCase() === value.toLowerCase()) === index);
  if (!unique.length) return '';
  return emailList(unique.join('; '));
}

function filterPendingRecipients(payload, users) {
  if (!payload.routingSnapshot) return payload;
  const { groupKey, manualEmails, automaticRecipients } = payload.routingSnapshot;
  const valid = (Array.isArray(automaticRecipients) ? automaticRecipients : []).filter(snapshot => {
    const user = users.find(entry => entry.id === snapshot.userId);
    const recipient = user && managedRecipient(user);
    return recipient && `department.${user.department}.${user.signingStep}` === groupKey
      && user.department === snapshot.department && user.signingStep === snapshot.signingStep
      && user.mailDirectoryId === snapshot.directoryId && recipient.email.toLowerCase() === String(snapshot.email).toLowerCase();
  });
  return { ...payload, to: mergedEmails(manualEmails, valid.map(entry => entry.email)) };
}

async function assertCurrentUser(tx, user) {
  if (!user) return; // Offline imports and internal maintenance do not have a browser principal.
  if (!user.id || !/^[a-f0-9]{16}$/i.test(user.version || '') || !user.sessionSecurityStamp) {
    throw new ApiError(401, 'Sign in again before saving');
  }
  const result = await tx.request().input('id', sql.UniqueIdentifier, user.id)
    .query('SELECT IsActive,SecurityStamp,AccessVersion FROM pcn.Users WHERE Id=@id');
  const current = result.recordset[0];
  if (!current?.IsActive || String(current.SecurityStamp).toLowerCase() !== String(user.sessionSecurityStamp).toLowerCase()
    || Buffer.from(current.AccessVersion || []).toString('hex') !== user.version.toLowerCase()) {
    throw new ApiError(401, 'User permissions changed; sign in again');
  }
}

module.exports = { USER_MAIL_ROUTING_LOCK, lockUserMailRouting, readUserMailAssignments, readGeneralNotificationUsers, managedRecipient,
  applyUserMailRouting, getUserMailAssignments, mergedEmails, filterPendingRecipients, assertCurrentUser };
