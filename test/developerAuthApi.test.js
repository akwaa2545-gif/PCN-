const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../src/httpServer');
const { AuthService } = require('../src/authService');
const { memoryRepository } = require('./helpers/apiHarness');

test('HTTP Developer challenge has typed code and no cookie; accepted challenge creates session without leaking credential',async t=>{
  const secret=crypto.randomBytes(24).toString('hex');
  const user={id:crypto.randomUUID(),username:'1234567',employeeCode:'1234567',normalizedEmployeeCode:'1234567',identityProvider:'pcn-local',displayName:'Developer',roles:['developer'],department:'developer',isActive:true,securityStamp:crypto.randomUUID()};
  const sessions=[];
  const repository={async getUserByEmployeeCode(){return user;},async getUserById(){return user;},async saveSession(s){sessions.push(s);},async getSession(hash){return sessions.find(s=>s.tokenHash===hash);},async recordLoginFailure(){},async resetLoginFailures(){}};
  const authService=new AuthService(repository,{developerPasswordHash:`fixture:${secret}`,passwordVerifier:async(hash,value)=>hash===`fixture:${value}`});
  const app=createApp({repository:memoryRepository(),authService,authMode:'employee-code',publicOrigin:'http://localhost',secureCookies:false});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{app.close(resolve);app.closeAllConnections();}));
  async function login(body){return fetch(`http://127.0.0.1:${app.address().port}/api/auth/login`,{method:'POST',headers:{origin:'http://localhost','content-type':'application/json'},body:JSON.stringify(body)});}
  const challenged=await login({employeeCode:'1234567'});
  assert.equal(challenged.status,401);
  assert.equal((await challenged.json()).code,'DEVELOPER_PASSWORD_REQUIRED');
  assert.equal(challenged.headers.get('set-cookie'),null);
  assert.equal(sessions.length,0);
  const wrong=await login({employeeCode:'1234567',developerPassword:crypto.randomBytes(8).toString('hex')});
  assert.equal(wrong.status,401);
  assert.equal(wrong.headers.get('set-cookie'),null);
  const accepted=await login({employeeCode:'1234567',developerPassword:secret});
  assert.equal(accepted.status,200);
  assert.ok(accepted.headers.get('set-cookie'));
  const text=await accepted.text();
  assert.equal(text.includes(secret),false);
  assert.equal(text.includes('PasswordHash'),false);
  assert.deepEqual(JSON.parse(text).data.user.roles,['developer']);
});

test('maintenance Developer without an employee code retains department and Administrator authorization in the public session',async t=>{
  const secret=crypto.randomBytes(24).toString('hex');
  const accountPassword=crypto.randomBytes(24).toString('hex');
  const user={id:crypto.randomUUID(),username:'maintenance-developer',identityProvider:'password',displayName:'Developer',roles:['developer'],department:'developer',signingStep:null,isActive:true,securityStamp:crypto.randomUUID(),passwordHash:`fixture:${accountPassword}`};
  const sessions=[];
  const repository={async getUserByLogin(){return user;},async getUserById(){return user;},async saveSession(s){sessions.push(s);},async getSession(hash){return sessions.find(s=>s.tokenHash===hash);},async recordLoginFailure(){},async resetLoginFailures(){},async listUsers(){return [user];}};
  const authService=new AuthService(repository,{authMode:'password',developerPasswordHash:`fixture:${secret}`,passwordHasher:async value=>`fixture:${value}`,passwordVerifier:async(hash,value)=>hash===`fixture:${value}`});
  const app=createApp({repository:memoryRepository(),authService,authMode:'password',publicOrigin:'http://localhost',secureCookies:false});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{app.close(resolve);app.closeAllConnections();}));
  const base=`http://127.0.0.1:${app.address().port}`;
  const response=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{origin:'http://localhost','content-type':'application/json'},body:JSON.stringify({username:user.username,password:accountPassword,developerPassword:secret})});
  assert.equal(response.status,200);
  const cookie=response.headers.get('set-cookie').split(';')[0];
  const admin=await fetch(`${base}/api/admin/users`,{headers:{cookie}});
  assert.equal(admin.status,200);
  const session=await fetch(`${base}/api/session`,{headers:{cookie}});
  const body=await session.json();
  assert.equal(body.data.user.department,'developer');
  assert.equal(body.data.user.employeeCode,undefined);
  assert.deepEqual(body.data.user.roles,['developer']);
  assert.equal(JSON.stringify(body).includes(secret),false);
});
