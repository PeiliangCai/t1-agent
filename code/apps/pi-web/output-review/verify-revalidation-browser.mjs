/** Final actual-data verification. No models, framework server or browser download. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { filteredRecords, partialRecords, roundComparisons, validateReaderManifest } from "./revalidation-model.ts";

const here = dirname(fileURLToPath(import.meta.url)), code = resolve(here, "../../.."), app = resolve(here, "..");
const root = join(app, "public/output-review"), base = join(code, "docs/acceptance/user-feedback-2026-11-05/revalidation");
const evidence = join(base, "frontend"), scratchRoot = join(code, "runtime-data/output-review-browser-tests");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const build = JSON.parse(await readFile(join(root, "revalidation-build.json"), "utf8"));
const bytes = await readFile(join(root, build.manifest_file));
const manifest = validateReaderManifest(JSON.parse(bytes));
const frozenInputs = [];
for (const freeze of manifest.freeze_plans) {
  const plan = JSON.parse(await readFile(join(code, freeze.plan_path), "utf8"));
  for (const [path, expected] of Object.entries(plan.source_hashes)) frozenInputs.push({ path: join(code, freeze.source_root, path), expected });
}
const userPath = join(root, "普通用户初筛-cc939653-2026-11-05T06-08-53.json");
const userFeedback = JSON.parse(await readFile(userPath, "utf8"));
const protectedPaths = [...frozenInputs.map(item => item.path), ...manifest.freeze_plans.map(item => join(code, item.plan_path)), ...manifest.source_artifacts.map(item => join(code, item.path)),
  ...["index.html", "review.js", "review.css", "pack-manifest.json", "source-groups.json", "pdf/L01.pdf", "pdf/L05.pdf"].map(path => join(root, path)), userPath];
const previousEvidence = join(code, "docs/acceptance/user-feedback-2026-11-05/frontend");
for (const name of await readdir(previousEvidence)) protectedPaths.push(join(previousEvidence, name));
const protectedBefore = new Map(await Promise.all([...new Set(protectedPaths)].map(async path => [path, hash(await readFile(path))])));
const deliveryBefore = new Map(await Promise.all(["revalidation.html", "revalidation.js", "revalidation.css", build.manifest_file].map(async path => [path, hash(await readFile(join(root, path)))])));
await mkdir(evidence, { recursive: true }); await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(join(scratchRoot, "revalidation-isolated-"));
const checks = [], pageErrors = [], consoleErrors = [], external = [], failures = [], requests = [];
const report = { schema_version: "feedback-revalidation-reader-browser-1", checked_at: new Date().toISOString(), actual_browser_execution: true,
  actual_finalized_manifest_sha256: hash(bytes), finalized_at: manifest.finalized_at, batch_id: manifest.batch_id,
  rounds: manifest.rounds,
  actual_new_human_reviews: 0, medical_quality_approved: false, product_export_approved: false, stage_passed: false,
  paid_calls_by_frontend: 0, runtime_or_ledger_mutations_by_frontend: 0, inherited_formal_reviews: "3/3, no additional review",
  new_data_scope: "Only finalized actual outputs, with source delivery provenance; no synthetic or manually corrected counterfactual outputs in delivery",
  browser_profiles: "isolated Playwright contexts; no real user profile or progress", server: "temporary static HTTP on 127.0.0.1 only", next_or_fastify_started: false,
  tested_delivery_sha256: Object.fromEntries(deliveryBefore), checks };
async function persist() { await writeFile(join(evidence, "results.json"), JSON.stringify({ ...report, page_errors: pageErrors, console_errors: consoleErrors, external_requests: external, failed_resources: failures, request_count: requests.length }, null, 2) + "\n"); }
async function check(name, work) {
  try { checks.push({ name, status: "passed", detail: await work() }); }
  catch (error) { checks.push({ name, status: "failed", error: error.stack || String(error) }); }
  console.log(`${checks.at(-1).status}: ${name}`); await persist();
}
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".pdf": "application/pdf", ".png": "image/png", ".woff2": "font/woff2", ".wasm": "application/wasm" };
const nested = "/isolated/nested/output-review/";
const server = createServer(async (request, response) => {
  try {
    let path = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    path = path.startsWith(nested) ? path.slice(nested.length) : path.slice(1);
    if (!path) path = "index.html";
    const file = resolve(root, path);
    if (!file.startsWith(root + sep) || !["GET", "HEAD"].includes(request.method)) { response.writeHead(403).end(); return; }
    if (!(await stat(file)).isFile()) { response.writeHead(404).end(); return; }
    const body = await readFile(file);
    response.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream", "Content-Length": body.length, "Cache-Control": "no-store" });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch { response.writeHead(404).end(); }
});
process.env.PLAYWRIGHT_BROWSERS_PATH = join(code, ".tools/annotation-browser/browsers");
process.env.LD_LIBRARY_PATH = [join(code, ".tools/annotation-browser/sysroot/usr/lib/x86_64-linux-gnu"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
const { chromium } = await import(pathToFileURL(join(code, ".tools/annotation-browser/node_modules/playwright/index.mjs")).href);
let browser, url;
async function pageFor(label, viewport = { width: 1512, height: 1000 }) {
  const context = await browser.newContext({ viewport, locale: "zh-CN" });
  await context.route(/^https?:\/\//, async route => {
    if (new URL(route.request().url()).origin === new URL(url).origin) return route.continue();
    external.push({ label, url: route.request().url() }); await route.abort();
  });
  context.on("page", page => { page.on("pageerror", error => pageErrors.push({ label, error: String(error) })); page.on("console", message => { if (message.type() === "error") consoleErrors.push({ label, message: message.text() }); }); });
  context.on("response", response => { if (response.status() >= 400) failures.push({ label, url: response.url(), status: response.status() }); });
  context.on("request", request => requests.push({ method: request.method(), url: request.url() }));
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  return { context, page };
}
async function open(page, target = url) { const response = await page.goto(target, { waitUntil: "networkidle" }); assert.equal(response.status(), 200); await page.getByTestId("revalidation-app").waitFor(); }
async function pdf(page) {
  await page.getByTestId("pdf-canvas").waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(() => document.querySelector('[data-testid="pdf-scroll"]')?.getAttribute("aria-busy") === "false");
  const result = await page.getByTestId("pdf-canvas").evaluate(canvas => {
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let nonwhite = 0; for (let i = 0; i < pixels.length; i += 16) if (pixels[i + 3] && (pixels[i] < 240 || pixels[i + 1] < 240 || pixels[i + 2] < 240)) nonwhite++;
    return { page: Number(canvas.getAttribute("aria-label").match(/第(\d+)/)[1]), width: canvas.width, height: canvas.height, nonwhite };
  });
  assert.ok(result.width > 100 && result.height > 100 && result.nonwhite > 10); return result;
}
async function literal(page, originals, context = []) {
  const groups = [...originals, ...context], parts = groups.flatMap(group => group.segments);
  const actual = await page.getByTestId("reader-exact-span").evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, block: node.dataset.blockId, start: Number(node.dataset.start), end: Number(node.dataset.end), page: Number(node.dataset.page) })));
  assert.deepEqual(actual, parts.map(part => ({ text: part.exact_quote, block: part.block_id, start: part.start, end: part.end, page: part.physical_page })));
  assert.deepEqual(await page.getByTestId("reader-group-quote").allTextContents(), groups.map(group => group.segments.map(part => part.exact_quote).join("\n")));
  assert.deepEqual(await page.getByTestId("reader-source-group").evaluateAll(nodes => nodes.map(node => node.dataset.completeness)), groups.map(group => group.completeness));
  assert.equal(await page.locator('[data-testid="reader-exact-span"] script, [data-testid="reader-exact-span"] img').count(), 0);
  return parts.length;
}
async function noOverflow(page) { const size = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth })); assert.ok(size.document <= size.width + 1); return size; }

try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}/revalidation.html`;
  browser = await chromium.launch({ headless: true, channel: "chromium", downloadsPath: scratch });
  report.browser_version = browser.version(); report.browser_downloaded = false;
  await check("actual_finalized_manifest_frozen_sources_and_prior_user_feedback_bindings", async () => {
    assert.equal(hash(bytes), build.manifest_sha256);
    assert.deepEqual(bytes, await readFile(join(base, "final-two-rounds/reader-manifest.json")));
    for (const { path, expected } of frozenInputs) assert.equal(hash(await readFile(path)), expected, path);
    for (const artifact of manifest.source_artifacts) assert.equal(hash(await readFile(join(code, artifact.path))), artifact.sha256, artifact.path);
    assert.equal(hash(await readFile(userPath)), "e53f669c7086761f9d0ef209448979aae488068c7b1e2a80d1f5590e422b6a28");
    assert.equal(manifest.issues.length, 11);
    for (const issue of manifest.issues) assert.equal(issue.old_note, userFeedback.items.find(item => item.id === issue.old_item_id).note);
    return { finalized_real_outputs: true, representative_records: manifest.records.length, partial_attempt_records: partialRecords(manifest).length, logical_jobs: manifest.jobs.length, frozen_runtime_sources: frozenInputs.length, rounds: manifest.rounds.length, old_notes: 11 };
  });
  await check("focused_typecheck_and_reader_unit_regressions", async () => {
    execFileSync(process.execPath, [join(app, "node_modules/typescript/bin/tsc"), "--project", join(here, "tsconfig.json"), "--noEmit"], { cwd: app, encoding: "utf8" });
    const output = execFileSync(process.execPath, ["--import", "tsx", "--test", "--test-reporter=tap", join(here, "revalidation-model.test.mjs")], { cwd: code, encoding: "utf8" });
    assert.match(output, /# fail 0/); return { typecheck: "passed", unit_summary: output.slice(-180) };
  });
  const { page, context } = await pageFor("actual-records");
  await check("default_latest_view_prominently_keeps_negative_group_cost_and_summary_outcome", async () => {
    await open(page);
    const comparisons = roundComparisons(manifest);
    assert.equal(await page.getByTestId("reader-comparison-row").count(), comparisons.length);
    if (comparisons.length) {
      const primary = comparisons.find(pair => pair.after.document_id === "L05" && pair.after.method === "B0") ?? comparisons[0];
      const text = await page.getByTestId("reader-primary-comparison").textContent();
      assert.ok(text.includes(`${primary.after.document_id} · ${primary.after.method}`));
      assert.ok(text.includes(`请求${primary.before.requests} → ${primary.after.requests}`));
      assert.ok(text.includes(`实际候选${primary.before.candidate_count} → ${primary.after.candidate_count}`));
      if (primary.after.summary_complete === false) assert.match(text, /全文概括汇总未完成/);
      assert.match(await page.getByTestId("reader-comparison").textContent(), /更少候选均不能证明结果更好/);
      assert.deepEqual(await page.getByTestId("reader-primary-diagnostic-original").allTextContents(), primary.after.notes ?? []);
      assert.ok((await page.getByTestId("reader-primary-diagnostic").allTextContents()).every(text => !text.includes("application_context_estimate_limit")), "Original technical cause is folded behind the plain explanation");
      assert.match(await page.getByTestId("reader-runs").locator(":scope > summary").textContent(), /10组实际运行（两轮各5组）/);
      assert.match(await page.getByTestId("reader-round-note").textContent(), /计算方法不单独列为描述/);
      return { actual_group: primary.after.job_id, earlier_requests: primary.before.requests, latest_requests: primary.after.requests,
        earlier_candidates: primary.before.candidate_count, latest_candidates: primary.after.candidate_count, latest_summary_complete: primary.after.summary_complete,
        actual_diagnostics_shown_without_inventing_error_codes: true, low_candidate_count_not_treated_as_quality: true };
    }
    return { single_round_only: true };
  });
  await check("all_actual_new_records_literal_groups_locations_and_readonly_state", async () => {
    await open(page);
    assert.match(await page.getByTestId("reader-boundary").textContent(), /未继承旧35条/);
    assert.equal(await page.getByTestId("reader-round").inputValue(), manifest.rounds.at(-1).round_id, "The latest actual rule round is the default");
    await page.getByTestId("reader-round").selectOption("all");
    assert.equal(await page.getByTestId("reader-record").locator("option").count(), manifest.records.length || 1);
    let spans = 0, locations = 0;
    for (const record of manifest.records) {
      await page.getByTestId("reader-record").selectOption(record.record_id);
      spans += await literal(page, record.original_groups, record.context_groups);
      assert.match(await page.getByTestId("reader-record-label").textContent(), /待用户 \/ 专业核验/);
      const visibleHelp = await page.locator('.reader-checks ul').innerText();
      assert.doesNotMatch(visibleHelp, /Mechanical checks|new_term_pending_human_review|span\/offset|delivery/);
      await page.getByTestId("reader-source-group").first().getByRole("button", { name: "在PDF中定位 ↗", exact: true }).click();
      assert.equal((await pdf(page)).page, record.original_groups[0].segments[0].physical_page);
      const detail = page.getByTestId("reader-source-group").first().locator("details");
      await detail.locator("summary").click();
      await detail.getByTestId("reader-locate-span").last().click();
      assert.equal((await pdf(page)).page, record.original_groups[0].segments.at(-1).physical_page); locations += 2;
      await detail.locator("summary").click();
    }
    assert.deepEqual(await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)]))), {});
    assert.equal(await page.locator("textarea, input[type=radio]").count(), 0, "This reader does not manufacture a second approval questionnaire");
    await page.getByTestId("reader-round").selectOption(manifest.rounds.at(-1).round_id);
    const latestRecords = filteredRecords(manifest, "all", "all", manifest.rounds.at(-1).round_id);
    const duplicates = new Map();
    for (const record of latestRecords) {
      const quote = record.original_groups.flatMap(group => group.segments.map(part => part.exact_quote)).join("");
      const sameTaskQuote = `${record.job_id}:${quote}`;
      duplicates.set(sameTaskQuote, [...(duplicates.get(sameTaskQuote) ?? []), record]);
    }
    const duplicateGroups = [...duplicates.values()].filter(records => records.length > 1);
    const duplicateGroup = duplicateGroups.find(records => records[0].job_id.endsWith(":L05-B0")) ?? duplicateGroups[0];
    if (latestRecords.length) { await page.getByTestId("reader-record").selectOption((duplicateGroup?.[0] ?? latestRecords[0]).record_id); await pdf(page); }
    await noOverflow(page); await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: join(evidence, "01-final-actual-record-and-PDF.png"), fullPage: true });
    return { actual_records: manifest.records.length, exact_source_and_context_spans: spans, actual_group_and_span_location_clicks: locations,
      actual_same_primary_source_records_retained: duplicateGroup?.length ?? 0, duplicate_record_ids: duplicateGroup?.map(record => record.record_id) ?? [], new_review_progress_written: false };
  });
  await check("all_methods_papers_alias_reuse_and_real_empty_outcomes", async () => {
    let empty = 0, aliases = 0;
    for (const round of manifest.rounds) for (const paper of manifest.papers) for (const method of ["B0", "F", "R"]) {
      await page.getByTestId("reader-round").selectOption(round.round_id);
      await page.getByTestId("reader-document").selectOption(paper.document_id); await page.getByTestId("reader-method").selectOption(method);
      const expected = filteredRecords(manifest, paper.document_id, method, round.round_id);
      if (!expected.length) { await page.getByTestId("reader-empty").waitFor(); empty++; }
      else assert.deepEqual(await page.getByTestId("reader-record").locator("option").evaluateAll(nodes => nodes.map(node => node.value)), expected.map(record => record.record_id));
      const reused = manifest.jobs.find(job => job.round_id === round.round_id && job.document_id === paper.document_id && job.method === method && job.reused_from_job_id);
      if (reused && expected.length) { assert.match(await page.getByTestId("reader-record-label").textContent(), /复用/); aliases++; }
    }
    await page.getByTestId("reader-round").selectOption("all"); await page.getByTestId("reader-document").selectOption("all"); await page.getByTestId("reader-method").selectOption("all");
    assert.equal(await page.getByTestId("reader-record").locator("option").count(), manifest.records.length || 1);
    return { paper_method_views: manifest.rounds.length * manifest.papers.length * 3, actual_empty_views: empty, reused_views_checked: aliases, all_view_has_no_duplicated_reused_records: true };
  });
  await check("actual_failed_and_retry_attempt_costs_and_zero_incremental_alias_are_visible", async () => {
    await page.getByTestId("reader-runs").locator(":scope > summary").click();
    assert.equal(await page.getByTestId("reader-job").count(), manifest.jobs.length);
    const totals = await page.getByTestId("reader-usage-total").textContent();
    assert.ok(totals.includes(`${manifest.usage_totals.requests}次请求`)); assert.match(totals, /含失败与重试/);
    if (manifest.usage_totals.actual_cost === null) assert.match(totals, /不能按0计/);
    assert.equal(await page.getByTestId("reader-attempt").count(), manifest.jobs.reduce((sum, job) => sum + (job.attempts?.length ?? 0), 0));
    for (const job of manifest.jobs) {
      const row = page.getByTestId("reader-job").nth(manifest.jobs.indexOf(job));
      assert.ok((await row.textContent()).includes(`${job.requests}次请求`));
      if (job.reused_from_job_id) assert.match(await row.textContent(), /复用/);
      for (const attempt of job.attempts ?? []) assert.ok((await row.textContent()).includes(`${attempt.requests}次请求`));
      if (job.attempts?.length) await row.getByText(`实际尝试链（${job.attempts.length}次）`, { exact: true }).click();
    }
    await page.screenshot({ path: join(evidence, "02-final-run-costs-failures-and-retries.png"), fullPage: true });
    await page.getByTestId("reader-runs").locator(":scope > summary").click();
    return { actual_usage_totals: manifest.usage_totals, attempts: manifest.jobs.reduce((sum, job) => sum + (job.attempts?.length ?? 0), 0), failures_and_retries_not_omitted: true, unknown_cost_not_zero: true };
  });
  await check("failed_partial_attempt_actual_records_are_separate_readable_and_locatable", async () => {
    const partials = partialRecords(manifest);
    await page.getByTestId("reader-runs").locator(":scope > summary").click();
    assert.equal(await page.getByTestId("reader-attempt-record").count(), partials.length);
    for (let index = 0; index < partials.length; index++) {
      const record = partials[index], card = page.getByTestId("reader-attempt-record").nth(index);
      assert.deepEqual(await card.locator("blockquote").allTextContents(), record.original_groups.map(group => group.segments.map(part => part.exact_quote).join("\n")));
      await card.getByTestId("reader-open-partial").click();
      await page.getByTestId("reader-partial-banner").scrollIntoViewIfNeeded();
      assert.match(await page.getByTestId("reader-partial-banner").textContent(), /不计为代表路径记录/);
      await literal(page, record.original_groups, record.context_groups);
      await page.getByTestId("reader-source-group").first().getByRole("button", { name: "在PDF中定位 ↗", exact: true }).click();
      assert.equal((await pdf(page)).page, record.original_groups[0].segments[0].physical_page);
      if (index === 0) await page.screenshot({ path: join(evidence, "05-final-partial-attempt-actual-source.png"), fullPage: false });
      await page.getByTestId("reader-close-partial").click();
    }
    await page.getByTestId("reader-runs").locator(":scope > summary").click();
    return { failed_attempt_actual_records: partials.length, separately_shown_without_promoting_to_representative_path: true, all_partial_source_context_and_PDF_locations_verified: true };
  });
  await check("all_11_legacy_notes_remain_literal_and_source_links_do_not_inherit_old_opinions", async () => {
    await page.getByTestId("reader-issues-mode").click();
    let noMatch = 0;
    const jobs = new Map(manifest.jobs.map(job => [job.job_id, job]));
    for (const round of manifest.rounds) for (const issue of manifest.issues) {
      await page.getByTestId("reader-round").selectOption(round.round_id);
      await page.getByTestId("reader-issue").selectOption(issue.old_item_id);
      assert.equal(await page.getByTestId("reader-old-note").textContent(), issue.old_note);
      await literal(page, issue.old_original_groups, issue.old_context_groups);
      const related = issue.new_record_ids.filter(id => jobs.get(manifest.records.find(record => record.record_id === id).job_id).round_id === round.round_id);
      assert.equal(await page.getByTestId("reader-related-record").count(), related.length);
      if (!related.length) { assert.match(await page.getByTestId("reader-no-direct-match").textContent(), /不能据此认定问题已修复/); noMatch++; }
    }
    await page.getByTestId("reader-round").selectOption("all");
    const issue = manifest.issues.find(item => item.new_record_ids.length) ?? manifest.issues[0];
    if (issue) await page.getByTestId("reader-issue").selectOption(issue.old_item_id);
    await pdf(page); await page.screenshot({ path: join(evidence, "03-final-legacy-note-source-comparison.png"), fullPage: false });
    if (issue?.new_record_ids.length) { await page.getByTestId("reader-related-record").first().click(); assert.equal(await page.getByTestId("reader-record").inputValue(), issue.new_record_ids[0]); }
    return { literal_old_notes: 11, actual_round_comparisons: manifest.rounds.length, no_direct_match_round_issues: noMatch, correspondence: "source overlap only, not one-to-one matching or review inheritance" };
  });
  await check("original_assets_and_reused_image_dialog_are_real_local_files", async () => {
    let images = 0, dialogs = 0;
    for (const paper of manifest.papers) assert.equal(hash(await (await context.request.get(new URL(paper.pdf_path, url).href)).body()), paper.pdf_sha256);
    for (const figure of manifest.figures) for (const asset of figure.assets) { assert.equal(hash(await (await context.request.get(new URL(asset.pack_path, url).href)).body()), asset.sha256); images++; }
    const withImage = manifest.records.find(record => manifest.figures.some(figure => record.figure_ids.includes(figure.figure_id) && figure.assets.length));
    if (withImage) {
      await page.getByTestId("reader-records-mode").click(); await page.getByTestId("reader-round").selectOption("all"); await page.getByTestId("reader-record").selectOption(withImage.record_id);
      const trigger = page.locator('.reader-figures button[aria-haspopup="dialog"]').first(); await trigger.click();
      const dialog = page.getByRole("dialog", { name: "查看原整图", exact: true }); await dialog.waitFor();
      await dialog.locator("img").evaluate(image => image.complete ? Promise.resolve() : new Promise(resolve => { image.onload = resolve; }));
      assert.ok(await dialog.locator("img").evaluate(image => image.naturalWidth > 100 && image.naturalHeight > 100));
      await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" }); dialogs++;
    }
    return { original_PDFs: manifest.papers.length, exact_original_image_files: images, actual_image_dialogs_exercised: dialogs, no_image_is_not_a_claim_of_no_figure: true };
  });
  await check("nested_Live_Server_style_URL_and_narrow_viewport_are_usable", async () => {
    const { page: narrow } = await pageFor("nested-narrow", { width: 390, height: 844 });
    await open(narrow, new URL(`${nested}revalidation.html`, url).href); await pdf(narrow); const geometry = await noOverflow(narrow);
    await narrow.getByTestId("reader-issues-mode").click(); if (manifest.issues[0]) await narrow.getByTestId("reader-issue").selectOption(manifest.issues[0].old_item_id);
    await noOverflow(narrow); await narrow.screenshot({ path: join(evidence, "04-final-narrow-source-comparison.png"), fullPage: true });
    return { viewport: { width: 390, height: 844 }, geometry, nested_relative_assets_loaded: true };
  });
  await check("reader_has_no_storage_dependency_and_rejects_unfinalized_intercepted_data", async () => {
    const { page: readonly, context: readonlyContext } = await pageFor("disabled-storage");
    await readonlyContext.addInitScript(() => { Storage.prototype.getItem = () => { throw new DOMException("QA disabled", "SecurityError"); }; Storage.prototype.setItem = () => { throw new DOMException("QA disabled", "SecurityError"); }; });
    await open(readonly); await pdf(readonly);
    const { page: invalid } = await pageFor("unfinalized-rejected");
    const altered = structuredClone(manifest); delete altered.finalized_at;
    await invalid.route(`**/${build.manifest_file}`, route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(altered) }));
    await invalid.goto(url, { waitUntil: "networkidle" });
    assert.match(await invalid.getByRole("alert").textContent(), /没有使用模拟或未完成数据/);
    assert.equal(await invalid.getByTestId("revalidation-app").count(), 0);
    return { disabled_storage_reader_still_works: true, unfinalized_data_visible_error: true, no_placeholder_outputs_substituted: true };
  });
  await check("legacy_page_backlink_still_opens_unchanged_35_item_material", async () => {
    await page.getByTestId("legacy-reader-link").click(); await page.getByTestId("review-app").waitFor();
    assert.match(await page.getByTestId("group-random").textContent(), /30/); assert.match(await page.getByTestId("group-risk").textContent(), /5/);
    assert.match(await page.getByTestId("progress-summary").textContent(), /未看 35/);
    return { old_page_loaded: true, old_progress_not_written_by_reader: true };
  });
  await check("no_external_API_console_or_static_resource_failures", async () => {
    assert.deepEqual(external, []); assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []); assert.deepEqual(failures, []);
    assert.ok(requests.every(item => ["GET", "HEAD"].includes(item.method)));
    assert.ok(requests.every(item => !/\/(?:api|_next|agent)(?:\/|$)/.test(new URL(item.url).pathname)));
    return { actual_requests: requests.length, external_or_API_requests: 0, browser_errors: 0 };
  });
} catch (error) {
  checks.push({ name: "verification_harness", status: "failed", error: error.stack || String(error) });
} finally {
  await check("frozen_runtime_actual_artifacts_old_35_feedback_and_prior_evidence_bytes_unchanged", async () => {
    for (const [path, expected] of protectedBefore) assert.equal(hash(await readFile(path)), expected, path);
    for (const [path, expected] of deliveryBefore) assert.equal(hash(await readFile(join(root, path))), expected, path);
    return { protected_files: protectedBefore.size, tested_new_delivery_files: deliveryBefore.size };
  });
  await browser?.close(); if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive: true, force: true }); report.isolated_scratch_removed = true; report.completed_at = new Date().toISOString();
  report.passed = checks.every(item => item.status === "passed"); await persist(); process.exitCode = report.passed ? 0 : 1;
}
