import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { answerItem, assertPack, canRecord, canonical, commitItem, counts, emptyResults, itemsForPack, needsExpert, parseResults, validateResults, storageKey, PACK_ID, ZIP_SHA256, MANIFEST_SHA256 } from "./model.ts";
import { parseSaved, ProgressConflict, saveUnchanged } from "./storage.ts";

const here = dirname(fileURLToPath(import.meta.url));
const code = resolve(here, "../../..");
const destination = resolve(here, "../public/output-review");
const frozen = join(code, "docs/acceptance/s0-s4-current-2026-11-04/output-review-pack-2026-11-05");
const zip = join(frozen, "真实输出人工核验包.zip");
const manifestRaw = execFileSync("python3", ["-c", "import zipfile,sys;sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read('pack-manifest.json'))", zip], { maxBuffer: 8_000_000 });
const pack = JSON.parse(manifestRaw);
const t0 = "2026-11-05T03:00:00.000Z", t1 = "2026-11-05T03:01:00.000Z", t2 = "2026-11-05T03:02:00.000Z";
const hash = data => createHash("sha256").update(data).digest("hex");
const fresh = () => emptyResults(pack, t0);
const clone = value => JSON.parse(JSON.stringify(value));
function recorded() {
  const r = fresh();
  r.reviewer_name = "测试核验人";
  r.items[0] = answerItem(r.items[0], "text_match", "found", t1);
  r.items[0] = answerItem(r.items[0], "image_description", "looks_like", t1);
  r.items[0] = commitItem(r.items[0], false, t2);
  r.updated_at = t2;
  return r;
}
const pending = { context: "pending", terminology: "pending", attribution: "pending", medical_pairing: "pending" };

test("frozen ZIP and manifest hashes, all 286 exact fragments, and static copy remain bound", async () => {
  assert.equal(hash(await readFile(zip)), ZIP_SHA256);
  assert.equal(hash(await readFile(join(frozen, "manifest.json"))), MANIFEST_SHA256);
  assert.deepEqual(await readFile(join(destination, "pack-manifest.json")), manifestRaw);
  assertPack(pack);
  assert.equal(pack.pack_id, PACK_ID);
  assert.equal(pack.fragments.length, 286);
  const sourceText = canonical(pack);
  const r = fresh(); r.items[0].note = "<script>source must stay literal</script>";
  assert.equal(canonical(pack), sourceText);
  for (const paper of pack.papers) assert.equal(hash(await readFile(join(destination, paper.pack_pdf))), paper.pdf_sha256);
  const figures = pack.figures.flatMap(f => f.assets);
  assert.equal(figures.length, 1);
  for (const figure of figures) assert.equal(hash(await readFile(join(destination, figure.pack_path))), figure.sha256);
});

test("all 30 baseline and 10 risk arms retain actual record versions and fingerprints", () => {
  const result = fresh();
  assert.equal(result.items.length, 35);
  assert.equal(itemsForPack(pack).length, 35);
  assert.deepEqual(counts(result.items), { recorded: 0, deferred: 0, unseen: 35 });
  for (const item of result.items) {
    const source = item.kind === "random" ? pack.random_samples.find(s => s.id === item.id) : pack.risks.find(s => s.id === item.id);
    assert.equal(item.source_binding.job_id, source.job_id);
    for (const arm of item.kind === "random" ? ["baseline"] : ["before", "after"]) {
      const view = arm === "baseline" ? source.view : source[arm];
      const binding = item.source_binding[arm];
      assert.deepEqual(binding, {
        record_id: view.record_id, record_version: view.record_version, source_record_sha256: view.source_record_sha256,
        text_fingerprint: view.text_fingerprint, delivery_fingerprint: view.delivery_fingerprint,
        text_version: view.text_version, file_sha256: view.file_sha256,
      });
    }
  }
});

test("ordinary observations require explicit record action; drafts and untouched questions never count", () => {
  let result = fresh();
  const untouched = canonical(result.items.slice(1));
  result.items[0] = answerItem(result.items[0], "text_match", "found", t1);
  assert.equal(canRecord(result.items[0]), false);
  assert.throws(() => commitItem(result.items[0], false, t2));
  assert.deepEqual(counts(result.items), { recorded: 0, deferred: 0, unseen: 35 });
  result.items[0] = answerItem(result.items[0], "image_description", "looks_like", t1);
  result.items[0] = commitItem(result.items[0], false, t2);
  assert.deepEqual(counts(result.items), { recorded: 1, deferred: 0, unseen: 34 });
  assert.equal(canonical(result.items.slice(1)), untouched);
  assert.equal(result.items[0].recorded_at, t2);
  assert.equal(result.items[0].answer_times.text_match, t1);
  assert.equal(result.items[0].answer_times.figure_match, null);
  assert.equal(result.items[0].answers.figure_match, "not_checked");
  result.items[0] = answerItem(result.items[0], "text_match", "problem", t2);
  assert.equal(result.items[0].disposition, "draft");
  assert.equal(result.items[0].recorded_at, null);
});

