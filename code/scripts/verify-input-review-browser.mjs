/** Actual Chromium + static HTTP only. No Next/Fastify, model API, or server-side opinion writes. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const code = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(code, 'apps/pi-web/public/input-review');
const evidence = join(code, 'docs/acceptance/pdf-structure-review-2026-11-07/browser');
const notePath = join(code, 'runtime-data/agent-notes/figure-review-2026-11-07.json');
const prefix = '/nested/static/input-review/';
const sha = data => createHash('sha256').update(data).digest('hex');
const pack = JSON.parse(await readFile(join(root, 'data.json'), 'utf8'));
const checks = [], requests = [], errors = [], external = [], failures = [];
async function hashes(folder) {
  const result = {};
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) Object.assign(result, await hashes(path));
    else if (entry.isFile()) result[path] = sha(await readFile(path));
  }
  return result;
}
const before = await hashes(root);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.pdf': 'application/pdf' };
const server = createServer(async (req, res) => {
  requests.push({ method: req.method, path: req.url });
  try {
    const url = new URL(req.url, 'http://127.0.0.1'), pathname = decodeURIComponent(url.pathname);
    if (!['GET', 'HEAD'].includes(req.method) || !pathname.startsWith(prefix)) throw new Error('static only');
    const file = resolve(root, pathname.slice(prefix.length) || 'index.html');
    if (file !== root && !file.startsWith(root + sep)) throw new Error('path');
    const info = await stat(file); if (!info.isFile()) throw new Error('file');
    const bytes = await readFile(file); res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'content-length': bytes.length, 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch { res.writeHead(404); res.end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port, url = origin + prefix;
const scratch = await mkdtemp(join(code, 'runtime-data/agent-notes/input-review-browser-'));
const fontConfig = join(scratch, 'fonts.conf');
await writeFile(fontConfig, '<?xml version="1.0"?><fontconfig><include>/etc/fonts/fonts.conf</include><dir>' +
  join(code, '.tools/pdf-parser/fonts') + '</dir><cachedir>' + join(scratch, 'font-cache') + '</cachedir></fontconfig>');
process.env.FONTCONFIG_FILE = fontConfig;
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir(evidence, { recursive: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1060 }, acceptDownloads: true });
await context.route('**/*', async route => {
  const address = route.request().url();
  if (address.startsWith(origin + '/') || address.startsWith('blob:') || address.startsWith('data:')) return route.continue();
  external.push(address); return route.abort();
});
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('requestfailed', request => failures.push({ url: request.url(), reason: request.failure()?.errorText }));
function checked(id, detail) { checks.push({ id, status: 'passed', detail }); }
const select = async caseId => { await page.locator('[data-case-id="' + caseId + '"]').click(); await page.locator('#case-title').waitFor(); };
try {
  await page.goto(url, { waitUntil: 'networkidle' });
  assert.equal(await page.title(), 'PDF解析与图文定位核验');
  assert.equal(await page.locator('#workspace').isVisible(), true);
  assert.equal(await page.locator('.case-button').count(), pack.cases.length);
  assert.match(await page.locator('#progress').innerText(), /0\s*\//);
  assert.equal(await page.locator('[data-verdict][aria-pressed="true"]').count(), 0);
  await page.screenshot({ path: join(evidence, '00-default.png'), fullPage: true });
  checked('static_nested_entry', 'Actual Chromium opens a nested static directory; no app server or default verdict.');
  await page.locator('#kind-filter').selectOption('figure');
  assert.equal(await page.locator('.case-button').count(), pack.cases.filter(c => c.kind === 'figure').length);
  const fig6 = pack.cases.find(c => c.case_id === 'L07-P09-F6'); assert.ok(fig6);
  await select(fig6.case_id);
  const afterSrc = await page.locator('#parsed-view img').first().getAttribute('src');
  assert.equal(afterSrc, fig6.after.sections.find(s => s.type === 'image').image);
  await page.screenshot({ path: join(evidence, '01-figure6-after.png'), fullPage: true });
  await page.locator('#view-before').click(); const beforeSrc = await page.locator('#parsed-view img').first().getAttribute('src'); assert.notEqual(beforeSrc, afterSrc);
  await page.screenshot({ path: join(evidence, '02-figure6-before.png'), fullPage: true });
  await page.locator('#view-after').click(); assert.equal(await page.locator('#parsed-view img').first().getAttribute('src'), afterSrc);
  assert.ok((await page.locator('#original-pdf').getAttribute('href')).endsWith('#page=9'));
  checked('before_after_source_link', 'Figure6 defaults to repaired crop; before/after use different bound PNGs and original PDF page9.');
  await page.locator('#parsed-view .image-button').first().click(); await page.locator('#image-dialog').waitFor({ state: 'visible' });
  await page.locator('#zoom-in').click(); assert.equal(await page.locator('#zoom-level').innerText(), '150%');
  await page.locator('#zoom-reset').click(); assert.equal(await page.locator('#zoom-level').innerText(), '100%');
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#image-dialog').isVisible(), false);
  checked('image_zoom', 'Real dialog opens full PNG, zooms, resets and closes with Escape.');
  const firstQuestion = page.locator('.opinion-card').first();
  await firstQuestion.getByRole('button', { name: '有问题', exact: true }).click();
  await firstQuestion.getByLabel('图不完整', { exact: true }).check();
  await firstQuestion.locator('input[type=text]').fill('图6底部脚注');
  const sentinel = '<img src=x onerror="window.__review_xss=1">';
  await firstQuestion.locator('textarea').fill(sentinel);
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#kind-filter').selectOption('figure'); await select(fig6.case_id);
  assert.equal(await page.locator('.opinion-card').first().locator('textarea').inputValue(), sentinel);
  assert.equal(await page.locator('.opinion-card').first().getByRole('button', { name: '有问题', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => window.__review_xss), undefined);
  assert.equal(await page.locator('#questions img').count(), 0);
  checked('opinion_save_restore_and_plain_text', 'Verdict, issue type, location and literal note survive reload; note HTML is never executed.');
  const fig4 = pack.cases.find(c => c.case_id === 'L07-P07-F4-CONTROL'); await select(fig4.case_id);
  const caption = fig4.after.sections.find(s => s.layout === 'caption-lines');
  assert.equal(await page.locator('#parsed-view .caption-lines').count(), 1);
  assert.equal(await page.locator('#parsed-view .fragment-label').count(), 1);
  assert.deepEqual(await page.locator('#parsed-view .caption-line').allTextContents(), caption.fragments.map(f => f.text));
  assert.equal(await page.locator('#parsed-view .caption-lines').textContent(), caption.fragments.map(f => f.text).join('\n'));
  assert.ok(caption.fragments.every(f => f.source_segment?.block_id && f.source_segment?.text_version));
  await page.screenshot({ path: join(evidence, '06-compact-caption.png'), fullPage: true });
  checked('compact_literal_caption', 'Figure4 keeps every original line and source span in one compact page group with one original-page navigation.');
  await page.locator('#kind-filter').selectOption('table');
  const table = pack.cases.find(c => c.kind === 'table' && c.after.sections.some(s => s.type === 'table' && s.grid.n_rows >= 20)); assert.ok(table);
  await select(table.case_id); assert.ok(await page.locator('.readable-table tr').count() >= 20);
  assert.ok(await page.locator('.readable-table').evaluate(t => [...t.querySelectorAll('th,td')].some(c => c.colSpan > 1)));
  assert.ok(await page.locator('.readable-table').evaluate(t => [...t.querySelectorAll('th,td')].some(c => c.rowSpan > 1)));
  assert.match(await page.locator('.table-controls').innerText(), /共25行×7列.*上下\/左右滚动/s);
  assert.equal(await page.locator('#case-explanation').isVisible(), false);
  const tableScroll = page.locator('.table-scroll'), lastRow = page.locator('.readable-table tr').last();
  await tableScroll.evaluate(node => { node.scrollTop = node.scrollHeight; }); await lastRow.scrollIntoViewIfNeeded();
  assert.match(await lastRow.innerText(), /Diameter/);
  assert.ok(await tableScroll.evaluate(node => {
    const last = node.querySelector('tr:last-child').getBoundingClientRect(), box = node.getBoundingClientRect();
    return node.scrollTop > 0 && last.bottom <= box.bottom + 1 && last.top >= box.top;
  }));
  await page.screenshot({ path: join(evidence, '07-table4-last-row.png'), fullPage: true });
  await page.getByRole('button', { name: '展开全表', exact: true }).click();
  assert.ok(await tableScroll.evaluate(node => node.scrollHeight <= node.clientHeight + 1));
  await page.locator('.opinion-card').first().getByRole('button', { name: '看起来正确', exact: true }).click();
  await page.screenshot({ path: join(evidence, '03-readable-table4.png'), fullPage: true });
  await page.getByRole('button', { name: '收起', exact: true }).click();
  assert.ok(await tableScroll.evaluate(node => node.scrollHeight > node.clientHeight));
  checked('readable_table_and_independent_opinion', 'Table4 shows25×7 and scroll guidance; Chromium actually scrolls to final Diameter row, expands all rows, and collapses; opinions stay distinct.');
  const table3 = pack.cases.find(c => c.kind === 'table' && c.case_id.includes('Table3'));
  assert.ok(table3, 'Final pack must expose the repaired Table3 and its actual native before result.');
  await select(table3.case_id);
  assert.ok((await page.locator('#original-pdf').getAttribute('href')).endsWith('#page=6'));
  const repairedGrid = table3.after.sections.find(s => s.type === 'table').grid;
  assert.match(await page.locator('.table-controls').innerText(), new RegExp('共' + repairedGrid.n_rows + '行×' + repairedGrid.n_cols + '列'));
  const repairedCell = repairedGrid.cells.find(c => c.text.includes('12.78') && c.text.includes('4.71')); assert.ok(repairedCell);
  assert.ok(await page.locator('.readable-table td').evaluateAll((cells, expected) => cells.some(c => c.textContent === expected), repairedCell.text));
  await page.locator('#view-before').click();
  assert.match(await page.locator('.table-controls').innerText(), /共17行×8列/);
  await page.locator('#view-after').click();
  await page.getByRole('button', { name: '展开全表', exact: true }).click();
  await page.screenshot({ path: join(evidence, '08-table3-before-after-repaired.png'), fullPage: true });
  checked('table3_actual_repair_and_source_page', 'The real Table3 case shows its native17×8 before result, repaired single-cell12.78/4.71, and original PDF physical page6.');
  await page.locator('#kind-filter').selectOption('continuation');
  const continuation = pack.cases.find(c => c.kind === 'continuation' && c.pages.length > 1); assert.ok(continuation);
  await select(continuation.case_id); const secondPage = continuation.pages[1];
  await page.locator('#page-select').selectOption(String(secondPage.physical_page));
  assert.equal(await page.locator('#original-image').getAttribute('src'), secondPage.image);
  assert.ok((await page.locator('#original-pdf').getAttribute('href')).endsWith('#page=' + secondPage.physical_page));
  await page.locator('#next').click(); await page.locator('#previous').click(); assert.equal(await page.locator('#case-title').innerText(), continuation.title);
  await page.screenshot({ path: join(evidence, '05-continuation.png'), fullPage: true });
  checked('case_and_page_switching', 'Case navigation and multi-page original PNG/PDF locations switch to the exact requested source page.');
  const downloadPromise = page.waitForEvent('download'); await page.locator('#export').click(); const download = await downloadPromise;
  const exportPath = join(scratch, 'actual-export.json'); await download.saveAs(exportPath); const exported = JSON.parse(await readFile(exportPath, 'utf8'));
  assert.equal(exported.pack_sha256, pack.pack_sha256); assert.equal(exported.opinions.length, 2);
  assert.equal(exported.human_approved, false); assert.equal(exported.product_export_approved, false); assert.equal(exported.medical_quality_approved, false);
  for (const opinion of exported.opinions) { const c = pack.cases.find(c => c.case_id === opinion.case_id); assert.equal(opinion.pdf_sha256, c.pdf_sha256); assert.equal(opinion.artifact_sha256, c.artifact_sha256); }
  page.once('dialog', dialog => dialog.accept()); await page.locator('#clear').click(); assert.match(await page.locator('#progress').innerText(), /0\s*\//);
  await page.locator('#import').setInputFiles(exportPath); await page.waitForFunction(() => document.getElementById('message').textContent.includes('已恢复'));
  assert.match(await page.locator('#progress').innerText(), /2\s*\//);
  const storedBefore = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])));
  for (const [name, mutate] of [['wrong-pack', v => v.pack_sha256 = '0'.repeat(64)], ['wrong-source', v => v.opinions[0].pdf_sha256 = '0'.repeat(64)],
    ['approval', v => v.human_approved = true], ['duplicate', v => v.opinions.push(v.opinions[0])]]) {
    const invalid = structuredClone(exported); mutate(invalid); const path = join(scratch, name + '.json'); await writeFile(path, JSON.stringify(invalid));
    await page.locator('#import').setInputFiles(path); await page.waitForFunction(() => document.getElementById('import').value === '');
    assert.equal(await page.locator('#message').evaluate(node => node.classList.contains('error')), true);
    assert.deepEqual(await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)]))), storedBefore);
  }
  checked('bound_export_import_and_invalid_import_rollback', 'Actual browser download restores after clearing; wrong pack/PDF, approval claims and duplicates reject without changing saved opinions.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#kind-filter').selectOption('figure'); await select(fig6.case_id);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2));
  await page.screenshot({ path: join(evidence, '04-mobile.png'), fullPage: true });
  checked('mobile_readability', 'Mobile layout preserves controls and contains wide tables/images within scrollable panels.');
  assert.equal(external.length, 0); assert.equal(errors.length, 0); assert.equal(failures.length, 0);
  assert.ok(requests.every(r => ['GET', 'HEAD'].includes(r.method) && !r.path.includes('/api/')));
  assert.deepEqual(await hashes(root), before);
  checked('static_only_and_no_server_writes', 'All browser requests stay in the static directory, GET/HEAD only; page/assets unchanged after opinion interactions.');
  const result = { status: 'passed', actual_Chromium: true, server: 'local static HTTP, nested mount', pack_sha256: pack.pack_sha256,
    screenshot_cjk_font: 'Existing local .tools/pdf-parser/fonts; no external font request or page CSS injection.',
    cases: pack.cases.length, questions: pack.cases.reduce((n, c) => n + c.questions.length, 0), checks,
    page_errors: errors, external_requests: external, failed_resources: failures, non_static_or_write_requests: requests.filter(r => !['GET', 'HEAD'].includes(r.method) || r.path.includes('/api/')),
    static_delivery_sha256: Object.fromEntries(Object.entries(before).map(([p, hash]) => [p.slice(code.length + 1), hash])),
    storage_key: 't1-pdf-input-review:' + pack.pack_id + ':' + pack.pack_sha256, temporary_downloads_removed: true, paid_calls: 0 };
  try {
    const note = JSON.parse(await readFile(notePath, 'utf8')); note.browser_verification = result; await writeFile(notePath, JSON.stringify(note, null, 2) + '\n');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  process.stdout.write(JSON.stringify({ status: result.status, checks: checks.length, cases: result.cases, questions: result.questions, page_errors: errors, external_requests: external, paid_calls: 0 }) + '\n');
} finally {
  await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); await rm(scratch, { recursive: true, force: true });
}
