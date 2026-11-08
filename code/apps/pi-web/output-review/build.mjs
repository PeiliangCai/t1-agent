import { build } from "../../../node_modules/esbuild/lib/main.js";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSourceGroups } from "./source-groups.ts";

const source = dirname(fileURLToPath(import.meta.url));
const app = resolve(source, "..");
const code = resolve(app, "../..");
const destination = join(app, "public/output-review");
const frozen = join(code, "docs/acceptance/s0-s4-current-2026-11-04/output-review-pack-2026-11-05");
const zip = join(frozen, "真实输出人工核验包.zip");
const groupingSource = join(code, "docs/acceptance/user-feedback-2026-11-05/source-groups.json");
const sha = value => createHash("sha256").update(value).digest("hex");
const expected = {
  zip: "4e52ce034979bbad2777e66a88f69879e9b43cf6ae7883e88da5cf43f192b5fd",
  manifest: "9c88aede860464d5e32a53596e45e2e752ff8d290bc6244049aa6a7c9c76f80c",
  pack: "cc939653193b71c047cdc1e3314f923b234ebef7aefbfaf2f8cbf9adfa20845f",
};

if (sha(await readFile(zip)) !== expected.zip || sha(await readFile(join(frozen, "manifest.json"))) !== expected.manifest) throw new Error("冻结核验包SHA不匹配，停止构建；未更新源材料");
await mkdir(destination, { recursive: true });
// Only overwrite this builder's explicitly generated files. Never recursively remove
// the destination: users may place their exported results or other files beside it.
const extraction = String.raw`
import hashlib,json,pathlib,sys,zipfile
src,dest,packid=sys.argv[1:]
allowed=['pack-manifest.json','pdf/L01.pdf','pdf/L05.pdf','figures/L05-figure-616ca126ac6d24e11b1329fa-0.png']
with zipfile.ZipFile(src) as z:
  m=json.loads(z.read('pack-manifest.json'))
  assert m['pack_id']==packid and len(m['random_samples'])==30 and len(m['risks'])==5
  for name in allowed:
    data=z.read(name)
    if name.startswith('pdf/'):
      paper=next(p for p in m['papers'] if p['pack_pdf']==name)
      assert hashlib.sha256(data).hexdigest()==paper['pdf_sha256']
    if name.startswith('figures/'):
      asset=next(a for f in m['figures'] for a in f['assets'] if a['pack_path']==name)
      assert hashlib.sha256(data).hexdigest()==asset['sha256']
    target=pathlib.Path(dest,name); target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(data)
print(json.dumps({'copied':allowed,'pack_id':m['pack_id'],'fragments':len(m['fragments'])}))
`;
const extracted = JSON.parse(execFileSync("python3", ["-c", extraction, zip, destination, expected.pack], { encoding: "utf8" }));
const groupingBytes = await readFile(groupingSource);
const frozenPack = JSON.parse(await readFile(join(destination, "pack-manifest.json"), "utf8"));
validateSourceGroups(JSON.parse(groupingBytes), frozenPack);
await writeFile(join(destination, "source-groups.json"), groupingBytes);
const pdfjs = join(app, "node_modules/pdfjs-dist");
await mkdir(join(destination, "pdfjs"), { recursive: true });
await copyFile(join(pdfjs, "legacy/build/pdf.worker.min.mjs"), join(destination, "pdfjs/pdf.worker.min.mjs"));
for (const folder of ["cmaps", "standard_fonts", "wasm"]) await cp(join(pdfjs, folder), join(destination, "pdfjs", folder), { recursive: true, force: true });
await copyFile(join(pdfjs, "LICENSE"), join(destination, "pdfjs/LICENSE"));
await mkdir(join(destination, "fonts"), { recursive: true });
for (const name of ["noto-cjk.woff2", "OFL.txt"]) await copyFile(join(app, "public/t1-assets/fonts", name), join(destination, "fonts", name));

