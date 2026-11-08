/**
 * Real-browser verification of the frozen 30+5 lay-review static distribution.
 * Run from code/ with its project Node binary:
 *   .tools/node-v24.22.2-linux-x64/bin/node scripts/verify-output-review-browser.mjs
 * Serves only static files on 127.0.0.1; never starts Next, Fastify or a model API.
 * All browser profiles, downloads and altered import fixtures are ephemeral.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const code = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const staticRoot = join(code, 'apps/pi-web/public/output-review');
const evidence = join(code, 'docs/acceptance/user-feedback-2026-11-05/frontend');
const runtimeRoot = join(code, 'runtime-data/output-review-browser-tests');
const frozenRoot = join(code, 'docs/acceptance/s0-s4-current-2026-11-04/output-review-pack-2026-11-05');
const frozenZip = join(frozenRoot, '真实输出人工核验包.zip');
const userFeedbackPath = join(staticRoot, '普通用户初筛-cc939653-2026-11-05T06-08-53.json');
const nestedBase = '/test/nested/output-review/';
const checks = [], pageErrors = [], consoleErrors = [], attemptedExternal = [], failedResources = [], requests = [];
const contexts = [];
const summary = {
  schema_version: 'output-review-static-browser-verification-1',
  checked_at: new Date().toISOString(),
  actual_browser_execution: true,
  server: 'temporary Node built-in static HTTP server, 127.0.0.1 only',
  vscode_live_server_extension_exercised: false,
  next_or_fastify_started: false,
  paid_requests: 0,
  new_AGICTO_requests: 0,
  historical_ledger_requests: 189,
  actual_human_reviews: 0,
  actual_medical_reviews: 0,
  medical_quality_approved: false,
  product_export_approved: false,
  stage_passed: false,
  verification_command: 'cd code && .tools/node-v24.22.2-linux-x64/bin/node scripts/verify-output-review-browser.mjs',
  automatic_clicks_are_review_evidence: false,
  verification_scope: 'feedback readability repair: frozen text, explicit sentence groups, discontinuity, original locations and isolated import of the user 35 observations; includes prior static distribution regression coverage; no medical acceptance',
  formal_architecture_reviews_used: '3/3, inherited; no additional formal review',
  baseline_reproduction: { actual_chromium_execution: true, original_S03_cards: 5, original_S11_cards: 8, original_S11_context_cards: 1,
    symptom: 'PDF lines were separate cards; S03 sentence split across cards and S11 context visibly cut off', screenshot: '00-before-S03-line-cards.png' },
  checks,
};

process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
await mkdir(evidence, { recursive: true });
await mkdir(runtimeRoot, { recursive: true });
const scratch = await mkdtemp(join(runtimeRoot, 'isolated-'));
const sha256 = data => createHash('sha256').update(data).digest('hex');
const pack = JSON.parse(execFileSync('python3', ['-c', 'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.read("pack-manifest.json").decode("utf-8"))', frozenZip], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
const sourceGroups = JSON.parse(await readFile(join(staticRoot, 'source-groups.json'), 'utf8'));
const userFeedbackBytes = await readFile(userFeedbackPath);
const userFeedback = JSON.parse(userFeedbackBytes);
const protectedPaths = [...new Set([frozenZip, join(frozenRoot, 'manifest.json'), userFeedbackPath,
  join(staticRoot, 'pack-manifest.json'), ...pack.papers.map(p => join(staticRoot, p.pack_pdf)), ...Object.keys(pack.source_inputs).map(path => join(code, path))])];
const protectedBefore = new Map(await Promise.all(protectedPaths.map(async path => [path, sha256(await readFile(path))])));
const deliveryBefore = new Map(await Promise.all(['index.html', 'review.js', 'review.css', 'source-groups.json'].map(async path => [path, sha256(await readFile(join(staticRoot, path)))])));
summary.tested_static_delivery_sha256 = Object.fromEntries(deliveryBefore);

async function persist() {
  await writeFile(join(evidence, 'results.json'), JSON.stringify({ ...summary, page_errors: pageErrors, console_errors: consoleErrors,
    attempted_external_requests: attemptedExternal, failed_static_resources: failedResources,
    request_count: requests.length, request_paths: [...new Set(requests.map(request => request.path))] }, null, 2) + '\n');
}
async function check(name, work) {
  const start = Date.now();
  try {
    const detail = await work();
    checks.push({ name, status: 'passed', elapsed_ms: Date.now() - start, ...(detail === undefined ? {} : { detail }) });
  } catch (error) {
    checks.push({ name, status: 'failed', elapsed_ms: Date.now() - start, error: error.stack || String(error) });
  }
  console.log(`${checks.at(-1).status}: ${name}`);
  await persist();
}

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.pdf': 'application/pdf', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.bcmap': 'application/octet-stream' };
const server = createServer(async (request, response) => {
  try {
    const parsed = new URL(request.url, 'http://127.0.0.1');
    let path = decodeURIComponent(parsed.pathname);
    if (path.startsWith(nestedBase)) path = path.slice(nestedBase.length);
    else path = path.slice(1);
    if (!path || path.endsWith('/')) path += 'index.html';
    const absolute = resolve(staticRoot, path);
    if (absolute !== staticRoot && !absolute.startsWith(staticRoot + sep)) { response.writeHead(403).end(); return; }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
    const info = await stat(absolute);
    if (!info.isFile()) { response.writeHead(404).end(); return; }
    let buffer = await readFile(absolute);
    if (extname(absolute) === '.html' && parsed.searchParams.has('qa-live-server-inline')) {
      // Test-only equivalent of Live Server's injected inline refresh bootstrap.
      // This is not a claim to have exercised VSCode or its real WebSocket channel.
      buffer = Buffer.from(buffer.toString('utf8').replace('</body>', '<script>window.__t1LiveServerRefreshProbe = true;</script></body>'));
    }
    const headers = { 'Content-Type': mime[extname(absolute)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), buffer.length - 1) : buffer.length - 1;
      if (start >= buffer.length || end < start) { response.writeHead(416, { 'Content-Range': `bytes */${buffer.length}` }).end(); return; }
      const bytes = buffer.subarray(start, end + 1);
      response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${buffer.length}`, 'Content-Length': bytes.length });
      response.end(request.method === 'HEAD' ? undefined : bytes);
      return;
    }
    response.writeHead(200, { ...headers, 'Content-Length': buffer.length });
    response.end(request.method === 'HEAD' ? undefined : buffer);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
  }
});
let browser;
let rootUrl, nestedUrl, insecureUrl;
async function newPage(label, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1512, height: 900 }, locale: 'zh-CN', acceptDownloads: true, ...options });
  contexts.push(context);
  await context.route(/^https?:\/\//, async route => {
    const url = new URL(route.request().url());
    if (['127.0.0.1', 'review.test'].includes(url.hostname) && url.port === String(server.address().port)) return route.continue();
    attemptedExternal.push({ label, origin: url.origin, path: url.pathname });
    await route.abort('blockedbyclient');
  });
  context.on('page', page => {
    page.on('pageerror', error => pageErrors.push({ label, error: error.stack || String(error) }));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ label, message: message.text() }); });
  });
  context.on('request', request => {
    if (!request.url().startsWith('http')) return;
    const url = new URL(request.url());
    requests.push({ label, method: request.method(), path: url.pathname, type: request.resourceType() });
  });
  context.on('response', response => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    failedResources.push({ label, path: url.pathname, status: response.status() });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  return { page, context };
}
async function openApp(page, url = rootUrl) {
  const response = await page.goto(url, { waitUntil: 'networkidle' });
  assert.equal(response.status(), 200);
  await page.getByTestId('review-app').waitFor();
  await page.getByTestId('item-select').waitFor();
}
async function exportProgress(page, label) {
  const pendingDownload = page.waitForEvent('download');
  await page.getByTestId('export-results').click();
  const download = await pendingDownload;
  assert.equal(await download.failure(), null);
  const path = join(scratch, `${label}.json`);
  await download.saveAs(path);
  return { payload: JSON.parse(await readFile(path, 'utf8')), path, suggestedFilename: download.suggestedFilename() };
}
async function importProgress(page, value, label, confirm = false) {
  const path = join(scratch, `${label}.json`);
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  await page.getByTestId('import-results').setInputFiles(path);
  await page.getByTestId('import-status').waitFor();
  if (confirm) {
    await page.getByTestId('confirm-import').waitFor();
    await page.getByTestId('confirm-import').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="import-status"]')?.textContent.includes('已载入'));
  }
}
async function storageSnapshot(page) {
  return page.evaluate(() => Object.fromEntries(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)])));
}
async function canvasDetails(page) {
  return page.getByTestId('pdf-canvas').evaluate(canvas => {
    const context = canvas.getContext('2d');
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonWhiteOpaque = 0, pixelHash = 2166136261;
    for (let offset = 0; offset < pixels.length; offset += 16) {
      if (pixels[offset + 3] > 0 && (pixels[offset] < 240 || pixels[offset + 1] < 240 || pixels[offset + 2] < 240)) nonWhiteOpaque++;
      pixelHash = Math.imul(pixelHash ^ pixels[offset] ^ (pixels[offset + 1] << 8) ^ (pixels[offset + 2] << 16) ^ (pixels[offset + 3] << 24), 16777619) >>> 0;
    }
    return { bitmap_width: canvas.width, bitmap_height: canvas.height, sampled_nonwhite_opaque_pixels: nonWhiteOpaque,
      sampled_pixel_hash: pixelHash.toString(16).padStart(8, '0'),
      visible_width: canvas.getBoundingClientRect().width, visible_height: canvas.getBoundingClientRect().height,
      physical_page: Number(canvas.getAttribute('aria-label')?.match(/第(\d+)物理页/)?.[1] || 0) };
  });
}
async function assertRenderedPdf(page) {
  await page.getByTestId('pdf-canvas').waitFor({ state: 'visible' });
  // Let React's page-change effect set aria-busy before waiting for its completion.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(() => document.querySelector('[data-testid="pdf-scroll"]')?.getAttribute('aria-busy') === 'false');
  await page.waitForFunction(() => {
    const canvas = document.querySelector('[data-testid="pdf-canvas"]');
    return canvas && canvas.width > 100 && canvas.height > 100;
  });
  const detail = await canvasDetails(page);
  assert.ok(detail.bitmap_width > 100 && detail.bitmap_height > 100 && detail.sampled_nonwhite_opaque_pixels > 10, 'PDF must contain actual nonblank page pixels');
  return detail;
}
async function assertNoViewportOverflow(page) {
  const geometry = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  assert.ok(geometry.document <= geometry.viewport + 1, `document overflows by ${geometry.document - geometry.viewport}px`);
  return geometry;
}
async function assertWorkspaceDoesNotOverlapFooter(page) {
  const layout = await page.evaluate(() => ({ question_bottom: document.querySelector('.question-panel').getBoundingClientRect().bottom,
    trace_top: document.querySelector('.trace-info').getBoundingClientRect().top,
    footer_top: document.querySelector('footer').getBoundingClientRect().top }));
  assert.ok(layout.trace_top >= layout.question_bottom - 1 && layout.footer_top >= layout.question_bottom - 1, 'Expanded notes/help must leave the source, answers and footer in separate document areas');
  return layout;
}
const viewBindingKeys = ['record_id', 'record_version', 'source_record_sha256', 'text_fingerprint', 'delivery_fingerprint', 'text_version', 'file_sha256'];
const frozenViewBinding = view => view === null ? null : Object.fromEntries(viewBindingKeys.map(key => [key, view[key]]));
function assertFrozenExport(payload) {
  assert.equal(payload.pack_id, pack.pack_id);
  assert.equal(payload.frozen_zip_sha256, protectedBefore.get(frozenZip));
  assert.equal(payload.frozen_manifest_sha256, protectedBefore.get(join(frozenRoot, 'manifest.json')));
  assert.equal(payload.scope, 'ordinary_user_screening_only');
  assert.equal(payload.reviewer_role, 'non_medical_user');
  for (const key of ['medical_quality_approved', 'product_export_approved', 'stage_passed']) assert.equal(payload[key], false, key);
  const pending = { context: 'pending', terminology: 'pending', attribution: 'pending', medical_pairing: 'pending' };
  assert.deepEqual(payload.professional_review, pending);
  assert.equal(payload.items.length, 35);
  assert.equal(new Set(payload.items.map(item => item.id)).size, 35);
  for (const item of payload.items) {
    const random = pack.random_samples.find(sample => sample.id === item.id);
    const risk = pack.risks.find(sample => sample.id === item.id);
    assert.ok(random || risk, item.id);
    const sample = random || risk;
    assert.equal(item.kind, random ? 'random' : 'risk');
    assert.equal(item.reviewer_role, 'non_medical_user');
    assert.deepEqual(item.professional_review, pending);
    assert.deepEqual(item.source_binding, { job_id: sample.job_id, version_scope: sample.version_scope,
      baseline: frozenViewBinding(random ? random.view : null), before: frozenViewBinding(risk ? risk.before : null), after: frozenViewBinding(risk ? risk.after : null) }, item.id);
  }
  const k02 = payload.items.find(item => item.id === 'K02').source_binding;
  assert.equal(k02.before.record_version, 4); assert.equal(k02.after.record_version, 4);
  assert.notEqual(k02.before.source_record_sha256, k02.after.source_record_sha256);
  assert.notEqual(k02.before.delivery_fingerprint, k02.after.delivery_fingerprint);
}
function comparableProgress(payload) {
  const { exported_at, updated_at, ...withoutExportTime } = payload;
  return withoutExportTime;
}
function originalFeedback(payload) {
  const { exported_at, ...original } = payload;
  return original;
}
async function assertLiteralView(page, view, label) {
  const [owner_id, arm] = label.split('/');
  const grouped = sourceGroups.views.find(value => value.owner_id === owner_id && value.arm === arm);
  assert.ok(grouped, label);
  for (const [kind, fragments, groups] of [['source', view.original_fragments, grouped.original_groups], ['context', view.context_fragments, grouped.context_groups]]) {
    const expectedSegments = groups.flatMap(group => group.segments);
    const actual = await page.getByTestId(`${kind === 'source' ? 'source' : 'context'}-quote`).evaluateAll(nodes => nodes.map(node => ({
      exact_quote: node.textContent, block_id: node.dataset.blockId, start: Number(node.dataset.start), end: Number(node.dataset.end),
      physical_page: Number(node.dataset.page), text_version: node.dataset.textVersion, occurrence: Number(node.dataset.occurrence), bbox: JSON.parse(node.dataset.bbox),
    })));
    assert.deepEqual(actual, expectedSegments.map(({ exact_quote, block_id, start, end, physical_page, text_version, occurrence, bbox }) => ({ exact_quote, block_id, start, end, physical_page, text_version, occurrence, bbox })), `${label}: ${kind} exact source span and locator`);
    let index = 0;
    for (const fragment of fragments) {
      let restored = '', cursor = fragment.start;
      while (cursor < fragment.end) {
        const part = actual[index++];
        assert.ok(part, `${label}: missing ${kind} source span`);
        assert.equal(part.block_id, fragment.block_id); assert.equal(part.text_version, fragment.text_version);
        assert.equal(part.start, cursor); assert.ok(part.end <= fragment.end);
        assert.equal(Array.from(part.exact_quote).length, part.end - part.start);
        assert.equal(part.physical_page, fragment.physical_page); assert.deepEqual(part.bbox, fragment.bbox);
        restored += part.exact_quote; cursor = part.end;
      }
      assert.equal(restored, fragment.exact_quote, `${label}: all original ${kind} codepoints unchanged`);
    }
    assert.equal(index, actual.length, `${label}: no new ${kind} source text`);
    assert.equal(await page.getByTestId(`${kind}-group`).count(), groups.length);
    assert.deepEqual(await page.getByTestId(`${kind}-group-quote`).allTextContents(), groups.map(group => group.segments.map(segment => segment.exact_quote).join('\n')));
    const locations = page.getByTestId(kind === 'source' ? 'fragment' : 'context-fragment');
    assert.equal(await locations.count(), expectedSegments.length, label);
    const originalRanges = await locations.evaluateAll(nodes => nodes.map(node => ({ index: Number(node.dataset.originalIndex), start: Number(node.dataset.originalStart), end: Number(node.dataset.originalEnd) })));
    assert.deepEqual([...new Set(originalRanges.map(value => value.index))], fragments.map((_, index) => index), `${label}: each frozen original locator remains reachable`);
    for (const range of originalRanges) { assert.equal(range.start, fragments[range.index].start); assert.equal(range.end, fragments[range.index].end); }
  }
  assert.equal(await page.locator('[data-testid="source-quote"] strong, [data-testid="source-quote"] script, [data-testid="source-quote"] img').count(), 0);
  return view.original_fragments.length + view.context_fragments.length;
}
async function locateOriginalFragment(page, index) {
  const row = page.locator(`[data-testid="fragment"][data-original-index="${index}"]`).first();
  const details = row.locator('xpath=ancestor::details[1]');
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
  await row.getByRole('button').click();
}

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  rootUrl = `http://127.0.0.1:${server.address().port}/`;
  nestedUrl = `http://127.0.0.1:${server.address().port}${nestedBase}`;
  insecureUrl = `http://review.test:${server.address().port}${nestedBase}`;
  summary.urls = { root: rootUrl, nested: nestedUrl, insecure_http_via_test_only_host_mapping: insecureUrl };
  browser = await chromium.launch({ headless: true, channel: 'chromium', downloadsPath: scratch,
    args: ['--host-resolver-rules=MAP review.test 127.0.0.1', '--no-proxy-server'] });
  summary.browser = { playwright: '1.64.1', chromium: browser.version(), browser_downloaded_during_this_task: false,
    runtime_libraries: 'existing project-local sysroot', host_permissions_or_security_settings_changed: false,
    launch_mode: 'Playwright default Chromium headless; default Chromium sandbox option unchanged' };

  await check('frozen_inputs_match_authorized_sha256', async () => {
    assert.equal(protectedBefore.get(frozenZip), '4e52ce034979bbad2777e66a88f69879e9b43cf6ae7883e88da5cf43f192b5fd');
    assert.equal(protectedBefore.get(join(frozenRoot, 'manifest.json')), '9c88aede860464d5e32a53596e45e2e752ff8d290bc6244049aa6a7c9c76f80c');
    assert.equal(pack.random_samples.length, 30); assert.equal(pack.risks.length, 5);
    assert.equal(pack.original_ledger.totals.requests, 189);
    assert.equal(sha256(userFeedbackBytes), 'e53f669c7086761f9d0ef209448979aae488068c7b1e2a80d1f5590e422b6a28');
    return { random: 30, risks: 5, frozen_source_input_files: Object.keys(pack.source_inputs).length, historical_paid_ledger: 189 };
  });

  await check('focused_static_typecheck_and_source_progress_regressions', async () => {
    const app = join(code, 'apps/pi-web');
    execFileSync(process.execPath, [join(app, 'node_modules/typescript/bin/tsc'), '--project', join(app, 'output-review/tsconfig.json'), '--noEmit'], { cwd: app, encoding: 'utf8' });
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap',
      join(app, 'output-review/model.test.mjs'), join(app, 'output-review/source-groups.test.mjs')], { cwd: code, encoding: 'utf8', maxBuffer: 2_000_000 });
    assert.match(output, /# fail 0/);
    return { typecheck: 'passed', unit_test_summary: output.slice(output.lastIndexOf('ℹ tests') >= 0 ? output.lastIndexOf('ℹ tests') : -1200),
      generated_unknown_file_and_actual_user_JSON_retention_checked: true };
  });

  // Behavioral cases are kept here so the verifier needs no app module imports.
  // They inspect public DOM and actual downloaded JSON, using the frozen ZIP as the oracle.
  const { page: rootPage, context: rootContext } = await newPage('root');
  await check('root_static_http_initial_30_plus_5_and_blank_download', async () => {
    await openApp(rootPage);
    assert.match(await rootPage.getByTestId('group-random').textContent(), /30/);
    assert.match(await rootPage.getByTestId('group-risk').textContent(), /5/);
    const download = await exportProgress(rootPage, 'initial-blank');
    assertFrozenExport(download.payload);
    assert.equal(download.payload.reviewer_name, '');
    assert.ok(download.payload.items.every(item => item.disposition === 'draft' && item.recorded_at === null && item.note === '' && item.updated_at === null));
    assert.ok(download.payload.items.every(item => Object.entries(item.answers).every(([key, answer]) => answer === null || key === 'figure_match' && answer === 'not_checked')));
    const fonts = await rootPage.evaluate(async () => {
      await document.fonts.ready;
      return { loaded_faces: [...document.fonts].filter(font => font.status === 'loaded').map(font => font.family),
        cjk_loaded: document.fonts.check('16px "T1 CJK"', '真实输出普通用户原文'), computed_family: getComputedStyle(document.body).fontFamily };
    });
    assert.ok(fonts.loaded_faces.some(family => family.includes('T1 CJK')) && fonts.cjk_loaded, 'A bundled CJK font must be loaded in the browser');
    await rootPage.getByTestId('item-select').selectOption('S03');
    await assertRenderedPdf(rootPage);
    await rootPage.waitForTimeout(150);
    await assertRenderedPdf(rootPage);
    await rootPage.evaluate(() => scrollTo(0, 0));
    const visibleLayout = await rootPage.evaluate(() => {
      const bounds = selector => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      return { viewport: { width: innerWidth, height: innerHeight }, original: bounds('[data-testid="source-quote"]'),
        pdf: bounds('[data-testid="pdf-scroll"]'), current_question: bounds('.question-panel fieldset'),
        current_option: bounds('.question-panel input[type="radio"]') };
    });
    for (const [name, bounds] of Object.entries(visibleLayout).filter(([name]) => name !== 'viewport')) {
      assert.ok(bounds.top >= 0 && bounds.top < visibleLayout.viewport.height && bounds.bottom > 0, `${name} must be on the normal desktop viewport`);
    }
    assert.ok(visibleLayout.current_option.bottom <= visibleLayout.viewport.height, 'The first question option must be fully visible without scrolling the whole page');
    assert.ok(visibleLayout.original.right <= visibleLayout.pdf.left + 1 && visibleLayout.current_question.right <= visibleLayout.pdf.left + 1, 'Original fragments and questions must share one side of the PDF');
    await rootPage.screenshot({ path: join(evidence, '01-after-S03-sentence-pdf-questions.png'), fullPage: false });
    await rootPage.getByTestId('item-select').selectOption('S01');
    return { initial_random_items: 30, experimental_risk_items: 5, blank_items: 35, actual_download_filename: download.suggestedFilename,
      nonmedical_role_and_all_frozen_bindings_verified: true, root_url: rootUrl, fonts, visible_layout: visibleLayout };
  });

  await check('nested_static_url_and_nonsecure_http_without_secure_context_APIs', async () => {
    const { page } = await newPage('insecure-nested');
    await openApp(page, insecureUrl);
    const environment = await page.evaluate(() => ({ origin: location.origin, secure_context: isSecureContext,
      crypto_subtle: typeof crypto.subtle, file_system_access: typeof window.showSaveFilePicker }));
    assert.equal(environment.secure_context, false);
    assert.equal(environment.crypto_subtle, 'undefined');
    assert.equal(environment.file_system_access, 'undefined');
    const pdf = await assertRenderedPdf(page);
    await page.getByTestId('reviewer-name').fill('非安全HTTP自动测试');
    await page.getByTestId('defer-record').click();
    const download = await exportProgress(page, 'insecure-blank');
    assertFrozenExport(download.payload);
    await importProgress(page, download.payload, 'insecure-roundtrip', true);
    const second = await exportProgress(page, 'insecure-roundtrip-reexport');
    assertFrozenExport(second.payload);
    assert.deepEqual(comparableProgress(second.payload), comparableProgress(download.payload));
    await assertNoViewportOverflow(page);
    return { ...environment, nested_url: insecureUrl, pdf, actual_blob_download_and_file_import: true };
  });

  await check('simulated_Live_Server_inline_refresh_injection_CSP_compatibility', async () => {
    const { page } = await newPage('simulated-live-server-inline');
    await openApp(page, nestedUrl + '?qa-live-server-inline=1');
    assert.equal(await page.evaluate(() => window.__t1LiveServerRefreshProbe), true, 'Inline refresh bootstrap was blocked');
    const pdf = await assertRenderedPdf(page);
    return { method: 'test static server injects an inline bootstrap into the HTML response', inline_bootstrap_executed: true,
      actual_VSCode_extension_or_WebSocket_refresh_tested: false, pdf };
  });

  await check('static_PDF_and_original_PNG_bytes_equal_frozen_bundle', async () => {
    const assets = [...pack.papers.map(paper => ({ path: paper.pack_pdf, hash: paper.pdf_sha256 })),
      ...pack.figures.flatMap(figure => figure.assets.map(asset => ({ path: asset.pack_path, hash: asset.sha256 })))];
    for (const asset of assets) {
      const response = await rootContext.request.get(new URL(asset.path, nestedUrl).href);
      assert.equal(response.status(), 200, asset.path);
      assert.equal(sha256(await response.body()), asset.hash, asset.path);
    }
    return { source_pdfs: pack.papers.length, original_images: assets.length - pack.papers.length, checked_over_nested_HTTP_url: true };
  });

  await check('real_PDF_navigation_zoom_source_location_and_approximate_highlight', async () => {
    await rootPage.getByTestId('group-random').click();
    await rootPage.getByTestId('item-select').selectOption('S03');
    await locateOriginalFragment(rootPage, 1);
    let pdf = await assertRenderedPdf(rootPage);
    assert.equal(pdf.physical_page, pack.random_samples[2].view.original_fragments[1].physical_page);
    await rootPage.getByTestId('pdf-highlight').waitFor();
    const highlight = await rootPage.getByTestId('pdf-highlight').first().evaluate(node => ({
      left: parseFloat(node.style.left), top: parseFloat(node.style.top), width: parseFloat(node.style.width), height: parseFloat(node.style.height),
    }));
    assert.ok(highlight.left > 0 && highlight.top > 0 && highlight.width > 0 && highlight.height > 0);
    assert.ok(highlight.left < pdf.visible_width && highlight.top < pdf.visible_height);
    const originalPagePixels = pdf.sampled_pixel_hash;
    await rootPage.getByRole('button', { name: 'PDF下一页', exact: true }).click();
    const followingPage = await assertRenderedPdf(rootPage);
    assert.equal(followingPage.physical_page, 4);
    assert.notEqual(followingPage.sampled_pixel_hash, originalPagePixels, 'Changing the page must change actual rendered page pixels');
    assert.equal(await rootPage.getByTestId('pdf-highlight').count(), 0);
    await rootPage.getByRole('button', { name: 'PDF上一页', exact: true }).click();
    pdf = await assertRenderedPdf(rootPage);
    assert.equal(pdf.physical_page, 3);
    const widthAtFit = pdf.bitmap_width;
    await rootPage.getByTestId('pdf-zoom').selectOption('1.5');
    pdf = await assertRenderedPdf(rootPage);
    assert.ok(pdf.bitmap_width > widthAtFit * 1.4);
    await assertNoViewportOverflow(rootPage);
    await rootPage.getByTestId('pdf-page').fill('1');
    await rootPage.getByTestId('pdf-page').press('Enter');
    assert.equal((await assertRenderedPdf(rootPage)).physical_page, 1);
    assert.ok((await rootPage.getByTestId('open-pdf').getAttribute('href')).endsWith('/pdf/L01.pdf#page=1'));
    await locateOriginalFragment(rootPage, 0);
    assert.equal((await assertRenderedPdf(rootPage)).physical_page, 3);
    await rootPage.getByTestId('pdf-zoom').selectOption('1');
    await assertRenderedPdf(rootPage);
    const internalScroll = await rootPage.getByTestId('pdf-scroll').evaluate(node => {
      const available = node.scrollHeight - node.clientHeight;
      node.scrollTop = Math.min(65, available);
      return { available, before_answer: node.scrollTop };
    });
    assert.ok(internalScroll.available > 0);
    const sourceScroll = await rootPage.getByTestId('source-scroll').evaluate(node => ({ client_height: node.clientHeight, scroll_height: node.scrollHeight, overflow: getComputedStyle(node).overflowY }));
    assert.ok(sourceScroll.scroll_height > sourceScroll.client_height && ['auto', 'scroll'].includes(sourceScroll.overflow));
    await rootPage.getByTestId('answer-text_match-uncertain').check();
    await rootPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const scrollAfterAnswer = await rootPage.getByTestId('pdf-scroll').evaluate(node => node.scrollTop);
    assert.ok(Math.abs(scrollAfterAnswer - internalScroll.before_answer) <= 1, 'Answering must preserve the user-scrolled PDF position');
    let releaseSecondPdf;
    const secondPdfGate = new Promise(resolve => { releaseSecondPdf = resolve; });
    const delayedSecondPdf = async route => { await secondPdfGate; await route.continue(); };
    await rootPage.route('**/pdf/L05.pdf', delayedSecondPdf);
    let paperSwitch;
    try {
      const pendingPdfRequest = rootPage.waitForRequest('**/pdf/L05.pdf');
      await rootPage.getByTestId('item-select').selectOption('S13');
      await pendingPdfRequest;
      await rootPage.waitForFunction(() => document.querySelector('[data-testid="pdf-scroll"]')?.getAttribute('aria-busy') === 'true');
      await rootPage.locator('.pdf-loading').waitFor({ state: 'visible' });
      const loading = await rootPage.locator('.pdf-loading').textContent();
      releaseSecondPdf();
      const rendered = await assertRenderedPdf(rootPage);
      assert.equal(rendered.physical_page, pack.random_samples[12].view.original_fragments[0].physical_page);
      assert.ok((await rootPage.getByTestId('open-pdf').getAttribute('href')).includes('/pdf/L05.pdf#page='));
      await rootPage.getByTestId('pdf-highlight').waitFor();
      paperSwitch = { loading_visible_while_PDF_request_was_delayed: loading, final_document: 'L05', final_pdf: rendered };
    } finally {
      releaseSecondPdf();
      await rootPage.unroute('**/pdf/L05.pdf', delayedSecondPdf);
    }
    return { actual_nonblank_PDF_pages: [1, 3, 4], clicked_original_fragment: 2, zoom_150_percent: true,
      highlight_is_approximate_and_within_page: true, highlight, paper_switch_loading_and_final_page: paperSwitch,
      original_and_PDF_have_independent_scroll: sourceScroll, PDF_scroll_preserved_while_answering: { ...internalScroll, after_answer: scrollAfterAnswer } };
  });

  await check('original_whole_image_dialog_and_unavailable_figure_remains_pending', async () => {
    await rootPage.getByTestId('item-select').selectOption('S09');
    assert.match(await rootPage.locator('.associated-figures').textContent(), /尚无确认可用的独立整图/);
    assert.equal(await rootPage.locator('.associated-figures img').count(), 0);
    await rootPage.getByTestId('figure-pdf-link').click();
    assert.equal((await assertRenderedPdf(rootPage)).physical_page, 2);
    await rootPage.locator('.associated-figures summary').click();
    const missingFigure = pack.figures.find(figure => figure.figure_id === pack.random_samples[8].view.figure_ids[0]);
    assert.deepEqual(await rootPage.locator('.associated-figures blockquote').allTextContents(), missingFigure.caption_segments.map(fragment => fragment.exact_quote));
    await rootPage.getByText('全部图资料（仅1份独立整图，其余待核）', { exact: true }).click();
    const image = rootPage.locator('.figure-library img');
    await image.waitFor({ state: 'visible' });
    await image.evaluate(node => node.complete ? Promise.resolve() : new Promise((resolve, reject) => { node.onload = resolve; node.onerror = reject; }));
    assert.deepEqual(await image.evaluate(node => ({ width: node.naturalWidth, height: node.naturalHeight })), { width: 978, height: 742 });
    await rootPage.locator('.figure-library button[aria-haspopup="dialog"]').click();
    const dialog = rootPage.getByRole('dialog', { name: '查看原整图', exact: true });
    await dialog.waitFor({ state: 'visible' });
    assert.deepEqual(await dialog.locator('img').evaluate(node => ({ width: node.naturalWidth, height: node.naturalHeight })), { width: 978, height: 742 });
    await rootPage.keyboard.press('Escape');
    assert.equal(await rootPage.locator('dialog[open]').count(), 0);
    await rootPage.getByText('全部图资料（仅1份独立整图，其余待核）', { exact: true }).click();
    const downloaded = await exportProgress(rootPage, 'still-unreviewed-after-image-test');
    assert.equal(downloaded.payload.items.find(item => item.id === 'S09').disposition, 'draft');
    assert.equal(downloaded.payload.items.find(item => item.id === 'S09').answers.figure_match, null);
    assertFrozenExport(downloaded.payload);
    return { actual_original_png_dimensions: [978, 742], original_ImagePreview_dialog_open_and_Escape_close: true,
      missing_asset_example: 'S09', missing_asset_was_not_automatically_marked_checked: true };
  });

  await check('all_35_frozen_views_preserve_literal_original_spans_and_all_unknown_remains_professionally_pending', async () => {
    const { page } = await newPage('all-literals-and-all-unknown');
    await openApp(page);
    let checkedPackRows = 0, checkedViewFragments = 0, checkedControlRows = 0;
    const seenCaptionFigures = new Set();
    async function verifyView(itemId, arm, view) {
      checkedViewFragments += await assertLiteralView(page, view, `${itemId}/${arm}`);
      const captionQuotes = pack.figures.filter(figure => view.figure_ids.includes(figure.figure_id)).flatMap(figure => figure.caption_segments.map(fragment => fragment.exact_quote));
      assert.deepEqual(await page.locator('.associated-figures blockquote').allTextContents(), captionQuotes);
      // assertLiteralView already reconstructed every frozen original from its rendered
      // exact subspans. Compare the 286 frozen workbook rows against those originals.
      const displayed = [...view.original_fragments.map(fragment => fragment.exact_quote), ...view.context_fragments.map(fragment => fragment.exact_quote), ...captionQuotes];
      for (const fragment of pack.fragments.filter(fragment => fragment.owner_id === itemId && fragment.arm === arm)) {
        assert.ok(displayed.includes(fragment.exact_quote), `${itemId}/${arm}/${fragment.fragment_id}: exact codepoints missing`);
        checkedPackRows++;
        if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(fragment.exact_quote)) checkedControlRows++;
      }
      for (const figure of pack.figures.filter(figure => view.figure_ids.includes(figure.figure_id))) {
        if (seenCaptionFigures.has(figure.figure_id)) continue;
        const rows = pack.fragments.filter(fragment => fragment.owner_id === `${figure.document_id}-${figure.figure_id}` && fragment.arm === 'caption');
        for (const fragment of rows) {
          assert.ok(captionQuotes.includes(fragment.exact_quote), `${fragment.fragment_id}: original caption codepoints missing`);
          checkedPackRows++;
          if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(fragment.exact_quote)) checkedControlRows++;
        }
        seenCaptionFigures.add(figure.figure_id);
      }
    }
    for (const sample of pack.random_samples) {
      await page.getByTestId('item-select').selectOption(sample.id);
      await verifyView(sample.id, 'baseline', sample.view);
      await page.getByTestId('defer-record').click();
    }
    await page.getByTestId('group-risk').click();
    assert.match(await page.locator('.group-note').textContent(), /不并入30条随机统计/);
    for (const risk of pack.risks) {
      await page.getByTestId('item-select').selectOption(risk.id);
      const changes = page.getByTestId('risk-changes');
      assert.match(await changes.textContent(), /改动前/); assert.match(await changes.textContent(), /改动后/);
      for (const arm of ['before', 'after']) {
        await page.getByTestId(`risk-${arm}`).click();
        assert.equal(await page.getByTestId(`risk-${arm}`).getAttribute('aria-pressed'), 'true');
        await verifyView(risk.id, arm, risk[arm]);
      }
      await page.getByTestId('defer-record').click();
    }
    assert.equal(checkedPackRows, 286);
    assert.equal(checkedControlRows, 14);
    assert.match(await page.getByTestId('progress-summary').textContent(), /已记录 0 · 待专业 35 · 未看 0/);
    const download = await exportProgress(page, 'all-35-unknown');
    assertFrozenExport(download.payload);
    assert.ok(download.payload.items.every(item => item.disposition === 'deferred' && item.recorded_at !== null));
    assert.ok(download.payload.items.every(item => item.kind === 'risk' ? item.answers.risk_notice === 'uncertain' : item.answers.text_match === 'uncertain' && item.answers.image_description === 'uncertain'));
    return { random_items: 30, risk_items: 5, risk_views_separately_checked: 10, frozen_pack_fragment_rows_checked: checkedPackRows,
      original_plus_context_fragments_checked: checkedViewFragments, control_character_rows_preserved: checkedControlRows,
      all_35_unknown_counted_as_professionally_pending: true, professional_approvals: false };
  });

  await check('continuous_multiline_sentences_share_cards_and_noncontinuous_or_missing_source_is_explicit', async () => {
    const { page } = await newPage('source-sentences-and-gaps');
    await openApp(page);
    await page.getByTestId('item-select').selectOption('S03');
    await assertLiteralView(page, pack.random_samples[2].view, 'S03/baseline');
    assert.equal(await page.getByTestId('source-group').count(), 2, 'Five original lines form two exact source sentences');
    assert.equal(await page.getByTestId('source-group').first().getByTestId('source-quote').count(), 3);
    assert.equal(await page.getByTestId('source-group-quote').first().evaluate(node => getComputedStyle(node).whiteSpace), 'normal', 'PDF line wraps flow together within the source sentence');
    await page.getByTestId('source-group').first().getByRole('button', { name: '在PDF中定位 ↗', exact: true }).click();
    assert.equal((await assertRenderedPdf(page)).physical_page, 3);
    assert.equal(await page.getByTestId('pdf-highlight').count(), 3, 'Group location highlights each exact source span');
    await locateOriginalFragment(page, 2);
    assert.equal(await page.getByTestId('pdf-highlight').count(), 1, 'Original PDF-line locator remains available across a sentence split');
    await page.getByTestId('item-select').selectOption('S11');
    await assertLiteralView(page, pack.random_samples[10].view, 'S11/baseline');
    assert.equal(await page.getByTestId('source-group').count(), 2);
    assert.equal(await page.getByTestId('context-group').count(), 2);
    assert.equal(await page.getByTestId('source-break').count(), 1);
    assert.equal(await page.getByTestId('context-break').count(), 1);
    assert.match(await page.getByTestId('source-break').textContent(), /分开核对/);
    assert.equal(await page.locator('[data-testid="source-group"][data-completeness="incomplete"]').count(), 1);
    assert.equal(await page.locator('[data-testid="context-group"][data-completeness="incomplete"]').count(), 2);
    assert.ok((await page.getByTestId('completeness-hint').allTextContents()).every(text => text.includes('缺失文字未补入')));
    await page.getByTestId('source-scroll').evaluate(node => { node.scrollTop = 0; });
    await page.setViewportSize({ width: 1512, height: 1500 });
    await assertRenderedPdf(page);
    await page.screenshot({ path: join(evidence, '03-after-S11-explicit-gap-and-incomplete-context.png'), fullPage: false });
    await page.getByTestId('item-select').selectOption('S18');
    await assertLiteralView(page, pack.random_samples[17].view, 'S18/baseline');
    assert.equal(await page.locator('[data-testid="source-group"][data-completeness="incomplete"]').count(), 2);
    return { S03: { old_line_cards: 5, sentence_cards: 2, exact_subspans: 6, group_and_original_locations_checked: true },
      S11: { old_original_line_cards: 8, source_cards: 2, incomplete_source_cards: 1, incomplete_context_cards: 2, visible_separators: true },
      S18: { incomplete_source_cards: 2 }, original_source_text_added: false, source_offsets_pages_and_bbox_unchanged: true };
  });

  await check('tampered_grouping_falls_back_to_frozen_lines_without_losing_source_or_progress', async () => {
    const { page } = await newPage('invalid-source-grouping');
    const altered = structuredClone(sourceGroups);
    altered.views[0].original_groups[0].segments[0].exact_quote += 'UNAUTHORIZED SOURCE';
    await page.route('**/source-groups.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(altered) }));
    await openApp(page);
    await page.getByTestId('source-groups-unavailable').waitFor();
    assert.deepEqual(await page.getByTestId('source-quote').allTextContents(), pack.random_samples[0].view.original_fragments.map(fragment => fragment.exact_quote));
    assert.equal(await page.getByText('UNAUTHORIZED SOURCE', { exact: false }).count(), 0);
    await importProgress(page, userFeedbackBytes.toString('utf8'), 'real-user-with-invalid-grouping', true);
    const restored = await exportProgress(page, 'real-user-grouping-fallback');
    assert.deepEqual(originalFeedback(restored.payload), originalFeedback(userFeedback));
    assertFrozenExport(restored.payload);
    return { fixture_only_intercepted_in_isolated_context: true, altered_source_rejected: true, frozen_line_fallback: true, real_user_feedback_preserved: true };
  });

  await check('real_user_35_recorded_observations_and_11_notes_explicit_import_refresh_and_roundtrip', async () => {
    const { page } = await newPage('real-user-feedback');
    await openApp(page);
    assert.equal(await page.getByTestId('note-review-row').count(), 0, 'User JSON is never automatically applied');
    const blankStorage = await storageSnapshot(page);
    await importProgress(page, userFeedbackBytes.toString('utf8'), 'real-user-byte-copy');
    await page.getByTestId('confirm-import').waitFor();
    assert.deepEqual(await storageSnapshot(page), blankStorage, 'Choosing the file requires explicit import confirmation');
    assert.equal(await page.getByTestId('note-review-row').count(), 0);
    await page.getByTestId('confirm-import').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="import-status"]')?.textContent.includes('已载入'));
    const exported = await exportProgress(page, 'real-user-exact-observations');
    assertFrozenExport(exported.payload);
    assert.equal(exported.payload.items.filter(item => item.disposition === 'recorded').length, 35);
    assert.deepEqual(originalFeedback(exported.payload), originalFeedback(userFeedback));
    assert.equal(await page.getByTestId('note-review-row').count(), 11);
    assert.deepEqual(await page.getByTestId('recorded-note').allTextContents(), userFeedback.items.filter(item => item.note.length > 0).map(item => item.note));
    await page.getByTestId('notes-review').locator('summary').click();
    await page.getByTestId('note-review-row').filter({ hasText: 'S03 ·' }).getByRole('button').click();
    assert.equal(await page.getByTestId('item-select').inputValue(), 'S03');
    assert.equal(await page.getByTestId('review-note').inputValue(), userFeedback.items.find(item => item.id === 'S03').note);
    assert.equal(await page.getByTestId('answer-image_description-not_like').isChecked(), true);
    await page.getByTestId('notes-review').locator('summary').click();
    await page.getByTestId('filter-status').selectOption('notes');
    assert.deepEqual(await page.getByTestId('item-select').locator('option').evaluateAll(nodes => nodes.map(node => node.value)), userFeedback.items.filter(item => item.kind === 'random' && item.note.length > 0).map(item => item.id));
    for (const id of ['S01', 'S16', 'S20']) {
      await page.getByTestId('item-select').selectOption(id);
      assert.equal(await page.getByTestId('answer-image_description-looks_like').isChecked(), true, `${id}: original broad answer must remain unchanged despite the rejection note`);
      assert.equal(await page.getByTestId('review-note').inputValue(), userFeedback.items.find(item => item.id === id).note);
    }
    await page.getByTestId('question-help').locator('summary').click();
    assert.match(await page.getByTestId('question-help').textContent(), /特征名字、测量清单、P值比较/);
    assert.match(await page.getByTestId('question-help').textContent(), /不表示候选可接受/);
    await assertWorkspaceDoesNotOverlapFooter(page);
    await page.getByTestId('question-help').locator('summary').click();
    await page.getByTestId('filter-status').selectOption('all');
    await page.getByTestId('item-select').selectOption('S15');
    assert.match(await page.getByTestId('statistical-figure-hint').textContent(), /Lasso/);
    assert.match(await page.locator('.associated-figures').textContent(), /尚未完成医学影像配对/);
    await page.getByTestId('notes-review').locator('summary').click();
    await page.getByTestId('statistical-figure-hint').scrollIntoViewIfNeeded();
    const expandedNotesLayout = await assertWorkspaceDoesNotOverlapFooter(page);
    await page.waitForTimeout(150);
    await assertRenderedPdf(page);
    await page.screenshot({ path: join(evidence, '04-real-user-notes-and-Lasso-pairing-warning.png'), fullPage: true });
    await page.getByTestId('notes-review').locator('summary').click();
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByTestId('review-app').waitFor();
    assert.equal(await page.getByTestId('note-review-row').count(), 11);
    const after = await exportProgress(page, 'real-user-after-refresh');
    assert.deepEqual(originalFeedback(after.payload), originalFeedback(userFeedback));
    assertFrozenExport(after.payload);
    assert.equal(sha256(await readFile(userFeedbackPath)), 'e53f669c7086761f9d0ef209448979aae488068c7b1e2a80d1f5590e422b6a28');
    return { uploaded_user_JSON_sha256: sha256(userFeedbackBytes), recorded_observations: 35, exact_notes: 11,
      staged_import_and_note_navigation_and_notes_filter: true, original_S01_S16_S20_looks_like_and_S03_not_like_retained: true,
      full_answers_notes_times_bindings_and_statuses_retained_after_refresh: true, expanded_notes_layout: expandedNotesLayout,
      medical_or_product_approval: false, user_browser_profile_touched: false };
  });

  await check('real_user_feedback_remains_exact_in_memory_when_browser_storage_is_unavailable', async () => {
    const { page, context } = await newPage('real-user-feedback-disabled-storage');
    await context.addInitScript(() => {
      const originalGet = Storage.prototype.getItem, originalSet = Storage.prototype.setItem;
      Storage.prototype.getItem = function(key) {
        if (key.startsWith('t1-output-review:')) throw new DOMException('Synthetic QA storage is disabled', 'SecurityError');
        return originalGet.call(this, key);
      };
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith('t1-output-review:')) throw new DOMException('Synthetic QA storage is disabled', 'SecurityError');
        return originalSet.call(this, key, value);
      };
    });
    await openApp(page);
    await importProgress(page, userFeedbackBytes.toString('utf8'), 'real-user-disabled-storage-copy', true);
    assert.equal(await page.getByTestId('storage-status').getAttribute('role'), 'alert');
    assert.match(await page.getByTestId('storage-status').textContent(), /刷新前请导出备份/);
    assert.deepEqual(await page.getByTestId('recorded-note').allTextContents(), userFeedback.items.filter(item => item.note.length > 0).map(item => item.note));
    const backup = await exportProgress(page, 'real-user-disabled-storage-backup');
    assert.deepEqual(originalFeedback(backup.payload), originalFeedback(userFeedback));
    assertFrozenExport(backup.payload);
    return { actual_browser_Storage_getItem_and_setItem_throw: 'SecurityError', visibly_unsaved: true, exact_35_observations_and_11_notes_downloadable: true,
      original_top_level_and_per_question_times_preserved: true, uploaded_JSON_and_real_user_browser_progress_touched: false };
  });

  let filledPayload;
  await check('plain_questions_navigation_filters_draft_save_and_refresh_restore', async () => {
    const { page } = await newPage('fill-and-refresh');
    await openApp(page);
    assert.equal(await page.getByTestId('save-record').isDisabled(), true);
    assert.match(await page.locator('.question-panel').textContent(), /能在论文中找到/);
    assert.match(await page.locator('.question-panel').textContent(), /看不懂/);
    assert.equal(await page.getByTestId('previous-item').isDisabled(), true);
    await page.getByTestId('next-item').click();
    assert.equal(await page.getByTestId('item-select').inputValue(), 'S02');
    await page.getByTestId('previous-item').click();
    assert.equal(await page.getByTestId('item-select').inputValue(), 'S01');
    await page.getByTestId('reviewer-name').fill('自动测试（不计真人）');
    await page.getByTestId('answer-text_match-found').check();
    await page.getByTestId('answer-image_description-looks_like').check();
    await page.getByTestId('review-note').fill('自动测试备注：仅验证本地保存与恢复。');
    let download = await exportProgress(page, 'answered-draft');
    assert.equal(download.payload.items.find(item => item.id === 'S01').disposition, 'draft');
    assert.match(await page.getByTestId('progress-summary').textContent(), /已记录 0 · 待专业 0 · 未看 35/);
    await page.getByTestId('save-record').click();
    assert.equal(await page.getByTestId('item-select').inputValue(), 'S02');
    await page.getByTestId('defer-record').click();
    assert.equal(await page.getByTestId('item-select').inputValue(), 'S03');
    await page.getByTestId('item-select').selectOption('S01');
    assert.equal(await page.getByTestId('item-select').inputValue(), 'S01');
    assert.match(await page.getByTestId('item-status').textContent(), /已记录本条观察/);
    assert.equal(await page.getByTestId('previous-item').isDisabled(), true);
    await page.getByTestId('filter-status').selectOption('uncertain');
    assert.deepEqual(await page.getByTestId('item-select').locator('option').evaluateAll(nodes => nodes.map(node => node.value)), ['S02']);
    await page.getByTestId('filter-status').selectOption('unseen');
    assert.equal(await page.getByTestId('item-select').locator('option').count(), 28);
    await page.getByTestId('group-risk').click();
    assert.equal(await page.getByTestId('item-select').locator('option').count(), 5);
    await page.getByTestId('item-select').selectOption('K02');
    await page.getByTestId('answer-risk_notice-uncertain').check();
    await page.getByTestId('save-record').click();
    download = await exportProgress(page, 'filled-before-reload');
    assertFrozenExport(download.payload);
    filledPayload = download.payload;
    assert.equal(filledPayload.items.find(item => item.id === 'S01').disposition, 'recorded');
    assert.equal(filledPayload.items.find(item => item.id === 'S02').disposition, 'deferred');
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByTestId('review-app').waitFor();
    assert.equal(await page.getByTestId('reviewer-name').inputValue(), filledPayload.reviewer_name);
    assert.equal(await page.getByTestId('answer-text_match-found').isChecked(), true);
    assert.equal(await page.getByTestId('answer-image_description-looks_like').isChecked(), true);
    assert.equal(await page.getByTestId('review-note').inputValue(), '自动测试备注：仅验证本地保存与恢复。');
    assert.match(await page.getByTestId('storage-status').textContent(), /已保存在当前浏览器/);
    assert.match(await page.getByTestId('progress-summary').textContent(), /已记录 1 · 待专业 2 · 未看 32/);
    const after = await exportProgress(page, 'filled-after-reload');
    assert.deepEqual(comparableProgress(after.payload), comparableProgress(filledPayload));
    return { draft_is_not_counted_as_recorded: true, simple_questions_and_unknown_option: true,
      navigation_and_both_groups_and_filters: true, restored_name_answers_note_timestamps_bindings_and_progress: true,
      both_successful_primary_actions_advance_automatically: true,
      recorded_observations: 1, professional_pending: 2, unseen: 32 };
  });

  await check('actual_JSON_import_roundtrip_staged_replace_and_invalid_files_preserve_original_progress', async () => {
    assert.ok(filledPayload, 'A real filled browser export is required');
    const { page } = await newPage('import-roundtrip-and-rejections');
    await openApp(page);
    const blankStorage = await storageSnapshot(page);
    await importProgress(page, filledPayload, 'valid-staged');
    await page.getByTestId('confirm-import').waitFor();
    assert.deepEqual(await storageSnapshot(page), blankStorage, 'Selecting a valid file must wait for the explicit replacement action');
    assert.equal(await page.getByTestId('reviewer-name').inputValue(), '');
    await page.getByTestId('confirm-import').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="import-status"]')?.textContent.includes('已载入'));
    const roundtrip = await exportProgress(page, 'valid-roundtrip');
    assertFrozenExport(roundtrip.payload);
    assert.deepEqual(comparableProgress(roundtrip.payload), comparableProgress(filledPayload));
    const preserved = await storageSnapshot(page);
    const clone = () => structuredClone(roundtrip.payload);
    const wrongPack = clone(); wrongPack.pack_id = 'different-pack';
    const duplicate = clone(); duplicate.items[1] = structuredClone(duplicate.items[0]);
    const version = clone(); version.items[0].source_binding.baseline.record_version++;
    const fingerprint = clone(); fingerprint.items[0].source_binding.baseline.delivery_fingerprint = '0'.repeat(64);
    const beforeBinding = clone(); beforeBinding.items.find(item => item.kind === 'risk').source_binding.before.record_version++;
    const role = clone(); role.reviewer_role = 'medical_professional';
    const medical = clone(); medical.medical_quality_approved = true;
    const product = clone(); product.product_export_approved = true;
    const stage = clone(); stage.stage_passed = true;
    const questionnaire = clone(); questionnaire.questionnaire_version = 'different-questionnaire';
    const fixtures = [['damaged-json', '{'], ['different-pack', wrongPack], ['duplicate-record', duplicate], ['tampered-record-version', version],
      ['tampered-delivery-fingerprint', fingerprint], ['tampered-risk-before-binding', beforeBinding], ['changed-role', role],
      ['medical-approval-escalation', medical], ['product-approval-escalation', product], ['stage-approval-escalation', stage], ['different-questionnaire', questionnaire]];
    for (const [name, value] of fixtures) {
      await importProgress(page, value, name);
      await page.waitForFunction(() => document.querySelector('[data-testid="import-status"]')?.textContent.includes('导入失败'));
      assert.equal(await page.getByTestId('confirm-import').count(), 0, name);
      assert.deepEqual(await storageSnapshot(page), preserved, `${name}: original browser progress must remain byte-for-byte unchanged`);
      assert.equal(await page.getByTestId('reviewer-name').inputValue(), filledPayload.reviewer_name, name);
    }
    const after = await exportProgress(page, 'after-all-rejections');
    assert.deepEqual(comparableProgress(after.payload), comparableProgress(roundtrip.payload));
    return { actual_download_reimport_and_reexport: true, explicit_replace_stage_verified: true,
      rejected_files: fixtures.map(([name]) => name), rejection_visible_and_original_storage_unchanged: true };
  });

  await check('browser_storage_write_failure_is_visible_and_in_memory_backup_still_downloads', async () => {
    const { page, context } = await newPage('storage-write-failure');
    await context.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith('t1-output-review:')) throw new DOMException('Synthetic QA quota exceeded', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    });
    await openApp(page);
    await page.getByTestId('reviewer-name').fill('存储失败自动测试');
    await page.waitForFunction(() => document.querySelector('[data-testid="storage-status"]')?.getAttribute('role') === 'alert');
    assert.match(await page.getByTestId('storage-status').textContent(), /未能保存到浏览器/);
    assert.match(await page.getByTestId('storage-status').textContent(), /请立即导出备份/);
    await page.getByTestId('review-note').fill('保存失败仍需保留的测试备注');
    await page.getByTestId('defer-record').click();
    const backup = await exportProgress(page, 'write-failed-in-memory-backup');
    assertFrozenExport(backup.payload);
    assert.equal(backup.payload.reviewer_name, '存储失败自动测试');
    assert.equal(backup.payload.items[0].disposition, 'draft');
    assert.equal(backup.payload.items[0].recorded_at, null);
    assert.equal(backup.payload.items[0].answers.text_match, 'uncertain');
    assert.equal(backup.payload.items[0].note, '保存失败仍需保留的测试备注');
    assert.equal(await page.getByTestId('item-select').inputValue(), 'S01');
    assert.match(await page.getByTestId('progress-summary').textContent(), /已记录 0 · 待专业 0 · 未看 35/);
    assert.deepEqual(await storageSnapshot(page), {});
    return { actual_browser_Storage_setItem_throw_injection: 'QuotaExceededError', warning_visible: true, unsaved_memory_backup_downloaded: true,
      browser_storage_not_misreported_as_saved: true, failed_commit_stays_on_current_draft_and_does_not_count_as_completed: true };
  });

  await check('cross_tab_changes_pause_stale_writes_and_preserve_both_local_drafts', async () => {
    const { page: first, context } = await newPage('cross-tab');
    await openApp(first);
    await first.getByTestId('review-note').fill('共享初始自动测试');
    const second = await context.newPage();
    second.setDefaultTimeout(10000);
    await openApp(second);
    assert.equal(await second.getByTestId('review-note').inputValue(), '共享初始自动测试');
    await first.getByTestId('review-note').fill('A标签的新进度');
    await second.getByTestId('conflict-banner').waitFor();
    assert.match(await second.getByTestId('conflict-banner').textContent(), /暂停自动写入/);
    const shared = await storageSnapshot(first);
    await second.getByTestId('review-note').fill('B标签保留的内存草稿');
    await second.getByTestId('defer-record').click();
    assert.deepEqual(await storageSnapshot(first), shared, 'The stale tab must not overwrite the newer tab');
    const staleBackup = await exportProgress(second, 'cross-tab-stale-draft');
    assert.equal(staleBackup.payload.items[0].note, 'B标签保留的内存草稿');
    assert.equal(staleBackup.payload.items[0].disposition, 'draft');
    assert.equal(staleBackup.payload.items[0].recorded_at, null);
    assert.equal(await second.getByTestId('item-select').inputValue(), 'S01');
    const pendingBackup = second.waitForEvent('download');
    await second.getByRole('button', { name: '先导出本页，再载入另一页进度', exact: true }).click();
    const automaticBackup = await pendingBackup;
    const automaticPath = join(scratch, 'cross-tab-before-load-other.json');
    await automaticBackup.saveAs(automaticPath);
    const backupPayload = JSON.parse(await readFile(automaticPath, 'utf8'));
    assert.equal(backupPayload.items[0].note, 'B标签保留的内存草稿');
    await second.getByTestId('conflict-banner').waitFor({ state: 'detached' });
    assert.equal(await second.getByTestId('review-note').inputValue(), 'A标签的新进度');
    assert.deepEqual(await storageSnapshot(second), shared);
    return { real_shared_browser_context_tabs: 2, storage_event_conflict_banner: true, stale_writes_paused: true,
      both_A_saved_progress_and_B_downloadable_draft_preserved: true, load_other_action_downloaded_stale_draft_first: true };
  });

  await check('failed_commit_in_pending_filter_keeps_the_current_draft_and_answers_visible', async () => {
    const { page } = await newPage('pending-filter-write-failure');
    await openApp(page);
    await page.getByTestId('defer-record').click();
    assert.equal(await page.getByTestId('item-select').inputValue(), 'S02');
    await page.getByTestId('filter-status').selectOption('uncertain');
    assert.equal(await page.getByTestId('item-select').inputValue(), 'S01');
    const originalStorage = await storageSnapshot(page);
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith('t1-output-review:')) throw new DOMException('Synthetic QA quota after filtering', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    });
    await page.getByTestId('review-note').fill('待专业筛选中保存失败，当前备注仍需可见');
    await page.getByTestId('defer-record').click();
    assert.equal(await page.getByTestId('item-select').inputValue(), 'S01');
    assert.equal(await page.getByTestId('filter-status').inputValue(), 'uncertain');
    assert.equal(await page.getByTestId('review-note').inputValue(), '待专业筛选中保存失败，当前备注仍需可见');
    assert.match(await page.getByTestId('storage-status').textContent(), /未能保存到浏览器/);
    assert.deepEqual(await storageSnapshot(page), originalStorage);
    const backup = await exportProgress(page, 'pending-filter-failed-commit');
    assert.equal(backup.payload.items[0].disposition, 'draft');
    assert.equal(backup.payload.items[0].recorded_at, null);
    assert.equal(backup.payload.items[0].answers.text_match, 'uncertain');
    assertFrozenExport(backup.payload);
    return { filter: 'uncertain', failed_item_id: 'S01', current_draft_visible_without_changing_filter: true, stored_progress_unchanged: true };
  });

  await check('narrow_viewport_risk_comparison_PDF_and_simple_actions_are_usable', async () => {
    const { page } = await newPage('narrow', { viewport: { width: 390, height: 844 } });
    await openApp(page, nestedUrl);
    await page.getByTestId('group-risk').click();
    await page.getByTestId('item-select').selectOption('K02');
    await page.getByTestId('risk-before').click();
    await assertLiteralView(page, pack.risks[1].before, 'K02/before/narrow');
    await page.getByTestId('risk-after').click();
    await assertLiteralView(page, pack.risks[1].after, 'K02/after/narrow');
    const pdf = await assertRenderedPdf(page);
    const geometry = await assertNoViewportOverflow(page);
    await page.screenshot({ path: join(evidence, '02-narrow-risk-comparison.png'), fullPage: true });
    await page.getByTestId('answer-risk_notice-uncertain').check();
    await page.getByTestId('save-record').click();
    assert.equal(await page.getByTestId('item-select').inputValue(), 'K03');
    await page.getByTestId('item-select').selectOption('K02');
    assert.match(await page.getByTestId('item-status').textContent(), /留待专业人员/);
    const backup = await exportProgress(page, 'narrow-risk-unknown');
    assertFrozenExport(backup.payload);
    assert.equal(backup.payload.items.find(item => item.id === 'K02').answers.risk_notice, 'uncertain');
    await assertNoViewportOverflow(page);
    return { viewport: { width: 390, height: 844 }, geometry, pdf, before_after_switch_and_unknown_action_and_download: true };
  });

  await check('no_API_external_network_console_errors_or_resource_404s', async () => {
    assert.deepEqual(attemptedExternal, []);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(failedResources, []);
    assert.ok(requests.every(request => ['GET', 'HEAD'].includes(request.method)));
    assert.deepEqual(requests.filter(request => /\/(?:api|_next|agent)(?:\/|$)/.test(request.path)), []);
    return { browser_requests: requests.length, external_attempts: 0, API_requests: 0, console_errors: 0, failed_static_resources: 0 };
  });
  await check('static_delivery_build_did_not_change_mid_run', async () => {
    for (const [path, hash] of deliveryBefore) assert.equal(sha256(await readFile(join(staticRoot, path))), hash, path);
    return { files_checked: deliveryBefore.size };
  });

} catch (error) {
  checks.push({ name: 'verification_harness', status: 'failed', error: error.stack || String(error) });
} finally {
  await check('protected_input_bytes_unchanged_after_browser_execution', async () => {
    const changed = [];
    for (const [path, hash] of protectedBefore) if (sha256(await readFile(path)) !== hash) changed.push(path.slice(code.length + 1));
    assert.deepEqual(changed, []);
    return { files_checked: protectedBefore.size };
  });
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
  summary.isolated_browser_downloads_and_fixtures_removed = true;
  summary.completed_at = new Date().toISOString();
  summary.passed = checks.every(check => check.status === 'passed');
  await persist();
  process.exitCode = summary.passed ? 0 : 1;
}
