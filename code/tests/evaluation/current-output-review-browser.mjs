/** Focused current-round UI verification. Static HTTP, disposable opinions, zero APIs. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const code = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const options = new Map();
for (let n = 2; n < process.argv.length; n += 2) {
  assert.ok(['--pack', '--evidence', '--fixture-evidence'].includes(process.argv[n]) && process.argv[n + 1]);
  options.set(process.argv[n], resolve(process.argv[n + 1]));
}
const temporary = await mkdtemp(join(code, '.tools/current-output-browser-'));
const fixtureOnly = !options.has('--pack');
const root = options.get('--pack') || join(temporary, 'fixture/output-review');
const evidence = options.get('--evidence') || join(code, 'runtime-data/agent-notes/current-output-review-browser-fixture.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const checks = [], pageErrors = [], consoleErrors = [], resourceFailures = [], externalRequests = [];
const summary = { schema_version: 'current-output-review-browser-verification-1', checked_at_utc: new Date().toISOString(),
  fixture_only: fixtureOnly, actual_chromium_execution: true, vscode_live_server_extension_exercised: false,
  static_only: true, model_or_API_calls: 0, actual_human_reviews: 0, synthetic_opinions_are_not_human_review: true,
  medical_quality_approved: false, product_export_approved: false, formal_reviews_used: '3/3 inherited; no new formal review', checks };
let browser, server;
let manifest, before, pack;
const contexts = [];

async function check(name, work) {
  try { const detail = await work(); checks.push({ name, status: 'passed', ...(detail === undefined ? {} : { detail }) }); }
  catch (error) { checks.push({ name, status: 'failed', error: error.stack || String(error) }); }
  console.log(checks.at(-1).status + ': ' + name);
}
function insideCode(path) {
  const target = resolve(code, path.replace(/^code\//, ''));
  assert.ok(target.startsWith(code + sep));
  return target;
}
const mime = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.pdf': 'application/pdf' };
async function exportOpinions(page, label) {
  const pending = page.waitForEvent('download');
  await page.locator('#export').click();
  const download = await pending;
  assert.equal(await download.failure(), null);
  const path = join(temporary, label + '.json');
  await download.saveAs(path);
  return { path, value: JSON.parse(await readFile(path, 'utf8')) };
}
async function importOpinions(page, value, label) {
  const path = join(temporary, label + '.json');
  await writeFile(path, JSON.stringify(value));
  // Discard only the previous visible status before waiting for this async
  // File.text() handler. The opinion state/storage remains untouched.
  await page.locator('#message').evaluate(node => { node.textContent = ''; });
  await page.locator('#import').setInputFiles(path);
  await page.waitForFunction(() => document.querySelector('#message').textContent.length > 0);
  return page.locator('#message').textContent();
}

try {
  if (fixtureOnly) {
    execFileSync(join(code, '.venv/bin/python'), [join(code, 'tests/evaluation/test_current_output_review.py'),
      '--write-browser-fixture', dirname(root)], { stdio: 'pipe' });
  }
  pack = JSON.parse(await readFile(join(root, 'data.json'), 'utf8'));
  manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  summary.pack_id = pack.pack_id;
  summary.pack_sha256 = pack.pack_sha256;
  summary.plan_sha256 = pack.plan_sha256;
  summary.questionnaire_version = pack.questionnaire_version;
  summary.generator_sha256 = manifest.generator_sha256;
  summary.verification_script_sha256 = hash(await readFile(fileURLToPath(import.meta.url)));
  if (manifest.generator_sha256) assert.equal(hash(await readFile(join(code, 'scripts/build-current-output-review.py'))), manifest.generator_sha256);
  summary.population = pack.group_counts;
  summary.sample = pack.sample_group_counts;
  before = new Map(await Promise.all(Object.entries(manifest.source_files).map(async ([path, expected]) => {
    const actual = hash(await readFile(insideCode(path))); assert.equal(actual, expected); return [path, actual];
  })));
  for (const [path, expected] of Object.entries(manifest.files)) assert.equal(hash(await readFile(join(root, path))), expected);

  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      let path = decodeURIComponent(url.pathname).replace(/^\/nested\/review\//, '');
      if (!path || path.endsWith('/')) path += 'index.html';
      const target = resolve(root, path);
      if (!target.startsWith(root + sep) || !['GET', 'HEAD'].includes(request.method)) { response.writeHead(403).end(); return; }
      if (!(await stat(target)).isFile()) { response.writeHead(404).end(); return; }
      const bytes = await readFile(target);
      response.writeHead(200, { 'Content-Type': mime[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const localOrigin = 'http://127.0.0.1:' + port;
  const insecureOrigin = 'http://192.0.2.42:' + port;
  const base = localOrigin + '/nested/review/';
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
  process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  // Use an existing local CJK font through this browser process's private
  // fontconfig. No OS install, page CSS injection or product asset changes.
  const cjkFont = join(code, '.tools/mineru-venv/lib/python3.12/site-packages/docvortex/resources/fonts/DroidSansFallbackFull.ttf');
  const fontConfig = join(temporary, 'fonts.conf'), fontCache = join(temporary, 'font-cache');
  await mkdir(fontCache);
  await writeFile(fontConfig, '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>/usr/share/fonts</dir><dir>' +
    dirname(cjkFont) + '</dir><cachedir>' + fontCache + '</cachedir></fontconfig>');
  process.env.FONTCONFIG_FILE = fontConfig;
  summary.font_environment = { private_process_fontconfig: true, system_fonts_unmodified: true, page_CSS_unmodified: true,
    existing_local_font: relative(code, cjkFont), font_sha256: hash(await readFile(cjkFont)) };
  const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
  browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-proxy-server'] });
  summary.browser_version = browser.version();
  summary.delivery = 'temporary static loopback HTTP; nonsecure-origin route.fetch obtains the same actual loopback response bytes';
  async function newPage(label) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    contexts.push(context);
    await context.route(/^https?:\/\//, async route => {
      const url = new URL(route.request().url());
      if (url.origin === localOrigin) return route.continue();
      if (url.origin === insecureOrigin) {
        const response = await route.fetch({ url: localOrigin + url.pathname + url.search });
        return route.fulfill({ response });
      }
      externalRequests.push({ label, origin: url.origin, path: url.pathname });
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => pageErrors.push({ label, error: String(error) }));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ label, message: message.text() }); });
    page.on('response', response => { if (response.status() >= 400) resourceFailures.push({ label, url: response.url(), status: response.status() }); });
    return { page, context };
  }
  const { page } = await newPage('current');
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.querySelector('#export').disabled || document.querySelector('#progress').textContent.includes('没有已冻结'));

  await check('primary_background_rejected_denominators_and_honest_run_states', async () => {
    const text = await page.locator('#group-summary').textContent();
    for (const key of ['total_current_records', 'primary_candidate', 'background_suggestion', 'delivery_rejected']) assert.ok(text.includes(String(pack.group_counts[key])));
    assert.equal(pack.group_counts.total_current_records, pack.group_counts.primary_candidate + pack.group_counts.background_suggestion + pack.group_counts.delivery_rejected);
    const states = await page.locator('#run-summary tbody tr').evaluateAll(nodes => nodes.map(n => ({ job_id: n.dataset.jobId, text: n.textContent })));
    assert.equal(states.length, 6);
    for (const job of pack.logical_jobs) {
      const row = states.find(n => n.job_id === job.job_id);
      assert.ok(row);
      if (!job.independent) assert.match(row.text, /等价复用.*只算一次/);
      else if (!job.started) assert.match(row.text, /未启动/);
      else if (job.error || job.whole_live_delivery_passed === false) assert.match(row.text, /失败/);
      else if (job.task_processing_complete !== true) assert.match(row.text, /未完成|未保存结果/);
      else assert.match(row.text, /本次范围处理完成/);
      if (job.parser_status === 'partial') assert.match(row.text, /原解析保留 partial/);
    }
    assert.equal(await page.locator('#role-filter').inputValue().catch(() => 'all'), 'all');
    return { groups_visible_together: true, states, all_groups_in_population: true };
  });

  await check('all_sample_source_fragments_match_literal_DOM_and_group_specific_questions', async () => {
    for (const c of pack.cases) {
      await page.locator('#kind-filter').selectOption('all');
      await page.locator('#role-filter').selectOption('all');
      await page.locator(`[data-case-id="${c.case_id}"]`).click();
      const actual = await page.locator('#parsed-view .caption-line').allTextContents();
      const expected = c.after.sections.filter(s => s.type === 'fragments').flatMap(s => s.fragments.map(f => f.text));
      assert.deepEqual(actual, expected, c.case_id + ': original/context/caption/diagnostic bytes in textContent');
      const original = page.locator('#original-image');
      await original.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => { const im = document.querySelector('#original-image'); return im.complete && im.naturalWidth > 100 && im.naturalHeight > 100; });
      assert.equal(await page.locator('#questions fieldset').count(), 3);
      assert.deepEqual(await page.locator('#questions legend').allTextContents(), c.questions.map(q => q.text));
      assert.doesNotMatch(await page.locator('body').innerText(), /Figure (None|null)\b/);
      const types = await page.locator('[data-question-id="target_visual_description"] input[type="checkbox"]').evaluateAll(nodes => nodes.map(n => n.value));
      if (c.review_group === 'background_suggestion') {
        assert.deepEqual(types, ['background_unnecessary', 'background_should_be_main', 'other']);
        assert.equal(c.questions[1].review_intent, 'background_retention_suitability');
      } else if (c.questions[1].review_intent === 'confirmed_scope_execution_deviation_visibility') {
        assert.deepEqual(types, ['other']);
        assert.match(await page.locator('#parsed-view').innerText(), /这是规则执行偏差/);
        assert.match(c.questions[1].hint, /不重新决定范围/);
      } else assert.deepEqual(types, ['not_target_visual', 'other']);
    }
    for (const role of ['primary_candidate', 'background_suggestion', 'delivery_rejected']) {
      if (!pack.cases.length) break;
      await page.locator('#role-filter').selectOption(role);
      assert.equal(await page.locator('#case-list button').count(), pack.cases.filter(c => c.review_group === role).length);
    }
    if (pack.cases.length) await page.locator('#role-filter').selectOption('all');
    if (!fixtureOnly && pack.cases.length) {
      const screenshotCase = pack.cases.find(c => c.review_group === 'background_suggestion' && c.source_binding.job_id === 'L05-B0') || pack.cases[0];
      await page.locator(`[data-case-id="${screenshotCase.case_id}"]`).click();
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: join(root, 'browser-review.png'), fullPage: true });
      summary.screenshot = { file: 'browser-review.png', case_id: screenshotCase.case_id, has_synthetic_answers: false,
        sha256: hash(await readFile(join(root, 'browser-review.png'))) };
    }
    return { cases: pack.cases.length, literal_textContent_equality: true, distinct_main_background_semantics: true };
  });

  await check('bound_export_import_uses_no_default_answers_and_rejects_stale_group_question_and_source', async () => {
    if (!pack.cases.length) return { skipped: 'No current source-bound cases; controls remain disabled.' };
    assert.equal(await page.locator('#questions [data-verdict][aria-pressed="true"]').count(), 0);
    const selected = ['primary_candidate', 'background_suggestion'].map(role => pack.cases.find(c => c.review_group === role)).filter(Boolean);
    const scopeDeviationCase = pack.cases.find(c => c.questions[1].review_intent === 'confirmed_scope_execution_deviation_visibility');
    if (scopeDeviationCase && !selected.includes(scopeDeviationCase)) selected.push(scopeDeviationCase);
    if (!selected.length) selected.push(pack.cases[0]);
    for (const c of selected) {
      await page.locator(`[data-case-id="${c.case_id}"]`).click();
      const q = page.locator('[data-question-id="target_visual_description"]');
      await q.locator('[data-verdict="has_problem"]').click();
      assert.equal(await q.locator('input[type="checkbox"]:checked').count(), 0, 'verdict must not auto-select a problem type');
      const issueCode = c.questions[1].review_intent === 'confirmed_scope_execution_deviation_visibility' ? 'other' :
        c.review_group === 'background_suggestion' ? 'background_unnecessary' : 'not_target_visual';
      await q.locator(`input[value="${issueCode}"]`).check();
      await q.locator('textarea').fill('自动化验证合成意见，不作为实际人核。');
    }
    const exported = await exportOpinions(page, 'roundtrip');
    assert.equal(exported.value.questionnaire_version, pack.questionnaire_version);
    assert.equal(exported.value.opinions.length, selected.length);
    for (const opinion of exported.value.opinions) {
      const c = pack.cases.find(c => c.case_id === opinion.case_id), q = c.questions.find(q => q.question_id === opinion.question_id);
      assert.deepEqual(opinion.source_binding, c.source_binding);
      assert.equal(opinion.review_group, c.review_group);
      assert.equal(opinion.question_text, q.text);
      assert.equal(opinion.question_semantics, q.review_intent);
    }
    for (const key of ['human_approved', 'medical_quality_approved', 'product_export_approved']) assert.equal(exported.value[key], false);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#clear').click();
    assert.match(await importOpinions(page, exported.value, 'valid-import'), /已恢复/);
    const snapshot = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    for (const kind of ['source', 'group', 'question', 'semantics']) {
      const changed = structuredClone(exported.value), o = changed.opinions[0];
      if (kind === 'source') o.source_binding.record_version += 1;
      if (kind === 'group') o.review_group = 'stale-group';
      if (kind === 'question') o.question_text += ' changed';
      if (kind === 'semantics') o.question_semantics = 'stale-semantics';
      assert.match(await importOpinions(page, changed, 'invalid-' + kind), /不一致|未导入/);
      assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage })), snapshot);
    }
    const python = execFileSync(join(code, '.venv/bin/python'), [join(code, 'scripts/build-current-output-review.py'),
      '--root', dirname(root), '--verify-opinions', exported.path], { encoding: 'utf8' });
    assert.match(python, /strict_version_binding.*passed/);
    return { automatic_opinions_discarded_after_test: true, roundtrip_opinion_count: selected.length,
      actual_questions_roles_and_source_bound: true, stale_imports_rejected_without_overwriting_storage: 4 };
  });

  await check('all_current_index_retains_every_primary_background_and_rejected_record_verbatim', async () => {
    await page.goto(base + 'all-candidates.html', { waitUntil: 'networkidle' });
    assert.equal(await page.locator('details[data-record-id]').count(), manifest.all_candidate_membership.length);
    for (const member of manifest.all_candidate_membership) {
      const card = page.locator(`details[data-job-id="${member.job_id}"][data-record-id="${member.record_id}"]`);
      assert.equal(await card.getAttribute('data-review-group'), member.review_group);
      const result = JSON.parse(await readFile(insideCode(member.source_binding.result_path), 'utf8'));
      const version = result.versions.find(v => v.record.record_id === member.record_id && v.version === member.record_version);
      assert.ok(version);
      const sections = card.locator(':scope > section.parsed-section');
      assert.deepEqual(await sections.nth(0).locator('pre.original-text').allTextContents(), version.record.quote_span.segments.map(s => s.exact_quote));
      assert.deepEqual(await sections.nth(1).locator('pre.original-text').allTextContents(), version.record.context.fragments.map(s => s.exact_quote));
    }
    assert.doesNotMatch(await page.locator('body').innerText(), /Figure (None|null)\b/);
    return { all_indexed: manifest.all_candidate_membership.length, exact_original_and_context_for_every_record: true };
  });

  await check('frozen_directed_risks_and_same_source_comparisons_keep_each_current_version_separate', async () => {
    const allRisks = [...(pack.bound_directed_review_risks || []), ...(pack.page_additional_directed_review_risks || [])];
    for (const risk of allRisks) {
      const matches = pack.cases.filter(c => c.source_binding.job_id === risk.job_id &&
        c.source_binding.record_id === risk.record_id && c.source_binding.record_version === risk.record_version);
      assert.equal(matches.length, 1, 'each owner-directed risk must appear once in the simple review');
      assert.equal(matches[0].review_group, risk.effective_role);
    }
    await page.goto(base + 'risk-comparisons.html', { waitUntil: 'networkidle' });
    const groups = pack.risk_comparisons?.groups || [];
    assert.equal(await page.locator('[data-comparison-id]').count(), groups.length);
    for (const group of groups) {
      const section = page.locator(`[data-comparison-id="${group.comparison_id}"]`);
      assert.equal(await section.locator('.risk-member').count(), group.members.length);
      for (const member of group.members) {
        const card = section.locator(`[data-job-id="${member.job_id}"][data-record-id="${member.record_id}"]`);
        assert.equal(Number(await card.getAttribute('data-record-version')), member.record_version);
        const result = JSON.parse(await readFile(insideCode(member.source_binding.result_path), 'utf8'));
        const record = result.versions.find(v => v.record.record_id === member.record_id && v.version === member.record_version).record;
        assert.deepEqual(await card.locator('.comparison-original pre').allTextContents(), record.quote_span.segments.map(f => f.exact_quote));
        assert.deepEqual(await card.locator('.comparison-context pre').allTextContents(), record.context.fragments.map(f => f.exact_quote));
        if (member.case_id) assert.equal(await card.locator('a[href^="index.html#"]').getAttribute('href'), 'index.html#' + member.case_id);
      }
    }
    return { explicitly_bound_risks_in_simple_review: (pack.bound_directed_review_risks || []).length,
      page_level_scope_execution_risks_in_simple_review: (pack.page_additional_directed_review_risks || []).length,
      comparisons: groups.length, literal_source_preserved: true, records_not_merged_or_reclassified: true };
  });

  await check('nonsecure_HTTP_uses_real_SHA256_fallback_and_refuses_tampered_pack', async () => {
    const { page: insecure, context } = await newPage('insecure-actual-static-bytes');
    await insecure.goto(insecureOrigin + '/nested/review/', { waitUntil: 'networkidle' });
    await insecure.waitForFunction(() => document.querySelector('#group-summary').textContent.length > 0);
    const environment = await insecure.evaluate(() => ({ secure_context: isSecureContext, crypto_subtle: typeof crypto.subtle }));
    assert.equal(environment.secure_context, false);
    assert.equal(environment.crypto_subtle, 'undefined');
    if (pack.cases.length) assert.equal(await insecure.locator('#export').isEnabled(), true);
    await context.route('**/data.json', async route => {
      const altered = structuredClone(pack); altered.population_rule += ' tampered';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(altered) });
    });
    await insecure.reload({ waitUntil: 'networkidle' });
    assert.match(await insecure.locator('#message').textContent(), /资料指纹校验失败/);
    assert.equal(await insecure.locator('#export').isDisabled(), true);
    return { ...environment, actual_loopback_static_response_bytes: true, tampered_pack_refused_before_opinions_applied: true };
  });

  await check('frozen_sources_and_static_payload_bytes_unchanged', async () => {
    for (const [path, expected] of before) assert.equal(hash(await readFile(insideCode(path))), expected, path);
    for (const [path, expected] of Object.entries(manifest.files)) assert.equal(hash(await readFile(join(root, path))), expected, path);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(resourceFailures, []);
    assert.deepEqual(externalRequests, []);
    return { frozen_source_files: before.size, static_pack_files: Object.keys(manifest.files).length,
      no_external_requests: true, no_page_errors: true, no_original_feedback_or_paid_output_writes: true };
  });
} catch (error) {
  checks.push({ name: 'harness_setup', status: 'failed', error: error.stack || String(error) });
} finally {
  for (const context of contexts) await context.close();
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  summary.page_errors = pageErrors;
  summary.console_errors = consoleErrors;
  summary.resource_failures = resourceFailures;
  summary.external_requests = externalRequests;
  summary.overall_status = checks.some(c => c.status === 'failed') ? 'failed' : 'passed';
  summary.temporary_browser_and_server_closed = true;
  summary.synthetic_opinions_and_downloads_removed = true;
  if (options.has('--fixture-evidence')) summary.fixture_verification = JSON.parse(await readFile(options.get('--fixture-evidence'), 'utf8'));
  await rm(temporary, { recursive: true, force: true });
  await mkdir(dirname(evidence), { recursive: true });
  await writeFile(evidence, JSON.stringify(summary, null, 2) + '\n');
  if (!fixtureOnly && summary.overall_status === 'passed') {
    const localEvidence = relative(root, evidence);
    assert.ok(!localEvidence.startsWith('..') && localEvidence !== 'manifest.json');
    manifest.browser_verification = { file: localEvidence, sha256: hash(await readFile(evidence)),
      actual_chromium_execution: true, vscode_live_server_extension_exercised: false, model_or_API_calls: 0,
      synthetic_opinions_are_not_human_review: true, status: 'passed' };
    manifest.files[localEvidence] = manifest.browser_verification.sha256;
    if (summary.screenshot) manifest.files[summary.screenshot.file] = summary.screenshot.sha256;
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
}
console.log(JSON.stringify({ status: summary.overall_status, fixture_only: fixtureOnly, checks: checks.length, evidence }));
if (summary.overall_status !== 'passed') process.exitCode = 1;
