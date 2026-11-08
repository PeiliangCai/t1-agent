/** Local-only UI verification. Creates one in-memory S1 fixture, never an AgentSession. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RunStore, makeFixture } from '../packages/agent/src/index.ts';
import { buildApp } from '../apps/server/src/app.ts';

const code = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
process.env.TMPDIR = join(code, '.tools/qa-tmp');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const evidence = join(code, 'docs/acceptance/pi-web-frontend-2026-11-04/browser');
await mkdir(evidence, { recursive: true });
const checks = [], errors = [], blocked = [], requests = [], failedStaticResources = [];
const summary = { schema_version: 'pi-web-browser-verification-1', checked_at: new Date().toISOString(), checks,
  paid_calls: 0, external_model_requests: 0, fixture_only_for_S1_events: true, historical_medical_candidates_read_only: true,
  server_port: 3210, frontend: 'http://127.0.0.1:5173', browser_sandbox_enabled: false, host_permissions_changed: false };
const store = new RunStore();
const fixture = makeFixture({ provider: 'local-test', modelId: 'offline-fixture', baseUrl: 'http://127.0.0.1:1' });
store.create(fixture.input);
let app = buildApp(store), browser;
async function check(name, work) {
  const start = Date.now();
  try { const detail = await work(); checks.push({ name, status: 'passed', elapsed_ms: Date.now() - start, ...(detail ? { detail } : {}) }); }
  catch (error) { checks.push({ name, status: 'failed', elapsed_ms: Date.now() - start, error: error.stack || String(error) }); throw error; }
  finally { await writeFile(join(evidence, 'results.json'), JSON.stringify({ ...summary, errors, blocked, requests, failedStaticResources }, null, 2) + '\n'); }
  console.log(`${checks.at(-1).status}: ${name}`);
}
async function startBackend() { await app.listen({ host: '127.0.0.1', port: 3210 }); }
try {
  await startBackend();
  browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
  const context = await browser.newContext({ viewport: { width: 1512, height: 1050 }, locale: 'zh-CN', deviceScaleFactor: 1 });
  await context.route(/^https?:\/\//, async route => {
    const url = new URL(route.request().url());
    if (['127.0.0.1', 'localhost'].includes(url.hostname) && ['5173', '3210'].includes(url.port)) return route.continue();
    blocked.push(url.origin); return route.abort('blockedbyclient');
  });
  context.on('request', request => { const url = new URL(request.url()); if (url.protocol.startsWith('http')) requests.push({ method: request.method(), path: url.pathname }); });
  context.on('response', response => { const url = new URL(response.url());
    if (response.status() >= 400 && ['/icons/', '/_next/static/', '/t1-assets/'].some(prefix => url.pathname.startsWith(prefix))) failedStaticResources.push({ path: url.pathname, status: response.status() });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.stack || String(error)));
  await check('general_coding_and_retired_reference_routes_unreachable', async () => {
    const paths = ['/annotation', '/src/main.tsx', '/api/terminal', '/api/agent/new', '/api/files/etc/passwd', '/api/auth/providers', '/api/models', '/api/sessions', '/login', '/sw.js'];
    for (const path of paths) {
      const response = await context.request.get(`http://127.0.0.1:5173${path}`);
      assert.equal(response.status(), 404, path);
    }
    assert.equal((await context.request.post('http://127.0.0.1:5173/api/t1/workbench/papers', { data: {} })).status(), 405);
    assert.equal((await context.request.get('http://127.0.0.1:5173/api/agent/new', { headers: { 'x-middleware-subrequest': 'proxy:proxy:proxy:proxy:proxy' } })).status(), 404);
    assert.equal((await context.request.get('http://127.0.0.1:5173/api/t1/workbench/papers?cwd=/tmp')).status(), 400);
    for (const theme of ['latte', 'mocha']) assert.equal((await context.request.get(`http://127.0.0.1:5173/icons/catppuccin/${theme}/_file.svg`)).status(), 200);
    return { rejected_routes: paths.length, no_annotation_entry: true, both_upstream_tab_icon_themes_HTTP_200: true };
  });
  await check('real_workbench_and_exact_original_fragments', async () => {
    await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });
    const fonts = await page.evaluate(async () => { await document.fonts.ready; return { chinese_font_loaded: document.fonts.check('14px T1CJK', '论文原文工作台'), family: getComputedStyle(document.querySelector('.t1-workbench')).fontFamily }; });
    assert.ok(fonts.chinese_font_loaded && fonts.family.includes('T1CJK'));
    await page.getByRole('heading', { name: '原文片段', exact: true }).waitFor();
    assert.equal(await page.locator('.t1-paper-list>button').count(), 5);
    assert.equal(await page.locator('a[href="/annotation"]').count(), 0);
    await page.getByRole('button', { name: /^L05 / }).click();
    await page.waitForFunction(() => document.querySelector('.t1-record-meta code')?.textContent.startsWith('ev-'));
    const detail = await (await fetch('http://127.0.0.1:3210/api/workbench/papers/L05')).json();
    const baseline = detail.outputs.find(output => output.strategy === 'B0');
    assert.equal(await page.getByLabel('历史策略').inputValue(), baseline.id);
    await page.getByLabel('原文记录').selectOption('0');
    const displayed = await page.locator('.t1-evidence-card > .t1-fragments .t1-verbatim').allTextContents();
    assert.deepEqual(displayed, baseline.records[0].fragments.map(fragment => fragment.exact_quote));
    assert.equal(await page.locator('.t1-evidence-card .markdown-body').count(), 0);
    await page.screenshot({ path: join(evidence, '01-real-original-fragments.png'), fullPage: true });
    return { records: baseline.records.length, fragments_checked: displayed.length, source: 'existing real L05 B0 historical replay', fonts };
  });
  await check('explicit_pair_whole_figure_caption_and_original_image_dialog', async () => {
    const detail = await (await fetch('http://127.0.0.1:3210/api/workbench/papers/L05')).json();
    const output = detail.outputs.find(output => output.strategy === 'B0');
    const index = output.records.findIndex(record => record.association === 'paired');
    assert.ok(index >= 0);
    await page.getByLabel('原文记录').selectOption(String(index));
    await page.locator('.t1-evidence-card > .t1-fragments button').first().click();
    const physicalPage = output.records[index].fragments[0].physical_page;
    await page.locator(`.t1-pdf-reader canvas[data-page="${physicalPage}"]`).waitFor();
    await page.waitForFunction(() => document.querySelector('.t1-pdf-status')?.textContent.includes('已显示第 8 物理页'));
    const viewer = await page.locator('.t1-pdf-reader').evaluate(node => ({ page: Number(node.querySelector('canvas').dataset.page),
      bitmap_width: node.querySelector('canvas').width, bitmap_height: node.querySelector('canvas').height,
      text: node.querySelector('.textLayer').textContent }));
    assert.equal(viewer.page, physicalPage); assert.ok(viewer.bitmap_width > 100 && viewer.bitmap_height > 100);
    assert.ok(viewer.text.includes('Fig. 4'));
    const image = page.locator('.t1-association.paired img').first();
    await image.waitFor(); await image.evaluate(node => node.complete ? Promise.resolve() : new Promise(resolve => node.addEventListener('load', resolve, { once: true })));
    assert.ok(await image.evaluate(node => node.naturalWidth > 100));
    const figure = detail.figures.find(figure => figure.id === output.records[index].figure_ids[0]);
    assert.deepEqual(await page.locator('.t1-association .t1-caption .t1-verbatim').allTextContents(), figure.caption.map(fragment => fragment.exact_quote));
    await page.screenshot({ path: join(evidence, '02-explicit-original-figure.png'), fullPage: true });
    await page.locator('.t1-association button[aria-haspopup="dialog"]').first().click();
    await page.locator('dialog[open]').waitFor();
    await page.screenshot({ path: join(evidence, '03-whole-image-dialog.png'), fullPage: true });
    await page.keyboard.press('Escape'); assert.equal(await page.locator('dialog[open]').count(), 0);
    return { paired_record_index: index, original_image_sha256: figure.assets[0].sha256, caption_fragments: figure.caption.length,
      source_link_clicked_physical_page: physicalPage, controlled_pdfjs_rendered_physical_page: viewer.page,
      bitmap: { width: viewer.bitmap_width, height: viewer.bitmap_height }, source_page_text_contains_original_Figure4: true,
      screenshot_visual_check_required_in_addition: true };
  });
  await check('tabs_keyboard_resize_theme_and_source_directory_statuses', async () => {
    const separator = page.getByRole('separator', { name: '调整论文导航宽度' });
    const before = Number(await separator.getAttribute('aria-valuenow'));
    await separator.focus(); await page.keyboard.press('ArrowRight');
    assert.ok(Number(await separator.getAttribute('aria-valuenow')) > before);
    await page.getByRole('tab', { name: '原 Figure 目录', exact: true }).click();
    await page.getByRole('heading', { name: '原 Figure 目录', exact: true }).waitFor();
    assert.ok(await page.getByText('待核候选 · 尚未确认原文对应', { exact: true }).count());
    assert.ok(await page.getByText('独立图源 · 无明确原文对应', { exact: true }).count());
    await page.getByRole('button', { name: '界面主题', exact: true }).click();
    await page.getByRole('menuitemradio', { name: '深色', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.classList.contains('dark') || document.documentElement.dataset.theme === 'dark');
    await page.screenshot({ path: join(evidence, '04-figure-directory-dark.png'), fullPage: true });
    await page.getByRole('button', { name: '界面主题', exact: true }).click();
    await page.getByRole('menuitemradio', { name: '浅色', exact: true }).click();
    await page.getByRole('tab', { name: '原 Figure 目录', exact: true }).focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('tab', { name: '工程任务', exact: true }).getAttribute('aria-selected'), 'true');
    return { resized_from: before, resized_to: Number(await separator.getAttribute('aria-valuenow')), original_components_used: ['TabBar', 'useResizablePanel', 'SidebarMenu', 'useTheme'] };
  });
  await check('S1_existing_state_events_and_reconnect_without_duplicate_sequences', async () => {
    await page.locator('.t1-run-list button').first().click();
    await page.waitForFunction(() => document.querySelector('.t1-stream-status')?.textContent.includes('已连接'));
    await page.waitForFunction(() => document.querySelectorAll('.t1-events li').length === 1);
    await app.close();
    await page.waitForFunction(() => document.querySelector('.t1-stream-status')?.textContent.includes('重连'));
    app = buildApp(store); await startBackend();
    store.transition(fixture.input.run_id, 'extracting');
    await page.waitForFunction(() => document.querySelectorAll('.t1-events li').length === 2, { timeout: 15000 });
    const labels = await page.locator('.t1-events li>span').allTextContents();
    assert.deepEqual(labels.map(label => Number(label.match(/^#(\d+)/)[1])), [1, 2]);
    await page.screenshot({ path: join(evidence, '05-S1-events-reconnected.png'), fullPage: true });
    return { local_fixture_id: fixture.input.run_id, received_sequences: [1, 2], model_calls: 0 };
  });
  await check('unknown_task_and_real_empty_paper_are_distinct', async () => {
    await page.getByLabel('已有任务 ID').fill('unknown-task'); await page.getByRole('button', { name: '查看任务', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '未找到所选论文或任务' }).waitFor();
    await page.getByRole('button', { name: /^L02 / }).click();
    await page.getByRole('heading', { name: '此论文暂无已接入的抽取结果' }).waitFor();
    assert.ok(await page.getByText('当前不会启动新的模型抽取', { exact: false }).count());
    await page.screenshot({ path: join(evidence, '06-real-empty-result.png'), fullPage: true });
    return { missing_task_status: 404, empty_paper: 'L02', automatic_extraction: false };
  });
  await check('backend_failure_visible_and_retry_recovers', async () => {
    await app.close();
    await page.getByRole('button', { name: '刷新工作台', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '尚未连接到 T1 服务' }).first().waitFor();
    await page.screenshot({ path: join(evidence, '07-real-backend-error.png'), fullPage: true });
    app = buildApp(store); await startBackend();
    await page.getByRole('button', { name: '重新连接', exact: true }).click();
    await page.getByRole('heading', { name: '此论文暂无已接入的抽取结果' }).waitFor();
    await page.waitForFunction(() => ![...document.querySelectorAll('[role="alert"]')].some(node => node.textContent.includes('尚未连接')));
  });
  await check('mobile_layout_and_direct_original_pdf_link', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '关闭论文导航', exact: true }).click();
    await page.getByRole('button', { name: '切换论文导航', exact: true }).click();
    await page.getByRole('button', { name: /^L02 / }).click();
    await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert.ok((await page.locator('.t1-mobile-source').getAttribute('href')).includes('/pdf#page=1'));
    await page.screenshot({ path: join(evidence, '08-mobile-empty-paper.png'), fullPage: true });
  });
  await check('no_script_markdown_execution_in_source_renderer', async () => {
    await page.setViewportSize({ width: 1512, height: 1050 });
    const detail = await (await fetch('http://127.0.0.1:3210/api/workbench/papers/L01')).json();
    const literal = 'QA <img src=x onerror="window.__qaExecuted=true"> **literal** <script>window.__qaExecuted=true</script>';
    detail.outputs[0].records[0].fragments[0].exact_quote = literal;
    const view = await context.newPage();
    await view.route('**/api/t1/workbench/papers/L01', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detail) }));
    await view.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });
    await view.locator('.t1-evidence-card > .t1-fragments .t1-verbatim').first().waitFor();
    assert.equal(await view.locator('.t1-evidence-card > .t1-fragments .t1-verbatim').first().textContent(), literal);
    assert.equal(await view.locator('.t1-evidence-card > .t1-fragments img, .t1-evidence-card > .t1-fragments script, .t1-evidence-card > .t1-fragments strong').count(), 0);
    assert.equal(await view.evaluate(() => window.__qaExecuted), undefined);
    await view.close();
    return { renderer_fixture_only: true, backend_source_binding_validation_bypassed_only_in_test_intercept: true };
  });
  await check('no_failed_static_resources_external_network_or_uncaught_browser_errors', async () => { assert.deepEqual(blocked, []); assert.deepEqual(errors, []); assert.deepEqual(failedStaticResources, []); return { browser_requests: requests.length, external_requests: blocked.length, failed_static_resources: failedStaticResources.length }; });
} finally {
  await browser?.close(); await app.close(); store.close();
  await writeFile(join(evidence, 'results.json'), JSON.stringify({ ...summary, errors, blocked, requests, failedStaticResources }, null, 2) + '\n');
}
