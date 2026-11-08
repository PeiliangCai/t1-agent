/** Build only the independent post-fix static reader from an explicitly bound final manifest. */
import { build } from "../../../node_modules/esbuild/lib/main.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assetPath, figureAssets, safeRelativePath, sha256Value, validateReliabilityManifest, versionCount } from "./reliability-model.ts";

const source = dirname(fileURLToPath(import.meta.url)), app = resolve(source, ".."), code = resolve(app, "../..");
const destination = join(app, "public/output-review"), acceptance = join(code, "docs/acceptance/s4-reliability-2026-11-05/live-revalidation");
const frontend = join(acceptance, "frontend"), sha = bytes => createHash("sha256").update(bytes).digest("hex");
const expectedManifestSha = process.argv[2];
if (!sha256Value(expectedManifestSha)) throw new Error("必须显式提供核心封存的reader-manifest.json SHA256；未生成页面");
const manifestBytes = await readFile(join(acceptance, "reader-manifest.json"));
assert.equal(sha(manifestBytes), expectedManifestSha, "定版清单SHA不符，未生成页面");
const manifest = validateReliabilityManifest(JSON.parse(manifestBytes));
const reportPath = "docs/acceptance/s4-reliability-2026-11-05/live-revalidation/report.json";
const expectedReportSha = "390cea6385ae3fd35a26ce8672c95b903438cd6894eab6aac78de2312b3d1f96";
const sealedBytes = await readFile(join(acceptance, "sealed-artifacts.json")), sealed = JSON.parse(sealedBytes);
assert.equal(sealed.reader_manifest_sha256, expectedManifestSha, "封存证据与清单不符");
assert.equal(sealed.report_sha256, expectedReportSha, "封存证据与审计报告不符");
const oldFiles = JSON.parse(await readFile(join(frontend, "protected-before.json"), "utf8")).sha256;
const freeze = JSON.parse(await readFile(join(code, "docs/acceptance/s4-reliability-2026-11-05/source-freeze.json"), "utf8"));
const frozen = Object.fromEntries(Object.entries(freeze.frozen_current_sources).map(([path, values]) => [path, values.expected]));
const sources = new Map();
async function verifyFiles(files) { for (const [path, expected] of Object.entries(files)) assert.equal(sha(await readFile(join(code, path))), expected, `受保护文件变化：${path}`); }
await verifyFiles(oldFiles); await verifyFiles(frozen);
await verifyFiles(sealed.artifacts);
async function addSource(path, expected) {
  assert.ok(safeRelativePath(path) && sha256Value(expected), "证据路径或指纹无效");
  const bytes = await readFile(join(code, path));
  assert.equal(sha(bytes), expected, `实际产物指纹不符：${path}`);
  sources.set(path, bytes);
}
for (const artifact of manifest.artifacts) await addSource(artifact.path, artifact.sha256);
await addSource(reportPath, expectedReportSha);
for (const job of manifest.jobs) {
  for (const key of ["result", "delivery", "summary"]) await addSource(job[`${key}_path`], job[`${key}_sha256`]);
  for (const attempt of job.batch_attempts) await addSource(attempt.result_path, attempt.result_sha256);
  for (const attempt of job.summary.summary_attempts ?? []) {
    const path = isAbsolute(attempt.path) ? relative(code, attempt.path) : attempt.path;
    assert.ok(sealed.artifacts[path], "汇总尝试缺少封存指纹");
    await addSource(path, sealed.artifacts[path]);
  }
}
// All identities, all versions and all literal record payloads must agree with actual run results.
for (const job of manifest.jobs) {
  assert.ok(sources.has(job.result_path), "运行结果没有列入定版指纹");
  const actual = JSON.parse(sources.get(job.result_path));
  const entries = manifest.records.filter(entry => entry.job_id === job.job_id);
  assert.equal(entries.length, actual.records.length, `候选身份有遗漏：${job.job_id}`);
  assert.equal(entries.reduce((sum, entry) => sum + entry.versions.length, 0), actual.versions.length, `版本有遗漏：${job.job_id}`);
  assert.deepEqual(job.coverage, actual.coverage, `覆盖范围被改写：${job.job_id}`);
  for (const entry of entries) {
    const current = actual.records.find(envelope => envelope.record.record_id === entry.record_id && envelope.version === entry.current_version);
    assert.ok(current, `当前候选来源缺失：${entry.entry_id}`);
    assert.deepEqual(entry.current.record, current.record, "当前候选正文被改写");
    for (const version of entry.versions) {
      const original = actual.versions.find(envelope => envelope.record.record_id === entry.record_id && envelope.version === version.version);
      assert.ok(original, `原始版本来源缺失：${entry.entry_id}:v${version.version}`);
      for (const key of ["record", "version", "actor", "status", "created_at", "reason"]) assert.deepEqual(version[key], original[key], `实际版本被改写：${key}`);
      if (version.source_record_sha256) assert.equal(sha(Buffer.from(JSON.stringify(version.record))), version.source_record_sha256, "源记录指纹不符");
    }
  }
}
for (const paper of manifest.papers) {
  const bytes = await readFile(join(destination, paper.public_pdf_path));
  assert.equal(sha(bytes), paper.pdf_sha256, "复用原PDF指纹不符");
}
const copies = [], evidence = {};
for (const figure of manifest.figures) for (const asset of figureAssets(figure)) {
  const publicPath = assetPath(asset);
  if (!publicPath) continue;
  if (publicPath.startsWith("reliability-assets/")) {
    const path = asset.source_path ?? asset.path;
    assert.ok(safeRelativePath(path), "新图资源缺少来源路径");
    const bytes = await readFile(join(code, path));
    assert.equal(sha(bytes), asset.sha256, "新图资源指纹不符"); copies.push([publicPath, bytes]);
  } else assert.equal(sha(await readFile(join(destination, publicPath))), asset.sha256, "复用原图指纹不符");
}
for (const [path, bytes] of sources) {
  // The full finalized result retains errors and tool events. Databases and runtime sources stay in place.
  if (!/\.(?:json|log)$/.test(path) || !path.startsWith("docs/acceptance/s4-reliability-2026-11-05/")) continue;
  const target = `reliability-evidence/${path}`;
  evidence[path] = target; copies.push([target, bytes]);
}
const dataName = `reliability-data-${expectedManifestSha.slice(0, 12)}.json`;
evidence.__manifest = dataName;
evidence.__report = evidence[reportPath];
for (const [path, bytes] of copies) {
  assert.ok(safeRelativePath(path), "静态资源路径无效");
  const target = resolve(destination, path);
  assert.ok(target.startsWith(destination + sep), "静态资源路径越界");
  assert.ok(!oldFiles[`apps/pi-web/public/output-review/${path}`], "不允许覆盖旧资源");
  await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes);
}
await writeFile(join(destination, dataName), manifestBytes);
await writeFile(join(destination, "reliability-evidence-map.json"), JSON.stringify(evidence, null, 2) + "\n");
const result = await build({ absWorkingDir: app, entryPoints: [join(source, "reliability.tsx")], outfile: join(destination, "reliability.js"),
  bundle: true, minify: true, format: "esm", platform: "browser", target: ["chrome111", "firefox111", "safari16.2"], jsx: "automatic", legalComments: "inline",
  alias: { "@/hooks/useI18n": join(source, "static-i18n.ts") }, external: ["./fonts/*"], define: { "process.env.NODE_ENV": '"production"' }, metafile: true });
