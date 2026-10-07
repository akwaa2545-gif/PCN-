// Browser verification against isolated test adapters; never connects to SQL or sends email.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const http = require('node:http');
const {chromium} = require('@playwright/test');
const {createApp,createRequestHandler} = require('../src/httpServer');
const {PcnService} = require('../src/pcnService');
const {IntegrationService} = require('../src/integrationService');
const {memoryRepository,fakeAuthService,TEST_PASSWORD,unsignedPayload} = require('../test/helpers/apiHarness');
const {NotificationService} = require('../src/notificationService');
const {buildWorkflowNotificationMessage,buildPcnUpdateNotificationMessage} = require('../src/notificationTemplate');
const masterData = require('../src/masterData');

async function verifyPcnEmailLinks(browser, errors) {
  const repository=memoryRepository();
  repository.getMasterData=async()=>({...masterData,versionId:1});
  const service=new PcnService(repository,()=>new Date('2026-10-07T00:00:00.000Z'));
  const record=await service.create({...unsignedPayload,supplierName:'Direct link private fixture'},'isolated-fixture',{id:'000001-id',roles:['supplier']});
  assert.equal(record.id,'PCN-2026-0001');
  const passwordAuth=fakeAuthService({additionalUsers:[
    {username:'000001',employeeCode:'000001',roles:['supplier'],identityProvider:'employee-code'},
    {username:'000002',employeeCode:'000002',roles:['supplier'],identityProvider:'employee-code'}
  ]});
  const logins=[];
  // Only the isolated fixture translates employee codes into the existing fake session adapter.
  const authService={...passwordAuth,authMode:'employee-code',async login(body) {
    assert.deepEqual(Object.keys(body).sort(),['employeeCode','remember']);
    assert.match(body.employeeCode,/^00000[12]$/);
    logins.push(structuredClone(body));
    return passwordAuth.login({username:body.employeeCode,password:TEST_PASSWORD});
  }};
  const server=http.createServer();
  let context;
  let tracingStarted=false;
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const origin=`http://127.0.0.1:${server.address().port}`;
    server.on('request',createRequestHandler({repository,service,authService,rootDir:path.resolve(__dirname,'..'),secureCookies:false,publicOrigin:origin}));
    context=await browser.newContext({viewport:{width:1440,height:1100}});
    const page=await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror',error=>errors.push(error.message));
    const externalRequests=[];
    await context.route('**/*',route=>{
      if(new URL(route.request().url()).origin===origin) return route.continue();
      externalRequests.push(route.request().url());
      return route.abort();
    });
    await fs.mkdir(path.resolve('test-results'),{recursive:true});
    await context.tracing.start({screenshots:true,snapshots:true});
    tracingStarted=true;
    const notification=new NotificationService(null,{publicOrigin:origin});
    const pcnUrl=notification.pcnLink(record.id);
    assert.equal(pcnUrl,`${origin}/form.html?id=PCN-2026-0001`);
    const details={pcnUrl,completedGroup:'Supplier submission',nextGroup:'GSC/TET Prepared',nextDepartment:'GSC/TET',nextRole:'Prepared',updateSummary:'Supplier details updated'};
    const messages=[buildWorkflowNotificationMessage(record,details),buildPcnUpdateNotificationMessage(record,details)];
    const links=messages.map(message=>message.match(/<a href="([^"]+)"/)[1]);
    assert.deepEqual(links,[pcnUrl,pcnUrl],'Actual action-required and update email anchors point at the same PCN');
    const login=async(employeeCode)=>{
      await page.locator('#employeeLoginForm').waitFor({state:'visible'});
      await page.locator('#employeeCode').fill(employeeCode);
      await page.locator('#employeeLoginForm button[type=submit]').click();
      await page.waitForURL(pcnUrl);
    };
    const loaded=async()=>{
      await page.locator('#appNoticeTitle').filter({hasText:'PCN loaded'}).waitFor();
      assert.match(await page.locator('#appNoticeMessage').textContent(),/Loaded PCN-2026-0001/);
      assert.equal(await page.locator('#supplierName').inputValue(),record.supplierName);
      assert.equal(await page.locator('#submitButton').isDisabled(),false);
    };
    await page.goto(`${origin}/login?returnTo=${encodeURIComponent('/form.html?id=PCN-2026-0001')}`);
    await login('000001');
    await loaded();
    await page.goto(links[1]);
    await loaded();
    assert.equal(logins.length,1,'Authorized direct opening requires no second sign-in');
    await page.locator('#signOutButton').click();
    await page.waitForURL(`${origin}/login`);
    const signedOut=await page.request.get(`${origin}/api/pcns/${record.id}`);
    assert.equal(signedOut.status(),401,'Sign out removes access to the protected PCN API');
    await page.goto(links[0]);
    await page.waitForURL(`${origin}/login?returnTo=${encodeURIComponent('/form.html?id=PCN-2026-0001')}`);
    assert.equal(new URL(page.url()).searchParams.get('returnTo'),'/form.html?id=PCN-2026-0001');
    await login('000001');
    await loaded();
    assert.deepEqual(logins[1],{employeeCode:'000001',remember:false});
    await page.screenshot({path:path.resolve('test-results/pcn-email-link-loaded.png'),fullPage:true});
    await page.locator('#signOutButton').click();
    await page.waitForURL(`${origin}/login`);
    await page.goto(links[1]);
    const deniedResponse=page.waitForResponse(response=>response.url()===`${origin}/api/pcns/${record.id}`);
    await login('000002');
    const denied=await deniedResponse;
    assert.equal(denied.status(),404,'Normal ownership checks conceal another supplier PCN');
    assert.deepEqual((await denied.json()).error,'PCN not found');
    await page.locator('#appNoticeTitle').filter({hasText:'Unable to load PCN data'}).waitFor();
    assert.equal(await page.locator('#appNoticeMessage').textContent(),'PCN not found');
    assert.equal(await page.locator('#submitButton').isDisabled(),true);
    assert.equal(await page.getByText(record.supplierName,{exact:true}).count(),0,'Denied PCN details never render');
    assert.notEqual(await page.locator('#supplierName').inputValue(),record.supplierName);
    assert.deepEqual(externalRequests,[],'Direct-link browser checks stay on the isolated local server');
    await page.screenshot({path:path.resolve('test-results/pcn-email-link-denied.png'),fullPage:true});
    console.log(JSON.stringify({browser:'passed',checks:['real-action-and-update-email-pcn-anchors','authorized-query-link-direct-load','sign-out-revokes-pcn-api-access','signed-out-pcn-link-login-return','employee-code-login-loads-same-pcn','query-link-retains-normal-record-access-denial','denied-pcn-not-disclosed-or-editable'],storage:'isolated_test_adapters'}));
  } finally {
    try {
      if(tracingStarted) await context.tracing.stop({path:path.resolve('test-results/pcn-email-link-trace.zip')});
    } finally {
      try {
        if(context) await context.close();
      } finally {
        if(server.listening) await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
      }
    }
  }
}

