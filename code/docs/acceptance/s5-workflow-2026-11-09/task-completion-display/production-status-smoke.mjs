/** Read-only check of the already bound real L01 run; no production mutations or model calls. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const base = dirname(fileURLToPath(import.meta.url)), code = resolve(base, '../../../..'), origin = 'http://127.0.0.1:30141';
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const before = JSON.parse(await readFile(join(base, 'L01-state-and-review-before.json'), 'utf8'));
const report = { checked_at: new Date().toISOString(), paid_calls: 0, production_mutations: 0, browser_errors: [], blocked_external_requests: [] };
let browser;
try {
  report.build_id = (await readFile(join(code, 'apps/pi-web/.next/BUILD_ID'), 'utf8')).trim();
  browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1512, height: 1050 } });
  await context.route(/^https?:\/\//, route => { if (new URL(route.request().url()).origin === origin) return route.continue(); report.blocked_external_requests.push(route.request().url()); return route.abort('blockedbyclient'); });
  const page = await context.newPage(); page.on('pageerror', error => report.browser_errors.push(error.stack ?? String(error)));
  const api = async path => { const response = await context.request.get(origin + '/api/t1/' + path); assert.equal(response.status(), 200); return response.json(); };
  const caps = await api('workbench/capabilities'); assert.equal(caps.controlled_fixture, false); assert.equal(caps.extraction_start, false);
  const detail = await api('workbench/runs/' + encodeURIComponent(before.run.run_id));
  assert.equal(detail.run.state, 'partial'); assert.equal(detail.output.coverage.task_processing_complete, true);
  await page.goto(`${origin}/?paper=L01&run=${encodeURIComponent(before.run.run_id)}&view=records`);
  await page.getByText('本次任务范围已处理完成；候选仍需逐条审核，全文召回和医学正确性仍待独立核验。', { exact: true }).waitFor();
  assert.equal(await page.locator('.t1-task-progress strong').innerText(), '任务处理完成 · 候选仍待人工审核');
  assert.ok((await page.locator('.t1-output-toolbar select').evaluate(node => node.selectedOptions[0].textContent)).includes('任务处理完成'));
  const text = await page.locator('.t1-content').innerText(); assert.equal(text.includes('任务已停止'), false); assert.equal(text.includes('可创建新运行从头抽取'), false);
  await page.locator('.t1-source-limits').waitFor(); assert.ok((await page.locator('.t1-source-limits').innerText()).includes('解析来源仍有限制'));
  assert.equal(await page.locator('.t1-task-progress').getByRole('button', { name: '取消此任务', exact: true }).count(), 0);
  await page.locator('.t1-evidence-card').waitFor(); await page.locator('.t1-evidence-card > .t1-fragments button').first().click(); const physicalPage = detail.output.records[0].fragments[0].physical_page;
  await page.locator(`.t1-pdf-reader canvas[data-page="${physicalPage}"]`).waitFor();
  await page.screenshot({ path: join(base, 'L01-task-complete-with-source-limits.png'), fullPage: true });
  await page.getByRole('tab', { name: '任务与历史', exact: true }).click();
  const row = page.locator('.t1-task-row').filter({ has: page.locator('code', { hasText: before.run.run_id }) });
  assert.ok((await row.locator('span').first().innerText()).includes('任务处理完成'));
  const after = await api('workbench/runs/' + encodeURIComponent(before.run.run_id));
  const snap = { run: after.run, coverage: after.output.coverage, records: after.output.records.map(record => ({ id: record.id, version: record.version, text_approved: record.text_approved, figures_approved: record.figures_approved, labels: record.labels, text_fingerprint: record.text_fingerprint })) };
  assert.deepEqual(snap, before); await writeFile(join(base, 'L01-state-and-review-after.json'), JSON.stringify(snap, null, 2));
  assert.deepEqual(report.browser_errors, []); assert.deepEqual(report.blocked_external_requests, []);
  Object.assign(report, { passed: true, raw_state_unchanged: 'partial', task_processing_complete: true, parser_status: after.output.coverage.parser_status, completion_visible: true, source_limitations_separate: true, incorrect_rerun_hint_absent: true, dropdown_and_history_consistent: true, raw_terminal_controls_unchanged: true, original_pdf_physical_page: physicalPage, coverage_and_review_versions_unchanged: true, controlled_fixture: caps.controlled_fixture, extraction_start: caps.extraction_start });
} catch (error) { report.passed = false; report.error = error.stack ?? String(error); process.exitCode = 1; }
finally { await writeFile(join(base, 'production-smoke.json'), JSON.stringify(report, null, 2) + '\n'); await browser?.close(); }
console.log(JSON.stringify(report));
