/** S5 HTTP/browser verification against the explicitly controlled local runner. Never calls a model. */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const code = resolve('../..'), origin = 'http://127.0.0.1:30141';
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const evidence = join(code, 'docs/acceptance/s5-workflow-2026-11-09/browser'); await mkdir(evidence, { recursive: true });
const checks = [], pageErrors = [], blocked = [], failures = [];
const result = { schema_version: 's5-http-browser-1', started_at: new Date().toISOString(), frontend: origin, backend: 'http://127.0.0.1:3210', controlled_saved_source_replay: true, paid_calls: 0, new_model_effectiveness_validated: false, medical_quality_approved: false, medical_catalog_restricted_browser: 'unavailable: real service; valid multiselect and invalidation covered separately with synthetic nonmedical unit tests', checks, pageErrors, blocked, failures, papers: {}, runs: {} };
let browser, context, page, second, runA, runB, paperA, paperB;
const resumeFrom = process.env.T1_BROWSER_RESUME_FROM;
const prior = resumeFrom ? JSON.parse(await readFile(join(evidence, 'attempt-4-results.json'), 'utf8')) : null;
let skipping = Boolean(resumeFrom);
if (resumeFrom) result.continued_from = 'attempt-4-results.json';
const suffix = Date.now().toString(36), titleA = `S5浏览器任务A-${suffix}`, titleB = `S5浏览器任务B-${suffix}`;
const pdfA = join(code, 'evaluation/corpus/development-candidates/L01.pdf'), pdfB = join(code, 'evaluation/corpus/development-candidates/L07.pdf');
const persist = () => writeFile(join(evidence, 'results.json'), JSON.stringify(result, null, 2) + '\n');
async function check(name, work) { if (skipping && name !== resumeFrom) { const previous = prior.checks.find(check => check.name === name && check.status === 'passed'); assert.ok(previous, 'resumed check must have passed: ' + name); checks.push({ ...previous, executed_in: 'attempt-4-results.json' }); await persist(); return; } skipping = false; const start = Date.now(); try { const detail = await work(); checks.push({ name, status: 'passed', elapsed_ms: Date.now() - start, detail }); console.log(`passed: ${name}`); } catch (e) { checks.push({ name, status: 'failed', elapsed_ms: Date.now() - start, error: e.stack ?? String(e) }); console.error(`failed: ${name}: ${e.message}`); throw e; } finally { await persist(); } }
async function json(path) { const response = await context.request.get(origin + '/api/t1/' + path); assert.equal(response.status(), 200, path); return response.json(); }
async function current(id = runB.run_id) { return json(`workbench/runs/${encodeURIComponent(id)}`); }
async function newTask() { await page.getByRole('tab', { name: '新任务', exact: true }).click(); await page.locator('.t1-scope-editor').waitFor(); }
async function upload(path, title) { await newTask(); await page.getByLabel('选择 PDF', { exact: true }).setInputFiles(path); await page.getByLabel('论文标题（可选）', { exact: true }).fill(title); const response = page.waitForResponse(response => response.url().endsWith('/api/t1/workbench/papers') && response.request().method() === 'POST'); await page.getByRole('button', { name: '上传论文', exact: true }).click(); const saved = await response; assert.equal(saved.status(), 201); const value = (await json("workbench/papers")).papers.find(paper => paper.title === title); assert.ok(value); await page.getByLabel('本次任务论文', { exact: true }).selectOption(value.id); return value; }
async function start() { const previous = new Set((await json('workbench/runs')).runs.map(run => run.run_id)); const response = page.waitForResponse(response => response.url().endsWith('/runs') && response.request().method() === 'POST'); await page.getByRole('button', { name: '开始抽取', exact: true }).click(); const saved = await response; assert.equal(saved.status(), 202); const run = (await json('workbench/runs')).runs.find(run => !previous.has(run.run_id)); assert.ok(run); return run; }
async function selectRecord(id, target = page) { await target.getByLabel('原文记录', { exact: true }).selectOption(id); await target.locator(`article[data-record-id="${id}"]`).waitFor(); }
async function openRun(run, recordId) { await page.goto(`${origin}/?paper=${run.document_id}&run=${encodeURIComponent(run.run_id)}${recordId ? '&record=' + encodeURIComponent(recordId) : ''}&view=records`); await page.locator('.t1-task-progress').waitFor(); await page.waitForFunction(id => document.querySelector('.t1-output-toolbar select')?.value === `run:${id}`, run.run_id); }
async function edit(target = page) { await target.getByRole('button', { name: '重选原文／修订标签', exact: true }).click(); await target.locator('.t1-editor').waitFor(); return target.locator('.t1-editor'); }
async function saveEditor(editor) { const response = page.waitForResponse(response => /\/records(?:\/[^/]+)?$/.test(new URL(response.url()).pathname) && ['POST', 'PATCH'].includes(response.request().method())); await editor.getByRole('button', { name: /保存新版本|从原文补录候选/, exact: true }).click(); return response; }
async function approveText(target = page) { const review = target.locator('.t1-review'); await review.getByLabel('审核人', { exact: true }).fill('S5工程浏览器验证（非医学批准）'); for (const label of ['已核对原文与来源一致', '已核对相关性与证据角色', '已核对必要语境、条件与否定']) await review.getByLabel(label, { exact: true }).check(); const response = target.waitForResponse(response => response.url().endsWith('/review') && response.request().method() === 'POST'); await review.getByRole('button', { name: '批准当前文字', exact: true }).click(); const saved = await response; assert.equal(saved.status(), 200); await target.locator('.t1-review .t1-badge', { hasText: '文字已批准' }).waitFor(); }
async function download(kind, label) { const value = page.waitForEvent('download'); await page.getByRole('button', { name: label, exact: true }).click(); const file = await value; const path = join(evidence, `${kind}-${suffix}.${kind.includes('package') ? 'tar.gz' : kind.endsWith('csv') ? 'csv' : 'jsonl'}`); await file.saveAs(path); assert.equal(await file.failure(), null); return path; }

