import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const code = process.cwd(), evidence = resolve(code, 'docs/acceptance/s5-workflow-2026-11-09/real-model-L05');
const retained = JSON.parse(await readFile(resolve(evidence, 'production-retention.json'), 'utf8'));
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [resolve(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(resolve(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
try {
  const context = await browser.newContext({ viewport: { width: 1512, height: 1050 }, locale: 'zh-CN' });
  const mutations = [], outside = [];
  await context.route(/^https?:\/\//u, route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:30141') { outside.push(url.origin); return route.abort(); }
    if (!['GET', 'HEAD'].includes(request.method())) { mutations.push(request.method() + ' ' + url.pathname); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage(); await page.goto(retained.user_url);
  await page.locator('.t1-task-progress').waitFor();
  await page.getByText('此运行暂无已保存候选；不代表论文没有证据或抽取无遗漏。', { exact: true }).waitFor();
  assert.ok((await page.locator('.t1-task-progress strong').innerText()).includes('任务处理完成'));
  await page.locator('.t1-source-limits').waitFor(); await page.locator('.t1-pdf-reader canvas[data-page="1"]').waitFor();
  for (const label of ['候选 JSONL', '候选 CSV', '候选证据包']) assert.equal(await page.getByRole('button', { name: label, exact: true }).isEnabled(), true);
  assert.equal(await page.locator('article.t1-evidence-card').count(), 0);
  const response = await context.request.get(`http://127.0.0.1:30141/api/t1/workbench/runs/${retained.run_id}`); assert.equal(response.status(), 200); const detail = await response.json();
  assert.equal(detail.run.state, 'partial'); assert.equal(detail.output.coverage.task_processing_complete, true); assert.equal(detail.output.origin, 'workbench_run'); assert.equal(detail.output.records.length, 0);
  const pdf = await context.request.get(retained.pdf_url); assert.equal(pdf.status(), 200); assert.equal(createHash('sha256').update(await pdf.body()).digest('hex'), 'bd60db7e7fe5c7950ac85264c653f48feeb9c503eca76147da26d297f830535f');
  const caps = await (await context.request.get('http://127.0.0.1:30141/api/t1/workbench/capabilities')).json(); assert.equal(caps.extraction_start, false); assert.equal(caps.controlled_fixture, false);
  await page.screenshot({ path: resolve(evidence, 'retained-L05-user-view.png'), fullPage: true });
  const runs = (await (await context.request.get('http://127.0.0.1:30141/api/t1/workbench/runs')).json()).runs;
  const old = runs.find(r => r.document_id === 'L07' && r.run_id.startsWith('b0-revalidation-') && r.origin === 'historical_compatibility_replay'); assert.ok(old);
  const historical = await (await context.request.get('http://127.0.0.1:30141/api/t1/workbench/runs/' + encodeURIComponent(old.run_id))).json(); assert.equal(historical.output.records.length, 26);
  assert.equal(mutations.length, 0); assert.equal(outside.length, 0);
  const result = { passed: true, current_L05_url: retained.user_url, original_pdf_url: retained.pdf_url, new_real_run_visible: true, record_count: 0,
    empty_output_and_three_download_controls_visible: true, task_complete_and_source_limits_separate: true, source_pdf_sha_checked: true,
    model_disabled: true, controlled_fixture: false, backend_mutations: mutations, external_browser_requests: outside, model_calls: 0,
    optional_historical_L07_url: 'http://127.0.0.1:30141/?paper=L07&run=' + encodeURIComponent(old.run_id) + '&view=records',
    historical_L07_is_separate_S4_output_not_this_run: true, historical_record_count: 26 };
  await writeFile(resolve(evidence, 'retained-view-check.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
} finally { await browser.close(); }
