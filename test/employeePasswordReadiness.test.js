const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { assertEmployeePasswordReadiness, migrationChecksum } = require('../src/employeePasswordReadiness');
const checksum=crypto.createHash('sha256').update(fs.readFileSync(require('node:path').join(__dirname,'../sql/migrations/010_employee_password_auth.sql'))).digest('hex');
function pool(change={}) {
  const rows=[[{Checksum:checksum}],
    [{TableName:'Users',ColumnName:'PasswordSetAt',TypeName:'datetime2',Scale:3,MaxLength:8,Nullable:true},
      {TableName:'Sessions',ColumnName:'AuthenticationMethod',TypeName:'nvarchar',Scale:0,MaxLength:60,Nullable:true}],
    [{name:'CK_Users_EmployeeCodeAuthentication',is_disabled:false,is_not_trusted:false,
      definition:"IdentityProvider EmployeeCode NormalizedEmployeeCode AdObjectGuid AdSid PasswordHash PasswordSetAt employee-code pcn-local"},
      {name:'CK_Sessions_AuthenticationMethod',is_disabled:false,is_not_trusted:false,
        definition:"AuthenticationMethod IN ('password','employee-code','employee-password','password-setup')"}]];
  if(change.missingMigration)rows[0]=[];
  if(change.checksum)rows[0][0].Checksum='f'.repeat(64);
  if(change.column)rows[1][change.column.index]={...rows[1][change.column.index],...change.column.values};
  if(change.constraint)rows[2][0]={...rows[2][0],...change.constraint};
  if(change.missingConstraint)rows[2].pop();
  return {request:()=>({input(){return this;},async query(){return {recordsets:rows};}})};
}
test('employee-password readiness requires applied matching migration and expected credential columns/constraints',async()=>{
  assert.deepEqual(await assertEmployeePasswordReadiness(pool()),{ready:true,migration:'010_employee_password_auth.sql'});
  for(const change of [{missingMigration:true},{checksum:true},
    {column:{index:0,values:{TypeName:'nvarchar'}}},{column:{index:0,values:{Scale:0}}},
    {column:{index:1,values:{MaxLength:30}}},{column:{index:1,values:{Nullable:false}}},
    {missingConstraint:true},{constraint:{is_disabled:true}},{constraint:{is_not_trusted:true}},
    {constraint:{definition:'PasswordHash IS NULL'}}]) {
    await assert.rejects(assertEmployeePasswordReadiness(pool(change)),{statusCode:503});
  }
});

test('the runtime migration checksum matches the reviewed migration source',()=>{
  assert.equal(migrationChecksum,checksum);
});

test('packaged password readiness works without SQL files or filesystem dependencies',async()=>{
  const vm=require('node:vm');
  const source=fs.readFileSync(require('node:path').join(__dirname,'../src/employeePasswordReadiness.js'),'utf8');
  const packaged={exports:{}};
  vm.runInNewContext(source,{module:packaged,require(name){
    if(name==='mssql')return require('mssql');
    if(name==='./apiError')return require('../src/apiError');
    throw new Error(`Not shipped as a runtime dependency: ${name}`);
  }});
  const result=await packaged.exports.assertEmployeePasswordReadiness(pool());
  assert.equal(result.ready,true);assert.equal(result.migration,'010_employee_password_auth.sql');
});