test("one-click defer affects only current item, keeps professional and approval boundaries pending", () => {
  const result = fresh();
  result.items[0] = commitItem(result.items[0], true, t1);
  assert.deepEqual(counts(result.items), { recorded: 0, deferred: 1, unseen: 34 });
  assert.equal(result.items[1].updated_at, null);
  assert.equal(result.items[0].reviewer_role, "non_medical_user");
  assert.deepEqual(result.items[0].professional_review, pending);
  result.items = result.items.map(item => commitItem(item, true, t2));
  assert.deepEqual(counts(result.items), { recorded: 0, deferred: 35, unseen: 0 });
  assert.deepEqual(validateResults(result, pack), result);
  assert.deepEqual(result.professional_review, pending);
  assert.equal(result.medical_quality_approved, false);
  assert.equal(result.product_export_approved, false);
  assert.equal(result.stage_passed, false);
});

test("uncertain observation routes to expert count while random and risk remain separate", () => {
  const result = recorded();
  result.items[0] = answerItem(result.items[0], "text_match", "uncertain", t1);
  result.items[0] = commitItem(result.items[0], false, t2);
  const risk = result.items.findIndex(item => item.kind === "risk");
  result.items[risk] = answerItem(result.items[risk], "risk_notice", "no_obvious_problem", t1);
  result.items[risk] = commitItem(result.items[risk], false, t2);
  assert.equal(needsExpert(result.items[0]), true);
  assert.deepEqual(counts(result.items.filter(item => item.kind === "random")), { recorded: 0, deferred: 1, unseen: 29 });
  assert.deepEqual(counts(result.items.filter(item => item.kind === "risk")), { recorded: 1, deferred: 0, unseen: 4 });
  assert.equal(result.stage_passed, false);
});

test("valid export/import round trip preserves explicit answers, notes and real per-question times", () => {
  const result = recorded();
  result.items[0].note = "只做普通观察，专业内容看不懂。\n<svg onload=alert(1)>";
  result.exported_at = t2;
  const text = JSON.stringify(result);
  assert.deepEqual(parseResults(text, pack), result);
  assert.equal(result.reviewer_role, "non_medical_user");
  assert.equal(result.items[0].answers.risk_notice, null);
  assert.equal(result.items[0].source_binding.before, null);
});

test("imports reject mismatched packs, questionnaire, exact version bindings, duplicates and source injection", () => {
  const valid = recorded();
  const unchanged = canonical(valid);
  const edits = [
    r => { r.pack_id = "wrong"; }, r => { r.questionnaire_version = "older"; }, r => { r.items.pop(); },
    r => { r.items[1] = clone(r.items[0]); }, r => { r.items[0].id = "outside"; },
    r => { r.items[0].source_binding.baseline.record_version++; },
    r => { r.items[0].source_binding.baseline.delivery_fingerprint = "wrong"; },
    r => { r.items[30].source_binding.before.record_version++; },
    r => { r.items[30].source_binding.after.source_record_sha256 = "wrong"; },
    r => { r.items[0].original_quote = "fabricated"; },
    r => { r.items[0].source_binding.baseline.original_quote = "fabricated"; },
    r => { r.items[0].answers.text_match = "approved"; },
  ];
  for (const edit of edits) { const invalid = clone(valid); edit(invalid); assert.throws(() => validateResults(invalid, pack)); }
  assert.equal(canonical(valid), unchanged);
});

test("imports cannot upgrade medical/product/stage approval or impersonate a professional role", () => {
  const edits = [
    r => { r.medical_quality_approved = true; }, r => { r.product_export_approved = true; }, r => { r.stage_passed = true; },
    r => { r.reviewer_role = "doctor"; }, r => { r.items[0].reviewer_role = "medical_expert"; },
    r => { r.professional_review.context = "approved"; }, r => { r.items[0].professional_review.medical_pairing = "approved"; },
    r => { r.items[0].medical_quality_approved = true; }, r => { r.human_approved = true; },
  ];
  for (const edit of edits) { const invalid = recorded(); edit(invalid); assert.throws(() => validateResults(invalid, pack)); }
});

