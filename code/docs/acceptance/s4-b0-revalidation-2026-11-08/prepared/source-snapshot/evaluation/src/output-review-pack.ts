import { createHash } from 'node:crypto';
import { ContractError, type EvidenceVersion, type LocatedEvidenceFragment } from '@t1/contracts';
import { prepareOutputSample } from './output-sampling.js';
import { allDeliveredRecords, evidenceDigest, type DeliveredEvidence, type EvidenceDelivery } from '../../packages/agent/src/evidence-delivery.js';

export const REVIEW_PACK_SCHEMA = 'offline-output-review-pack-1';
export const REVIEW_PACK_METHOD = '每个实际提取任务内，以记录当前版本及完整交付指纹为单位，SHA-256固定种子排序后取前N条；定向风险另列。';
export const REVIEW_PACK_ALGORITHM = 'unit_id=JSON.stringify([job_id,record_id,record_version,delivery_fingerprint]); job_seed=seed+"/"+job_id; rank=SHA256(job_seed+U+0000+unit_id); ascending hexadecimal rank (existing prepareOutputSample), then first N. Selection is without replacement within each actual job.';

export function versionSelectionUnit(jobId: string, record: DeliveredEvidence): string {
  return JSON.stringify([jobId, record.record_id, record.record_version, record.delivery_fingerprint]);
}

/** Reuse the existing sampler, with an explicit version-bound selection identity. */
export function selectVersionedOutputSample(delivery: EvidenceDelivery, options: { jobId: string; count: number; seed: string }) {
  if (!options.jobId.trim()) throw new ContractError('review_pack_job_required');
  const allRecords = allDeliveredRecords(delivery);
  const units = new Map(allRecords.map(record => [versionSelectionUnit(options.jobId, record), record]));
  if (units.size !== allRecords.length) throw new ContractError('review_pack_duplicate_version_unit');
  const indexed = (record: DeliveredEvidence) => ({ ...record, record_id: versionSelectionUnit(options.jobId, record) });
  const selectionDelivery = { ...delivery, records: delivery.records.map(indexed),
    ...(delivery.background_records ? { background_records: delivery.background_records.map(indexed) } : {}) };
  const prepared = prepareOutputSample(selectionDelivery, { count: options.count, seed: `${options.seed}/${options.jobId}`, selectionMethod: REVIEW_PACK_METHOD });
  return {
    job_id: options.jobId, seed: `${options.seed}/${options.jobId}`, count: prepared.selected_count,
    sample_id: prepared.review_template.sample_id,
    records: prepared.selected_records.map(record => units.get(record.record_id)!),
    selection_units: prepared.selected_records.map(record => record.record_id),
    actual_human_reviewed_count: 0, product_export_approved: false, medical_quality_approved: false,
  };
}

export function currentEvidenceVersions(versions: readonly EvidenceVersion[]): Map<string, EvidenceVersion> {
  const current = new Map<string, EvidenceVersion>();
  for (const version of versions) {
    if (version.status === 'proposed') continue;
    const previous = current.get(version.record.record_id);
    if (previous?.version === version.version && evidenceDigest(previous.record) !== evidenceDigest(version.record)) {
      throw new ContractError('review_pack_conflicting_record_version');
    }
    if (!previous || version.version > previous.version) current.set(version.record.record_id, version);
  }
  return current;
}

/** Literal source identity only. This is never a human medical deduplication judgment. */
export function exactFragmentGroup(documentSha: string, textVersion: string, fragments: readonly LocatedEvidenceFragment[]) {
  return createHash('sha256').update(JSON.stringify([documentSha, textVersion,
    fragments.map(f => [f.block_id, f.start, f.end, f.exact_quote])])).digest('hex');
}

export interface PackFragment {
  fragment_id: string; owner_id: string; arm: string; role: string; ordinal: number;
  document_id: string; physical_page: number; block_id: string; text_version: string;
  start: number; end: number; exact_quote: string; bbox: number[] | null;
  location_precision: string; source_type: string; source_structure: string[];
  pdf_path: string; file_sha256: string;
}

