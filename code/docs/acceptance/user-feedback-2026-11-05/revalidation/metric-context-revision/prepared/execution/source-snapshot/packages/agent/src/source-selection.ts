import { createHash } from 'node:crypto';
import { ContractError } from '@t1/contracts';
import type { ArticleScopeManifest, ExtractionDocument } from './article-scope.js';

export type SourceSelectionCondition = 'B0' | 'F' | 'R' | 'FR';
export type SourceSelectionState = 'kept' | 'deferred' | 'excluded';
export const SOURCE_SELECTION_VERSION = 's4-explainable-source-selection-1';
export interface SourceSelectionEntry {
  block_id: string; document_line_index: number; physical_page: number; text_sha256: string;
  code_points: number; state: SourceSelectionState; rule_ids: string[]; reasons: string[];
  context_of_block_ids: string[]; structure_unit_ids: string[]; article_eligible: boolean;
}
export interface SourceSelectionManifest {
  schema_version: 's4-source-selection-1'; rule_version: string; condition: SourceSelectionCondition;
  document_id: string; file_sha256: string; text_version: string; article_scope_digest: string;
  entries: SourceSelectionEntry[]; kept_block_ids: string[]; deferred_block_ids: string[]; excluded_block_ids: string[];
  counts: Record<SourceSelectionState, number>; code_points: Record<SourceSelectionState, number>;
  original_source_changed: false; medical_rules_approved: false; unknown_default: 'kept';
  full_document_coverage_implied: false; digest: string;
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
// Broad bilingual retrieval cues, not a feature taxonomy or medical decision rule.
const visual = /(?:形态|形状|边缘|边界|轮廓|密度|信号|强化|钙化|坏死|分叶|毛刺|空洞|囊|磨玻璃|血管|胸膜|支气管|结节|肿块|长径|短径|直径|厚度|细胞|细胞核|核仁|染色|组织结构|腺体|间质|异型|分化|浸润|排列|纹理|影像|图像|\b(?:shape|morpholog\w*|margin\w*|border\w*|contour\w*|densit\w*|attenuation|signal|enhanc\w*|calcif\w*|necros\w*|lobulat\w*|spicul\w*|cavit\w*|cyst\w*|ground[ -]glass|vascular|pleural|bronch\w*|nodule\w*|mass|diameter\w*|thickness|cell\w*|nucle\w*|chromatin|histolog\w*|tissue|gland\w*|stroma\w*|atypi\w*|differentiat\w*|invas\w*|architecture|texture|imaging|radiolog\w*)\b)/i;
const modality = /(?:\b(?:CT|MRI?|PET|DWI|ADC|T1WI|T2WI|H&E|HE|ultrasound|microscop\w*)\b|磁共振|超声|断层|显微|病理)/i;
const qualified = /(?:\b(?:no|not|without|absence|negative|uncertain|possible|may|might|suspect\w*|if|when|except|whereas)\b|未见|未|无|不|否认|可能|疑似|除外|仅|条件|期|扫描|重建)/i;
const numeric = /(?:\d|[０-９])\s*(?:[.,．]\s*\d+)?\s*(?:mm|cm|μm|µm|nm|HU|%|％|ms|秒|毫米|厘米|倍|例|岁|[×x]|±|[<>=≤≥＞＜])/i;
const figureTable = /(?:\b(?:fig(?:ure)?s?\.?|tables?)\s*\d+|[图表]\s*[0-9０-９]+|注[：:]|\b(?:note|abbreviations?)\s*[:：])/i;
const referenceHeading = /^(?:【?参考文献】?|references|bibliography)\s*[:：]?$/i;
const adminHeading = /^(?:acknowledg(?:e)?ments?|author contributions?|funding|data availability|availability of data(?: and materials)?|declarations|ethics(?: approval(?: and consent to participate)?)?|competing interests?|conflicts? of interest|consent for publication|致谢|基金(?:项目)?|利益冲突|作者贡献|伦理声明)\s*[:：]?$/i;
const heading = /^(?:\d+(?:\.\d+)*\s+.{1,90}|(?:introduction|abstract|background|methods?|materials? and methods?|results?|discussion|conclusions?|references|bibliography|limitations?|supplementary information|acknowledg(?:e)?ments?|declarations))\s*$/i;
const bibliographicEnd = /(?:\b(?:18|19|20)\d{2}\s*[;，,]\s*\d+\s*(?:\([^)]*\))?\s*[:：]\s*[\dA-Za-z-]+|https?:\s*\/\/\s*(?:doi\.org|dx\.doi\.org)|\bdoi\s*[:：]|\[J\])/i;
const referenceStart = /^(?:\[\s*\d+\s*\]|\d+\s*[.．、])\s*\S/;
const explicitBoilerplate = /^(?:【中图分类号】|【文献标识码】|【文章编号】|©\s*\d{4}|copyright\s+©|publisher['’]s note\b|vol:\.\(1234567890\)|\|\s*https?:\/\/doi\.org\/|open access\s+this article is licensed under|the authors declare no competing interests\.?$)/i;
const statisticalOnly = /^(?:(?:all )?statistical analys(?:is|es) (?:was|were) (?:performed|conducted|carried out)|(?:所有)?(?:统计分析|统计学分析).*(?:SPSS|R\s*软件|软件)|采用\s*(?:SPSS|SAS)\s*[\d.]+.*(?:分析|统计))/i;

/** Original blocks are never edited. Missing cues and uncertain structure stay visible. */
export function selectSourceBlocks(document: ExtractionDocument, article: ArticleScopeManifest,
  condition: SourceSelectionCondition = 'B0'): SourceSelectionManifest {
  if (!['B0', 'F', 'R', 'FR'].includes(condition)) throw new ContractError('invalid_source_selection_condition');
  if (document.document_id !== article.document_id || document.file_sha256 !== article.file_sha256 || document.text_version !== article.text_version)
    throw new ContractError('source_selection_binding_mismatch');
  const eligible = new Set(article.included_block_ids), positive = condition === 'F' || condition === 'FR', reverse = condition === 'R' || condition === 'FR';
  const structural = new Map<string, string[]>(), protectedIds = new Set<string>();
  if (document.schema_version === '3') {
    for (const u of document.structure.units) {
      for (const s of u.source_segments) {
        const values = structural.get(s.block_id) ?? []; values.push(u.unit_id); structural.set(s.block_id, values);
        if (['caption', 'table', 'table_cell', 'footnote'].includes(u.kind) || ['partial', 'unmapped', 'ambiguous'].includes(u.mapping.status)) protectedIds.add(s.block_id);
      }
    }
    // An unmapped table/figure cannot identify its exact source lines safely. Keep its entire page.
    const unknownStructurePages = new Set(document.structure.units.filter(u => ['table', 'table_cell', 'caption'].includes(u.kind) &&
      (!u.source_segments.length || !['exact', 'normalized_alignment'].includes(u.mapping.status))).flatMap(u => u.provenance.map(p => p.physical_page)));
    document.blocks.filter(b => unknownStructurePages.has(b.page)).forEach(b => protectedIds.add(b.block_id));
  }
  const references = new Set<number>(), administrative = new Set<number>();
  let region: 'reference' | 'admin' | undefined;
  for (let i = 0; i < document.blocks.length; i++) {
    const text = document.blocks[i]!.text.trim();
    if (referenceHeading.test(text)) { region = 'reference'; continue; }
    if (adminHeading.test(text)) { region = 'admin'; continue; }
    if (heading.test(text)) region = undefined;
    if (region === 'reference') references.add(i);
    if (region === 'admin') administrative.add(i);
  }
  // Drop only complete, clearly numbered bibliographic entries. A dangling tail stays unknown.
  const bibliography = new Set<number>();
  for (const start of references) {
    if (!referenceStart.test(document.blocks[start]!.text.trim())) continue;
    const group: number[] = [];
    for (let j = start; j < document.blocks.length && j < start + 16 && references.has(j); j++) {
      if (j > start && referenceStart.test(document.blocks[j]!.text.trim())) break;
      group.push(j);
      if (bibliographicEnd.test(document.blocks[j]!.text)) { group.forEach(n => bibliography.add(n)); break; }
    }
  }
  const entries = document.blocks.map((b, i): SourceSelectionEntry => {
    const rules: string[] = [], reasons: string[] = [];
    const add = (rule: string, reason: string) => { rules.push(rule); reasons.push(reason); };
    let state: SourceSelectionState = 'kept';
    const raw = b.text.trim(), isProtected = protectedIds.has(b.block_id) || figureTable.test(raw);
    if (!eligible.has(b.block_id)) { state = 'deferred'; add('ARTICLE_QUARANTINE', 'Article membership is pending human review; not dispatched.'); }
    else if (condition === 'B0') add('B0_ALL_ELIGIBLE', 'Unfiltered emitted source block.');
    else if (isProtected) add('KEEP_STRUCTURE_OR_FIGURE_TABLE', 'Figure/table/note or uncertain structural mapping; preserve source context.');
    else if (reverse && (bibliography.has(i) || explicitBoilerplate.test(raw))) {
      state = 'excluded'; add(bibliography.has(i) ? 'R_CONFIRMED_BIBLIOGRAPHY' : 'R_EXPLICIT_BOILERPLATE', 'Clearly bibliographic/administrative text excluded from input copy only; original remains available.');
    } else if (positive && (bibliography.has(i) || explicitBoilerplate.test(raw))) {
      state = 'deferred'; add(bibliography.has(i) ? 'F_BIBLIOGRAPHY_DEFERRED' : 'F_BOILERPLATE_DEFERRED', 'No primary visual evidence expected from this explicit non-content class; may be re-read.');
    } else if (visual.test(raw) || modality.test(raw)) add('F_VISUAL_OR_MODALITY_CUE', 'Broad imaging or cell/nucleus/tissue retrieval cue; not a medical finding.');
    else if (qualified.test(raw) || numeric.test(raw)) add('KEEP_QUALIFIER_OR_NUMERIC', 'Preserve negation, uncertainty, numerical values and applicable conditions.');
    else if (positive && (administrative.has(i) && /(?:grant|funded|funding|author|consent|ethic|data|利益|基金|资助|作者|同意|伦理)/i.test(raw) || statisticalOnly.test(raw))) {
      state = 'deferred'; add('F_EXPLICIT_NONVISUAL_DEFERRED', 'Explicit administrative/statistical software sentence deferred; ambiguous text is retained.');
    } else add('KEEP_UNKNOWN', 'No safe reason to omit this source block; unknown defaults to kept.');
    return { block_id: b.block_id, document_line_index: i, physical_page: b.page, text_sha256: sha(b.text),
      code_points: Array.from(b.text).length, state, rule_ids: rules, reasons, context_of_block_ids: [],
      structure_unit_ids: structural.get(b.block_id) ?? [], article_eligible: eligible.has(b.block_id) };
  });
  if (positive) {
    // Expand from evidence/qualifier/structure seeds, never recursively from added context.
    const seeds = entries.filter(e => e.state === 'kept' && e.rule_ids.some(r => ['F_VISUAL_OR_MODALITY_CUE', 'KEEP_QUALIFIER_OR_NUMERIC', 'KEEP_STRUCTURE_OR_FIGURE_TABLE'].includes(r)));
    for (const seed of seeds) {
      for (let i = Math.max(0, seed.document_line_index - 2); i <= Math.min(entries.length - 1, seed.document_line_index + 2); i++) {
        const e = entries[i]!;
        if (!e.article_eligible || e.state === 'excluded' || e.block_id === seed.block_id) continue;
        // Explicit bibliography/boilerplate is a boundary, not a missing clinical qualifier.
        if (e.rule_ids.some(r => /BIBLIOGRAPHY|BOILERPLATE/.test(r))) continue;
        if (e.state === 'deferred') { e.state = 'kept'; e.rule_ids.push('KEEP_CONTEXT_NEIGHBOR'); e.reasons.push('Restored two-line boundary context around a retrieval seed.'); }
        if (!e.context_of_block_ids.includes(seed.block_id)) e.context_of_block_ids.push(seed.block_id);
      }
      if (document.schema_version === '3') for (const unit of document.structure.units.filter(u =>
        ['exact', 'normalized_alignment'].includes(u.mapping.status) && u.source_segments.some(s => s.block_id === seed.block_id))) {
        for (const s of unit.source_segments) {
          const e = entries.find(x => x.block_id === s.block_id);
          if (!e?.article_eligible || e.state === 'excluded' || e.rule_ids.some(r => /BIBLIOGRAPHY|BOILERPLATE/.test(r))) continue;
          if (e.state === 'deferred') { e.state = 'kept'; e.rule_ids.push('KEEP_MAPPED_UNIT_CONTEXT'); e.reasons.push('All exact/aligned source lines of the same native unit are retained as context; relation is unverified.'); }
          if (e.block_id !== seed.block_id && !e.context_of_block_ids.includes(seed.block_id)) e.context_of_block_ids.push(seed.block_id);
        }
      }
    }
  }
  const ids = (state: SourceSelectionState) => entries.filter(e => e.state === state && e.article_eligible).map(e => e.block_id);
  const counts = Object.fromEntries(['kept', 'deferred', 'excluded'].map(state => [state, entries.filter(e => e.state === state).length])) as Record<SourceSelectionState, number>;
  const codePoints = Object.fromEntries(['kept', 'deferred', 'excluded'].map(state => [state, entries.filter(e => e.state === state).reduce((n, e) => n + e.code_points, 0)])) as Record<SourceSelectionState, number>;
  const manifest = { schema_version: 's4-source-selection-1' as const, rule_version: SOURCE_SELECTION_VERSION, condition,
    document_id: document.document_id, file_sha256: document.file_sha256, text_version: document.text_version, article_scope_digest: article.digest,
    entries, kept_block_ids: ids('kept'), deferred_block_ids: ids('deferred'), excluded_block_ids: ids('excluded'), counts, code_points: codePoints,
    original_source_changed: false as const, medical_rules_approved: false as const, unknown_default: 'kept' as const, full_document_coverage_implied: false as const };
  return { ...manifest, digest: sha(JSON.stringify(manifest)) };
}

/** Independent diagnostic variable: exact figure/table IDs suggest links, never merged assertions. */
export function proposeExplicitSourceLinks(document: ExtractionDocument, article: ArticleScopeManifest) {
  const allowed = new Set(article.included_block_ids);
  const mentions = document.blocks.flatMap((b, lineIndex) => {
    if (!allowed.has(b.block_id)) return [];
    const pattern = /\b(fig(?:ure)?s?\.?|tables?)\s*(\d+)(?:\s*\(?([a-z])\)?)?(?=\s|[.,;:)\]]|$)|([图表])\s*(\d+)(?:\s*([A-Za-z]))?/gi;
    return [...b.text.matchAll(pattern)].map(m => ({ block_id: b.block_id, document_line_index: lineIndex, physical_page: b.page,
      identifier: (/^(?:tab|表)/i.test(m[1] ?? m[4] ?? '') ? 'table:' : 'figure:') + (m[2] ?? m[5]),
      panel: (m[3] ?? m[6] ?? '').toLowerCase() || null, exact_marker: m[0], text: b.text }));
  });
  const values = (text: string, re: RegExp) => [...new Set([...text.matchAll(re)].map(m => (m[1] ?? m[0]).toLowerCase().replace(/\s+/g, '')))];
  const links = [];
  for (let i = 0; i < mentions.length; i++) for (let j = i + 1; j < mentions.length; j++) {
    const a = mentions[i]!, b = mentions[j]!;
    if (a.block_id === b.block_id || a.identifier !== b.identifier) continue;
    const checks = {
      case: [values(a.text, /(?:\bcase\s*(?:no\.?\s*)?|病例\s*)(\d+)/gi), values(b.text, /(?:\bcase\s*(?:no\.?\s*)?|病例\s*)(\d+)/gi)],
      lesion: [values(a.text, /(?:\blesion\s*(?:no\.?\s*)?|病灶\s*)(\d+)/gi), values(b.text, /(?:\blesion\s*(?:no\.?\s*)?|病灶\s*)(\d+)/gi)],
      modality: [values(a.text, /\b(CT|MRI|PET|ultrasound)\b/gi), values(b.text, /\b(CT|MRI|PET|ultrasound)\b/gi)],
      condition: [values(a.text, /\b(arterial|venous|delayed|unenhanced|T1WI|T2WI|DWI|ADC)\b/gi), values(b.text, /\b(arterial|venous|delayed|unenhanced|T1WI|T2WI|DWI|ADC)\b/gi)],
    };
    const conflicts = Object.entries(checks).filter(([, [x, y]]) => x!.length && y!.length && !x!.some(v => y!.includes(v))).map(([k]) => k);
    if (a.panel && b.panel && a.panel !== b.panel) conflicts.push('panel');
    const missing = Object.entries(checks).filter(([, [x, y]]) => !x!.length || !y!.length).map(([k]) => k);
    links.push({ identifier: a.identifier, from: { ...a, text: undefined }, to: { ...b, text: undefined },
      status: conflicts.length ? 'blocked_incompatible_conditions' : missing.length ? 'pending_identity_or_conditions' : 'compatible_explicit_markers_pending_review',
      conflicts, unknown_dimensions: missing, checks, relation_is_unapproved: true, assertion_merge_allowed: false });
  }
  return { schema_version: 's4-explicit-source-link-candidates-1', document_id: document.document_id,
    file_sha256: document.file_sha256, text_version: document.text_version, experimental_variable: 'offline_only_not_in_main_selection_prompts',
    full_source_text_included_in_prompt: false, links, medical_approval: false };
}
