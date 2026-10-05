// Browser verification against isolated test adapters; never connects to SQL or sends email.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const {chromium} = require('@playwright/test');
const {createApp} = require('../src/httpServer');
const {memoryRepository,fakeAuthService,TEST_PASSWORD} = require('../test/helpers/apiHarness');
const masterData = require('../src/masterData');

async function main() {
  const repository = memoryRepository();
  repository.getMasterData = async()=>({...masterData,versionId:1});
  const server = createApp({repository,authService:fakeAuthService(),rootDir:path.resolve(__dirname,'..'),publicOrigin:'http://127.0.0.1:3099',secureCookies:false});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(3099,'127.0.0.1',resolve);});
  let browser;
  try {
    browser = await chromium.launch({headless:true});
    const page = await browser.newPage({viewport:{width:1440,height:1100}});
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
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
    const context=await browser.newContext({viewport:{width:1440,height:1100}});
    const supplier=await context.newPage();
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
    assert.deepEqual(errors,[]);
    await fs.mkdir(path.resolve('test-results'),{recursive:true});
    await supplier.screenshot({path:path.resolve('test-results/pcn-browser-smoke.png'),fullPage:true});
    console.log(JSON.stringify({browser:'passed',checks:['forced-password-change','relogin','empty-email-routing','blank-new-supplier-form','supplier-create','saved-pcn-reload','no-page-errors'],storage:'isolated_test_adapters'}));
  } finally {
    if(browser) await browser.close();
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
