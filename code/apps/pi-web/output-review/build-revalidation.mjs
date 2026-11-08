import { build } from "../../../node_modules/esbuild/lib/main.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { partialRecords, safeAssetPath, validateReaderManifest } from "./revalidation-model.ts";

const source = dirname(fileURLToPath(import.meta.url)), app = resolve(source, ".."), code = resolve(app, "../..");
const destination = join(app, "public/output-review");
const acceptance = join(code, "docs/acceptance/user-feedback-2026-11-05/revalidation");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const manifestBytes = await readFile(join(acceptance, "final-two-rounds/reader-manifest.json"));
if (sha(manifestBytes) !== "a296a9e3ff6e8834073b7ed85ef72732b2a6fbf7d3d277f70e46502d6332685e") throw new Error("两轮定版实际清单SHA不符，未生成阅读入口");
const manifest = validateReaderManifest(JSON.parse(manifestBytes));
const frozen = [];
for (const freeze of manifest.freeze_plans) {
  const plan = JSON.parse(await readFile(join(code, freeze.plan_path), "utf8"));
  for (const [path, hash] of Object.entries(plan.source_hashes)) {
    const absolute = join(code, freeze.source_root, path);
    if (sha(await readFile(absolute)) !== hash) throw new Error(`轮次冻结源码快照发生变化：${freeze.round_id}/${path}`);
    frozen.push([absolute, hash]);
  }
}
const artifacts = new Map();
const actualDeliveryRecords = [];
for (const artifact of manifest.source_artifacts) {
  const bytes = await readFile(join(code, artifact.path));
  if (sha(bytes) !== artifact.sha256) throw new Error(`实际产物指纹不符：${artifact.path}`);
  artifacts.set(artifact.path, artifact.sha256);
  if (artifact.path.startsWith("docs/acceptance/user-feedback-2026-11-05/revalidation/") && artifact.path.endsWith("/delivery.json") && !/counterfactual|offline|tool-failure-reproduction/.test(artifact.path)) {
    const delivery = JSON.parse(bytes);
    for (const record of delivery.records ?? []) actualDeliveryRecords.push(record);
  }
}
function assertActualPartition(groups, fragments) {
  const segments = groups.flatMap(group => group.segments);
  let index = 0;
  for (const fragment of fragments) {
    let cursor = fragment.start, text = "";
    while (cursor < fragment.end) {
      const part = segments[index++];
      if (!part || part.block_id !== fragment.block_id || part.text_version !== fragment.text_version || part.start !== cursor || part.end > fragment.end
        || part.physical_page !== fragment.physical_page || JSON.stringify(part.bbox) !== JSON.stringify(fragment.bbox)) throw new Error("阅读句段与本轮实际delivery定位不符");
      text += part.exact_quote; cursor = part.end;
    }
    if (text !== fragment.exact_quote) throw new Error("阅读句段修改了本轮实际delivery原文");
  }
  if (index !== segments.length) throw new Error("阅读句段增加了实际delivery中没有的文字");
}
const allActualReaderRecords = [...manifest.records, ...partialRecords(manifest)];
for (const record of allActualReaderRecords) {
  const actual = actualDeliveryRecords.find(value => value.record_id === record.record_id && value.record_version === record.record_version && value.source_record_sha256 === record.source_record_sha256 && value.document_id === record.document_id);
  if (!actual) throw new Error(`新候选无法追溯到真实delivery：${record.record_id}`);
  assertActualPartition(record.original_groups, actual.original_fragments);
  assertActualPartition(record.context_groups, actual.context_fragments);
}
for (const actual of actualDeliveryRecords) if (!allActualReaderRecords.some(record => record.record_id === actual.record_id && record.record_version === actual.record_version && record.source_record_sha256 === actual.source_record_sha256)) throw new Error(`阅读材料遗漏了实际delivery记录：${actual.record_id}`);
const userBytes = await readFile(join(destination, "普通用户初筛-cc939653-2026-11-05T06-08-53.json"));
if (sha(userBytes) !== "e53f669c7086761f9d0ef209448979aae488068c7b1e2a80d1f5590e422b6a28") throw new Error("旧用户反馈指纹不符");
const oldNotes = new Map(JSON.parse(userBytes).items.filter(item => item.note.length > 0).map(item => [item.id, item.note]));
if (manifest.issues.length !== oldNotes.size || manifest.issues.some(issue => oldNotes.get(issue.old_item_id) !== issue.old_note)) throw new Error("旧11条原备注对照不符");
for (const paper of manifest.papers) if (sha(await readFile(join(destination, paper.pdf_path))) !== paper.pdf_sha256) throw new Error(`原PDF指纹不符：${paper.document_id}`);

