/* global document, innerWidth */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {createConfigServer} from './server.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'flow-diagnostics-ui-'));
let server,browser;
try {
    server=await createConfigServer({dataDir,port:0,adminPassword:'fixture-diagnostics',logger:{log(){},warn(){},error(){}},
        requestDiagnostics:{get:async(site,requestId)=>({status:200,body:{record:{requestId,site,
            request:{model:'sd2-fast',duration:15,resolution:'720p',referenceCounts:{images:7}},
            upstreamStatus:400,error:{code:'invalid_duration',message:'duration must be between 1 and 12 seconds'},
            publicError:{category:'parameter',submissionState:'rejected'},billingState:'unknown',
            relayLog:{state:'found',rows:[{cost:0,is_completed:1,billing_detail:'请求未受理'}]}}}})}});
    browser=await chromium.launch({channel:'chrome',headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    await page.goto(server.url+'/admin');
    await page.getByPlaceholder('管理密码').fill('fixture-diagnostics');
    await page.getByRole('button',{name:'登录',exact:true}).click();
    await page.getByRole('textbox',{name:'排查编号',exact:true}).fill('rh_'+'a'.repeat(32));
    await page.locator('#requestDiagnosticsForm button').click();
    await page.waitForFunction(()=>document.getElementById('requestDiagnosticsStatus').textContent==='查询完成');
    assert.match(await page.locator('#requestDiagnosticsError').innerText(),/invalid_duration/);
    await fs.mkdir('output/playwright',{recursive:true});
    for(const [name,width] of [['desktop',1440],['mobile',390]]) {
        await page.setViewportSize({width,height:1000});
        await page.locator('#requestDiagnosticsForm').scrollIntoViewIfNeeded();
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        await page.screenshot({path:`output/playwright/admin-diagnostics-${name}.png`});
    }
    console.log('PASS administrator request lookup: login, query, detailed response, desktop/mobile layout.');
} finally {
    await browser?.close();await server?.close();await fs.rm(dataDir,{recursive:true,force:true});
}