async function verifySplitNotificationFeedback(browser, storageState, errors) {
  const context = await browser.newContext({storageState,viewport:{width:1440,height:1100}});
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror',error=>errors.push(error.message));
  let record;
  let writes=0;
  let refreshes=0;
  const requests=[];
  const outcomes=[
    {update:{queued:true},actionRequired:{queued:false,reason:'recipient_not_configured'}},
    {update:{queued:true},actionRequired:{queued:true,nextLabel:'GSC/TET Checked'}},
    {update:{queued:false,reason:'no_verified_recipients'},actionRequired:{queued:true,nextLabel:'GSC/TET Checked'}},
    {update:{queued:true},actionRequired:{queued:true,nextLabel:'GSC/TET Checked'}}
  ];
  try {
    await page.route('**/api/session',route=>route.fulfill({json:{success:true,data:{authenticated:true,
      user:{username:'browser-signer',displayName:'Browser Signer',roles:['reviewer'],department:'gscTet',signingStep:'prepared',isActive:true},csrfToken:'isolated-split-csrf'}}}));
    await page.route('**/api/pcns**',route=>{
      const request=route.request();
      const pathname=new URL(request.url()).pathname;
      requests.push({method:request.method(),path:pathname});
      if(request.method()==='GET') {
        if(pathname==='/api/pcns') {
          refreshes+=1;
          return route.fulfill({json:{success:true,data:record?[record]:[]}});
        }
        assert.equal(pathname,`/api/pcns/${record.id}`);
        return route.fulfill({json:{success:true,data:record}});
      }
      assert(['POST','PATCH'].includes(request.method()),'Only PCN saves are expected');
      assert.equal(pathname,writes===0?'/api/pcns':`/api/pcns/${record.id}`,'Split responses never trigger a legacy notification POST');
      const payload=request.postDataJSON();
      if(writes>0) assert.equal(payload.version,record.version,'Refresh supplies the current version before each write');
      const id='PCN-2026-9001';
      const next={...record,...payload,id,version:String(writes+1).padStart(16,'0'),mailRoutingPolicyVersion:2};
      record=writes===0?{...next,internalReview:{...next.internalReview,signoff:{...next.internalReview.signoff,
        gscTet:{...next.internalReview.signoff.gscTet,approved:true,checked:true,prepared:false}}}}:next;
      const notification=outcomes[writes++];
      assert(notification,'Unexpected extra PCN save');
      return route.fulfill({status:request.method()==='POST'?201:200,json:{success:true,data:{...record,notification}}});
    });
    await page.goto('http://127.0.0.1:3099/create');
    await page.locator('#submitButton:not([disabled])').waitFor();
    await page.locator('#supplierName').fill('Split notification browser fixture');
    await page.locator('#materialName').fill('Isolated notification material');
    const notice=page.locator('#appNoticeMessage');
    const assertNotice=async(title,expected)=>{
      await page.locator('#appNoticeTitle').filter({hasText:title}).waitFor();
      const message=await notice.textContent();
      for(const text of expected) assert(message.includes(text),`Missing notification feedback: ${text}`);
      assert.doesNotMatch(message,/\b(sent|delivered|delivery)\b/i,'Queue feedback does not claim delivery');
      assert.doesNotMatch(message,/policy|jobCount|nextGroupKey|mailRouting/i,'Notification internals stay out of the notice');
      assert.equal(await page.locator('#supplierName').inputValue(),record.supplierName,'Refresh preserves the saved PCN');
    };
    await page.locator('#submitButton').click();
    await assertNotice('PCN created',['PCN update emails queued.','Action-required email not queued: next-step recipients are not configured.']);
    const prepared=page.locator('.internal-check[data-internal-field="signoff.gscTet.prepared"]');
    await prepared.check();
    await page.locator('#submitButton').click();
    await assertNotice('PCN updated',['PCN update emails queued.','Action-required email queued for GSC/TET Checked.']);
    assert.equal(await prepared.isChecked(),true,'A saved signature survives the list refresh');
    await page.locator('#reason').fill('Verify independently blocked update recipients');
    const thirdWrite=page.waitForResponse(response=>response.url().endsWith(`/api/pcns/${record.id}`)&&response.request().method()==='PATCH');
    await page.locator('#submitButton').click();
    await thirdWrite;
    await notice.filter({hasText:'PCN update emails not queued'}).waitFor();
    await assertNotice('PCN updated',['PCN update emails not queued: no verified recipients have access to this PCN.','Action-required email queued for GSC/TET Checked.']);
    await page.getByRole('button',{name:'Workflow',exact:true}).click();
    const [workflowWrite]=await Promise.all([
      page.waitForRequest(request=>request.url().endsWith(`/api/pcns/${record.id}`)&&request.method()==='PATCH'),
      page.locator('#workflowSteps .is-active .workflow-check').click()
    ]);
    assert.deepEqual(workflowWrite.postDataJSON(),{status:'gsc_review',version:'0000000000000003'});
    await assertNotice('Workflow updated',['Current status is Gsc Review.','PCN update emails queued.','Action-required email queued for GSC/TET Checked.']);
    assert.equal(record.status,'gsc_review');
    assert.equal(writes,4);
    assert.equal(refreshes,5,'Every write refreshes the list without losing its notification summary');
    assert.equal(requests.filter(request=>request.path.includes('/notifications/')).length,0,'No legacy notification request is emitted');
  } finally {
    await context.close();
  }
}

