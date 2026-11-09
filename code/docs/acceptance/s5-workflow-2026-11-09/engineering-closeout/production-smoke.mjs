/** Read-only production-build smoke; no uploads, reviews, deletions, or model execution. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const evidence = dirname(fileURLToPath(import.meta.url)), code = resolve(evidence, '../../../..');
const origin = 'http://127.0.0.1:30141';
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const report = { schema_version: 's5-production-build-browser-smoke-1', checked_at: new Date().toISOString(), origin, paid_calls: 0, operations: 'GET only; no production mutations', checks: [], browser_errors: [], unexpected_resources: [], blocked_external_requests: [] };
let browser;
try {
  report.build_id = (await readFile(join(code, 'apps/pi-web/.next/BUILD_ID'), 'utf8')).trim(); assert.ok(report.build_id);
  browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1512, height: 1050 } });
  await context.route(/^https?:\/\//, route => { const url = new URL(route.request().url()); if (url.origin === origin) return route.continue(); report.blocked_external_requests.push(url.origin); return route.abort('blockedbyclient'); });
  const page = await context.newPage(); page.on('pageerror', error => report.browser_errors.push(error.stack ?? String(error)));
  page.on('response', response => { const url = new URL(response.url()); if (response.status() >= 400 && /^(\/_next\/|\/t1-assets\/|\/api\/t1\/)/.test(url.pathname)) report.unexpected_resources.push({ path: url.pathname, status: response.status() }); });
  const api = async path => { const response = await context.request.get(origin + '/api/t1/' + path); assert.equal(response.status(), 200, path); return response.json(); };
  const caps = await api('workbench/capabilities'); assert.equal(caps.controlled_fixture, false); assert.equal(caps.extraction_start, false); report.capabilities = caps;
  await page.goto(origin + '/?view=newTask'); await page.locator('.t1-scope-editor').waitFor();
  assert.equal(await page.getByRole('button', { name: '开始抽取', exact: true }).isEnabled(), false);
  assert.equal(await page.locator('.t1-fixture-banner').count(), 0);
  await page.screenshot({ path: join(evidence, 'production-home.png'), fullPage: true }); report.checks.push({ name: 'production_home_and_model_disabled', passed: true });
  const papers = (await api('workbench/papers')).papers, runs = (await api('workbench/runs')).runs;
  assert.equal(runs.some(run => run.fixture || run.origin === 'controlled_fixture'), false);
  assert.equal(papers.some(paper => paper.title.startsWith('S5浏览器')), false);
  const run = runs.find(run => run.document_id === 'L01' && run.candidate_count > 0); assert.ok(run, 'existing retained L01 run');
  const detail = await api('workbench/runs/' + encodeURIComponent(run.run_id));
  await page.goto(`${origin}/?paper=${run.document_id}&run=${encodeURIComponent(run.run_id)}&view=records`);
  await page.locator('.t1-evidence-card').waitFor(); await page.locator('.t1-pdf-reader canvas[data-page="1"]').waitFor();
  assert.deepEqual(await page.locator('.t1-evidence-card > .t1-fragments .t1-verbatim').allTextContents(), detail.output.records[0].fragments.map(fragment => fragment.exact_quote));
  const physicalPage = detail.output.records[0].fragments[0].physical_page;
  await page.locator('.t1-evidence-card > .t1-fragments button').first().click(); await page.locator(`.t1-pdf-reader canvas[data-page="${physicalPage}"]`).waitFor();
  const pdf = await page.locator('.t1-pdf-reader').evaluate(node => ({ page: Number(node.querySelector('canvas').dataset.page), width: node.querySelector('canvas').width, text_length: node.querySelector('.textLayer').textContent.length }));
  assert.equal(pdf.page, physicalPage); assert.ok(pdf.width > 100 && pdf.text_length > 0);
  await page.screenshot({ path: join(evidence, 'production-retained-source.png'), fullPage: true }); report.checks.push({ name: 'retained_paper_verbatim_and_original_pdf_navigation', passed: true, document_id: run.document_id, physical_page: physicalPage, rendered: pdf });
  const worker = await context.request.get(origin + '/t1-assets/pdfjs/pdf.worker.min.mjs'); assert.equal(worker.status(), 200); assert.ok((await worker.text()).includes('pdfjsVersion = 6.5.438')); report.checks.push({ name: 'fixed_pdfjs_worker_resource', passed: true });
  for (const path of ['/api/sessions', '/api/agent/new', '/api/files/etc/passwd', '/api/models-config/discover', '/login']) assert.equal((await context.request.get(origin + path)).status(), 404, path);
  report.checks.push({ name: 'retired_routes_remain_blocked_in_built_application', passed: true });
  assert.deepEqual(report.browser_errors, []); assert.deepEqual(report.unexpected_resources, []); assert.deepEqual(report.blocked_external_requests, []); report.passed = true;
} catch (error) { report.passed = false; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally { await writeFile(join(evidence, 'production-browser-smoke.json'), JSON.stringify(report, null, 2) + '\n'); await browser?.close(); }
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, browser_errors: report.browser_errors.length, paid_calls: report.paid_calls }));
