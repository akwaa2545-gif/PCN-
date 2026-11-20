// Retain inactive/unverified identities for exclusions; eligibility is applied by the policy.
async function readNotificationPreferenceUsers(source) {
  const result=await source.request().query(`SELECT u.Id,u.EmployeeCode,u.DisplayName,u.IsActive,u.IdentityProvider,u.DepartmentKey,u.SigningStep,
    u.Email,u.MailDirectoryId,u.MailVerifiedAt,u.MailProfileJson,r.Name AS RoleName
    FROM pcn.Users u LEFT JOIN pcn.UserRoles ur ON ur.UserId=u.Id LEFT JOIN pcn.Roles r ON r.Id=ur.RoleId
    WHERE u.IdentityProvider IN (N'employee-code',N'pcn-local') ORDER BY u.Id,r.Name;`);
  const grouped=new Map();
  for (const row of result.recordset) {
    let profile=null;
    try { profile=row.MailProfileJson ? JSON.parse(row.MailProfileJson) : null; } catch { /* Invalid profiles are ineligible for delivery. */ }
    const previous=grouped.get(row.Id);
    grouped.set(row.Id,previous ? {...previous,roles:[...previous.roles,...(row.RoleName ? [row.RoleName] : [])]} : {
      id:row.Id,employeeCode:row.EmployeeCode,displayName:row.DisplayName,isActive:Boolean(row.IsActive),identityProvider:row.IdentityProvider,
      department:row.DepartmentKey,signingStep:row.SigningStep,email:row.Email,mailDirectoryId:row.MailDirectoryId,
      mailVerifiedAt:row.MailVerifiedAt,mailProfile:profile,roles:row.RoleName ? [row.RoleName] : []
    });
  }
  return [...grouped.values()];
}
module.exports={readNotificationPreferenceUsers};