export const packHtmlEscape = (value: unknown) => String(value ?? '').replace(/[&<>"']/gu,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export function renderReviewPackHtml(pack: Record<string, any>): string {
  const e = packHtmlEscape;
  const fragment = (f: PackFragment) => {
    const controls = [...f.exact_quote].flatMap((c, i) => /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u.test(c) ? [`码点偏移${i}:U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`] : []);
    return `<article class="fragment" id="${e(f.fragment_id)}"><p class="label">${e(f.role)} ${f.ordinal} · ${e(f.source_type)} · <a href="${e(f.pdf_path)}#page=${f.physical_page}">原PDF物理第${f.physical_page}页</a></p><pre>${e(f.exact_quote)}</pre>${controls.length ? '<p class="notice">源解析文本含控制字符，可能显示为空白或转义串。本包保留原始文本；请回看PDF原页核对，不能把控制字符当成已确认的论文文字。Office及其他表格软件的视觉显示尚未实机验证。</p>' : ''}<p class="small">片段独立保存，不能将不同框内文字当成连续原句。</p></article>`;
  };
  const ownerFragments = (owner: string, arm: string) => pack.fragments.filter((f: PackFragment) => f.owner_id === owner && f.arm === arm).map(fragment).join('');
  const metadata = (view: Record<string, any>) => `${view.primary_assessment ? '<p>' + (view.primary_assessment.effective_role === 'background_suggestion' ? '仅背景建议，未人工确认；不计独立主目标。' : '主目标候选，仍待核。') + '</p><pre>' + e(JSON.stringify(view.primary_assessment, null, 2)) + '</pre>' : ''}<details><summary>模型字段与自动待核提示（均未获人工确认）</summary><pre>${e(JSON.stringify(view.fields, null, 2))}</pre><p>图文自动状态：${e(view.figure_status_label)}；${e(view.figure_association.reasons.join(' '))}</p></details>`;
  const figures = (view: Record<string, any>) => view.figure_ids.length
    ? '<p>仅列实际输出提出的Figure：' + view.figure_ids.map((id: string) => `<a href="#${e(view.document_id + '-' + id)}">${e(pack.figures.find((f: any) => f.document_id === view.document_id && f.figure_id === id)?.figure_number ?? id)}</a>`).join('、') + '。关联与整图仍需人工核对。</p>'
    : '<p>本记录没有已明确配对的Figure。无显式关联、未检查、待核均不代表论文没有图片；请按PDF核对。</p>';
  const sampleItems = pack.random_samples.map((sample: Record<string, any>) => `<section id="${e(sample.id)}"><h2>${e(sample.id)} · ${e(sample.job_id)} · ${e(sample.method)}</h2><p>首轮baseline实际输出；${e(sample.view.figure_status_label)}。机器相同片段组 ${e(sample.exact_fragment_group)}，首轮同组${sample.duplicate_occurrences.length}条；这不是医学有效描述数。</p><details><summary>同组任务与完整归属记录（追溯）</summary><p>${e(sample.duplicate_occurrences.map((v: any) => `${v.job_id}:${v.record_id}@v${v.record_version}`).join('；'))}</p></details>${metadata(sample.view)}${ownerFragments(sample.id, 'baseline')}${figures(sample.view)}<p><a href="#top">返回目录</a></p></section>`).join('');
  const risks = pack.risks.map((risk: Record<string, any>) => `<section class="risk" id="${e(risk.id)}"><h2>${e(risk.id)} · ${e(risk.job_id)} · 定向实验风险</h2><p><strong>这是汇总单因素实验before/after版本，不是30条随机baseline的同一版本，不计入随机统计。</strong></p><ul>${risk.reasons.map((r: string) => `<li>${e(r)}</li>`).join('')}</ul><p>若记录ID与随机样本重叠：${e(risk.baseline_random_ids.join('、') || '本次没有重叠')}；仍按实验版本单独核验。</p><table><thead><tr><th>字段（模型/自动，非医学结论）</th><th>before 实验</th><th>after 实验</th></tr></thead><tbody>${risk.changes.map((change: any) => `<tr><td>${e(change.field)}</td><td><pre>${e(JSON.stringify(change.before, null, 2))}</pre></td><td><pre>${e(JSON.stringify(change.after, null, 2))}</pre></td></tr>`).join('')}</tbody></table><h3>before 实验：v${risk.before.record_version}</h3>${metadata(risk.before)}${ownerFragments(risk.id, 'before')}<h3>after 实验：v${risk.after.record_version}</h3>${metadata(risk.after)}${ownerFragments(risk.id, 'after')}${figures(risk.after)}<p>对照全图及完整图注位于下方Figure区域；修订意见请填写Excel人工栏，保持原文不动。</p><p><a href="#top">返回目录</a></p></section>`).join('');
  const figureItems = pack.figures.map((f: Record<string, any>) => `<section id="${e(f.document_id + '-' + f.figure_id)}"><h2>${e(f.document_id)} · Figure ${e(f.figure_number ?? '未编号候选')}</h2><p>${e(f.status_label)}；人工批准：无。${e(f.verification.notes)}</p>${f.assets.length ? f.assets.map((a: any) => `<p><a href="${e(a.pack_path)}">打开原尺寸资产</a> · <a href="pdf/${e(f.document_id)}.pdf#page=${a.physical_page}">原PDF物理第${a.physical_page}页</a></p><img loading="lazy" src="${e(a.pack_path)}" alt="${e(f.document_id)} Figure ${e(f.figure_number)} 原资产，整图及关联未获人工批准"><p class="small">本次直接使用原资产，没有裁剪或生成图像。图文关联和整图完整性仍需人工核验。</p>`).join('') : '<p>现有目录没有可确认的整幅Figure资产。本包不猜配或另裁图，请打开原PDF回看整页。</p>'}<h3>原图注的独立片段</h3>${ownerFragments(f.document_id + '-' + f.figure_id, 'caption') || '<p>当前没有可绑定图注；待核。</p>'}</section>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>三方法真实输出人工核验</title><style>body{font:16px/1.65 system-ui,sans-serif;color:#1e293b;margin:0 auto;padding:24px;max-width:1100px}a{color:#075985}h1,h2,h3{line-height:1.3}nav{display:flex;gap:9px;flex-wrap:wrap}section{border-top:2px solid #cbd5e1;margin-top:30px;padding-top:12px;scroll-margin-top:12px}section.risk{border-color:#d97706}.notice{background:#fff7dd;border-left:5px solid #d97706;padding:14px}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;font:15px/1.65 ui-monospace,monospace}.fragment{border:1px solid #cbd5e1;background:#f8fafc;border-radius:5px;margin:12px 0;padding:12px}.label{font-weight:600;margin:0}.small,dt{font-size:13px;color:#475569}dd{overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;table-layout:fixed}td,th{border:1px solid #cbd5e1;padding:10px;vertical-align:top}table pre{font-size:13px}img{display:block;max-width:100%;height:auto;border:1px solid #cbd5e1}details{background:#f1f5f9;padding:10px;margin:10px 0}summary{cursor:pointer}ul{padding-left:23px}</style></head><body id="top"><h1>三方法真实输出人工核验</h1><div class="notice"><strong>30条随机工作样本＋${pack.risks.length}条独立实验风险；当前人核0、医学批准0。</strong><p>来自2篇开发论文、5次实际提取，每个任务随机6条；同论文不同方法及重复证据并不独立。L01-R复用L01-F，没有第6次独立提取或额外6条。30是用户选定的开发筛查数量，正式样本量/阈值未冻结。方法明示，不称盲审。</p><p>请先完整解压ZIP，在Excel黄色人工栏填写判断、问题和真实核验人/时间；索引里的模型字段与自动状态只供对照。没有完整参考答案准备步骤；抽样结论不会批准产品已审核导出，文字与图片批准边界仍分别保留。</p></div><p><a href="核验表.xlsx">打开Excel核验表</a> · <a href="pdf/L01.pdf">L01原PDF</a> · <a href="pdf/L05.pdf">L05原PDF</a></p><p>每框都是独立原文片段，不作改写或翻译；模型上下文与原图注另框保存。页码为从1开始的PDF物理页，行号是解析锚点而非期刊印刷行。必要否定、不确定、病例/条件、数值单位和证据归属请回看PDF；图文及整图需要分别核对。PDF页锚在部分阅读器中可能忽略，可按标明的物理页手动定位。</p><h2>随机baseline样本</h2><nav>${pack.random_samples.map((r: any) => `<a href="#${e(r.id)}">${e(r.id)} ${e(r.job_id)}</a>`).join('')}</nav><h2>实验风险（单独统计）</h2><nav>${pack.risks.map((r: any) => `<a href="#${e(r.id)}">${e(r.id)} ${e(r.job_id)}</a>`).join('')}</nav>${sampleItems}${risks}<h2>原Figure资产与原图注</h2><p>只列样本或风险实际提出的Figure；needs_review不改为已配对，机械整图检查不代表人工核验。图像直接复制原资产字节，不猜子图、不裁病灶。</p>${figureItems}</body></html>\n`;
}
