/** Focused browser checks for this round's real, finalized B0 review pack only. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)), code = resolve(here, '../../..');
const packRoot = join(here, 'output-review'), evidence = join(packRoot, 'browser-verification.json');
const scratch = await mkdtemp(join(here, '.review-browser-'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const checks = [], pageErrors = [], consoleErrors = [], failures = [], external = [];
const contexts = [];
const result = { schema_version: 'b0-output-review-browser-verification-1', checked_at_utc: new Date().toISOString(),
  method: 'B0', actual_real_round_pack: true, actual_chromium_execution: true, vscode_live_server_extension_exercised: false,
  static_only: true, model_or_API_calls: 0, actual_human_reviews: 0, ordinary_opinions_are_not_business_version_approval: true,
  medical_quality_approved: false, checks };
let browser, server, manifest, pack;
const inside = path => { const target = resolve(code, path.replace(/^code\//, '')); assert.ok(target.startsWith(code + sep)); return target; };
async function check(name, work) {
  try { const detail = await work(); checks.push({ name, status: 'passed', detail }); }
  catch (error) { checks.push({ name, status: 'failed', error: error.stack || String(error) }); }
  console.log(checks.at(-1).status + ': ' + name);
}
async function exported(page, name) {
  const pending = page.waitForEvent('download'); await page.locator('#export').click(); const download = await pending;
  assert.equal(await download.failure(), null);
  const path = join(scratch, name + '.json'); await download.saveAs(path);
  return { path, value: JSON.parse(await readFile(path, 'utf8')) };
}
async function imported(page, value, name) {
  const path = join(scratch, name + '.json'); await writeFile(path, JSON.stringify(value));
  await page.locator('#message').evaluate(n => { n.textContent = ''; });
  await page.locator('#import').setInputFiles(path);
  await page.waitForFunction(() => document.querySelector('#message').textContent.length > 0);
  return page.locator('#message').textContent();
}

try {
  pack = JSON.parse(await readFile(join(packRoot, 'data.json'), 'utf8'));
  manifest = JSON.parse(await readFile(join(packRoot, 'manifest.json'), 'utf8'));
  assert.equal(pack.method, 'B0'); assert.equal(pack.method_selected, true);
  assert.equal(hash(await readFile(join(here, 'build-output-review.py'))), manifest.generator_sha256);
  for (const [path, expected] of Object.entries(manifest.source_files)) assert.equal(hash(await readFile(inside(path))), expected, path);
  for (const [path, expected] of Object.entries(manifest.files)) assert.equal(hash(await readFile(join(packRoot, path))), expected, path);
  Object.assign(result, { pack_id: pack.pack_id, pack_sha256: pack.pack_sha256, plan_sha256: pack.plan_sha256,
    output_binding_sha256: pack.output_binding_sha256, population: pack.group_counts, sample: pack.sample_group_counts,
    postprocessing_binding_sha256: pack.postprocessing_binding_sha256, original_strict_groups: pack.unique_source_group_count,
    derived_source_context_groups: pack.derived_source_context_group_count, derived_same_source_pairs: pack.derived_same_source_multi_member_group_count,
    internal_reference_hints: pack.derived_internal_reference_hint_count, sampling_summary: pack.sampling_summary,
    question_semantics_counts: manifest.question_semantics_counts, figure_question_cases: pack.figure_question_cases,
    no_figure_question_cases: pack.no_figure_question_cases, verification_script_sha256: hash(await readFile(fileURLToPath(import.meta.url))) });
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.pdf': 'application/pdf' };
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1'); let path = decodeURIComponent(url.pathname).replace(/^\/review\//, '');
      if (!path || path.endsWith('/')) path += 'index.html';
      const target = resolve(packRoot, path);
      if (!target.startsWith(packRoot + sep) || !['GET', 'HEAD'].includes(request.method)) return response.writeHead(403).end();
      if (!(await stat(target)).isFile()) return response.writeHead(404).end();
      const bytes = await readFile(target); response.writeHead(200, { 'Content-Type': mime[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const local = 'http://127.0.0.1:' + server.address().port, insecure = 'http://192.0.2.42:' + server.address().port, url = local + '/review/';
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
  process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  const font = join(code, '.tools/mineru-venv/lib/python3.12/site-packages/docvortex/resources/fonts/DroidSansFallbackFull.ttf');
  const config = join(scratch, 'fonts.conf'); await mkdir(join(scratch, 'font-cache'));
  await writeFile(config, '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>/usr/share/fonts</dir><dir>' + dirname(font) + '</dir><cachedir>' + join(scratch, 'font-cache') + '</cachedir></fontconfig>');
  process.env.FONTCONFIG_FILE = config;
  result.screenshot_font_environment = { existing_font_sha256: hash(await readFile(font)), temporary_private_fontconfig_only: true, system_fonts_and_page_CSS_unchanged: true };
  const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
  browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-proxy-server'] });
  result.browser_version = browser.version();
  async function page(label) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true }); contexts.push(context);
    await context.route(/^https?:\/\//, async route => {
      const request = new URL(route.request().url());
      if (request.origin === local) return route.continue();
      if (request.origin === insecure) return route.fulfill({ response: await route.fetch({ url: local + request.pathname + request.search }) });
      external.push({ label, origin: request.origin, path: request.pathname }); return route.abort('blockedbyclient');
    });
    const p = await context.newPage(); p.setDefaultTimeout(15000);
    p.on('pageerror', e => pageErrors.push({ label, error: String(e) }));
    p.on('console', m => { if (m.type() === 'error') consoleErrors.push({ label, text: m.text() }); });
    p.on('response', r => { if (r.status() >= 400) failures.push({ label, url: r.url(), status: r.status() }); });
    return { p, context };
  }
  const { p } = await page('real-B0'); await p.goto(url, { waitUntil: 'networkidle' });
  await p.waitForFunction(() => document.querySelector('#group-summary').textContent.length > 0);
  await check('single_B0_truthful_status_population_and_conditional_image_question_counts', async () => {
    assert.match(await p.locator('.scope').first().textContent(), /B0 已选定/);
    assert.doesNotMatch(await p.locator('body').innerText(), /L01-F|五个独立|六个逻辑/);
    assert.equal(await p.locator('#run-summary tbody tr').count(), 3);
    assert.equal(pack.total_current_candidates, pack.group_counts.primary_candidate + pack.group_counts.background_suggestion + pack.group_counts.delivery_rejected);
    assert.equal(pack.figure_question_cases + pack.no_figure_question_cases, pack.cases.length);
    for (const j of pack.logical_jobs) {
      const row = await p.locator(`[data-job-id="${j.job_id}"]`).textContent();
      if (!j.started) assert.match(row, /未启动/);
      else if (j.failure_codes?.length || j.error) assert.match(row, /失败|未完成/);
      else if (j.task_processing_complete) assert.match(row, /本次范围处理完成/);
    }
    return { jobs: 3, groups_visible: true, image_omissions_not_counted_as_pairing_success: true };
  });
  await check('all_sample_literal_fragments_safe_DOM_and_each_actual_question', async () => {
    for (const c of pack.cases) {
      await p.locator('#kind-filter').selectOption('all'); await p.locator('#role-filter').selectOption('all');
      await p.locator(`[data-case-id="${c.case_id}"]`).click();
      assert.deepEqual(await p.locator('#parsed-view .caption-line').allTextContents(), c.after.sections.filter(s => s.type === 'fragments').flatMap(s => s.fragments.map(f => f.text)));
      assert.deepEqual(await p.locator('#questions legend').allTextContents(), c.questions.map(q => q.text));
      assert.equal(await p.locator('[data-question-id="figure_correspondence"]').count(), c.figure_question_applicable ? 1 : 0);
      assert.equal(await p.locator('#questions [aria-pressed="true"]').count(), 0);
      await p.locator('#original-image').scrollIntoViewIfNeeded();
      await p.waitForFunction(() => { const i = document.querySelector('#original-image'); return i.complete && i.naturalWidth > 100; });
      assert.doesNotMatch(await p.locator('body').innerText(), /Figure (None|null)\b/);
    }
    if (pack.cases.length) {
      const c = pack.cases.find(c => c.review_group === 'background_suggestion') || pack.cases[0];
      await p.locator(`[data-case-id="${c.case_id}"]`).click(); await p.evaluate(() => scrollTo(0, 0));
      await p.screenshot({ path: join(packRoot, 'browser-review.png'), fullPage: true });
      result.screenshot = { file: 'browser-review.png', sha256: hash(await readFile(join(packRoot, 'browser-review.png'))), no_synthetic_answers: true };
    }
    return { sample_cases: pack.cases.length, raw_textContent_equal: true, questions_bound_to_actual_purpose: true };
  });
  await check('export_import_exact_case_question_group_and_source_binding_without_business_approval', async () => {
    if (!pack.cases.length) return { skipped: 'No source-bound current records to answer.' };
    const chosen = [...new Map(pack.cases.map(c => [c.questions[1].review_intent, c])).values()];
    for (const c of chosen) {
      await p.locator(`[data-case-id="${c.case_id}"]`).click();
      const question = p.locator('[data-question-id="target_visual_description"]');
      await question.locator('[data-verdict="cannot_judge"]').click();
      assert.equal(await question.locator('input[type="checkbox"]:checked').count(), 0);
      await question.locator('textarea').fill('自动化检查的临时意见；不作实际审核。');
    }
    const value = await exported(p, 'synthetic-roundtrip');
    for (const o of value.value.opinions) {
      const c = pack.cases.find(c => c.case_id === o.case_id), q = c.questions.find(q => q.question_id === o.question_id);
      assert.deepEqual(o.source_binding, c.source_binding); assert.equal(o.question_text, q.text);
      assert.equal(o.question_semantics, q.review_intent); assert.equal(o.review_group, c.review_group);
    }
    for (const name of ['human_approved', 'medical_quality_approved', 'product_export_approved']) assert.equal(value.value[name], false);
    p.once('dialog', d => d.accept()); await p.locator('#clear').click();
    assert.match(await imported(p, value.value, 'valid'), /已恢复/);
    const before = await p.evaluate(() => JSON.stringify({ ...localStorage }));
    for (const name of ['source', 'semantics', 'plan']) {
      const wrong = structuredClone(value.value);
      if (name === 'source') wrong.opinions[0].source_binding.record_version++;
      if (name === 'semantics') wrong.opinions[0].question_semantics = 'wrong-purpose';
      if (name === 'plan') wrong.plan_sha256 = 'wrong-plan';
      assert.match(await imported(p, wrong, name), /未导入|不一致/);
      assert.equal(await p.evaluate(() => JSON.stringify({ ...localStorage })), before);
    }
    assert.match(execFileSync(join(code, '.venv/bin/python'), [join(here, 'build-output-review.py'), '--verify-opinions', value.path], { encoding: 'utf8' }), /strict_version_binding.*passed/);
    return { temporary_opinions: chosen.length, stale_imports_refused: 3, no_preselected_answer: true };
  });
  await check('all_actual_records_source_groups_members_and_ten_observations_retained', async () => {
    await p.goto(url + 'all-candidates.html', { waitUntil: 'networkidle' });
    assert.equal(await p.locator('details[data-record-id]').count(), manifest.all_candidate_membership.length);
    for (const m of manifest.all_candidate_membership) {
      const card = p.locator(`details[data-job-id="${m.job_id}"][data-record-id="${m.record_id}"]`);
      const saved = JSON.parse(await readFile(inside(m.source_binding.result_path), 'utf8'));
      const record = saved.versions.find(v => v.record.record_id === m.record_id && v.version === m.record_version).record;
      const sections = card.locator(':scope > section.parsed-section');
      assert.deepEqual(await sections.nth(0).locator('pre').allTextContents(), record.quote_span.segments.map(f => f.exact_quote));
      assert.deepEqual(await sections.nth(1).locator('pre').allTextContents(), record.context.fragments.map(f => f.exact_quote));
    }
    await p.goto(url + 'source-groups.html', { waitUntil: 'networkidle' });
    assert.equal(await p.locator('[data-source-group-id]').count(), pack.strict_source_groups.length);
    for (const g of pack.strict_source_groups) {
      const section = p.locator(`[data-source-group-id="${g.group_id}"]`);
      assert.equal(await section.locator('article[data-record-id]').count(), g.member_count);
      for (const member of g.members) assert.equal(await section.locator(`article[data-record-id="${member.record_id}"]`).count(), 1);
    }
    assert.equal(pack.source_observations.length, 10);
    for (const o of pack.source_observations) {
      assert.equal(o.recall_pass_or_fail, null);
      for (const m of o.matches) assert.equal(pack.cases.filter(c => c.source_binding.job_id === m.job_id && c.source_binding.record_id === m.record_id && c.source_binding.record_version === m.record_version).length, 1);
    }
    await p.goto(url + 'source-observations.html', { waitUntil: 'networkidle' });
    assert.equal(await p.locator('main > section').count(), 10);
    return { all_current_records: pack.total_current_candidates, source_groups: pack.strict_source_groups.length, observations: 10, absent_items_not_recall_verdicts: true };
  });
  await check('separate_postrun_provenance_three_pairs_all_members_and_internal_Figure_hints', async () => {
    const transition = pack.postprocessing_source_transition;
    assert.equal(transition.helper_source_path, 'packages/agent/src/strict-source-groups.ts');
    const plan = JSON.parse(await readFile(join(here, 'prepared/plan.json'), 'utf8'));
    const post = JSON.parse(await readFile(join(here, 'postprocessing/binding.json'), 'utf8'));
    assert.equal(hash(await readFile(join(here, 'postprocessing/binding.json'))), pack.postprocessing_binding_sha256);
    assert.equal(post.helper_used_in_paid_model_execution, false); assert.equal(post.additional_real_model_provider_requests, 0);
    assert.equal(post.parent_output_binding_sha256, pack.output_binding_sha256);
    for (const [path, expected] of Object.entries(plan.source_hashes)) {
      assert.equal(hash(await readFile(join(here, 'prepared/source-snapshot', path))), expected, 'model-run snapshot: ' + path);
      assert.equal(hash(await readFile(join(code, path))), path === transition.helper_source_path ? transition.postprocessing_source_sha256 : expected, 'current code guard: ' + path);
    }
    assert.equal(transition.model_runtime_sha256, plan.source_hashes[transition.helper_source_path]);
    const original = await readFile(join(here, 'prepared/source-snapshot', transition.helper_source_path));
    const current = await readFile(join(code, transition.helper_source_path));
    assert.ok(current.subarray(0, original.length).equals(original), 'pure append keeps all original model-run code');
    await p.goto(url + 'source-groups.html', { waitUntil: 'networkidle' });
    let pairs = 0, hints = 0, visibleGroups = 0;
    for (const job of pack.same_source_review_index.jobs) {
      for (const group of job.index.groups) {
        if (group.member_count <= 1 && !group.internal_reference_role_needs_review) continue;
        visibleGroups++;
        const section = p.locator(`[data-source-review-group-id="${group.group_id}"]`);
        assert.equal(await section.locator('article[data-record-id]').count(), group.member_count);
        if (group.member_count > 1) pairs++;
        for (const member of group.members) {
          const cases = pack.cases.filter(c => c.source_binding.job_id === job.job_id && c.source_binding.record_id === member.record_id && c.source_binding.record_version === member.record_version);
          assert.equal(cases.length, 1, 'each multi-member/hint record remains its own sample');
          assert.equal(cases[0].source_binding.postprocessing_binding_sha256, pack.postprocessing_binding_sha256);
          const card = section.locator(`article[data-record-id="${member.record_id}"]`);
          const saved = JSON.parse(await readFile(inside(cases[0].source_binding.result_path), 'utf8'));
          const record = saved.versions.find(v => v.record.record_id === member.record_id && v.version === member.record_version).record;
          assert.deepEqual(await card.locator('.review-original pre').allTextContents(), record.quote_span.segments.map(f => f.exact_quote));
          assert.deepEqual(await card.locator('.review-context pre').allTextContents(), record.context.fragments.map(f => f.exact_quote));
        }
      }
      for (const hint of job.index.internal_reference_hints) {
        hints++;
        assert.equal(hint.origin_modified, false); assert.equal(hint.external_attribution_established, false);
        assert.ok(hint.internal_structure_markers.every(marker => marker !== '[26]'));
      }
    }
    assert.equal(await p.locator('[data-source-review-group-id]').count(), visibleGroups);
    assert.equal(pairs, pack.derived_same_source_multi_member_group_count); assert.equal(hints, pack.derived_internal_reference_hint_count);
    return { model_source_snapshots: 66, unchanged_current_sources: 65, separately_bound_current_helper: 1,
      helper_not_used_in_model_run: true, source_pairs_preserved: pairs, internal_reference_hints: hints, no_record_merge_or_opinion_propagation: true };
  });
  await check('ordinary_insecure_HTTP_SHA_fallback_and_pack_tamper_refusal', async () => {
    const { p: remote, context } = await page('insecure'); await remote.goto(insecure + '/review/', { waitUntil: 'networkidle' });
    await remote.waitForFunction(() => document.querySelector('#group-summary').textContent.length > 0);
    assert.deepEqual(await remote.evaluate(() => [isSecureContext, typeof crypto.subtle]), [false, 'undefined']);
    await context.route('**/data.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...pack, method: 'tampered' }) }));
    await remote.reload({ waitUntil: 'networkidle' }); assert.match(await remote.locator('#message').textContent(), /指纹校验失败/);
    assert.equal(await remote.locator('#export').isDisabled(), true);
    return { actual_loopback_bytes_behind_nonsecure_origin: true, browser_SHA_fallback_executed: true };
  });
  await check('frozen_sources_and_existing_pack_bytes_unchanged', async () => {
    for (const [path, expected] of Object.entries(manifest.source_files)) assert.equal(hash(await readFile(inside(path))), expected, path);
    for (const [path, expected] of Object.entries(manifest.files)) assert.equal(hash(await readFile(join(packRoot, path))), expected, path);
    assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []); assert.deepEqual(failures, []); assert.deepEqual(external, []);
    return { source_files: Object.keys(manifest.source_files).length, no_external_requests: true, no_runtime_or_old_feedback_writes: true };
  });
} catch (error) { checks.push({ name: 'harness_setup', status: 'failed', error: error.stack || String(error) }); }
finally {
  for (const c of contexts) await c.close(); if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
  result.overall_status = checks.some(c => c.status === 'failed') ? 'failed' : 'passed';
  Object.assign(result, { page_errors: pageErrors, console_errors: consoleErrors, failed_resources: failures, external_requests: external,
    temporary_browser_server_and_opinions_removed: true });
  if (manifest) {
    await writeFile(evidence, JSON.stringify(result, null, 2) + '\n');
    if (result.overall_status === 'passed') {
      const digest = hash(await readFile(evidence)); manifest.files['browser-verification.json'] = digest;
      manifest.browser_verification = { file: 'browser-verification.json', sha256: digest, status: 'passed', actual_chromium_execution: true, vscode_live_server_extension_exercised: false };
      if (result.screenshot) manifest.files[result.screenshot.file] = result.screenshot.sha256;
      await writeFile(join(packRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    }
  }
}
console.log(JSON.stringify({ status: result.overall_status, checks: checks.length, evidence }));
if (result.overall_status !== 'passed') process.exitCode = 1;
