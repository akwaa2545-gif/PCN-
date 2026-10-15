const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {AuthService}=require('../src/authService');
const secret=crypto.randomBytes(24).toString('hex');
const password=crypto.randomBytes(24).toString('hex');
const actor={id:'administrator-id',roles:['admin'],isActive:true};
function fixture(provider='pcn-local',options={}){
 const profile={employeeCode:'1234567',displayName:'Developer Person',isActive:true};
 const mailProfile={id:'mail-id',email:'developer@example.com',displayName:'Developer Person'};
 const state={user:{id:'12345678-1234-1234-1234-123456789012',username:'1234567',employeeCode:'1234567',normalizedEmployeeCode:'1234567',identityProvider:provider,roles:['developer'],department:'developer',signingStep:null,isActive:true,securityStamp:'stamp',version:'0011223344556677',passwordHash:`fixture:${password}`,email:mailProfile.email,mailDirectoryId:mailProfile.id,mailVerifiedAt:'2026-10-14T00:00:00Z',mailProfile},sessions:[],writes:[],lookups:[],mailCalls:0,local:false};
 const save=async(kind,account)=>{state.writes=[...state.writes,{kind,account}];return {...state.user,...account};};
 const repository={async getUserByLogin(){return state.user;},async getUserByEmployeeCode(){return state.user;},async getUserById(){return state.user;},async saveSession(s){state.sessions=[...state.sessions,s];},async getSession(h){return state.sessions.find(s=>s.tokenHash===h);},async resetLoginFailures(){},async recordLoginFailure(){},async createEmployeeUser(a){return save('employee',a);},async createLocalEmployeeUser(a){return save('local',a);},async updateEmployeeAccount(id,a){return save('edit',a);},async createUser(a){return save('password',a);},async removeEmployeeRoles(){return save('remove',{roles:[],department:null});}};
 const directory={async getByCode(code){state.lookups=[...state.lookups,code];return state.local?null:profile;}};
 const service=new AuthService(repository,{authMode:provider==='password'?'password':'employee-code',employeeDirectory:directory,integrationService:{async directory(){state.mailCalls+=1;return {users:[mailProfile]};}},developerPasswordHash:`fixture:${secret}`,passwordHasher:async v=>`fixture:${v}`,passwordVerifier:async(h,v)=>h===`fixture:${v}`,...options});
 return {state,service,directory,body:provider==='password'?{username:'1234567',password}:{employeeCode:'1234567'}};
}
for(const provider of ['employee-code','pcn-local','password'])test(`${provider} Developer signs in normally without assignment password or configured hash`,async()=>{
 const {state,service,body}=fixture(provider,{developerPasswordHash:undefined});const login=await service.login(body);assert.deepEqual(login.user.roles,['developer']);assert.equal((await service.session(login.token)).user.department,'developer');assert.equal(state.sessions.length,1);await assert.rejects(service.login({...body,developerPassword:secret}),e=>e.statusCode===400);
});
test('Developer session survives restart and assignment-password configuration rotation',async()=>{
 const f=fixture();const login=await f.service.login(f.body);f.service.developerPasswordHash=undefined;assert.equal((await f.service.session(login.token)).user.id,f.state.user.id);const restarted=fixture('pcn-local',{developerPasswordHash:`fixture:${crypto.randomBytes(16).toString('hex')}`});restarted.state.sessions=[...f.state.sessions];restarted.state.user=f.state.user;assert.equal((await restarted.service.session(login.token)).user.id,f.state.user.id);
});
function operation(kind,f,extra={}){
 const {service,state,directory}=f;const base={roles:['developer'],department:'developer',signingStep:null,...extra};
 if(kind==='employee')return service.createEmployee({employeeCode:'1234567',...base},directory,'user:administrator-id',actor);
 if(kind==='local'){state.local=true;return service.createLocalEmployee({employeeCode:'1234567',displayName:'Developer Person',...base},directory,'user:administrator-id',actor);}
 if(kind==='edit')return service.updateEmployee({userId:state.user.id,isActive:true,version:state.user.version,...base},'user:developer-id',{...actor,roles:['developer'],department:'developer',signingStep:null});
 return service.createUser({username:'new-developer',password,...base},'user:administrator-id',actor);
}
for(const kind of ['employee','local','edit','password']){
 test(`${kind} Developer assignment requires password before directory, mail or persistence`,async()=>{
  const f=fixture();await assert.rejects(operation(kind,f),e=>e.statusCode===400&&e.code==='DEVELOPER_PASSWORD_REQUIRED');assert.equal(f.state.writes.length,0);assert.equal(f.state.lookups.length,0);assert.equal(f.state.mailCalls,0);
  await assert.rejects(operation(kind,f,{developerPassword:crypto.randomBytes(8).toString('hex')}),e=>e.statusCode===400&&e.code==='DEVELOPER_PASSWORD_INCORRECT');assert.equal(f.state.writes.length,0);assert.equal(f.state.lookups.length,0);assert.equal(f.state.mailCalls,0);
  const account=await operation(kind,f,{developerPassword:secret});assert.deepEqual(account.roles,['developer']);assert.equal(account.department,'developer');assert.equal(f.state.writes.length,1);assert.equal(JSON.stringify(f.state.writes).includes(secret),false);
 });
 test(`${kind} Developer assignment fails closed for missing or failing verifier`,async()=>{
  for(const options of [{developerPasswordHash:undefined},{passwordVerifier:async()=>{throw Error('private verifier');}}]){const f=fixture('pcn-local',options);await assert.rejects(operation(kind,f,{developerPassword:secret}),e=>e.statusCode===503&&!e.message.includes('private'));assert.equal(f.state.writes.length,0);assert.equal(f.state.lookups.length,0);}
 });
}
test('Developer assignment validates input and throttles actor across target accounts',async()=>{
 const f=fixture();for(const developerPassword of [123,null,{},'x'.repeat(129)])await assert.rejects(operation('edit',f,{developerPassword}),e=>e.statusCode===400);
 for(let i=0;i<5;i++){f.state.user={...f.state.user,id:crypto.randomUUID()};await assert.rejects(operation('edit',f,{developerPassword:crypto.randomBytes(8).toString('hex')}),e=>e.statusCode===400);}
 await assert.rejects(operation('edit',f,{developerPassword:secret}),e=>e.statusCode===429);assert.equal(f.state.writes.length,0);
});
test('Developer actor needs password to retain Developer access; demotion and role removal do not',async()=>{
 const f=fixture('pcn-local',{developerPasswordHash:undefined});await assert.rejects(operation('edit',f),e=>e.statusCode===400&&e.code==='DEVELOPER_PASSWORD_REQUIRED');assert.deepEqual((await operation('edit',f,{roles:['admin'],department:'it'})).roles,['admin']);assert.deepEqual((await f.service.removeEmployeeRoles({userId:f.state.user.id,version:f.state.user.version},'user:developer-id',{...actor,roles:['developer'],department:'developer',signingStep:null})).roles,[]);
});
test('malformed Developer pair cannot be assigned',async()=>{const f=fixture();for(const extra of [{department:'it'},{roles:['developer','admin']},{signingStep:'checked'}])await assert.rejects(operation('employee',f,{...extra,developerPassword:secret}),e=>e.statusCode===400);assert.equal(f.state.writes.length,0);});

