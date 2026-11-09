import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
const code = resolve('.'), base = join(code, 'docs/acceptance/finalization-2026-11-09/s6/post-holdout-raw-name-repair');
const origin = 'http://127.0.0.1:30141';
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, '.tools/annotation-browser/browsers');
process.env.LD_LIBRARY_PATH = [join(code, '.tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const { chromium } = await import(pathToFileURL(join(code, '.tools/annotation-browser/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: false });
const report = { started_at: new Date().toISOString(), positive_data_kind: 'GET capabilities response fixture only; ordinary backend remains model disabled', errors: [], mutations: [], checks: [] };
try {
  for (const locale of ['zh-CN', 'en', 'zh-TW']) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(({ locale, theme }) => { localStorage.setItem('pi-locale', locale); localStorage.setItem('pi-theme', theme); }, { locale, theme });
    await context.route(/^https?:\/\//, async route => {
      const request = route.request(); assert.equal(new URL(request.url()).origin, origin);
      if (!['GET', 'HEAD'].includes(request.method())) { report.mutations.push(request.method()); return route.abort(); }
      if (new URL(request.url()).pathname === '/api/t1/workbench/capabilities') {
        const response = await route.fetch(), value = await response.json();
        return route.fulfill({ response, json: { ...value, extraction_start: true, max_concurrent_runs: 2, model_runtime: {
          provider: 'local-ui-response-fixture', model_id: 'fixture-model-123', reasoning_effort: 'fixture-effort',
          limits: { requests: 7, input_tokens: 12345, output_tokens: 3456, execution_seconds: 120 }
        } } });
      }
      return route.continue();
    });
    const page = await context.newPage(); page.on('pageerror', e => report.errors.push(String(e)));
    await page.goto(origin + '/?view=newTask');
    const notice = page.locator('.t1-model-runtime'); await notice.waitFor(); await notice.scrollIntoViewIfNeeded();
    assert.match(await notice.innerText(), /fixture-model-123 · fixture-effort/);
    assert.ok(!(await notice.innerText()).includes('t1.'));
    await notice.locator('summary').click();
    const values = await notice.locator('dd').allTextContents();
    assert.deepEqual(values, ['7', new Intl.NumberFormat(locale).format(12345), new Intl.NumberFormat(locale).format(3456), locale === 'en' ? '2 min' : locale === 'zh-CN' ? '2 分钟' : '2 分鐘', '2']);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false);
    report.checks.push({ locale, theme, width: 390, dynamic_values: values, horizontal_overflow: overflow, start_never_clicked: true });
    if (locale === 'zh-CN' && theme === 'light') await page.screenshot({ path: join(base, 'runtime-mobile-zh-CN.png'), fullPage: true });
    if (locale === 'en' && theme === 'dark') { await page.setViewportSize({ width: 1512, height: 1050 }); await notice.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(base, 'runtime-desktop-en-dark.png'), fullPage: true }); }
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 1512, height: 1050 } });
  await context.route(/^https?:\/\//, route => { const request = route.request(); assert.equal(new URL(request.url()).origin, origin); if (!['GET', 'HEAD'].includes(request.method())) { report.mutations.push(request.method()); return route.abort(); } return route.continue(); });
  const page = await context.newPage(); page.on('pageerror', e => report.errors.push(String(e)));
  await page.goto(origin + '/?view=newTask'); await page.locator('.t1-start').waitFor();
  assert.equal(await page.locator('.t1-model-runtime').count(), 0); assert.equal(await page.locator('.t1-start').isDisabled(), true);
  report.checks.push({ actual_ordinary_capabilities: true, model_disabled: true, missing_public_runtime_not_hardcoded: true });
  await page.goto(origin + '/?paper=L07&run=b0-revalidation-2151bbfc-5883-49c4-9e17-d3b600f92a9f%3Asource-L07&view=records');
  await page.locator('.t1-evidence-card').waitFor();
  report.checks.push({ actual_L07_records_readable: true, source_not_mutated: true });
  await context.close();
  assert.deepEqual(report.errors, []); assert.deepEqual(report.mutations, []); report.passed = true;
} finally { await browser.close(); report.finished_at = new Date().toISOString(); await writeFile(join(base, 'ui-model-runtime-result.json'), JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify(report));