const result = await build({
  absWorkingDir: app,
  entryPoints: [join(source, "main.tsx")], outfile: join(destination, "review.js"), bundle: true, minify: true,
  format: "esm", platform: "browser", target: ["chrome111", "firefox111", "safari16.2"], jsx: "automatic", legalComments: "inline",
  alias: { "@/hooks/useI18n": join(source, "static-i18n.ts") },
  external: ["./fonts/*"],
  define: { "process.env.NODE_ENV": '"production"' }, metafile: true,
});
if (!Object.keys(result.metafile.inputs).some(path => path.endsWith("components/ImagePreview.tsx"))) throw new Error("现有ImagePreview未进入静态bundle");
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="google" content="notranslate"><title>真实输出 · 简单核验</title><link rel="stylesheet" href="./review.css"></head>
<body><div id="app"><p data-testid="loading" class="startup-error">正在载入核验材料…</p></div><noscript>需要在浏览器中启用JavaScript才能记录与导出初筛意见。</noscript><script type="module" src="./review.js"></script></body></html>\n`;
await writeFile(join(destination, "index.html"), html);
const licenseFiles = [join(app, "LICENSE"), join(app, "node_modules/react/LICENSE"), join(app, "node_modules/react-dom/LICENSE")];
const licenses = await Promise.all(licenseFiles.map(async path => `${path.includes("react-dom") ? "React DOM" : path.includes("react/") ? "React" : "Pi Web (ImagePreview and theme tokens)"}\n\n${await readFile(path, "utf8")}`));
await writeFile(join(destination, "LICENSES.txt"), licenses.join("\n\n--------------------\n\n"));
const authored = ["types.ts", "model.ts", "storage.ts", "source-groups.ts", "static-i18n.ts", "pdf-viewer.tsx", "main.tsx", "review.css", "build.mjs"];
const source_sha256 = Object.fromEntries(await Promise.all(authored.map(async path => [path, sha(await readFile(join(source, path)))])));
source_sha256["../components/ImagePreview.tsx"] = sha(await readFile(join(app, "components/ImagePreview.tsx")));
const artifacts = ["index.html", "review.js", "review.css", "pack-manifest.json", "source-groups.json", "pdf/L01.pdf", "pdf/L05.pdf", "figures/L05-figure-616ca126ac6d24e11b1329fa-0.png", "pdfjs/pdf.worker.min.mjs", "fonts/noto-cjk.woff2", "fonts/OFL.txt", "LICENSES.txt"];
const artifact_sha256 = Object.fromEntries(await Promise.all(artifacts.map(async path => [path, sha(await readFile(join(destination, path)))])));
await writeFile(join(destination, "build-info.json"), JSON.stringify({
  schema_version: "output-review-static-build-1", generated_at: new Date().toISOString(), frozen_zip_sha256: expected.zip,
  frozen_manifest_sha256: expected.manifest, pack_id: expected.pack, questionnaire_version: "ordinary-screening-2026-11-05-v1",
  random_count: 30, risk_count: 5, fragments: extracted.fragments, paid_calls: 0,
  source_sha256, artifact_sha256, reused_component: "components/ImagePreview.tsx (original unchanged)",
  i18n_adapter: "output-review/static-i18n.ts (standalone Chinese only; does not modify pi-web locale preferences)",
  pdfjs: "6.5.438 legacy build; local worker/cmaps/standard_fonts/wasm; main-thread rendering; no CDN",
  chinese_font: "Existing pi-web Noto CJK WOFF2 with OFL license, copied for systems without Chinese fonts",
  rebuild_policy: "Only generated named assets are overwritten; unknown files and user exports are retained",
  source_grouping: { source: "docs/acceptance/user-feedback-2026-11-05/source-groups.json", sha256: sha(groupingBytes),
    policy: "Only partition frozen exact spans; no added source text; original pack and questionnaire bindings remain unchanged" },
  medical_quality_approved: false, product_export_approved: false, stage_passed: false,
}, null, 2) + "\n");
process.stdout.write(`静态页面已生成：${destination}/index.html\n冻结30随机+5风险，286独立片段；原PDF/整图逐字节复制；ImagePreview原件已进入bundle。\n`);
