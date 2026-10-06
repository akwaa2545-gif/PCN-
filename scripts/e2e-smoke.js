// Browser verification against isolated test adapters; never connects to SQL or sends email.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const {chromium} = require('@playwright/test');
const {createApp} = require('../src/httpServer');
const {PcnService} = require('../src/pcnService');
const {memoryRepository,fakeAuthService,TEST_PASSWORD} = require('../test/helpers/apiHarness');
const masterData = require('../src/masterData');

async function main() {
  const repository = memoryRepository();
  repository.getMasterData = async()=>({...masterData,versionId:1});
  class BrowserPcnService extends PcnService {
    async getNotificationSettings() { return {...await super.getNotificationSettings(),directoryConfigured:true}; }
  }
  let configuration='configured';
  let healthError=false;
  let healthGate=null;
  let workerHealth={worker:{lastCheckedAt:null,lastOutcome:null},queue:{pending:2,sending:1,accepted:3,uncertain:1,latestAcceptedAt:null}};
  let healthReads=0;
  const outbound=[];
  const integrationService={
    mailConfigurationStatus:()=>configuration,
    async directory() { return {users:[{id:'browser-reviewer',displayName:'Browser Reviewer',email:'reviewer@example.test',photo:''}]}; },
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
    page.on('request',request=>{
      if(request.url().includes('/api/admin/notifications/')) notificationRequests.push({method:request.method(),path:new URL(request.url()).pathname});
    });
    await page.goto('http://127.0.0.1:3099/login?returnTo=%2Fadmin%23mail-routing');
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
    assert.equal(emails.length,7);
    assert(emails.every(email=>email===''));
    assert.equal(await page.locator('#notificationHealthRefreshButton').count(),1,'Health refresh replaces outbound test email');
    await page.locator('#notificationHealthStatus').filter({hasText:'Configured'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Test Email',exact:true}).count(),0);
    assert.equal(await page.locator('#mailRoutingView input[type=url]').count(),0);
    assert.equal(await page.locator('[data-recipient-email]:enabled').count(),7);
    assert.equal(await page.locator('#notificationHealthPending').textContent(),'2');
    assert.equal(await page.locator('#notificationHealthSending').textContent(),'1');
    assert.equal(await page.locator('#notificationHealthAccepted').textContent(),'3');
    assert.equal(await page.locator('#notificationHealthUncertain').textContent(),'1');
    assert.equal(await page.locator('#notificationHealthWorker').textContent(),'Not checked yet');
    assert.equal(await page.locator('#notificationHealthCheckedAt').textContent(),'Not yet');
    assert.match(await page.locator('#notificationHealthMessage').textContent(),/Delivery is not verified/);
    const firstRecipient=page.locator('[data-recipient-email]').first();
    await firstRecipient.fill('Browser Reviewer');
    await page.locator('.directory-suggestion').filter({hasText:'reviewer@example.test'}).click();
    assert.equal(await firstRecipient.inputValue(),'reviewer@example.test');
    for(const [status,label] of [['not_configured','Not configured'],['invalid','Invalid configuration'],['configured','Configured']]) {
      configuration=status;
      await page.locator('#notificationHealthRefreshButton').click();
      await page.locator('#notificationHealthStatus').filter({hasText:label}).waitFor();
      assert.equal(await firstRecipient.inputValue(),'reviewer@example.test','Health refresh preserves recipient edits');
    }
    let releaseHealth;
    healthGate=new Promise(resolve=>{releaseHealth=resolve;});
    await page.locator('#notificationHealthRefreshButton').focus();
    await page.keyboard.press('Enter');
    await page.locator('#notificationHealthPanel[aria-busy=true]').waitFor();
    assert.equal(await page.locator('#notificationHealthRefreshButton').isDisabled(),true);
    assert.equal(await firstRecipient.isEnabled(),true);
    workerHealth={...workerHealth,worker:{lastCheckedAt:'2026-10-06T01:02:03.000Z',lastOutcome:'accepted'},queue:{...workerHealth.queue,latestAcceptedAt:'2026-10-06T01:02:03.000Z'}};
    healthGate=null;
    releaseHealth();
    await page.locator('#notificationHealthPanel[aria-busy=false]').waitFor();
    assert.equal(await page.locator('#notificationHealthWorker').textContent(),'Accepted by workflow');
    assert.notEqual(await page.locator('#notificationHealthCheckedAt').textContent(),'Not yet');
    assert.notEqual(await page.locator('#notificationHealthAcceptedAt').textContent(),'Not yet');
    await page.locator('#notificationSaveButton').click();
    await page.locator('#mailRoutingMessage').filter({hasText:'Mail routing saved.'}).waitFor();
    assert.equal((await repository.getNotificationSettings()).groups[0].emails,'reviewer@example.test');
    await page.route('**/api/admin/notifications/health',route=>route.fulfill({status:503,json:{success:false,error:'PRIVATE_DIAGNOSTIC_MARKER'}}));
    await page.locator('#notificationHealthRefreshButton').click();
    await page.locator('#notificationHealthStatus').filter({hasText:'Unavailable'}).waitFor();
    assert.match(await page.locator('#notificationHealthMessage').textContent(),/stale/);
    assert.equal(await page.getByText('PRIVATE_DIAGNOSTIC_MARKER').count(),0);
    assert.equal(await page.locator('#notificationHealthAccepted').textContent(),'3');
    await page.unroute('**/api/admin/notifications/health');
    const context=await browser.newContext({viewport:{width:1440,height:1100}});
    const supplier=await context.newPage();
    supplier.setDefaultTimeout(15000);
    supplier.setDefaultNavigationTimeout(15000);
    supplier.on('pageerror',error=>errors.push(error.message));
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
    await page.locator('#notificationHealthRefreshButton').click();
    await page.locator('#notificationHealthStatus').filter({hasText:'Unavailable'}).waitFor();
    assert.equal(await page.locator('#adminDetailPreview').textContent(),selectedPreview,'Health failures preserve current PCN selection');
    assert.equal(await page.locator('#adminPcnRows tr').count(),1);
    assert.equal(await page.getByText('PRIVATE_DIAGNOSTIC_MARKER').count(),0);
    healthError=false;
    await page.locator('#notificationHealthRefreshButton').click();
    await page.locator('#notificationHealthStatus').filter({hasText:'Configured'}).waitFor();
    assert(healthReads>=7);
    assert(notificationRequests.length>=7);
    assert(notificationRequests.every(request=>request.method==='GET' && request.path==='/api/admin/notifications/health'));
    assert.deepEqual(outbound,[]);
    assert.deepEqual(errors,[]);
    await fs.mkdir(path.resolve('test-results'),{recursive:true});
    await page.screenshot({path:path.resolve('test-results/notification-health-browser-smoke.png'),fullPage:true});
    await supplier.screenshot({path:path.resolve('test-results/pcn-browser-smoke.png'),fullPage:true});
    console.log(JSON.stringify({browser:'passed',checks:['forced-password-change','relogin','editable-email-routing','directory-lookup-and-save','health-configuration-states','health-counts-and-timestamps','keyboard-health-refresh','safe-health-errors','health-failure-preserves-pcns','no-outbound-email','blank-new-supplier-form','supplier-create','saved-pcn-reload','no-page-errors'],storage:'isolated_test_adapters'}));
  } finally {
    if(browser) await browser.close();
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
