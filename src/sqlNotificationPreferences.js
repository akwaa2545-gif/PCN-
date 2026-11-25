const sql=require('mssql');
const crypto=require('node:crypto');
const {ApiError}=require('./apiError');
const {settingsVersion}=require('./mailRouting');
const {lockUserMailRouting,assertCurrentUser}=require('./userMailRouting');
const {hasRole}=require('./workflowAccess');
const {readNotificationPreferenceUsers}=require('./notificationPreferenceUsers');
const {readNotificationPreferences,validateNotificationPreferences,notificationPreferencesView,assertGroupExclusionCompatibility}=require('./notificationPreferences');

function storedSettings(row) {
  if(!row) return {};
  try {
    const settings=JSON.parse(row.SettingsJson);
    if(!settings || typeof settings!=='object' || Array.isArray(settings)) throw new Error('Invalid settings');
    readNotificationPreferences(settings);
    return settings;
  } catch {throw new ApiError(503,'Saved notification settings are invalid');}
}

class SqlNotificationPreferences {
  constructor(pool) {this.pool=pool;}
  async transaction(work) {
    const tx=this.pool.transaction();await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {const result=await work(tx);await tx.commit();return result;}
    catch(error) {try {await tx.rollback();} catch {/* Keep the original failure. */}throw error;}
  }
  async get(source) {
    const read=async tx=>{
      const result=await tx.request().query('SELECT SettingsJson FROM pcn.NotificationSettings WITH(HOLDLOCK) WHERE Id=1');
      return notificationPreferencesView(storedSettings(result.recordset[0]),await readNotificationPreferenceUsers(tx));
    };
    if(source)return read(source);
    return this.transaction(async tx=>{await lockUserMailRouting(tx);return read(tx);});
  }
  async save(input,actor,user) {
    const validated=validateNotificationPreferences(input);
    if(!user)throw new ApiError(401,'Sign in again before saving');
    return this.transaction(async tx=>{
      await lockUserMailRouting(tx,'Exclusive');
      await assertCurrentUser(tx,user);
      await this.assertAdministrator(tx,user.id);
      const result=await tx.request().query('SELECT SettingsJson FROM pcn.NotificationSettings WITH(UPDLOCK,HOLDLOCK) WHERE Id=1');
      const before=storedSettings(result.recordset[0]);
      if(settingsVersion(before)!==validated.version)throw new ApiError(409,'Notification settings changed; reload before saving');
      assertGroupExclusionCompatibility(validated,before);
      const users=await readNotificationPreferenceUsers(tx);
      const checked=validateNotificationPreferences(validated,users);
      const updatedBy=typeof actor==='string'?actor:`user:${user.id}`;
      const preferences=readNotificationPreferences({schemaVersion:1,rules:checked.rules,updatedAt:new Date().toISOString(),updatedBy});
      const after={...before,notificationPreferences:preferences};
      await tx.request().input('json',sql.NVarChar(sql.MAX),JSON.stringify(after)).query(`
        IF EXISTS(SELECT 1 FROM pcn.NotificationSettings WITH(UPDLOCK,HOLDLOCK) WHERE Id=1)
          UPDATE pcn.NotificationSettings SET SettingsJson=@json,UpdatedAt=SYSUTCDATETIME() WHERE Id=1;
        ELSE INSERT pcn.NotificationSettings(Id,SettingsJson) VALUES(1,@json);`);
      await tx.request().input('id',sql.NVarChar(128),crypto.randomUUID()).input('actor',sql.NVarChar(256),updatedBy)
        .input('metadata',sql.NVarChar(sql.MAX),JSON.stringify({before:readNotificationPreferences(before),after:preferences}))
        .query(`INSERT pcn.AuditLogs(Id,PcnCode,Action,Actor,MetadataJson,CreatedAt,SourceJson)
          VALUES(@id,N'notification-preferences',N'updated',@actor,@metadata,SYSUTCDATETIME(),NULL)`);
      return notificationPreferencesView(after,users);
    });
  }
  async assertAdministrator(tx,id) {
    const result=await tx.request().input('id',sql.UniqueIdentifier,id).query(`SELECT u.IsActive,u.DepartmentKey,u.SigningStep,r.Name AS RoleName
      FROM pcn.Users u LEFT JOIN pcn.UserRoles ur ON ur.UserId=u.Id LEFT JOIN pcn.Roles r ON r.Id=ur.RoleId WHERE u.Id=@id`);
    const row=result.recordset[0];
    const current=row && {isActive:Boolean(row.IsActive),department:row.DepartmentKey,signingStep:row.SigningStep,
      roles:result.recordset.map(entry=>entry.RoleName).filter(Boolean)};
    if(!current?.isActive || !hasRole(current,'admin'))throw new ApiError(403,'Administrator access required');
  }
}
module.exports={SqlNotificationPreferences};
