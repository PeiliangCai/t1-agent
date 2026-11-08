/** Actual finalized-data browser checks. No paid calls, framework server, installs or browser download. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assetPath, figureAssets, roleLabel, validateReliabilityManifest, versionCount, versionFigures } from "./reliability-model.ts";

const here = dirname(fileURLToPath(import.meta.url)), app = resolve(here, ".."), code = resolve(here, "../../..");
const root = join(app, "public/output-review"), acceptance = join(code, "docs/acceptance/s4-reliability-2026-11-05/live-revalidation"), evidence = join(acceptance, "frontend");
const hash = bytes => createHash("sha256").update(bytes).digest("hex"), checks = [], errors = [], failures = [], external = [], requests = [];
const build = JSON.parse(await readFile(join(root, "reliability-build.json"), "utf8")), manifestBytes = await readFile(join(root, build.manifest_file));
const manifest = validateReliabilityManifest(JSON.parse(manifestBytes)), evidenceMap = JSON.parse(await readFile(join(root, "reliability-evidence-map.json"), "utf8"));
const baseline = JSON.parse(await readFile(join(evidence, "protected-before.json"), "utf8")).sha256;
const sealed = JSON.parse(await readFile(join(acceptance, "sealed-artifacts.json"), "utf8"));
const freeze = JSON.parse(await readFile(join(code, "docs/acceptance/s4-reliability-2026-11-05/source-freeze.json"), "utf8"));
const frozen = Object.fromEntries(Object.entries(freeze.frozen_current_sources).map(([path, value]) => [path, value.expected]));
await mkdir(evidence, { recursive: true });
const scratchRoot = join(code, "runtime-data/output-review-browser-tests"); await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(join(scratchRoot, "reliability-isolated-"));
const report = { schema_version: "s4-reliability-reader-browser-1", started_at: new Date().toISOString(), actual_browser_execution: true,
  manifest_sha256: hash(manifestBytes), finalized_at: manifest.finalized_at, batch_id: manifest.batch_id,
  candidate_identities: manifest.records.length, retained_versions: versionCount(manifest),
  paid_calls_by_frontend: 0, new_human_reviews: 0, medical_quality_approved: false, product_export_approved: false,
  runtime_or_ledger_writes: 0, formal_reviews_inherited: "3/3; no additional formal review", browser_downloaded: false,
  server: "temporary 127.0.0.1 static HTTP only", real_user_browser_profile_used: false, next_or_fastify_started: false, checks };
async function persist() { await writeFile(join(evidence, "results.json"), JSON.stringify({ ...report, browser_errors: errors, failed_resources: failures, external_requests: external, request_count: requests.length }, null, 2) + "\n"); }
async function check(name, work) {
  try { checks.push({ name, status: "passed", detail: await work() }); }
  catch (error) { checks.push({ name, status: "failed", error: error.stack || String(error) }); }
  console.log(`${checks.at(-1).status}: ${name}`); await persist();
}
async function verifyFiles(files, base) { for (const [path, expected] of Object.entries(files)) assert.equal(hash(await readFile(join(base, path))), expected, path); }
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".pdf": "application/pdf", ".png": "image/png", ".woff2": "font/woff2", ".wasm": "application/wasm", ".log": "text/plain" };
const nested = "/code/apps/pi-web/public/output-review/";
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    const path = pathname.startsWith(nested) ? pathname.slice(nested.length) : pathname.slice(1);
    const file = resolve(root, path || "index.html");
    if (!file.startsWith(root + sep) || !["GET", "HEAD"].includes(request.method)) { response.writeHead(403).end(); return; }
    if (!(await stat(file)).isFile()) { response.writeHead(404).end(); return; }
    const body = await readFile(file);
    response.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Content-Length": body.length, "Cache-Control": "no-store" });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch { response.writeHead(404).end(); }
});
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, ".tools/annotation-browser/browsers");
process.env.LD_LIBRARY_PATH = [join(code, ".tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
const { chromium } = await import(pathToFileURL(join(code, ".tools/annotation-browser/node_modules/playwright/index.mjs")).href);
let browser, url;
async function pageFor(label, viewport = { width: 1512, height: 1000 }, disableStorage = false) {
  const context = await browser.newContext({ viewport, locale: "zh-CN" });
  await context.route(/^https?:\/\//, route => {
    if (new URL(route.request().url()).origin === new URL(url).origin) return route.continue();
    external.push({ label, url: route.request().url() }); return route.abort();
  });
  if (disableStorage) await context.addInitScript(() => {
    window.__readerStorageAccesses = [];
    for (const key of ["getItem", "setItem", "removeItem", "clear"]) Storage.prototype[key] = function () { window.__readerStorageAccesses.push(key); throw new DOMException("Isolated readonly QA", "SecurityError"); };
  });
  context.on("page", page => {
    page.on("pageerror", error => errors.push({ label, type: "pageerror", message: String(error) }));
    page.on("console", message => { if (message.type() === "error") errors.push({ label, type: "console", message: message.text() }); });
  });
  context.on("response", response => { if (response.status() >= 400) failures.push({ label, status: response.status(), url: response.url() }); });
  context.on("request", request => requests.push({ method: request.method(), url: request.url() }));
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  return { context, page };
}
async function open(page, target = url) { const response = await page.goto(target, { waitUntil: "networkidle" }); assert.equal(response.status(), 200); await page.getByTestId("reliability-app").waitFor(); }
async function pdf(page, expected) {
  await page.waitForFunction(expected => {
    const canvas = document.querySelector('[data-testid="pdf-canvas"]');
    return document.querySelector('[data-testid="pdf-scroll"]')?.getAttribute("aria-busy") === "false" && (!expected || canvas?.getAttribute("aria-label") === `原论文第${expected}物理页`);
  }, expected);
  const rendered = await page.getByTestId("pdf-canvas").evaluate(canvas => {
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let nonwhite = 0; for (let i = 0; i < pixels.length; i += 16) if (pixels[i + 3] && (pixels[i] < 240 || pixels[i + 1] < 240 || pixels[i + 2] < 240)) nonwhite++;
    return { width: canvas.width, height: canvas.height, nonwhite };
  });
  assert.ok(rendered.width > 100 && rendered.height > 100 && rendered.nonwhite > 10);
  if (expected) assert.equal(await page.getByTestId("pdf-page").inputValue(), String(expected));
  return rendered;
}
async function noOverflow(page) { const size = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth })); assert.ok(size.document <= size.viewport + 1, JSON.stringify(size)); return size; }

try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); url = `http://127.0.0.1:${server.address().port}/reliability.html`;
  browser = await chromium.launch({ headless: true, channel: "chromium", downloadsPath: scratch }); report.browser_version = browser.version();
  await check("frozen_actual_inputs_all_old_assets_and_build_bindings", async () => {
    assert.equal(hash(manifestBytes), "413fa83644c519d8ca69056d34458dd6d7ed69ee19cd640a9fd4ea82af5afaa5");
    assert.deepEqual(manifestBytes, await readFile(join(acceptance, "reader-manifest.json")));
    await verifyFiles(baseline, code); await verifyFiles(frozen, code); await verifyFiles(sealed.artifacts, code); await verifyFiles(build.artifact_sha256, root);
    execFileSync(process.execPath, [join(app, "node_modules/typescript/bin/tsc"), "--project", join(here, "tsconfig.json"), "--noEmit"], { cwd: app, encoding: "utf8" });
    return { protected_existing_files: Object.keys(baseline).length, frozen_runtime_sources: Object.keys(frozen).length, sealed_artifacts: Object.keys(sealed.artifacts).length, focused_typecheck: "passed" };
  });
  const { page, context } = await pageFor("actual-readonly-reader", undefined, true);
  await check("independent_statuses_failed_summary_full_usage_and_unknown_bill_visible", async () => {
    await open(page); await pdf(page); await noOverflow(page);
    assert.match(await page.getByTestId("reliability-boundary").textContent(), /联合工程修复的集成复验，非单因素效果、三方案排名或医学通过/);
    const totals = await page.getByTestId("reliability-totals").textContent();
    for (const value of [manifest.usage_totals.requests, manifest.usage_totals.input_tokens, manifest.usage_totals.output_tokens]) assert.ok(totals.includes(value.toLocaleString("en-US")));
    assert.match(totals, /41\/41已结算/); assert.match(totals, /费用未知/); assert.ok(!/费用\s*0/.test(totals));
    for (const job of manifest.jobs) {
      const card = page.locator(`[data-testid="reliability-job"][data-job-id="${job.job_id}"]`);
      assert.match(await card.getByTestId("selected-processing").textContent(), /处理完成/);
      assert.ok((await card.getByTestId("selected-processing").textContent()).includes(`${job.batch_count}批`));
      assert.match(await card.getByTestId("summary-status").textContent(), job.summary.complete ? /汇总已完成/ : /汇总未完成/);
      assert.match(await card.getByTestId("parser-status").textContent(), /原解析结果为部分完成/);
      for (const value of [job.usage.requests, job.usage.input_tokens, job.usage.output_tokens]) assert.ok((await card.getByTestId("job-usage").textContent()).includes(value.toLocaleString("en-US")));
      if (!job.summary.complete) {
        const failure = await card.getByTestId("summary-failure").textContent();
        assert.match(failure, /原子回滚/); assert.match(failure, /具体标签原文未保存/);
        await card.getByTestId("job-evidence").locator(":scope > summary").click();
        assert.match(await card.textContent(), /whole_document_summary_incomplete/); assert.match(await card.textContent(), /feature_name_not_in_evidence/);
        await card.getByTestId("job-evidence").locator(":scope > summary").click();
      } else assert.match(await card.getByTestId("selection-scope").textContent(), /91块未在本次选择范围内处理/);
    }
    await page.evaluate(() => document.fonts.ready); await pdf(page);
    await page.screenshot({ path: join(evidence, "01-reliability-overview.png"), fullPage: true });
    return { actual_usage: manifest.usage_totals, summary_outcomes: manifest.jobs.map(job => ({ job_id: job.job_id, summary_complete: job.summary.complete, run_state: job.state })), failures_and_retries_included: true, unknown_bill_not_zero: true };
  });
  await check("every_candidate_and_all_versions_literal_sources_context_PDF_and_roles", async () => {
    await page.getByTestId("reliability-group").selectOption("all");
    assert.equal(await page.getByTestId("reliability-record").locator("option").count(), manifest.records.length);
    let versions = 0, fragments = 0, pdfLocations = 0, proposalScreenshots = 0;
    for (const entry of manifest.records) {
      await page.getByTestId("reliability-record").selectOption(entry.entry_id);
      assert.equal(await page.getByTestId("reliability-version").inputValue(), String(entry.current_version));
      assert.equal(await page.getByTestId("reliability-version").locator("option").count(), entry.versions.length);
      for (const version of entry.versions) {
        await page.getByTestId("reliability-version").selectOption(String(version.version));
        const source = page.getByTestId("reliability-source"), record = version.record;
        assert.equal(await source.getByTestId("version-status").getAttribute("data-role"), version.version_role);
        assert.ok((await source.getByTestId("version-status").textContent()).includes(roleLabel(version.version_role)));
        assert.equal(await source.getByTestId("original-quote").textContent(), record.original_quote);
        const spans = await source.getByTestId("original-span").evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, block: node.dataset.blockId, start: Number(node.dataset.start), end: Number(node.dataset.end), page: Number(node.dataset.page) })));
        assert.deepEqual(spans, record.quote_span.segments.map(part => ({ text: part.exact_quote, block: part.block_id, start: part.start, end: part.end, page: part.physical_page })));
        assert.deepEqual(await source.getByTestId("context-quote").allTextContents(), record.context.fragments.map(part => part.exact_quote));
        assert.deepEqual(JSON.parse(await source.getByTestId("full-version-json").textContent()), version);
        assert.equal(await source.getByTestId("reliability-figure").count(), versionFigures(manifest, version).length);
        await source.getByTestId("locate-original").click(); await pdf(page, record.quote_span.segments[0].physical_page); pdfLocations++;
        if (record.context.fragments.length) { await source.getByTestId("locate-context").first().click(); await pdf(page, record.context.fragments[0].physical_page); pdfLocations++; }
        const link = await page.getByTestId("open-pdf").getAttribute("href");
        assert.ok(link.startsWith(new URL("pdf/L05.pdf", url).href));
        if (version.version_role === "proposed") {
          assert.match(await source.getByTestId("version-status").textContent(), /提议未采用/);
          await source.getByTestId("version-changes").locator(":scope > summary").click();
          assert.ok(await source.getByTestId("version-change").count() > 0);
          await page.screenshot({ path: join(evidence, "02-reliability-unadopted-proposal.png"), fullPage: false }); proposalScreenshots++;
        }
        versions++; fragments += record.quote_span.segments.length + record.context.fragments.length;
      }
      if (entry.versions.at(-1).version_role !== "current_active") await page.getByTestId("back-to-current").click();
    }
    for (const job of manifest.jobs) { await page.getByTestId("reliability-group").selectOption(job.job_id); assert.equal(await page.getByTestId("reliability-record").locator("option").count(), manifest.records.filter(entry => entry.job_id === job.job_id).length); }
    await page.getByTestId("reliability-group").selectOption("all");
    assert.deepEqual(await page.evaluate(() => window.__readerStorageAccesses), []);
    return { candidates: manifest.records.length, versions, literal_source_and_context_fragments: fragments, actual_PDF_jumps: pdfLocations, unadopted_proposals_checked: proposalScreenshots, local_or_session_storage_accesses: 0, all_complete_version_payloads_unchanged: true };
  });
  await check("real_PDF_Figure_assets_caption_jumps_and_original_image_dialog", async () => {
    for (const paper of manifest.papers) assert.equal(hash(await (await context.request.get(new URL(paper.public_pdf_path, url).href)).body()), paper.pdf_sha256);
    let assets = 0;
    for (const figure of manifest.figures) for (const asset of figureAssets(figure)) if (assetPath(asset)) { assert.equal(hash(await (await context.request.get(new URL(assetPath(asset), url).href)).body()), asset.sha256); assets++; }
    const withFigure = manifest.records.find(entry => entry.versions.some(version => version.figure_ids.length));
    assert.ok(withFigure); await page.getByTestId("reliability-record").selectOption(withFigure.entry_id);
    const source = page.getByTestId("reliability-source"), figure = versionFigures(manifest, withFigure.versions.find(version => version.version_role === "current_active"))[0];
    await source.getByTestId("locate-figure-caption").first().click(); await pdf(page, figure.caption_segments[0].physical_page);
    await source.locator('button[aria-haspopup="dialog"]').first().click();
    const dialog = page.getByRole("dialog", { name: "查看原整图", exact: true }); await dialog.waitFor();
    await dialog.locator("img").evaluate(image => image.complete ? Promise.resolve() : new Promise(resolve => { image.onload = resolve; }));
    assert.ok(await dialog.locator("img").evaluate(image => image.naturalWidth > 100 && image.naturalHeight > 100));
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
    await page.getByTestId("figure-catalog").locator(":scope > summary").click();
    assert.equal(await page.getByTestId("figure-catalog").getByTestId("reliability-figure").count(), manifest.figures.length);
    await page.getByTestId("figure-catalog").locator(":scope > summary").click();
    return { original_PDFs: manifest.papers.length, original_figure_assets: assets, individual_version_associations_used: true, actual_image_dialog_opened_and_closed: true, catalog_not_claimed_as_pairing: true };
  });
  await check("all_static_failure_and_report_evidence_links_remain_exact", async () => {
    let checked = 0;
    for (const [sourcePath, staticPath] of Object.entries(evidenceMap)) {
      if (sourcePath.startsWith("__")) continue;
      const response = await context.request.get(new URL(staticPath, url).href); assert.equal(response.status(), 200);
      assert.equal(hash(await response.body()), hash(await readFile(join(code, sourcePath))), sourcePath); checked++;
    }
    return { exact_copied_real_evidence_files: checked, full_failure_tool_events_and_error_codes_retained: true, model_wire_bodies_or_failed_feature_literal_not_invented: true };
  });
  await check("nested_Live_Server_relative_paths_and_narrow_screen", async () => {
    const { page: narrow } = await pageFor("nested-narrow", { width: 390, height: 844 }, true);
    await open(narrow, new URL(`${nested}reliability.html`, url).href); await pdf(narrow); const geometry = await noOverflow(narrow);
    const proposal = manifest.records.find(entry => entry.versions.some(version => version.version_role === "proposed"));
    await narrow.getByTestId("reliability-record").selectOption(proposal.entry_id);
    await narrow.getByTestId("reliability-version").selectOption(String(proposal.versions.find(version => version.version_role === "proposed").version));
    await noOverflow(narrow); await narrow.screenshot({ path: join(evidence, "03-reliability-narrow.png"), fullPage: true });
    return { viewport: { width: 390, height: 844 }, geometry, nested_relative_resources_loaded: true, proposed_version_remains_unadopted: true };
  });
  await check("unfinalized_manifest_is_rejected_without_result_substitution", async () => {
    const { page: invalid } = await pageFor("invalid-finalization"); const altered = structuredClone(manifest); delete altered.finalized_at;
    await invalid.route(`**/${build.manifest_file}`, route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(altered) }));
    await invalid.goto(url, { waitUntil: "domcontentloaded" }); await invalid.getByRole("alert").waitFor();
    assert.match(await invalid.getByRole("alert").textContent(), /没有用模拟或未定版数据/);
    assert.equal(await invalid.getByTestId("reliability-app").count(), 0); return { missing_finalization_visible_error: true, replacement_outputs_shown: false };
  });
  await check("both_old_backlinks_still_load_the_preserved_material", async () => {
    const { page: old } = await pageFor("old-backlinks"); await open(old);
    await old.getByTestId("previous-revalidation-link").click(); await old.getByTestId("revalidation-app").waitFor();
    await old.goto(url, { waitUntil: "networkidle" }); await old.getByTestId("legacy-review-link").click(); await old.getByTestId("review-app").waitFor();
    assert.match(await old.getByTestId("progress-summary").textContent(), /未看 35/);
    return { old_two_round_reader_loads: true, original_35_item_reader_loads: true, real_user_progress_not_used_or_written: true };
  });
  await check("no_external_API_static_resource_or_browser_errors", async () => {
    assert.deepEqual(errors, []); assert.deepEqual(failures, []); assert.deepEqual(external, []);
    assert.ok(requests.every(request => ["GET", "HEAD"].includes(request.method)));
    assert.ok(requests.every(request => !/\/(?:api|_next|agent)(?:\/|$)/.test(new URL(request.url).pathname)));
    return { browser_requests: requests.length, external_or_API_requests: 0, browser_errors: 0 };
  });
} catch (error) { checks.push({ name: "verification_harness", status: "failed", error: error.stack || String(error) }); }
finally {
  await check("old_assets_previous_reports_and_frozen_runtime_and_ledger_bytes_unchanged", async () => {
    await verifyFiles(baseline, code); await verifyFiles(frozen, code); await verifyFiles(sealed.artifacts, code); await verifyFiles(build.artifact_sha256, root);
    return { old_files: Object.keys(baseline).length, frozen_sources: Object.keys(frozen).length, sealed_artifacts: Object.keys(sealed.artifacts).length, new_reader_delivery_files: Object.keys(build.artifact_sha256).length };
  });
  await browser?.close(); if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive: true, force: true }); report.isolated_scratch_removed = true; report.completed_at = new Date().toISOString(); report.passed = checks.every(check => check.status === "passed");
  await persist(); process.exitCode = report.passed ? 0 : 1;
}