test('password account creation forwards the original trusted actor principal after all password verification',async()=>{
 const f=fixture();const principal={...actor,version:'0011223344556677'};Object.defineProperty(principal,'sessionSecurityStamp',{value:'stamp'});
 let received;
 f.service.repository.createUser=async(account,actorName,user)=>{received={account,actorName,user};return {...f.state.user,...account};};
 await f.service.createUser({username:'new-developer',password,roles:['developer'],department:'developer',signingStep:null,developerPassword:secret},'user:administrator-id',principal);
 assert.equal(received.user,principal);assert.equal(received.user.sessionSecurityStamp,'stamp');assert.equal(received.actorName,'user:administrator-id');assert.equal(received.account.developerPassword,undefined);
});

test('Developer access must be removed before changing the linked employee identity',async()=>{
 const f=fixture('employee-code');let linked=false;
 f.service.repository.linkEmployeeIdentity=async()=>{linked=true;return f.state.user;};
 await assert.rejects(f.service.linkEmployee({userId:f.state.user.id,employeeCode:'7654321'},f.directory,'user:administrator-id',actor),e=>e.statusCode===409&&/Remove Developer access/.test(e.message));
 assert.equal(f.state.lookups.length,0);assert.equal(linked,false);
});

test('malformed Developer role, department or signing assignment cannot authenticate or reuse a session',async()=>{
 for(const provider of ['employee-code','pcn-local','password'])for(const change of [{department:'it'},{roles:['developer','admin']},{signingStep:'checked'}]){
  const f=fixture(provider);const login=await f.service.login(f.body);f.state.user={...f.state.user,...change};
  assert.equal(await f.service.session(login.token),null);
  await assert.rejects(f.service.login(f.body),error=>error.statusCode===401);
 }
});