async function main() {
  const repository = memoryRepository();
  let directoryConfigured=true;
  await repository.saveNotificationSettings({groups:[{key:'signoff.gscTet',label:'GSC/TET',emails:'legacy@example.test',recipients:[{email:'legacy@example.test',displayName:'Legacy Contact'}]}]});
  repository.getMasterData = async()=>({...masterData,versionId:1});
  class BrowserPcnService extends PcnService {
    async getNotificationSettings() { return {...await super.getNotificationSettings(),directoryConfigured}; }
  }
  let configuration='configured';
  let healthError=false;
  let healthGate=null;
  let workerHealth={worker:{lastCheckedAt:null,lastOutcome:null},queue:{pending:2,sending:1,accepted:3,uncertain:0,latestAcceptedAt:null}};
  let healthReads=0;
  const outbound=[];
  const directoryRequests=[];
  let releasePendingLookup;
  let observePendingLookup;
  let finishPendingLookup;
  const pendingLookupGate=new Promise(resolve=>{releasePendingLookup=resolve;});
  const pendingLookupStarted=new Promise(resolve=>{observePendingLookup=resolve;});
  const pendingLookupFinished=new Promise(resolve=>{finishPendingLookup=resolve;});
  let releaseBlurLookup;
  let observeBlurLookup;
  const blurLookupGate=new Promise(resolve=>{releaseBlurLookup=resolve;});
  const blurLookupStarted=new Promise(resolve=>{observeBlurLookup=resolve;});
  const directoryPhoto='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHfkAAAAASUVORK5CYII=';
  const directoryProfile={id:'browser-reviewer',displayName:'Browser Reviewer',mail:'reviewer@example.test',jobTitle:'Quality Reviewer',department:'Supplier Quality',photo:directoryPhoto};
  const directoryAdapter=new IntegrationService({
    directoryUrl:'https://directory.example.test/search',allowedHosts:['directory.example.test'],
    fetchImpl:async(endpoint,options)=>{
      assert.equal(endpoint,'https://directory.example.test/search');
      assert.equal(options.method,'POST');
      assert.equal(options.redirect,'error');
      const payload=JSON.parse(options.body);
      assert.deepEqual(payload,{query:payload.query,searchTerm:payload.query});
      if(payload.query==='Lookup Failure') throw new Error('Expected isolated directory failure');
      if(payload.query==='Removal Reviewer') return new Response(JSON.stringify({users:[{...directoryProfile,displayName:'Removal Reviewer',mail:'remove@example.test'}]}));
      if(payload.query==='Prepared Reviewer') return new Response(JSON.stringify({users:[{...directoryProfile,displayName:'Prepared Reviewer',mail:'prepared@example.test'}]}));
      if(payload.query==='Remove Pending') {
        observePendingLookup();
        await pendingLookupGate;
        finishPendingLookup();
        return new Response(JSON.stringify({users:[directoryProfile]}));
      }
      if(payload.query==='Blur Pending') {
        observeBlurLookup();
        await blurLookupGate;
        return new Response(JSON.stringify({users:[directoryProfile]}));
      }
      if(payload.query!=='Browser Reviewer') return new Response(JSON.stringify({users:[]}));
      assert.deepEqual(payload,{query:'Browser Reviewer',searchTerm:'Browser Reviewer'});
      directoryRequests.push(payload);
      // Exercise both response envelopes used by the original Power Automate directory flow.
      const envelope=directoryRequests.length%2===1?'results':'users';
      return new Response(JSON.stringify({[envelope]:[directoryProfile]}));
    }
  });
  const integrationService={
    mailConfigurationStatus:()=>configuration,
    directory:query=>directoryAdapter.directory(query),
    async testMail() { outbound.push('test-mail'); throw new Error('Unexpected outbound email'); }
  };
  const notificationWorker={async health() {
    healthReads+=1;
    if(healthGate) await healthGate;
    if(healthError) throw new Error('PRIVATE_DIAGNOSTIC_MARKER');
    return structuredClone(workerHealth);
  }};
  const server = createApp({repository,service:new BrowserPcnService(repository),integrationService,notificationWorker,authService:fakeAuthService(),rootDir:path.resolve(__dirname,'..'),publicOrigin:'http://127.0.0.1:3099',secureCookies:false});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(3099,'127.0.0.1',resolve);});
  let browser;
  try {
    browser = await chromium.launch({headless:true});
    const page = await browser.newPage({viewport:{width:1440,height:1100}});
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(15000);
    const errors=[];
    const notificationRequests=[];
    page.on('pageerror',error=>errors.push(error.message));
    let provisioningAuthMode='password';
    await page.route('**/api/auth/config',route=>route.fulfill({json:{success:true,data:{mode:provisioningAuthMode,employeeProvisioningConfigured:true}}}));
    page.on('request',request=>{
      if(request.url().includes('/api/admin/notifications/')) notificationRequests.push({method:request.method(),path:new URL(request.url()).pathname});
    });
    await page.goto('http://127.0.0.1:3099/login?returnTo=%2Fadmin%23mail-routing');
    await page.locator('#loginForm').waitFor({state:'visible'});
    assert.equal(await page.locator('#authRetryButton').isVisible(),false,'Healthy password sign-in hides setup retry');
    await page.locator('#username').fill('temporary');
    await page.locator('#password').fill(TEST_PASSWORD);
    await page.locator('#loginForm button').click();
    await page.locator('#passwordChangeForm').waitFor({state:'visible'});
    await page.locator('#currentPassword').fill(TEST_PASSWORD);
    await page.locator('#newPassword').fill('5678');
    await page.locator('#confirmPassword').fill('5678');
    await page.locator('#passwordChangeForm button[type=submit]').click();
    await page.locator('#loginForm').waitFor({state:'visible'});
    await page.locator('#username').fill('temporary');
    await page.locator('#password').fill('5678');
    await page.locator('#loginForm button').click();
    await page.waitForURL('**/admin#mail-routing');
    await page.locator('[data-notification-group]').first().waitFor();
    const emails=await page.locator('[data-recipient-email]').evaluateAll(inputs=>inputs.map(input=>input.value));
    assert.equal(emails.length,0,'Empty lists do not create recipient input fields');
    assert(emails.every(email=>email===''));
    assert.equal(await page.locator('#notificationReloadButton').isVisible(),false,'Reload is offered only after a conflict');
    assert.equal(await page.locator('.notification-department').count(),5);
    for(const department of ['gscTet','prodEngTet','qaTet','gscTapbu','qaTapbu']) {
      assert.deepEqual(await page.locator(`[data-department="${department}"] [data-notification-group]`).evaluateAll(groups=>groups.map(group=>group.dataset.notificationGroup)),['approved','checked','prepared'].map(action=>`department.${department}.${action}`));
    }
    assert.match(await page.locator('[data-department=qaTet]').textContent(),/initial review and final judgment/);
    assert.equal(await page.locator('#notificationGroups [data-notification-group="qateFinal.signoff"]').count(),0);
    const legacySource=page.locator('[data-legacy-source="signoff.gscTet"]');
    assert.match(await legacySource.textContent(),/legacy@example.test/);
    assert.equal(await legacySource.locator('input').count(),0,'Legacy contacts are read-only');
    assert.equal(await page.locator('#notificationHealthRefreshButton').count(),1,'Health refresh replaces outbound test email');
    await page.locator('#notificationHealthStatus').filter({hasText:'Ready'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Test Email',exact:true}).count(),0);
    assert.equal(await page.locator('#mailRoutingView input[type=url]').count(),0);
    assert.equal(await page.locator('[data-recipient-email]:enabled').count(),0);
    assert.equal(await page.locator('#notificationHealthTitle').textContent(),'Mail service');
    assert.equal(await page.getByRole('button',{name:'Check status',exact:true}).count(),1);
    assert.equal(await page.locator('#notificationHealthPanel dl, #notificationHealthPanel p').count(),0,'Mail service has a compact status without metrics or delivery text');
    assert.equal(await page.locator('#notificationHealthStatus').getAttribute('aria-atomic'),'true');
    assert.equal(await page.locator('[data-recipient-count]').filter({hasText:'0 recipients'}).count(),16);
    await page.locator('#notificationSaveButton').click();
    await page.locator('#mailRoutingMessage').filter({hasText:'Mail routing saved.'}).waitFor();
    assert.equal((await repository.getNotificationSettings()).groups.length,16,'Empty groups can be saved without input fields');
    assert.equal(await page.locator('[data-recipient-email]').count(),0);
    const approvedList=page.locator('#notificationGroups [data-notification-group="department.gscTet.approved"]');
    const approvedAdd=approvedList.getByRole('button',{name:'Add recipient to GSC/TET Approved'});
    const popup=page.locator('#notificationRecipientDialog');
    const popupInput=popup.locator('input[type=text]');
    const confirmRecipient=popup.getByRole('button',{name:'Add recipient',exact:true});
    const cancelRecipient=popup.getByRole('button',{name:'Cancel',exact:true});
    await approvedAdd.click();
    await popup.waitFor({state:'visible'});
    assert.equal(await page.locator('#notificationRecipientTitle').textContent(),'GSC/TET \u2014 Approved');
    assert.equal(await page.locator('#notificationGroups input[type=text]').count(),0,'List cards never display inline text fields');
    assert.equal(await popupInput.count(),1);
    assert.equal(await popupInput.evaluate(input=>document.activeElement===input),true);
    assert.equal(await confirmRecipient.isDisabled(),true);
    await popupInput.fill('typed@example.test');
    assert.equal(await confirmRecipient.isDisabled(),true,'A typed valid email is not a directory selection');
    await confirmRecipient.dispatchEvent('click');
    assert.equal(await approvedList.locator('[data-recipient-email]').count(),0,'Forced confirmation cannot bypass directory selection');
    await page.locator('#notificationRecipientValidation').filter({hasText:'No directory match.'}).waitFor();
    assert.equal(await confirmRecipient.isDisabled(),true);
    await popupInput.fill('Lookup Failure');
    await page.locator('#notificationRecipientValidation').filter({hasText:'Directory lookup is unavailable.'}).waitFor();
    assert.equal(await confirmRecipient.isDisabled(),true);
    await cancelRecipient.click();
    await popup.waitFor({state:'hidden'});
    assert.equal(await approvedList.locator('[data-recipient-email]').count(),0,'Cancel leaves the target list unchanged');
    assert.equal(await approvedAdd.evaluate(button=>document.activeElement===button),true);
    directoryConfigured=false;
    await page.reload();
    await approvedAdd.waitFor();
    await approvedAdd.click();
    await popupInput.fill('typed@example.test');
    assert.equal(await confirmRecipient.isDisabled(),true,'Unconfigured directory lookup cannot permit free text');
    await confirmRecipient.dispatchEvent('click');
    assert.equal(await approvedList.locator('[data-recipient-email]').count(),0);
    await cancelRecipient.click();
    directoryConfigured=true;
    await page.reload();
    await approvedAdd.waitFor();
    await approvedAdd.click();
    await page.keyboard.press('Escape');
    await popup.waitFor({state:'hidden'});
    assert.equal(await approvedList.locator('[data-recipient-email]').count(),0,'Escape leaves routing unchanged');
    assert.equal(await approvedAdd.evaluate(button=>document.activeElement===button),true);
    const pendingList=page.locator('#notificationGroups [data-notification-group="department.qaTet.approved"]');
    await pendingList.getByRole('button',{name:'Add recipient to QA/TET Approved'}).click();
    assert.equal(await page.locator('#notificationRecipientTitle').textContent(),'QA/TET \u2014 Approved');
    await popupInput.fill('Remove Pending');
    let pendingTimeout;
    try { await Promise.race([pendingLookupStarted,new Promise((resolve,reject)=>{pendingTimeout=setTimeout(()=>reject(new Error('Pending directory lookup did not start')),15000);})]); }
    finally { clearTimeout(pendingTimeout); }
    assert.match(await page.locator('#notificationRecipientValidation').textContent(),/Searching directory/);
    await popupInput.focus();
    await page.keyboard.press('Escape');
    assert.equal(await popup.isVisible(),true,'Escape dismisses active directory results before closing the dialog');
    await popup.locator('.directory-suggestions').waitFor({state:'hidden'});
    releasePendingLookup();
    await pendingLookupFinished;
    assert.equal(await popup.locator('.directory-suggestion:not(.is-message)').count(),0,'A dismissed lookup cannot reopen after its late response');
    await cancelRecipient.click();
    await popup.waitFor({state:'hidden'});
    assert.equal(await pendingList.locator('[data-recipient-email]').count(),0,'Cancelling a lookup adds no recipient');
    await pendingList.getByRole('button',{name:'Add recipient to QA/TET Approved'}).click();
    await popupInput.fill('Blur Pending');
    try { await Promise.race([blurLookupStarted,new Promise((resolve,reject)=>{pendingTimeout=setTimeout(()=>reject(new Error('Blur directory lookup did not start')),15000);})]); }
    finally { clearTimeout(pendingTimeout); }
    const blurResponse=page.waitForResponse(response=>response.url().includes('/api/admin/directory-users?query=Blur%20Pending'));
    await cancelRecipient.focus();
    releaseBlurLookup();
    await blurResponse;
    await popup.locator('.directory-suggestions').waitFor({state:'hidden'});
    assert.equal(await popup.locator('.directory-suggestion:not(.is-message)').count(),0,'Late results do not reopen an unfocused search');
    await cancelRecipient.click();
    await popup.waitFor({state:'hidden'});
    await approvedAdd.click();
    for(const separator of [';',',']) {
      const multiAddress='first@example.test'+separator+'second@example.test';
      await popupInput.fill(multiAddress);
      await popupInput.dispatchEvent('paste');
      assert.equal(await popupInput.count(),1);
      assert.equal(await popupInput.inputValue(),multiAddress);
      assert.equal(await confirmRecipient.isDisabled(),true,'Multiple addresses cannot be confirmed');
      assert.equal(await approvedList.locator('[data-recipient-email]').count(),0);
    }
    await fs.mkdir(path.resolve('test-results'),{recursive:true});
    for(let lookup=0;lookup<2;lookup+=1) {
      await popupInput.fill('  Browser Reviewer  ');
      const suggestion=popup.locator('.directory-suggestion').filter({hasText:'reviewer@example.test'});
      await suggestion.waitFor({state:'visible'});
      assert.match(await page.locator('#notificationRecipientValidation').textContent(),/1 directory result/,'Result counts are announced inside the modal');
      assert.equal(await popupInput.count(),1,'Directory search keeps one dialog input');
      assert.equal(await approvedList.locator('[data-recipient-email]').count(),0,'Selecting happens before committing the popup');
      assert.equal(await popup.locator('.notification-person').evaluate(row=>parseFloat(getComputedStyle(row).marginBottom)),8);
      assert.equal(await suggestion.locator('.directory-suggestion-position').textContent(),'Quality Reviewer - Supplier Quality');
      assert.equal(await suggestion.locator('img').getAttribute('src'),directoryPhoto);
      await suggestion.locator('img').evaluate(image=>image.decode());
      if(lookup===0) await page.screenshot({path:path.resolve('test-results/directory-suggestions-browser-smoke.png'),fullPage:true});
      if(lookup===0) await suggestion.click();
      else { await popupInput.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); }
      assert.equal(await popupInput.inputValue(),'reviewer@example.test');
      assert.equal(await confirmRecipient.isEnabled(),true);
      assert.equal(await popup.locator('.notification-person-meta').textContent(),'Quality Reviewer - Supplier Quality');
    }
    assert.equal(directoryRequests.length,2);
    await popupInput.dispatchEvent('input');
    assert.equal(await confirmRecipient.isDisabled(),true,'Any input event clears selection even when the email value is unchanged');
    await confirmRecipient.dispatchEvent('click');
    assert.equal(await approvedList.locator('[data-recipient-email]').count(),0);
    await popupInput.fill('Browser Reviewer');
    const reselected=popup.locator('.directory-suggestion').filter({hasText:'reviewer@example.test'});
    await reselected.waitFor({state:'visible'});
    await reselected.click();
    assert.equal(await confirmRecipient.isEnabled(),true);
    await confirmRecipient.click();
    await popup.waitFor({state:'hidden'});
    const firstRecipient=approvedList.locator('[data-recipient-email]');
    assert.equal(await firstRecipient.inputValue(),'reviewer@example.test');
    assert.equal(await firstRecipient.getAttribute('type'),'hidden','Saved contacts have no visible input');
    assert.equal(await approvedList.locator('.notification-person-email').textContent(),'reviewer@example.test');
    assert.equal(await approvedList.locator('.notification-person-avatar img').getAttribute('src'),directoryPhoto);
    assert.equal(await approvedAdd.evaluate(button=>document.activeElement===button),true);
    await approvedAdd.click();
    await popupInput.fill('Browser Reviewer');
    const duplicateRecipient=popup.locator('.directory-suggestion').filter({hasText:'reviewer@example.test'});
    await duplicateRecipient.waitFor({state:'visible'});
    await duplicateRecipient.click();
    assert.equal(await confirmRecipient.isDisabled(),true);
    assert.match(await page.locator('#notificationRecipientValidation').textContent(),/already/);
    await cancelRecipient.click();
    await popup.waitFor({state:'hidden'});
    assert.equal(await approvedList.locator('[data-recipient-email]').count(),1);
    const removeList=page.locator('#notificationGroups [data-notification-group="department.qaTet.checked"]');
    await removeList.getByRole('button',{name:'Add recipient to QA/TET Checked'}).click();
    assert.equal(await page.locator('#notificationRecipientTitle').textContent(),'QA/TET \u2014 Checked');
    await popupInput.fill('Removal Reviewer');
    await popup.locator('.directory-suggestion').filter({hasText:'remove@example.test'}).click();
    await confirmRecipient.click();
    await popup.waitFor({state:'hidden'});
    await removeList.getByRole('button',{name:'Remove remove@example.test from QA/TET Checked'}).click();
    assert.equal(await removeList.locator('[data-recipient-email]').count(),0);
    assert.equal(await removeList.locator('.notification-add-button').evaluate(button=>document.activeElement===button),true);
    const supplierList=page.locator('#notificationGroups [data-notification-group="supplierNotification"]');
    await supplierList.locator('.notification-add-button').click();
    assert.equal(await page.locator('#notificationRecipientTitle').textContent(),'GSC/TET Supplier Notification');
    await cancelRecipient.click();
    await popup.waitFor({state:'hidden'});
    await page.locator('#adminRecordsButton').click();
    await page.locator('#adminMailRoutingButton').click();
    assert.equal(await firstRecipient.inputValue(),'reviewer@example.test');
    assert.equal(await page.locator('#notificationGroups input[type=text]').count(),0);
    const checkedList=page.locator('#notificationGroups [data-notification-group="department.gscTet.checked"]');
    await legacySource.locator('select').selectOption('department.gscTet.checked');
    page.once('dialog',dialog=>dialog.accept());
    await legacySource.getByRole('button',{name:'Copy contacts to list from GSC/TET'}).click();
    assert.equal(await checkedList.locator('input').inputValue(),'legacy@example.test');
    assert.equal(await firstRecipient.inputValue(),'reviewer@example.test','Copy affects only the selected step list');
    page.once('dialog',dialog=>dialog.accept());
    await legacySource.getByRole('button',{name:'Copy contacts to list from GSC/TET'}).click();
    assert.equal(await checkedList.locator('input').count(),1,'Copy merges duplicate contacts');
    assert.match(await legacySource.textContent(),/legacy@example.test/);
    for(const [status,label] of [['not_configured','Not configured'],['invalid','Needs attention'],['configured','Ready']]) {
      configuration=status;
      await page.locator('#notificationHealthRefreshButton').click();
      await page.locator('#notificationHealthStatus').filter({hasText:label}).waitFor();
      assert.equal(await firstRecipient.inputValue(),'reviewer@example.test','Health refresh preserves recipient edits');
    }
    for(const [outcome,uncertain] of [['error',0],['uncertain',0],['idle',1]]) {
      workerHealth={...workerHealth,worker:{...workerHealth.worker,lastOutcome:outcome},queue:{...workerHealth.queue,uncertain}};
      await page.locator('#notificationHealthRefreshButton').click();
      await page.locator('#notificationHealthStatus').filter({hasText:'Needs attention'}).waitFor();
      assert.equal(await firstRecipient.inputValue(),'reviewer@example.test');
    }
    let releaseHealth;
    healthGate=new Promise(resolve=>{releaseHealth=resolve;});
    await page.locator('#notificationHealthRefreshButton').focus();
    await page.keyboard.press('Enter');
    await page.locator('#notificationHealthPanel[aria-busy=true]').waitFor();
    assert.equal(await page.locator('#notificationHealthStatus').textContent(),'Checking...');
    assert.equal(await page.locator('#notificationHealthRefreshButton').isDisabled(),true);
    assert.equal(await firstRecipient.isEnabled(),true);
    workerHealth={...workerHealth,worker:{lastCheckedAt:'2026-10-06T01:02:03.000Z',lastOutcome:'accepted'},queue:{...workerHealth.queue,uncertain:0,latestAcceptedAt:'2026-10-06T01:02:03.000Z'}};
    healthGate=null;
    releaseHealth();
    await page.locator('#notificationHealthPanel[aria-busy=false]').waitFor();
    assert.equal(await page.locator('#notificationHealthStatus').textContent(),'Ready');
    await page.locator('#notificationSaveButton').click();
    await page.locator('#mailRoutingMessage').filter({hasText:'Mail routing saved.'}).waitFor();
    const savedRouting=(await repository.getNotificationSettings()).groups[0];
    assert.equal(savedRouting.emails,'reviewer@example.test');
    assert.deepEqual(savedRouting.recipients,[{email:'reviewer@example.test',displayName:'Browser Reviewer',jobTitle:'Quality Reviewer',department:'Supplier Quality',photo:directoryPhoto}]);
    const storedSettings=await repository.getNotificationSettings();
    assert.equal(storedSettings.schemaVersion,2);
    assert.equal(storedSettings.groups.length,16);
    assert.equal(storedSettings.groups.find(group=>group.key==='department.gscTet.checked').emails,'legacy@example.test');
    assert.equal(storedSettings.legacyGroups.find(group=>group.key==='signoff.gscTet').emails,'legacy@example.test');
    const preparedList=page.locator('#notificationGroups [data-notification-group="department.gscTet.prepared"]');
    await preparedList.getByRole('button',{name:'Add recipient to GSC/TET Prepared'}).click();
    assert.equal(await page.locator('#notificationRecipientTitle').textContent(),'GSC/TET — Prepared');
    await popupInput.fill('Prepared Reviewer');
    await popup.locator('.directory-suggestion').filter({hasText:'prepared@example.test'}).click();
    await confirmRecipient.click();
    await popup.waitFor({state:'hidden'});
    await page.route('**/api/notification-settings',route=>route.request().method()==='PUT'?route.fulfill({status:409,json:{success:false,error:'Mail routing changed; reload before saving'}}):route.continue());
    await page.locator('#notificationSaveButton').click();
    await page.locator('#notificationReloadButton').waitFor({state:'visible'});
    assert.match(await page.locator('#mailRoutingMessage').textContent(),/unsaved draft is kept/);
    assert.equal(await preparedList.locator('input').inputValue(),'prepared@example.test');
    page.once('dialog',dialog=>dialog.dismiss());
    await page.locator('#notificationReloadButton').click();
    assert.equal(await preparedList.locator('input').inputValue(),'prepared@example.test','Declining reload preserves draft');
    await page.unroute('**/api/notification-settings');
    page.once('dialog',dialog=>dialog.accept());
    await page.locator('#notificationReloadButton').click();
    await page.locator('#mailRoutingMessage').filter({hasText:'Latest saved routing loaded.'}).waitFor();
    assert.equal(await page.locator('#notificationReloadButton').isVisible(),false);
    assert.equal(await page.locator('#notificationSaveButton').evaluate(button=>document.activeElement===button),true,'Confirmed reload restores keyboard focus to the stable save control');
    assert.equal(await preparedList.locator('input').count(),0);
    await preparedList.getByRole('button',{name:'Add recipient to GSC/TET Prepared'}).click();
    await popupInput.fill('Prepared Reviewer');
    await popup.locator('.directory-suggestion').filter({hasText:'prepared@example.test'}).click();
    await confirmRecipient.click();
    await popup.waitFor({state:'hidden'});
    await page.locator('#notificationSaveButton').click();
    await page.locator('#mailRoutingMessage').filter({hasText:'Mail routing saved.'}).waitFor();
    assert.equal((await repository.getNotificationSettings()).groups.find(group=>group.key==='department.gscTet.prepared').emails,'prepared@example.test','Confirmed directory recipient is saved');
    await page.route('**/api/admin/notifications/health',route=>route.fulfill({status:503,json:{success:false,error:'PRIVATE_DIAGNOSTIC_MARKER'}}));
    await page.locator('#notificationHealthRefreshButton').click();
    await page.locator('#notificationHealthStatus').filter({hasText:'Unavailable'}).waitFor();
    assert.equal(await page.getByText('PRIVATE_DIAGNOSTIC_MARKER').count(),0);
    assert.equal(await firstRecipient.inputValue(),'reviewer@example.test');
    await page.unroute('**/api/admin/notifications/health');
    const context=await browser.newContext({viewport:{width:1440,height:1100}});
    const supplier=await context.newPage();
    supplier.setDefaultTimeout(15000);
    supplier.setDefaultNavigationTimeout(15000);
    supplier.on('pageerror',error=>errors.push(error.message));
    await supplier.route('**/api/auth/config',route=>route.fulfill({json:{success:true,data:{mode:'password',employeeProvisioningConfigured:true}}}));
    await supplier.goto('http://127.0.0.1:3099/login?returnTo=%2Fcreate');
    await supplier.locator('#username').fill('supplier');
    await supplier.locator('#password').fill(TEST_PASSWORD);
    await supplier.locator('#loginForm button').click();
    await supplier.waitForURL('**/create');
    await supplier.locator('#submitButton:not([disabled])').waitFor();
    assert.equal(await supplier.locator('#supplierName').inputValue(),'');
    assert.equal(await supplier.locator('#materialName').inputValue(),'');
    await supplier.locator('#supplierName').fill('Browser Supplier ไทย');
    await supplier.locator('#materialName').fill('Browser material');
    const savedResponse=supplier.waitForResponse(response=>response.url().endsWith('/api/pcns') && response.request().method()==='POST');
    await supplier.locator('#submitButton').click();
    const response=await savedResponse;
    assert.equal(response.status(),201,await response.text());
    const record=(await response.json()).data;
    await supplier.locator('#appNoticeTitle').filter({hasText:'PCN created'}).waitFor();
    await supplier.goto(`http://127.0.0.1:3099/${record.id}`);
    await supplier.locator('#appNoticeTitle').filter({hasText:'PCN loaded'}).waitFor();
    assert.equal(await supplier.locator('#supplierName').inputValue(),'Browser Supplier ไทย');
    assert.equal((await repository.findById(record.id)).ownerUserId,'supplier-id');
    healthError=true;
    const adminListResponse=page.waitForResponse(response=>response.url().endsWith('/api/pcns') && response.request().method()==='GET');
    await page.goto('http://127.0.0.1:3099/admin#records');
    await page.reload();
    const listResponse=await adminListResponse;
    assert.equal(listResponse.status(),200);
    assert.equal((await listResponse.json()).data.length,1);
    await page.locator('#adminPcnRows tr').filter({hasText:record.id}).waitFor();
    await page.locator('#notificationHealthStatus').filter({hasText:'Unavailable'}).waitFor({state:'attached'});
    await page.getByRole('button',{name:`View ${record.id}`,exact:true}).click();
    await page.locator('#adminOverviewSelected').filter({hasText:record.id}).waitFor();
    const selectedPreview=await page.locator('#adminDetailPreview').textContent();
    await page.locator('#adminMailRoutingButton').click();
    assert.equal(await page.locator('[data-recipient-email]').first().inputValue(),'reviewer@example.test');
    assert.equal(await page.locator('.notification-person-meta').first().textContent(),'Quality Reviewer - Supplier Quality','Saved directory metadata survives reload');
    assert.equal(await page.locator('.notification-person-avatar img').first().getAttribute('src'),directoryPhoto,'Saved inline photo survives reload');
    await page.locator('#notificationHealthRefreshButton').click();
    await page.locator('#notificationHealthStatus').filter({hasText:'Unavailable'}).waitFor();
    assert.equal(await page.locator('#adminDetailPreview').textContent(),selectedPreview,'Health failures preserve current PCN selection');
    assert.equal(await page.locator('#adminPcnRows tr').count(),1);
    assert.equal(await page.getByText('PRIVATE_DIAGNOSTIC_MARKER').count(),0);
    healthError=false;
    await page.locator('#notificationHealthRefreshButton').click();
    await page.locator('#notificationHealthStatus').filter({hasText:'Ready'}).waitFor();
    assert(healthReads>=7);
    assert(notificationRequests.length>=7);
    assert(notificationRequests.every(request=>request.method==='GET' && request.path==='/api/admin/notifications/health'));
    assert.deepEqual(outbound,[]);
    assert.deepEqual(errors,[]);
    await fs.mkdir(path.resolve('test-results'),{recursive:true});
    await page.screenshot({path:path.resolve('test-results/notification-health-browser-smoke.png'),fullPage:true});
    await page.setViewportSize({width:320,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'Separated routing fits a mobile viewport');
    assert.equal(await page.locator('.notification-department').first().locator('[data-notification-group]').count(),3);
    await page.screenshot({path:path.resolve('test-results/notification-routing-mobile-smoke.png'),fullPage:true});
    await approvedAdd.click();
    assert.equal(await popup.evaluate(dialog=>dialog.scrollWidth<=dialog.clientWidth),true,'Popup content fits a 320px viewport');
    await popupInput.focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await popup.evaluate(dialog=>dialog.contains(document.activeElement)),true,'Reverse Tab stays inside the popup');
    for(let tab=0;tab<5;tab+=1) {
      await page.keyboard.press('Tab');
      assert.equal(await popup.evaluate(dialog=>dialog.contains(document.activeElement)),true,'Native popup contains keyboard focus');
    }
    await page.screenshot({path:path.resolve('test-results/notification-recipient-popup-mobile.png'),fullPage:true});
    await page.keyboard.press('Escape');
    await popup.waitFor({state:'hidden'});
    // Employee provisioning is independently mocked, separate from the Power Automate mail directory.
    await page.setViewportSize({width:1440,height:1100});
    const employee={employeeCode:'000001',displayName:'Source Employee',englishName:'Source Employee',email:null,sourceDepartment:'Engineering',jobTitle:'Engineer',isActive:true};
    const linkedEmployee={...employee,employeeCode:'000002',displayName:'Source Administrator'};
    const existingUser={id:'legacy-admin',username:'itadmin',displayName:'Local Administrator',email:null,roles:['admin'],department:'it',isActive:true,identityProvider:'password',signingStep:null,mailProfile:null,version:'0000000000000001'};
    let assignedUsers=[existingUser];
    const provisioningWrites=[];
    const sourceMail={id:'source-mail',email:'source@example.test',displayName:'Source Employee',jobTitle:'Engineer',department:'Engineering',photo:directoryPhoto};
    let assignmentConflict=false;
    await page.route('**/api/admin/directory-users?*',async route=>{
      const query=new URL(route.request().url()).searchParams.get('query');
      if(query?.startsWith('Source') || query==='typed@example.test') return route.fulfill({json:{success:true,data:{users:[sourceMail,{...sourceMail,id:'source-other',email:'another@example.test',department:'Other office'}]}}});
      return route.fallback();
    });
    await page.route('**/api/notification-settings',async route=>{
      if(route.request().method()!=='GET') return route.fallback();
      const settings=await new BrowserPcnService(repository).getNotificationSettings();
      const managed=assignedUsers.filter(user=>user.isActive&&user.signingStep&&user.mailProfile).map(user=>({...user.mailProfile,userId:user.id,employeeCode:user.employeeCode,signingStep:user.signingStep,pcnDepartment:user.department}));
      settings.groups=settings.groups.map(group=>({...group,automaticRecipients:managed.filter(person=>group.key===`department.${person.pcnDepartment}.${person.signingStep}`)}));
      return route.fulfill({json:{success:true,data:settings}});
    });
    await page.route('**/api/admin/employees?*',route=>{
      const query=new URL(route.request().url()).searchParams.get('query');
      if(query==='Source Failure') return route.fulfill({status:503,json:{success:false,error:'Employee search unavailable'}});
      return route.fulfill({json:{success:true,data:query==='Source Employee'?[employee]:query==='Source Administrator'?[linkedEmployee]:[]}});
    });
    await page.route('**/api/admin/users**',route=>{
      if(route.request().method()==='GET') return route.fulfill({json:{success:true,data:assignedUsers}});
      const body=route.request().postDataJSON();
      const isLink=new URL(route.request().url()).pathname.endsWith('/employee');
      provisioningWrites.push({path:new URL(route.request().url()).pathname,body});
      const isEdit=route.request().method()==='PATCH';
      if(isEdit&&assignmentConflict) return route.fulfill({status:409,json:{success:false,error:'User changed on the server'}});
      const current=assignedUsers.find(user=>new URL(route.request().url()).pathname.endsWith(user.id));
      const user=isEdit?{...current,...body,version:'0000000000000002'}:isLink?{...existingUser,employeeCode:linkedEmployee.employeeCode,identityProvider:'employee-code'}:{id:'created-employee',username:employee.employeeCode,...employee,roles:body.roles,department:body.department,signingStep:body.signingStep,mailProfile:body.mailSelection?sourceMail:null,version:'0000000000000001',isActive:true,identityProvider:'employee-code'};
      assignedUsers=isLink||isEdit?assignedUsers.map(existing=>existing.id===user.id?user:existing):[...assignedUsers,user];
      return route.fulfill({status:isLink?200:201,json:{success:true,data:user}});
    });
    await page.locator('#adminUsersButton').click();
    await page.locator('#usersMessage').filter({hasText:'1 assigned users'}).waitFor();
    assert.equal(await page.locator('#adminUsersRows .employee-user-identity .notification-person-avatar').textContent(),'L','Users without a verified photo display an initial');
    assert.equal(await page.locator('#adminUsersRows .employee-user-identity img').count(),0,'Fallback avatars load no external images');
    assert.equal(await page.getByRole('button',{name:'Link employee to Local Administrator',exact:true}).isDisabled(),false,'A configured employee source permits explicit maintenance-account linking');
    assert.equal(await page.locator('#pcnAdminView').isVisible(),false);
    assert.equal(await page.locator('#mailRoutingView').isVisible(),false);
    assert.equal(await page.locator('#adminRefreshButton').isVisible(),false,'PCN refresh is hidden in Users');
    assert.deepEqual(await page.locator('#employeeRole option').evaluateAll(options=>options.map(option=>({value:option.value,label:option.textContent}))),[
      {value:'',label:'Select role'},{value:'admin',label:'Administrator'},{value:'approved',label:'Approved'},{value:'checked',label:'Checked'},{value:'prepared',label:'Prepared'}
    ],'One PCN role select contains exactly the four requested choices');
    assert.equal(await page.locator('#employeeSigningStep').count(),0,'There is no duplicate signing-step select');
    const employeeSearch=page.locator('#employeeSearch');
    await employeeSearch.fill('000001');
    await page.locator('#employeeSearchStatus').filter({hasText:'No employee found'}).waitFor();
    await page.locator('#employeeRole').selectOption('admin');
    await page.locator('#employeeDepartment').selectOption('qaTet');
    assert.equal(await page.locator('#employeeCreateButton').isDisabled(),true,'A typed employee code cannot create access');
    await page.locator('#employeeUserForm').dispatchEvent('submit');
    assert.equal(provisioningWrites.length,0);
    await employeeSearch.fill('Source Failure');
    await page.locator('#employeeSearchStatus').filter({hasText:'Employee search unavailable'}).waitFor();
    assert.equal(await page.locator('#employeeCreateButton').isDisabled(),true);
    await employeeSearch.fill('Source Employee');
    await page.locator('#employeeResults button').waitFor();
    await employeeSearch.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#employeeCode').inputValue(),'000001');
    assert.equal(await page.locator('#employeeCode').getAttribute('readonly'),'');
    assert.match(await page.locator('#employeeProfile').textContent(),/Organization: Engineering/);
    assert.equal(await page.locator('#employeeCreateButton').isDisabled(),false);
    await employeeSearch.dispatchEvent('input');
    assert.equal(await page.locator('#employeeCreateButton').isDisabled(),true,'Every new search input invalidates the selected employee');
    await page.locator('#employeeResults button').waitFor();
    await page.locator('#employeeResults button').click();
    await page.locator('#employeeRole').selectOption('checked');
    await page.locator('#employeeMailResults button').first().waitFor();
    assert.equal(await page.locator('#employeeMailSearch').inputValue(),'Source Employee','English name is searched automatically');
    assert.equal(await page.locator('#employeeMailResults button').count(),2,'Duplicate names require explicit matching-person confirmation');
    assert.equal(await page.locator('#employeeCreateButton').isDisabled(),true,'A signing step requires a selected directory email');
    await page.locator('#employeeUserForm').dispatchEvent('submit');
    assert.equal(provisioningWrites.length,0,'Submitting without confirmed mail creates no user');
    await page.locator('#employeeMailResults button').first().click();
    assert.match(await page.locator('#employeeRoutePreview').textContent(),/QA\/TET.*Checked.*source@example.test/);
    await page.locator('#employeeMailSearch').dispatchEvent('input');
    assert.equal(await page.locator('#employeeCreateButton').isDisabled(),true,'Typing invalidates the chosen mail recipient');
    await page.locator('#employeeMailSearch').fill('typed@example.test');
    await page.locator('#employeeMailResults button').first().waitFor();
    assert.equal(await page.locator('#employeeCreateButton').isDisabled(),true,'A typed email cannot be saved as a mail identity');
    await page.locator('#employeeMailSearch').fill('Source Employee');
    await page.locator('#employeeMailResults button').first().click();
    await page.locator('#employeeCreateButton').click();
    await page.locator('#usersMessage').filter({hasText:'Employee user created'}).waitFor();
    assert.deepEqual(provisioningWrites[0],{path:'/api/admin/users',body:{employeeCode:employee.employeeCode,roles:['qa'],department:'qaTet',signingStep:'checked',mailSelection:{id:sourceMail.id,email:sourceMail.email}}});
    assert.equal(await page.locator('#adminUsersRows tr').count(),2);
    assert.match(await page.locator('#adminUsersRows').textContent(),/000001/);
    const createdIdentity=page.locator('#adminUsersRows tr').filter({hasText:'000001'}).locator('.employee-user-identity');
    assert.equal(await createdIdentity.locator('.notification-person-avatar img').getAttribute('src'),directoryPhoto,'Users display the verified directory profile photo');
    assert.equal(await createdIdentity.locator('.notification-person-email').textContent(),'source@example.test');
    assert.equal(await createdIdentity.locator('.notification-person-meta').textContent(),'Engineer - Engineering');
    assert.equal(await page.locator('#employeeUserForm input[type=password]').count(),0);
    await page.locator('#adminMailRoutingButton').click();
    const managedList=page.locator('[data-notification-group="department.qaTet.checked"]');
    await managedList.locator('[data-managed-recipient]').waitFor();
    assert.match(await managedList.locator('.notification-managed-recipients').textContent(),/Managed from Users.*000001.*source@example.test/s);
    const managedCard=managedList.locator('[data-managed-recipient="source@example.test"]');
    assert.equal(await managedCard.locator('.notification-person-avatar img').getAttribute('src'),directoryPhoto,'Managed routing uses the same verified photo as Users');
    assert.equal(await managedCard.locator('.notification-person-meta').textContent(),'Engineer - Engineering');
    assert.equal(await managedCard.locator('.notification-person-identity').textContent(),'Source Employee · 000001');
    assert.equal(await managedCard.evaluate(row=>getComputedStyle(row).display),'grid','Managed recipients use the profile card layout');
    assert.equal(await managedList.locator('.notification-managed-recipients button,input').count(),0,'Managed recipients are displayed without manual editing controls');
    const manualSaveRequest=page.waitForRequest(request=>request.url().endsWith('/api/notification-settings')&&request.method()==='PUT');
    await page.locator('#notificationSaveButton').click();
    const manualSave=await manualSaveRequest;
    assert.equal(JSON.stringify(manualSave.postDataJSON()).includes('source@example.test'),false,'Managed mail never enters the manual routing save body');
    await page.locator('#mailRoutingMessage').filter({hasText:'Mail routing saved.'}).waitFor();
    await page.locator('#adminUsersButton').click();
    await page.getByRole('button',{name:'Edit user Source Employee',exact:true}).click();
    assert.equal(await employeeSearch.isDisabled(),true,'Editing cannot change employee identity');
    await page.locator('#employeeRole').selectOption('prepared');
    await page.locator('#employeeActive').uncheck();
    assignmentConflict=true;
    await page.locator('#employeeCreateButton').click();
    await page.locator('#usersMessage').filter({hasText:'Your edit is kept'}).waitFor();
    assert.equal(await page.locator('#employeeRole').inputValue(),'prepared','A concurrency conflict preserves the draft');
    assert.equal(await page.locator('#employeeActive').isChecked(),false);
    assert.deepEqual(provisioningWrites[1],{path:'/api/admin/users/created-employee',body:{roles:['qa'],department:'qaTet',signingStep:'prepared',isActive:false,version:'0000000000000001'}});
    await page.locator('#employeeCancelButton').click();
    assert.equal(provisioningWrites.length,2,'Cancelling the conflicted draft performs no write');
    assignmentConflict=false;
    await page.getByRole('button',{name:'Edit user Source Employee',exact:true}).click();
    await page.locator('#employeeRole').selectOption('prepared');
    await page.locator('#employeeActive').uncheck();
    await page.locator('#employeeCreateButton').click();
    await page.locator('#usersMessage').filter({hasText:'Employee access updated'}).waitFor();
    assert.equal(assignedUsers.find(user=>user.id==='created-employee').isActive,false);
    assert.equal(assignedUsers.find(user=>user.id==='created-employee').signingStep,'prepared');
    provisioningAuthMode='employee-code';
    await page.locator('#usersRefreshButton').click();
    await page.locator('#usersMessage').filter({hasText:'2 assigned users'}).waitFor();
    await page.getByRole('button',{name:'Link employee to Local Administrator',exact:true}).click();
    assert.equal(await page.locator('#employeeAssignments').isVisible(),false);
    await employeeSearch.fill('Source Administrator');
    await page.locator('#employeeResults button').click();
    page.once('dialog',dialog=>{assert.match(dialog.message(),/permissions and records will be preserved/);dialog.accept();});
    await page.locator('#employeeCreateButton').click();
    await page.locator('#usersMessage').filter({hasText:'Employee linked'}).waitFor();
    assert.deepEqual(provisioningWrites[3],{path:'/api/admin/users/legacy-admin/employee',body:{employeeCode:linkedEmployee.employeeCode}});
    assert.deepEqual(assignedUsers[0].roles,['admin']);
    assert.equal(assignedUsers[0].department,'it');
    await employeeSearch.fill('Source Employee');
    await page.locator('#employeeResults button').click();
    await page.locator('#employeeCancelButton').click();
    assert.equal(await employeeSearch.inputValue(),'');
    assert.equal(await page.locator('#employeeCreateButton').isDisabled(),true);
    assert.equal(provisioningWrites.length,4,'Clear selection performs no provisioning write');
    await page.getByRole('button',{name:'Edit user Local Administrator',exact:true}).click();
    await page.locator('#employeeRole').selectOption('checked');
    await page.locator('#employeeDepartment').selectOption('qaTet');
    await page.locator('#employeeMailSearch').fill('Source Employee');
    await page.locator('#employeeMailResults button').first().click();
    assert.match(await page.locator('#employeeRoleHelp').textContent(),/will replace.*when saved/);
    page.once('dialog',dialog=>{assert.match(dialog.message(),/Remove Administrator/);dialog.dismiss();});
    await page.locator('#employeeCreateButton').click();
    assert.equal(provisioningWrites.length,4,'Cancelling Administrator removal performs no account update');
    assert.equal(await page.locator('#employeeRole').inputValue(),'checked','Cancelled Administrator removal retains the draft');
    await page.locator('#employeeCancelButton').click();
    assignedUsers=[...assignedUsers,
      {...existingUser,id:'combined-admin',displayName:'Combined Administrator',roles:['reviewer','admin'],department:'qaTet',signingStep:'approved',mailProfile:sourceMail,identityProvider:'employee-code'},
      {...existingUser,id:'legacy-requester',displayName:'Legacy Requester',roles:['supplier'],department:'qaTet',identityProvider:'employee-code'}
    ];
    await page.locator('#usersRefreshButton').click();
    await page.locator('#usersMessage').filter({hasText:'4 assigned users'}).waitFor();
    await page.getByRole('button',{name:'Edit user Combined Administrator',exact:true}).click();
    assert.equal(await page.locator('#employeeRole').inputValue(),'admin');
    assert.match(await page.locator('#employeeRoleHelp').textContent(),/preserved.*QA\/TET.*Approved/);
    await page.locator('#employeeActive').uncheck();
    await page.locator('#employeeCreateButton').click();
    await page.locator('#usersMessage').filter({hasText:'Employee access updated'}).waitFor();
    assert.deepEqual(provisioningWrites[4].body,{roles:['reviewer','admin'],department:'qaTet',signingStep:'approved',isActive:false,version:'0000000000000001'},'Unrelated status edits retain exact multiple roles and signing authority');
    await page.getByRole('button',{name:'Edit user Legacy Requester',exact:true}).click();
    assert.equal(await page.locator('#employeeRole').inputValue(),'');
    assert.equal(await page.locator('#employeeRole').getAttribute('required'),null,'A legacy user needs no new signing grant for unrelated edits');
    await page.locator('#employeeActive').uncheck();
    await page.locator('#employeeCreateButton').click();
    await page.locator('#usersMessage').filter({hasText:'Employee access updated'}).waitFor();
    assert.deepEqual(provisioningWrites[5].body,{roles:['supplier'],department:'qaTet',signingStep:null,isActive:false,version:'0000000000000001'},'Legacy Requester is never implicitly converted to a signer');
    await page.screenshot({path:path.resolve('test-results/admin-users-browser-smoke.png'),fullPage:true});
    await page.setViewportSize({width:320,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'Users view fits a mobile viewport');
    await page.screenshot({path:path.resolve('test-results/admin-users-mobile-smoke.png'),fullPage:true});
    await page.unroute('**/api/auth/config');
    await page.route('**/api/auth/config',route=>route.fulfill({json:{success:true,data:{mode:'password',employeeProvisioningConfigured:false}}}));
    await page.locator('#usersRefreshButton').click();
    await page.locator('#usersMessage').filter({hasText:'not configured'}).waitFor();
    assert.equal(await employeeSearch.isDisabled(),true);
    assert.equal(await page.locator('#employeeCreateButton').isDisabled(),true);
    const employeeContext=await browser.newContext();
    const employeePage=await employeeContext.newPage();
    employeePage.on('pageerror',error=>errors.push(error.message));
    let employeeRequest;
    let employeeConfigValid=false;
    let employeeSessionStatus=503;
    const employeeCsrf='employee-test-csrf';
    await employeePage.route('**/api/auth/config',route=>route.fulfill({json:{success:true,data:{mode:employeeConfigValid?'employee-code':'unknown',employeeProvisioningConfigured:true}}}));
    await employeePage.route('**/api/session',route=>route.fulfill({status:employeeSessionStatus,json:{success:false,error:employeeSessionStatus===503?'Employee source unavailable':'Sign in required'}}));
    await employeePage.route('**/api/auth/login',route=>{
      employeeRequest={body:route.request().postDataJSON(),headers:route.request().headers()};
      return route.fulfill({json:{success:true,data:{authenticated:true,user:{username:'000001',employeeCode:'000001',roles:['reviewer'],identityProvider:'employee-code',mustChangePassword:false},csrfToken:employeeCsrf}}});
    });
    // A 204 navigation keeps this isolated page available to verify post-login CSRF behavior.
    await employeePage.route('**/employee-complete',route=>route.fulfill({status:204}));
    await employeePage.goto('http://127.0.0.1:3099/login?returnTo=%2Femployee-complete');
    await employeePage.locator('#authRetryButton').waitFor();
    assert.equal(await employeePage.locator('#loginForm').isVisible(),false,'Unknown auth mode never exposes password fields');
    assert.equal(await employeePage.locator('#employeeLoginForm').isVisible(),false);
    employeeConfigValid=true;
    await employeePage.locator('#authRetryButton').click();
    await employeePage.locator('#authMessage').filter({hasText:'Employee source unavailable'}).waitFor();
    assert.equal(await employeePage.locator('#employeeLoginForm').isVisible(),false,'Session infrastructure failure keeps sign-in controls closed');
    assert.equal(await employeePage.locator('#authRetryButton').evaluate(button=>button===document.activeElement),true,'Retry receives focus after a failed session load');
    employeeSessionStatus=401;
    await employeePage.locator('#authRetryButton').click();
    await employeePage.locator('#employeeLoginForm').waitFor({state:'visible'});
    assert.equal(await employeePage.locator('#authRetryButton').isVisible(),false,'Recovered employee sign-in hides setup retry');
    assert.equal(await employeePage.locator('#loginForm').isVisible(),false);
    assert.equal(await employeePage.locator('input[type=password]:visible').count(),0,'Employee mode exposes no password fields');
    assert.equal(await employeePage.locator('#employeeCode').getAttribute('type'),'text','Employee codes preserve leading zeros');
    await employeePage.locator('#employeeCode').fill('000001');
    await employeePage.locator('#employeeRemember').check();
    const employeeLoginResponse=employeePage.waitForResponse('**/api/auth/login');
    const employeeDestination=employeePage.waitForRequest('**/employee-complete');
    await employeePage.locator('#employeeLoginForm button[type=submit]').click({noWaitAfter:true});
    await employeeLoginResponse;
    await employeeDestination;
    assert.deepEqual(employeeRequest.body,{employeeCode:'000001',remember:true});
    assert.equal(employeeRequest.headers['x-employee-code'],undefined,'The employee code travels in the validated login payload');
    await employeePage.route('**/api/auth/logout',route=>{
      assert.equal(route.request().headers()['x-csrf-token'],employeeCsrf,'Authenticated employee writes use the returned CSRF token');
      return route.fulfill({json:{success:true,data:{authenticated:false,user:null,csrfToken:''}}});
    });
    await employeePage.evaluate(()=>window.PCN_SESSION.fetch('/api/auth/logout',{method:'POST',body:'{}'}));
    await employeeContext.close();
    await verifySplitNotificationFeedback(browser,await page.context().storageState(),errors);
    await verifyPcnEmailLinks(browser,errors);
    assert.deepEqual(outbound,[],'The complete browser suite performs no outbound email');
    assert.deepEqual(errors,[],'All browser journeys complete without page errors');
    await supplier.screenshot({path:path.resolve('test-results/pcn-browser-smoke.png'),fullPage:true});
    console.log(JSON.stringify({browser:'passed',checks:['forced-password-change','relogin','five-departments-fifteen-step-lists','separate-supplier-list','qa-initial-final-shared-lists','empty-lists-without-fields','popup-department-and-step','popup-cancel-and-escape-no-changes','popup-one-field','static-contact-rows','last-remove-restores-add','typing-and-selection-no-extra-fields','natural-directory-height','pending-escape-cancels-lookup','blurred-lookup-does-not-reopen','popup-internal-search-status','duplicate-recipient-rejected','read-only-legacy-contacts','explicit-deduplicated-legacy-copy','versioned-routing-save','routing-conflict-preserves-draft','confirmed-reload-discards-draft','directory-selection-required','forced-confirm-cannot-bypass','input-event-clears-selection','failed-no-match-unconfigured-lookup','original-directory-request-and-response-envelopes','keyboard-directory-selection','directory-profile-photo-selection-and-save','directory-profile-persists-on-reload','compact-mail-configuration-status','worker-and-queue-attention-status','keyboard-health-refresh','safe-health-errors','health-failure-preserves-pcns','no-outbound-email','blank-new-supplier-form','supplier-create','saved-pcn-reload','responsive-routing-layout','popup-focus-and-mobile-layout','admin-users-role-gate','employee-source-isolated-from-mail','typed-code-cannot-provision','employee-no-match-and-error','employee-selection-and-read-only-code','employee-input-invalidates-selection','selected-employee-create-fixed-assignments','four-pcn-role-options-no-duplicate-select','administrator-demotion-confirm-cancel','unchanged-multiple-role-and-signing-preserved','legacy-requester-no-implicit-signing','english-name-mail-lookup','duplicate-name-explicit-confirmation','single-step-requires-verified-mail','free-text-email-cannot-save','mail-input-invalidates-selection','managed-users-routing-readonly','manual-save-excludes-managed-mail','user-edit-step-active-version','user-conflict-keeps-draft','user-edit-cancel-no-write','maintenance-mode-explicit-employee-link','explicit-employee-link-preserves-assignments','cancel-employee-selection-no-write','unconfigured-source-blocks-provisioning','users-responsive-layout','unknown-auth-mode-retry','employee-session-service-failure-closed','employee-stale-session-recovery','employee-only-sign-in-no-password','employee-login-leading-zero-and-csrf','split-update-queued-action-blocked','split-signature-save-both-queued','split-update-blocked-action-queued','split-workflow-checkbox-feedback-after-refresh','split-queue-feedback-no-delivery-claims','split-policy2-no-legacy-notification-post','no-page-errors'],storage:'isolated_test_adapters'}));
  } finally {
    if(browser) await browser.close();
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