const protectedNames = ["index.html", "review.js", "review.css", "pack-manifest.json", "source-groups.json", "普通用户初筛-cc939653-2026-11-05T06-08-53.json", "pdf/L01.pdf", "pdf/L05.pdf"];
const protectedBefore = new Map(await Promise.all(protectedNames.map(async path => [path, sha(await readFile(join(destination, path)))])));
// New files only: never rebuild the old page or recursively clear this directory.
const copies = [];
for (const figure of manifest.figures) for (const asset of figure.assets) {
  if (asset.source_path) {
    if (!safeAssetPath(asset.source_path) || !asset.pack_path.startsWith("revalidation-assets/")) throw new Error("新整图只能复制到本轮独立资源目录");
    const target = resolve(destination, asset.pack_path);
    if (!target.startsWith(destination + sep)) throw new Error("图路径越界");
    const bytes = await readFile(join(code, asset.source_path));
    if (sha(bytes) !== asset.sha256) throw new Error(`实际整图指纹不符：${asset.source_path}`);
    copies.push({ target, bytes });
  } else if (sha(await readFile(join(destination, asset.pack_path))) !== asset.sha256) throw new Error(`复用整图指纹不符：${asset.pack_path}`);
}
const dataName = `revalidation-data-${sha(manifestBytes).slice(0, 12)}.json`;
await mkdir(destination, { recursive: true });
for (const { target, bytes } of copies) { await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes); }
await writeFile(join(destination, dataName), manifestBytes);
const result = await build({ absWorkingDir: app, entryPoints: [join(source, "revalidation.tsx")], outfile: join(destination, "revalidation.js"),
  bundle: true, minify: true, format: "esm", platform: "browser", target: ["chrome111", "firefox111", "safari16.2"], jsx: "automatic", legalComments: "inline",
  alias: { "@/hooks/useI18n": join(source, "static-i18n.ts") }, external: ["./fonts/*"], define: { "process.env.NODE_ENV": '"production"' }, metafile: true });
if (!Object.keys(result.metafile.inputs).some(path => path.endsWith("components/ImagePreview.tsx"))) throw new Error("原ImagePreview未复用");
await writeFile(join(destination, "revalidation.html"), `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="google" content="notranslate"><meta name="t1-revalidation-manifest" content="${dataName}"><title>真实复验 · 原文与问题对照</title><link rel="stylesheet" href="./revalidation.css"></head><body><div id="revalidation-app"><p class="startup-error">正在载入本轮定版实际结果…</p></div><noscript>需要启用JavaScript才能阅读和定位原PDF。</noscript><script type="module" src="./revalidation.js"></script></body></html>\n`);
for (const [path, hash] of protectedBefore) if (sha(await readFile(join(destination, path))) !== hash) throw new Error(`旧页面或原材料被改动：${path}`);
for (const [path, hash] of artifacts) if (sha(await readFile(join(code, path))) !== hash) throw new Error(`实际产物构建期间变化：${path}`);
for (const [path, hash] of frozen) if (sha(await readFile(path)) !== hash) throw new Error(`轮次冻结快照构建期间变化：${path}`);
const authored = ["revalidation-model.ts", "revalidation.tsx", "revalidation.css", "build-revalidation.mjs", "pdf-viewer.tsx", "../components/ImagePreview.tsx"];
await writeFile(join(destination, "revalidation-build.json"), JSON.stringify({ schema_version: "feedback-revalidation-reader-build-1", generated_at: new Date().toISOString(),
  batch_id: manifest.batch_id, manifest_file: dataName, manifest_sha256: sha(manifestBytes), finalized_actual_outputs: true,
  source_sha256: Object.fromEntries(await Promise.all(authored.map(async path => [path, sha(await readFile(join(source, path)))]))),
  artifact_sha256: Object.fromEntries(await Promise.all(["revalidation.html", "revalidation.js", "revalidation.css", dataName].map(async path => [path, sha(await readFile(join(destination, path)))]))),
  copied_original_images: copies.length, frozen_runtime_sources_checked: frozen.length, old_page_and_feedback_bytes_unchanged: true,
  representative_records: manifest.records.length, partial_attempt_records: partialRecords(manifest).length,
  paid_calls_by_frontend: 0, actual_new_human_reviews: 0, medical_quality_approved: false, stage_passed: false,
}, null, 2) + "\n");
process.stdout.write(`本轮实际复验阅读入口已生成：${join(destination, "revalidation.html")}\n数据：${dataName}；未覆盖旧入口、旧35条反馈或冻结材料。\n`);