test("imports reject missing action times, invalid time values, cross-type answers, corrupt and oversized JSON", () => {
  const edits = [
    r => { r.items[0].answer_times.text_match = null; }, r => { r.items[0].recorded_at = null; },
    r => { r.items[0].answer_times.text_match = "2026-11-31T00:00:00.000Z"; },
    r => { r.items[0].answers.risk_notice = "uncertain"; r.items[0].answer_times.risk_notice = t1; },
    r => { r.items[0].answers.figure_match = "looks_matched"; r.items[0].answer_times.figure_match = t1; },
    r => { r.items[1].note = "draft note"; }, r => { r.items[0].note = "x".repeat(4001); },
  ];
  for (const edit of edits) { const invalid = recorded(); edit(invalid); assert.throws(() => validateResults(invalid, pack)); }
  assert.throws(() => parseResults("{broken", pack));
  assert.throws(() => parseResults("x".repeat(2_000_001), pack));
});

function memoryStorage(start = null) { let value = start; return { getItem: () => value, setItem: (_key, next) => { value = next; }, value: () => value }; }
const saved = (results, revision = 1, writer = "tab-a") => ({ storage_schema: "output-review-browser-1", revision, writer_id: writer, saved_at: t2, results });

test("browser persistence verifies read-back and can restore exact isolated pack/questionnaire state", () => {
  const storage = memoryStorage();
  const key = storageKey(pack);
  assert.ok(key.includes(PACK_ID)); assert.ok(key.includes("ordinary-screening-2026-11-05-v1"));
  const raw = saveUnchanged(storage, key, null, saved(recorded()));
  assert.equal(storage.value(), raw);
  assert.deepEqual(parseSaved(raw, pack).results, recorded());
  assert.throws(() => parseSaved(JSON.stringify({ ...saved(recorded()), revision: -1 }), pack));
  assert.throws(() => parseSaved("broken", pack));
  assert.throws(() => saveUnchanged({ getItem: () => null, setItem: () => undefined }, key, null, saved(recorded())), ProgressConflict);
});

test("quota and disabled storage failures never report success or replace previous saved progress", () => {
  const existing = JSON.stringify(saved(fresh()));
  let raw = existing;
  const quota = { getItem: () => raw, setItem: () => { throw new Error("QuotaExceededError"); } };
  assert.throws(() => saveUnchanged(quota, storageKey(pack), existing, saved(recorded(), 2)), /QuotaExceededError/);
  assert.equal(raw, existing);
  const disabled = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("must not write"); } };
  assert.throws(() => saveUnchanged(disabled, storageKey(pack), null, saved(recorded())), /SecurityError/);
});

test("a stale tab cannot silently overwrite a newer saved revision", () => {
  const storage = memoryStorage(); const key = storageKey(pack);
  const first = saveUnchanged(storage, key, null, saved(fresh()));
  const second = saveUnchanged(storage, key, first, saved(recorded(), 2, "tab-b"));
  assert.throws(() => saveUnchanged(storage, key, first, saved(fresh(), 2, "tab-a")), ProgressConflict);
  assert.equal(storage.value(), second);
  assert.deepEqual(parseSaved(storage.value(), pack).results, recorded());
});

test("rebuild retains unknown user files and reuses the original pi-web ImagePreview without modifying it", async () => {
  const sentinel = join(destination, ".unit-user-result-retention.json");
  assert.equal(existsSync(sentinel), false);
  const originalComponent = await readFile(resolve(here, "../components/ImagePreview.tsx"));
  const userFeedbackPath = join(destination, "普通用户初筛-cc939653-2026-11-05T06-08-53.json");
  const userFeedback = await readFile(userFeedbackPath);
  try {
    await writeFile(sentinel, '{"ordinary_user_backup":"keep"}\n', { flag: "wx" });
    execFileSync(process.execPath, [join(here, "build.mjs")], { cwd: code });
    assert.equal(await readFile(sentinel, "utf8"), '{"ordinary_user_backup":"keep"}\n');
    assert.deepEqual(await readFile(resolve(here, "../components/ImagePreview.tsx")), originalComponent);
    assert.deepEqual(await readFile(userFeedbackPath), userFeedback);
    assert.equal(hash(userFeedback), "e53f669c7086761f9d0ef209448979aae488068c7b1e2a80d1f5590e422b6a28");
    const info = JSON.parse(await readFile(join(destination, "build-info.json"), "utf8"));
    assert.ok(info.reused_component.includes("components/ImagePreview.tsx"));
    assert.equal(info.paid_calls, 0);
    assert.equal(info.artifact_sha256["pack-manifest.json"], hash(manifestRaw));
    assert.equal(hash(await readFile(zip)), ZIP_SHA256);
  } finally { await unlink(sentinel); }
});
