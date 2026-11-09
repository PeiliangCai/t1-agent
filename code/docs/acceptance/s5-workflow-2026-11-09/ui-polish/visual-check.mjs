/** Read-only real L07/L05 browser capture. Browser storage changes only; never sends production mutations. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const base=dirname(fileURLToPath(import.meta.url)), code=resolve(base,'../../../..'), origin='http://127.0.0.1:30141', phase=process.argv[2] ?? 'before';
process.env.PLAYWRIGHT_BROWSERS_PATH=join(code,'.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH=[join(code,'.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'),process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const {chromium}=await import(pathToFileURL(join(code,'.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const browser=await chromium.launch({headless:true,channel:'chromium',chromiumSandbox:false});
const report={phase,at:new Date().toISOString(),mutations:[],errors:[],blocked:[],shots:[],checks:[]};
try {
 const context=await browser.newContext({locale:'zh-CN',viewport:{width:1512,height:1050},reducedMotion:'reduce'});
 await context.addInitScript(()=>{localStorage.setItem('pi-theme','light');localStorage.setItem('pi-locale','zh-CN');});
 await context.route(/^https?:\/\//,route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin){report.blocked.push(url.origin);return route.abort();}if(!['GET','HEAD'].includes(req.method())){report.mutations.push({method:req.method(),url:req.url()});return route.abort();}return route.continue();});
 const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.stack??String(e)));
 const run='b0-revalidation-2151bbfc-5883-49c4-9e17-d3b600f92a9f:source-L07';
 const response=await context.request.get(origin+'/api/t1/workbench/runs/'+encodeURIComponent(run));assert.equal(response.status(),200);const detail=await response.json();
 report.run={id:run,records:detail.output.records.filter(r=>!r.deleted).length,reviewed:detail.output.records.filter(r=>r.text_approved).length,figures:detail.figures.length};
 await page.goto(origin+'/?paper=L07&run='+encodeURIComponent(run)+'&view=records');await page.locator('.t1-evidence-card').waitFor();await page.locator(`.t1-pdf-reader canvas[data-page="${phase === "after" ? detail.output.records[0].fragments[0].physical_page : 1}"]`).waitFor();await page.evaluate(()=>document.fonts.ready);
 const capture=async name=>{const path=join(base,phase+'-'+name+'.png');await page.screenshot({path,fullPage:true});report.shots.push(path);};
 await capture('L07-desktop');
 await page.locator('.t1-review').scrollIntoViewIfNeeded();await capture('L07-review');
 await page.locator('.t1-content').evaluate(e=>e.scrollTop=0);
 await page.getByRole('tab',{name:'原 Figure 目录',exact:true}).click();await page.locator('.t1-figure').first().waitFor();await capture('L07-figure');
 await page.getByRole('tab',{name:'原文与审核',exact:true}).click();
 if(phase==='after'){
  for(const [locale,tab] of [['en','Evidence and review'],['zh-TW','原文與審核'],['zh-CN','原文与审核']]){await page.locator('.t1-top-actions select').selectOption(locale);await page.getByRole('tab',{name:tab,exact:true}).waitFor();assert.equal(await page.locator('html').getAttribute('lang'),locale);report.checks.push({locale,translated:true});if(locale==='en')await capture('L07-english');}
  await page.getByRole('button',{name:'界面主题',exact:true}).click();await page.getByRole('menuitemradio',{name:'深色',exact:true}).click();await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');await capture('L07-dark');
  await page.getByRole('button',{name:'界面主题',exact:true}).click();await page.getByRole('menuitemradio',{name:'浅色',exact:true}).click();
 }
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(250);await capture('L07-mobile');
 report.mobile={width:390,scrollWidth:await page.evaluate(()=>document.documentElement.scrollWidth)};assert.ok(report.mobile.scrollWidth<=390);
 if(phase==='after'){
  await page.setViewportSize({width:1512,height:1050});await page.goto(origin+'/?paper=paper-6dce31c5-dcbf-4b0b-861a-233a3919467f&run=run-c81de6e7-2a4b-47ec-afff-9b75341300c3&view=records');await page.locator('.t1-empty').waitFor();await capture('L05-empty');
  await page.getByRole('tab',{name:'新任务',exact:true}).click();await page.locator('.t1-scope-editor').waitFor();assert.equal(await page.getByRole('button',{name:'开始抽取',exact:true}).isEnabled(),false);assert.ok((await page.locator('.t1-content').innerText()).includes('正式医学目录尚未核定'));await capture('new-task');
 }
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.mutations,[]);assert.deepEqual(report.blocked,[]);report.passed=true;
} catch(error){report.passed=false;report.error=error.stack??String(error);process.exitCode=1;}finally{await browser.close();await writeFile(join(base,phase+'-visual.json'),JSON.stringify(report,null,2)+'\n');}console.log(JSON.stringify(report));