assert.ok(Object.keys(result.metafile.inputs).some(path => path.endsWith("components/ImagePreview.tsx")), "未复用原图查看组件");
assert.ok(Object.keys(result.metafile.inputs).some(path => path.endsWith("output-review/pdf-viewer.tsx")), "未复用原PDF组件");
await writeFile(join(destination, "reliability.html"), `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="google" content="notranslate"><meta name="t1-reliability-manifest" content="${dataName}"><meta name="t1-reliability-evidence" content="reliability-evidence-map.json"><title>工程修复后 · 两组集成复验</title><link rel="icon" href="data:,"><link rel="stylesheet" href="./reliability.css"></head><body><div id="reliability-app"><p class="startup-error">正在载入工程修复后定版真实结果…</p></div><noscript>需要启用JavaScript才能阅读版本与定位原PDF。</noscript><script type="module" src="./reliability.js"></script></body></html>\n`);
await verifyFiles(oldFiles); await verifyFiles(frozen);
await verifyFiles(sealed.artifacts);
for (const [path, bytes] of sources) assert.equal(sha(await readFile(join(code, path))), sha(bytes), "实际产物构建期间变化");
assert.equal(sha(await readFile(join(acceptance, "reader-manifest.json"))), expectedManifestSha, "定版清单构建期间变化");
const authored = ["reliability-model.ts", "reliability.tsx", "reliability.css", "build-reliability.mjs", "pdf-viewer.tsx", "../components/ImagePreview.tsx"];
const delivery = ["reliability.html", "reliability.js", "reliability.css", "reliability-evidence-map.json", dataName, ...copies.map(([path]) => path)];
const receipt = { schema_version: "s4-reliability-reader-build-1", built_at: new Date().toISOString(), batch_id: manifest.batch_id,
  manifest_path: "docs/acceptance/s4-reliability-2026-11-05/live-revalidation/reader-manifest.json", manifest_file: dataName, manifest_sha256: expectedManifestSha,
  report_path: reportPath, report_sha256: expectedReportSha, sealed_artifacts_sha256: sha(sealedBytes), sealed_artifacts_checked: Object.keys(sealed.artifacts).length,
  finalized_actual_outputs: true, candidate_identities: manifest.records.length, retained_versions: versionCount(manifest),
  frozen_runtime_sources_checked: Object.keys(frozen).length, protected_existing_files_checked: Object.keys(oldFiles).length,
  old_reader_and_review_data_unchanged: true, paid_calls_by_frontend: 0, new_human_reviews: 0, medical_quality_approved: false, product_export_approved: false,
  formal_reviews_inherited: "3/3; no additional formal review",
  source_sha256: Object.fromEntries(await Promise.all(authored.map(async path => [path, sha(await readFile(join(source, path)))]))),
  artifact_sha256: Object.fromEntries(await Promise.all(delivery.map(async path => [path, sha(await readFile(join(destination, path)))]))),
};
await writeFile(join(destination, "reliability-build.json"), JSON.stringify(receipt, null, 2) + "\n");
await writeFile(join(frontend, "build.json"), JSON.stringify(receipt, null, 2) + "\n");
process.stdout.write(`独立入口：${join(destination, "reliability.html")}\n真实候选身份${manifest.records.length} / 全部版本${versionCount(manifest)}；原静态页与审核数据指纹未变。\n`);
