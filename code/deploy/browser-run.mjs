import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

// Host-only browser driver. It cannot configure the server provider, limit or endpoint.
// The outer operator harness owns the container and always stops it in a separate finally.
export async function runContainerBrowser(options) {
  const code = process.cwd(), frontend = 'http://127.0.0.1:30142', root = resolve(code, options.evidence_directory);
  const inside = path => { const rel = relative(code, resolve(path)); assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel)); };
  inside(root); inside(resolve(code, options.input.path));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(await readFile(resolve(code, options.input.path))), options.input.sha256);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const report = { schema_version: 's7-container-browser-run-1', controlled_fixture: options.controlled_fixture === true, started_at: new Date().toISOString(), frontend,
    browser_upload_and_start: false, business_approval_added: false, external_browser_requests: [], page_errors: [] };
  process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(code, '.tools/annotation-browser/browsers');
  process.env.LD_LIBRARY_PATH = [resolve(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  const { chromium } = await import(pathToFileURL(resolve(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
  const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
  let context;
  const save = () => writeFile(resolve(root, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n');
  try {
    context = await browser.newContext({ viewport: { width: 1512, height: 1050 }, locale: 'zh-CN', acceptDownloads: true });
    await context.addInitScript(() => localStorage.setItem('pi-locale', 'zh-CN'));
    await context.route(/^https?:\/\//u, route => {
      if (new URL(route.request().url()).origin === frontend) return route.continue();
      report.external_browser_requests.push(route.request().url().split('?')[0]); return route.abort('blockedbyclient');
    });
    const page = await context.newPage(); page.on('pageerror', error => report.page_errors.push(error.message));
    const json = async suffix => { const response = await context.request.get(frontend + '/api/t1/workbench/' + suffix); assert.equal(response.status(), 200); return response.json(); };
    assert.equal((await json('runs')).runs.length, 0);
    const capabilities = await json('capabilities'); assert.equal(capabilities.extraction_start, true); assert.equal(capabilities.controlled_fixture, options.controlled_fixture === true);
    await page.goto(frontend + '/?view=newTask'); await page.locator('.t1-scope-editor').waitFor();
    if (!options.controlled_fixture) {
      assert.deepEqual(capabilities.model_runtime, { provider: options.model.provider, model_id: options.model.model_id, reasoning_effort: options.model.reasoning_effort,
        limits: { requests: options.limits.requests, input_tokens: options.limits.input_tokens, output_tokens: options.limits.output_tokens, execution_seconds: options.limits.seconds } });
      const notice = page.locator('.t1-model-runtime'); await notice.waitFor(); assert.ok((await notice.innerText()).includes(options.model.model_id));
      assert.ok((await notice.innerText()).includes('付费')); report.actual_model_notice_visible_before_start = true; report.public_model_runtime = capabilities.model_runtime;
    }
    for (const label of ['癌种', '图像类型', '视觉特征']) assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), 'all');
    await page.getByLabel('选择 PDF', { exact: true }).setInputFiles(resolve(code, options.input.path));
    await page.getByLabel('论文标题（可选）', { exact: true }).fill(options.controlled_fixture ? 'S7 Docker工程模拟（不作医学证据）' : `${options.input.document_id} S7 Docker真实贯通复验（原始结果待核）`);
    const pendingUpload = page.waitForResponse(response => response.url().endsWith('/api/t1/workbench/papers') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '上传论文', exact: true }).click(); assert.equal((await pendingUpload).status(), 201);
    const papers = (await json('papers')).papers; assert.equal(papers.length, 1); const paper = papers[0]; assert.equal(paper.sha256, options.input.sha256);
    report.paper_id = paper.id; await page.getByLabel('本次任务论文', { exact: true }).selectOption(paper.id);
    await page.locator('.t1-pdf-reader canvas[data-page="1"]').waitFor();
    await page.screenshot({ path: resolve(root, 'browser-upload-original.png'), fullPage: true });
    const pendingStart = page.waitForResponse(response => response.url().endsWith('/runs') && response.request().method() === 'POST');
    report.start_click_observed_at = new Date().toISOString();
    await page.getByRole('button', { name: '开始抽取', exact: true }).click(); assert.equal((await pendingStart).status(), 202);
    const runs = (await json('runs')).runs; assert.equal(runs.length, 1); const run = runs[0]; report.run_id = run.run_id; report.browser_upload_and_start = true; await save();
    let detail;
    const deadline = Date.now() + (options.seconds ?? 1800) * 1000;
    do {
      detail = await json('runs/' + encodeURIComponent(run.run_id));
      if (['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(detail.run.state) && detail.run.result_ready !== false && detail.output.result_ready !== false) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (Date.now() < deadline);
    assert.ok(['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(detail.run.state), 'operator deadline reached');
    assert.equal(detail.source_status, 'valid'); assert.equal((await json('runs')).runs.length, 1);
    const coverage = detail.output.coverage ?? {}, glyphIds = new Set(coverage.source_glyph_quarantined_block_ids ?? []);
    for (const record of detail.output.records) for (const fragment of [...record.fragments, ...record.context]) assert.equal(glyphIds.has(fragment.block_id), false, 'delivered quote intersects glyph quarantine');
    for (const blockId of coverage.completed_source_block_ids ?? []) assert.equal(glyphIds.has(blockId), false, 'glyph quarantine was reported completed');
    const original = await context.request.get(frontend + detail.pdf_url); assert.equal(original.status(), 200); assert.equal(hash(await original.body()), options.input.sha256);
    await page.goto(`${frontend}/?paper=${paper.id}&run=${encodeURIComponent(run.run_id)}&view=records`); await page.locator('.t1-task-progress').waitFor();
    if (detail.output.records.length) {
      const card = page.locator('article.t1-evidence-card').first(); await card.waitFor();
      await card.locator('.t1-fragment-location button').first().click();
      await page.locator(`.t1-pdf-reader canvas[data-page="${detail.output.records[0].fragments[0].physical_page}"]`).waitFor();
    }
    const downloads = [];
    for (const [kind, label, suffix] of [['candidate_jsonl', '候选 JSONL', 'jsonl'], ['candidate_csv', '候选 CSV', 'csv'], ['candidate_package', '候选证据包', 'tar.gz']]) {
      const pending = page.waitForEvent('download'); await page.getByRole('button', { name: label, exact: true }).click(); const download = await pending;
      const output = resolve(root, kind + '.' + suffix); await download.saveAs(output); assert.equal(await download.failure(), null);
      const bytes = await readFile(output); downloads.push({ kind, bytes: bytes.length, sha256: hash(bytes) });
    }
    await page.screenshot({ path: resolve(root, 'browser-saved-candidates.png'), fullPage: true });
    const approved = await context.request.get(frontend + '/api/t1/workbench/runs/' + encodeURIComponent(run.run_id) + '/exports/approved_jsonl');
    assert.equal(approved.status(), 400); assert.equal((await approved.json()).error, 'no_current_approved_records');
    Object.assign(report, { passed: true, state: detail.run.state, records: detail.output.records.length, coverage: detail.output.coverage,
      source_status: detail.source_status, task_processing_complete: detail.output.coverage?.task_processing_complete === true,
      selected_processable_scope_complete: coverage.selected_source_block_processing_complete === true,
      source_glyph_quarantined_blocks: glyphIds.size, source_gap_disclosed: glyphIds.size ? coverage.source_glyph_gaps_are_not_completed_or_task_exclusions === true : true,
      full_document_processing_claimed: false,
      approved_export_without_human_confirmation_refused: true,
      original_page_canvas_rendered: true, actual_UI_download_buttons: true, downloads, medical_quality_approved: false });
    assert.deepEqual(report.page_errors, []); assert.deepEqual(report.external_browser_requests, []);
  } catch (error) { report.passed = false; report.error = error.stack; throw error; }
  finally { report.finished_at = new Date().toISOString(); await save(); await Promise.allSettled([context?.close(), browser.close()]); }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try { const options = JSON.parse(await readFile(process.argv[2], 'utf8')); console.log(JSON.stringify(await runContainerBrowser(options))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