try {
  browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
  context = await browser.newContext({ viewport: { width: 1512, height: 1050 }, locale: 'zh-CN' });
  await context.route(/^https?:\/\//, route => { const url = new URL(route.request().url()); if (url.hostname === '127.0.0.1' && ['30141', '3210'].includes(url.port)) return route.continue(); blocked.push(url.origin); return route.abort('blockedbyclient'); });
  context.on('page', item => item.on('pageerror', e => pageErrors.push(e.stack ?? String(e))));
  context.on('response', response => { if (response.status() >= 500) failures.push({ status: response.status(), path: new URL(response.url()).pathname }); });
  page = await context.newPage();
  if (resumeFrom) { const papers = (await json('workbench/papers')).papers; paperA = papers.find(paper => paper.id === prior.papers.A); paperB = papers.find(paper => paper.id === prior.papers.B); runA = (await current(prior.runs.A)).run; runB = (await current(prior.runs.B)).run; result.papers = prior.papers; result.runs = prior.runs; await openRun(runB); }
  await check('controlled_service_and_gateway_boundaries', async () => {
    const caps = await json('workbench/capabilities'); assert.equal(caps.controlled_fixture, true); assert.equal(caps.extraction_start, true);
    for (const path of ['/api/agent/new', '/api/files/etc/passwd', '/api/terminal', '/annotation']) assert.equal((await context.request.get(origin + path)).status(), 404);
    assert.equal((await context.request.get(origin + '/api/t1/workbench/papers?cwd=/tmp')).status(), 400);
    assert.equal((await context.request.post(origin + '/api/t1/workbench/capabilities', { data: {} })).status(), 405);
    assert.equal((await context.request.post(origin + '/api/t1/workbench/papers', { data: {}, headers: { origin: 'https://untrusted.invalid' } })).status(), 403);
    return { controlled_fixture: true, arbitrary_routes_blocked: true, cross_origin_mutation_rejected: true };
  });
  await check('three_default_unrestricted_and_unavailable_medical_catalog', async () => {
    await page.goto(origin + '/?view=newTask'); await page.locator('.t1-scope-editor').waitFor();
    for (const label of ['癌种', '图像类型', '视觉特征']) assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), 'all');
    await page.getByLabel('癌种', { exact: true }).selectOption('selected');
    assert.ok((await page.locator('.t1-scope-editor').innerText()).includes('请至少选择一项'));
    assert.equal(await page.getByRole('button', { name: '开始抽取', exact: true }).isEnabled(), false);
    assert.equal(await page.locator('.t1-scope-editor input[type=checkbox]').count(), 0);
    await page.getByLabel('癌种', { exact: true }).selectOption('all');
    assert.ok((await page.locator('.t1-scope-editor').innerText()).includes('正式医学目录尚未核定'));
    await page.screenshot({ path: join(evidence, '01-new-task-scope.png'), fullPage: true });
    return { all_dimensions_default: 'all', restricted_empty_blocks: true, invented_medical_options: 0 };
  });
  await check('one_paper_upload_and_original_pdf_before_parsing', async () => {
    paperA = await upload(pdfA, titleA); result.papers.A = paperA.id;
    await page.locator('.t1-pdf-reader canvas[data-page="1"]').waitFor();
    assert.ok((await page.locator('.t1-pdf-status').innerText()).includes('已显示第 1 物理页'));
    assert.equal(await page.locator('.t1-pdf-reader canvas').getAttribute('data-page'), '1');
    return { paper_id: paperA.id, original_pdf_loaded_with_upload_page_count_initially_zero: true };
  });
  await check('two_independent_tasks_overlap_and_cancel_one', async () => {
    runA = await start(); result.runs.A = runA.run_id;
    paperB = await upload(pdfB, titleB); result.papers.B = paperB.id;
    runB = await start(); result.runs.B = runB.run_id;
    const a = await current(runA.run_id), b = await current(runB.run_id);
    assert.ok(['extracting', 'parsing'].includes(a.run.state), a.run.state); assert.ok(['extracting', 'parsing'].includes(b.run.state), b.run.state);
    assert.notEqual(a.run.document_id, b.run.document_id); assert.notEqual(a.run.run_id, b.run.run_id);
    await page.getByRole('tab', { name: '任务与历史', exact: true }).click();
    await page.locator('.t1-task-row').filter({ hasText: titleA }).getByRole('button', { name: '取消此任务', exact: true }).click();
    await page.waitForFunction(async ({ origin, id }) => (await (await fetch(origin + '/api/t1/workbench/runs/' + id)).json()).run.state === 'cancelled', { origin, id: runA.run_id });
    const after = await current(runB.run_id); assert.notEqual(after.run.state, 'cancelled');
    await page.locator('.t1-task-row').filter({ hasText: titleB }).getByRole('button').first().click();
    await page.locator('.t1-task-progress').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('article.t1-evidence-card').length > 0);
    await page.screenshot({ path: join(evidence, '02-progress-live-candidate.png'), fullPage: true });
    return { actual_overlap: { A: a.run.state, B: b.run.state }, A_cancelled: true, B_after_cancellation: after.run.state, per_paper_runs: true };
  });
  await check('refresh_restores_running_task_and_saved_candidates_sse', async () => {
    const before = await current(); await page.reload();
    await page.locator('.t1-task-progress').waitFor();
    assert.ok(page.url().includes(runB.run_id));
    await page.waitForFunction(() => document.querySelector('.t1-task-progress')?.textContent.includes('已连接'));
    let finished, deadline = Date.now() + 45000;
    do { finished = await current(); if (['completed', 'partial', 'failed'].includes(finished.run.state)) break; await delay(250); } while (Date.now() < deadline);
 assert.equal(finished.run.state, 'completed'); assert.ok(finished.output.records.length >= before.output.records.length);
    assert.equal(finished.output.origin, 'controlled_fixture'); assert.equal(finished.output.coverage.new_model_requests, 0); assert.equal(finished.output.medical_quality_approved, false);
    await page.getByRole('button', { name: '刷新工作台', exact: true }).click();
    await page.waitForFunction(count => document.querySelector('.t1-record-nav select')?.options.length === count, finished.output.records.length);
    return { records_before: before.output.records.length, records_after: finished.output.records.length, finished_scope: finished.output.scope, saved_source_replay_only: true };
  });
  await check('source_pdf_full_figure_caption_and_same_source_members', async () => {
    let value = await current();
    const proposal = value.output.records.find(record => record.proposed_figure_ids.length && record.reasons.some(reason => reason.includes("whole_figure")));
    const figureId = proposal?.proposed_figure_ids[0] ?? value.figures.find(figure => figure.assets.length && figure.number === "2")?.id;
    assert.ok(figureId, "retained full-Figure asset required");
    const sourceFigure = value.figures.find(figure => figure.id === figureId);
    await page.getByRole('tab', { name: '原 Figure 目录', exact: true }).click();
    const verification = page.locator(`section[aria-label="Figure ${sourceFigure.number}"] .t1-figure-verification`);
    await verification.locator('summary').click();
    await verification.getByLabel('已对照原页，确认整幅 Figure 的所有子图完整保留', { exact: true }).check();
    await verification.getByLabel('已核对此图身份、原图注及相关 Figure Note', { exact: true }).check();
    await verification.getByLabel('审核人', { exact: true }).fill('S5工程图源核验（仅独立受控DB）');
    await verification.getByLabel('图源核验说明（非论文原文）', { exact: true }).fill('本地浏览器工作流演示：整幅源资产与原页对照，非医学批准。');
    const checked = page.waitForResponse(response => response.url().endsWith('/verify') && response.request().method() === 'POST');
    await verification.getByRole('button', { name: '保存此图来源核验', exact: true }).click(); assert.equal((await checked).status(), 200);
    value = await current(); assert.equal(value.output.records.filter(record => record.text_approved || record.figures_approved).length, 0);
    const paired = value.output.records.find(record => record.association === 'paired' && record.figure_ids.length); assert.ok(paired, 'paired controlled candidate required after explicit full-Figure source verification');
    await page.getByRole('tab', { name: '原文与审核', exact: true }).click();
    await selectRecord(paired.id); await page.locator('.t1-evidence-card > .t1-fragments button').first().click();
    const physicalPage = paired.fragments[0].physical_page;
    await page.locator(`.t1-pdf-reader canvas[data-page="${physicalPage}"]`).waitFor();
    const image = page.locator('.t1-association img').first(); await image.waitFor();
    await image.evaluate(node => node.complete ? Promise.resolve() : new Promise((resolve, reject) => { node.addEventListener('load', resolve, { once: true }); node.addEventListener('error', reject, { once: true }); }));
    assert.ok(await image.evaluate(node => node.naturalWidth > 100));
    const figure = value.figures.find(item => item.id === paired.figure_ids[0]);
    assert.deepEqual(await page.locator('.t1-association .t1-caption .t1-verbatim').allTextContents(), figure.caption.map(fragment => fragment.exact_quote));
    assert.deepEqual(await page.locator('.t1-evidence-card > .t1-fragments .t1-verbatim').allTextContents(), paired.fragments.map(fragment => fragment.exact_quote));
    const group = value.output.same_source_review_index.groups.find(group => group.member_count > 1); assert.ok(group);
    await selectRecord(group.members[0].record_id); assert.equal(await page.locator('.t1-member-list>div').count(), group.member_count);
    await page.locator('.t1-member-list button').last().click(); assert.equal(await page.locator('.t1-evidence-card').getAttribute('data-record-id'), group.members.at(-1).record_id);
    assert.equal(await page.locator('.t1-evidence-card > .t1-fragments').count(), 1);
    await page.screenshot({ path: join(evidence, '03-source-group-members.png'), fullPage: true });
    return { original_pdf_physical_page: physicalPage, figure_original_bytes_and_caption: true, group_members: group.member_count, automatic_member_approval: false, candidate_text_verbatim: true };
  });
  let textRecordId;
  await check('text_approval_is_individual_and_pending_figures_do_not_block_export', async () => {
    const value = await current(), record = value.output.records.find(record => record.association !== 'paired'); assert.ok(record); textRecordId = record.id;
    await selectRecord(record.id); assert.equal(await page.locator('.t1-review').getByRole('button', { name: '批准当前文字', exact: true }).isEnabled(), false);
    await approveText(); const reviewed = await current(), latest = reviewed.output.records.find(item => item.id === record.id);
    assert.equal(latest.text_approved, true); assert.equal(latest.figures_approved, false);
    assert.equal(reviewed.output.records.filter(item => item.text_approved).length, 1);
    const path = await download('approved_jsonl', '已审核 JSONL'); const bytes = await readFile(path, 'utf8'); assert.ok(bytes.includes(record.id));
    await download('approved_csv', '已审核 CSV'); await download('approved_package', '已审核证据包');
    return { record_id: record.id, text_approved: true, figures_approved: false, other_records_approved: 0, approved_formats: ['jsonl', 'csv', 'tar.gz'] };
  });
  await check('figure_approval_is_separate_and_source_current_version_bound', async () => {
    const value = await current(), record = value.output.records.find(record => record.association === 'paired' && record.figure_ids.length); await selectRecord(record.id);
    await approveText(); let latest = (await current()).output.records.find(item => item.id === record.id); assert.equal(latest.figures_approved, false);
    const review = page.locator('.t1-review'); await review.getByLabel('审核人', { exact: true }).fill('S5工程浏览器验证（非医学批准）'); await review.getByLabel('已核对整幅图、原图注与此条配对关系', { exact: true }).check();
    const response = page.waitForResponse(response => response.url().endsWith('/review') && response.request().method() === 'POST'); await review.getByRole('button', { name: '批准当前图片', exact: true }).click(); assert.equal((await response).status(), 200);
    latest = (await current()).output.records.find(item => item.id === record.id); assert.equal(latest.text_approved, true); assert.equal(latest.figures_approved, true);
    return { record_id: record.id, separately_approved_figure_ids: latest.figure_ids, current_version: latest.version };
  });
  await check('two_tab_revision_conflict_retains_draft_and_isolation_on_refresh', async () => {
    await selectRecord(textRecordId); let editor = await edit();
    await editor.getByLabel('审核人', { exact: true }).fill('S5工程标签修订者A'); await editor.getByLabel('审核人补充（与原文分开）', { exact: true }).fill('A草稿：必须保留，不是论文原文'); await editor.getByLabel('标签（逗号分隔）', { exact: true }).fill('工程验证A, 独立标签');
    const baseVersion = (await current()).output.records.find(item => item.id === textRecordId).version;
    second = await context.newPage(); await second.goto(`${origin}/?paper=${paperB.id}&run=${runB.run_id}&record=${encodeURIComponent(textRecordId)}&view=records`); await second.locator('.t1-evidence-card').waitFor(); const secondEditor = await edit(second);
    await secondEditor.getByLabel('审核人', { exact: true }).fill('S5工程标签修订者B'); await secondEditor.getByLabel('审核人补充（与原文分开）', { exact: true }).fill('B已保存注释');
    const secondResponse = second.waitForResponse(response => response.request().method() === 'PATCH'); await secondEditor.getByRole('button', { name: '保存新版本', exact: true }).click(); assert.equal((await secondResponse).status(), 200);
    const response = await saveEditor(editor); assert.equal(response.status(), 409); await editor.getByRole('alert').waitFor();
    assert.equal(await editor.getByLabel('审核人补充（与原文分开）', { exact: true }).inputValue(), 'A草稿：必须保留，不是论文原文');
    const detail = await current(); assert.equal(detail.output.records.find(item => item.id === textRecordId).text_approved, false);
    await page.reload(); await page.locator('.t1-evidence-card').waitFor(); editor = await edit();
    assert.equal(await editor.getByLabel('审核人补充（与原文分开）', { exact: true }).inputValue(), 'A草稿：必须保留，不是论文原文');
    assert.ok((await editor.innerText()).includes(`版本 ${baseVersion}`));
    const stale = await saveEditor(editor); assert.equal(stale.status(), 409);
    await editor.getByRole('button', { name: '读取最新版本', exact: true }).click();
    assert.equal(await editor.getByLabel('审核人补充（与原文分开）', { exact: true }).inputValue(), 'A草稿：必须保留，不是论文原文');
    const saved = await saveEditor(editor); assert.equal(saved.status(), 200); await editor.waitFor({ state: 'hidden' });
    const after = (await current()).output.records.find(item => item.id === textRecordId); assert.equal(after.labels.comment, 'A草稿：必须保留，不是论文原文'); assert.deepEqual(after.labels.tags, ['工程验证A', '独立标签']); assert.equal(after.text_approved, false);
    await second.close();
    await openRun(runA); assert.equal(await page.locator('.t1-editor').count(), 0); await openRun(runB, textRecordId);
    return { base_version: baseVersion, saved_version: after.version, stale_http_status: 409, draft_survives_refresh: true, cross_task_draft_mixing: false, revision_invalidated_old_approval: true };
  });
  await check('source_reselection_add_and_delete_use_retained_units_only', async () => {
    const value = await current(), target = value.output.records.find(item => item.id !== textRecordId && item.source_unit_ids.length && item.context_unit_ids.length === 0); assert.ok(target);
    await selectRecord(textRecordId); const editor = await edit();
    for (const box of await editor.getByRole('checkbox').all()) if (await box.isChecked()) await box.uncheck();
    for (const id of target.source_unit_ids) { await editor.getByLabel('查找来源原文', { exact: true }).fill(id); await editor.getByRole('checkbox', { name: `主证据来源单元 ${id}`, exact: true }).check(); }
    await editor.getByLabel('审核人', { exact: true }).fill('S5工程来源重选'); const response = await saveEditor(editor); assert.equal(response.status(), 200); await editor.waitFor({ state: 'hidden' });
    const changed = (await current()).output.records.find(item => item.id === textRecordId); assert.deepEqual(changed.fragments, target.fragments); assert.equal(changed.text_approved, false);
    await page.getByRole('button', { name: '从原文补录候选', exact: true }).click(); const add = page.locator('.t1-editor');
    for (const id of target.source_unit_ids) { await add.getByLabel('查找来源原文', { exact: true }).fill(id); await add.getByRole('checkbox', { name: `主证据来源单元 ${id}`, exact: true }).check(); }
    await add.getByLabel('审核人', { exact: true }).fill('S5工程补录'); const addition = await saveEditor(add); assert.equal(addition.status(), 200); await add.waitFor({ state: 'hidden' });
    const added = (await current()).output.records.find(item => !value.output.records.some(old => old.id === item.id)); assert.ok(added); assert.equal(added.text_approved, false);
    await page.getByRole('button', { name: '刷新工作台', exact: true }).click(); await page.waitForFunction(id => [...(document.querySelector('.t1-record-nav select')?.options ?? [])].some(option => option.value === id), added.id); await selectRecord(added.id);
    const deletion = await edit(); await deletion.getByLabel('审核人', { exact: true }).fill('S5工程删除'); await deletion.getByRole('button', { name: '删除此条候选', exact: true }).click(); const deleting = page.waitForResponse(response => response.request().method() === 'DELETE'); await deletion.getByRole('button', { name: '确认仅删除此条记录', exact: true }).click(); assert.equal((await deleting).status(), 200); await deletion.waitFor({ state: 'hidden' });
    const after = await current(); assert.equal(after.output.records.some(item => item.id === added.id && !item.deleted), false);
    return { source_reselected_record: textRecordId, source_units: target.source_unit_ids, added_then_deleted: added.id, source_free_text_editor: false };
  });
  await check('candidate_downloads_and_complete_evidence_packages', async () => {
    await download('candidate_jsonl', '候选 JSONL'); await download('candidate_csv', '候选 CSV'); const path = await download('candidate_package', '候选证据包');
    const paired = (await current()).output.records.find(item => item.text_approved && item.figures_approved); assert.ok(paired); await download('approved_package_with_figures', '已审核证据包');
    return { candidate_formats: ['jsonl', 'csv', 'tar.gz'], package_bytes: (await readFile(path)).length, approved_figure_member: paired.id };
  });
  await check('missing_or_changed_pdf_blocks_approved_export_and_identical_restore', async () => {
    const path = join(code, 'runtime-data/s5-controlled-browser/pdf', paperB.sha256 + '.pdf'), backup = path + '.s5-browser-backup';
    const bytes = await readFile(path); await rename(path, backup);
    try {
      await page.getByRole('button', { name: '刷新工作台', exact: true }).click(); await page.locator('.t1-source-recovery').waitFor();
      assert.equal(await page.getByRole('button', { name: '已审核证据包', exact: true }).isEnabled(), false);
      const direct = await context.request.get(origin + `/api/t1/workbench/runs/${runB.run_id}/exports/approved_jsonl`); assert.equal(direct.status(), 400);
      await page.getByLabel('选择待恢复的同一原 PDF', { exact: true }).setInputFiles(pdfA); let response = page.waitForResponse(response => response.request().method() === 'PUT'); await page.getByRole('button', { name: '恢复同一原 PDF', exact: true }).click(); assert.equal((await response).status(), 400);
      assert.ok((await page.locator('.t1-content').innerText()).includes('须与保留原件的 SHA256 完全一致'));
      await page.getByLabel('选择待恢复的同一原 PDF', { exact: true }).setInputFiles(pdfB); response = page.waitForResponse(response => response.request().method() === 'PUT'); await page.getByRole('button', { name: '恢复同一原 PDF', exact: true }).click(); assert.equal((await response).status(), 200); await page.locator('.t1-source-recovery').waitFor({ state: 'hidden' });
      assert.deepEqual(await readFile(path), bytes);
      await writeFile(path, await readFile(pdfA)); await page.getByRole('button', { name: '刷新工作台', exact: true }).click(); await page.locator('.t1-source-recovery').waitFor();
      assert.ok((await page.locator('.t1-content').innerText()).includes('PDF 字节与登记 SHA256 不一致'));
      await page.getByLabel('选择待恢复的同一原 PDF', { exact: true }).setInputFiles(pdfB); response = page.waitForResponse(response => response.request().method() === 'PUT'); await page.getByRole('button', { name: '恢复同一原 PDF', exact: true }).click(); assert.equal((await response).status(), 200); await page.locator('.t1-source-recovery').waitFor({ state: 'hidden' });
      await page.screenshot({ path: join(evidence, '04-reviewed-workflow.png'), fullPage: true });
    } finally { await writeFile(path, bytes); await rm(backup, { force: true }); }
    return { missing_blocked: true, wrong_sha_blocked: true, wrong_restore_rejected: true, identical_pdf_restore: true, original_source_bytes_preserved: true };
  });
  await check('paper_deletion_explains_scope_and_preserves_shared_pdf', async () => {
    const extra = await upload(pdfB, `S5删除测试-${suffix}`); await page.getByRole('tab', { name: '任务与历史', exact: true }).click();
    const details = page.locator('details').filter({ has: page.locator('summary', { hasText: '删除此论文及其运行' }) }); await details.locator('summary').click(); assert.ok((await details.innerText()).includes('共享文件会保留'));
    await details.getByRole('button', { name: '删除此论文及其运行', exact: true }).click(); const response = page.waitForResponse(response => response.request().method() === 'DELETE'); await details.getByRole('button', { name: '确认删除此论文', exact: true }).click(); assert.equal((await response).status(), 200);
    assert.equal((await context.request.get(origin + '/api/t1/workbench/papers/' + extra.id)).status(), 404);
    assert.equal((await context.request.get(origin + '/api/t1/workbench/papers/' + paperB.id + '/pdf')).status(), 200);
    return { deleted_test_paper: extra.id, shared_original_pdf_still_available: true };
  });
  await check('responsive_and_three_locales_without_runtime_errors', async () => {
    await openRun(runB); await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: join(evidence, '05-mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.getByLabel('界面语言', { exact: true }).selectOption('en'); await page.getByRole('heading', { name: 'Evidence and review', exact: true }).waitFor();
    await page.getByLabel('Interface language', { exact: true }).selectOption('zh-TW'); await page.getByRole('heading', { name: '原文與審核', exact: true }).waitFor();
    await page.getByLabel('介面語言', { exact: true }).selectOption('zh-CN');
    assert.deepEqual(pageErrors, []); assert.deepEqual(blocked, []); assert.deepEqual(failures, []);
    return { mobile_no_horizontal_overflow: true, locales: ['en', 'zh-CN', 'zh-TW'], browser_errors: 0, external_requests: 0 };
  });
  result.completed_at = new Date().toISOString(); result.passed = true;
} catch (e) { result.passed = false; result.failure = e.stack ?? String(e); if (page) { await page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }).catch(() => {}); await writeFile(join(evidence, 'failure-body.txt'), await page.locator('body').innerText().catch(() => 'page unavailable')); } process.exitCode = 1;
} finally { await persist(); await browser?.close(); }
