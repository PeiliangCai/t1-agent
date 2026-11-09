import { createHash } from 'node:crypto';
import { ContractError } from '@t1/contracts';
import type { ArticleScopeManifest, ExtractionDocument } from './article-scope.js';
import { buildSourceEvidenceUnits, sourceGlyphQuarantine } from './source-evidence-units.js';

export const SOURCE_SELECTION_CONDITIONS = ['B0', 'F'] as const;
export type SourceSelectionCondition = typeof SOURCE_SELECTION_CONDITIONS[number];
/** Historical manifests may contain these values; they are never executable conditions. */
export type LegacySourceSelectionCondition = 'R' | 'FR';
export const isSourceSelectionCondition = (value: unknown): value is SourceSelectionCondition =>
  SOURCE_SELECTION_CONDITIONS.some(condition => condition === value);
/** Exclusion is the shared task scope; F retrieval may additionally defer source. */
export type SourceSelectionState = 'kept' | 'deferred' | 'excluded';
export const SOURCE_SELECTION_VERSION = 's4-explainable-source-selection-3';
export const BIBLIOGRAPHY_SCOPE_RULE_VERSION = 'explicit-bibliography-task-scope-1';
export interface SourceSelectionEntry {
  block_id: string; document_line_index: number; physical_page: number; text_sha256: string;
  code_points: number; state: SourceSelectionState; rule_ids: string[]; reasons: string[];
  context_of_block_ids: string[]; structure_unit_ids: string[]; article_eligible: boolean;
}
export interface SourceSelectionManifest<
  Condition extends SourceSelectionCondition | LegacySourceSelectionCondition = SourceSelectionCondition | LegacySourceSelectionCondition> {
  schema_version: 's4-source-selection-1'; rule_version: string; condition: Condition;
  /** Absent on historical manifests, which remain readable. */
  bibliography_scope_rule_version?: string;
  source_glyph_guard_version?: string;
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
const heading = /^(?:\d+(?:\.\d+)*\s+.{1,90}|(?:introduction|abstract|background|methods?|materials? and methods?|results?|discussion|conclusions?|references|bibliography|limitations?|supplement(?:ary|al)(?:\s+.{1,90})?|appendi(?:x|ces)(?:\s+.{1,90})?|附录(?:\s*[^。]{0,90})?|补充材料|acknowledg(?:e)?ments?|declarations))\s*$/i;
// A type marker ([J]) or a bare DOI prefix is insufficient. The complete entry
// must end in a publication locator or a complete DOI, with no appended prose.
const bibliographicEnd = /(?:\b(?:18|19|20)\d{2}\s*[;，,]\s*\d+\s*(?:\([^)]*\))?\s*[:：]\s*(?:\d+(?:\s*[–-]\s*\d+)?(?:\.[A-Za-z]\d+)?|[A-Za-z]\d+)(?:\s+e\d+)?\.?|(?:https?:\s*\/\/\s*(?:dx\.)?doi\.\s*org\/|\bdoi\s*[:：]\s*)(?:\s*10\.\s*\d{4,9}\/\s*)[A-Za-z0-9][A-Za-z0-9./()_:;%+–-]*(?:\n[A-Za-z0-9./()_:;%+–-]+)*\.?)\s*$/i;
const referenceStart = /^(?:\[\s*\d+\s*\]|\d+\s*[.．、])\s*\S/;
const referencePrefix = /^(?:\[\s*\d+\s*\]|\d+\s*[.．、])\s*/;
const authorStart = /^(?:[\p{L}'’–-]+\s+[A-Z](?:[ .-]*[A-Z])*(?=[,.;\s])|[\p{Script=Han}]{2,6}[，,、])/u;
const explicitBoilerplate = /^(?:【中图分类号】|【文献标识码】|【文章编号】|©\s*\d{4}|copyright\s+©|publisher['’]s note\b|vol:\.\(1234567890\)|\|\s*https?:\/\/doi\.org\/|open access\s+this article is licensed under|the authors declare no competing interests\.?$)/i;
const statisticalOnly = /^(?:(?:all )?statistical analys(?:is|es) (?:was|were) (?:performed|conducted|carried out)|(?:所有)?(?:统计分析|统计学分析).*(?:SPSS|R\s*软件|软件)|采用\s*(?:SPSS|SAS)\s*[\d.]+.*(?:分析|统计))/i;

// Open retrieval hints, including descriptive language outside named features.
// Absence of a hint is never an assessment of medical relevance.
const description = /(?:外观|表现|征象|表型|可见|显示|观察|测量|\b(?:visual|images?|appear\w*|phenotyp\w*|patterns?|features?|signs?|observ\w*|depict\w*|demonstrat\w*|measur\w*|describ\w*)\b)/i;
const unfamiliar = /(?:新表述|新征象|首次|未分类|未知|不明确|\b(?:novel|unlisted|unclassif\w*|unknown|unfamiliar|new|updated|revised|terminolog\w*|lexicon)\b)/i;
const refersBack = /^(?:\s*[·•–-]\s*)?(?:these\b|those\b|such\b|it\b|they\b|both\b|this\s+(?:finding|appearance|pattern|sign|feature|result|observation)|the\s+(?:former|latter)\b|however\b|therefore\b|whereas\b|in contrast\b|其|该|上述|前者|后者|因此|此外|然而|同时|但)/i;
interface PositiveUnitChoice { state: 'kept' | 'deferred'; rule: string; reason: string; context: string[] }

/** Reuse literal sentence/continuation units; never retrieve from processed native prose. */
function positiveUnitChoices(document: ExtractionDocument, available: ReadonlySet<string>, protectedIds: ReadonlySet<string>) {
  const choices = new Map<string, PositiveUnitChoice>();
  if (document.schema_version !== '3') return choices;
  const native = new Map(document.structure.units.map(u => [u.unit_id, u]));
  const blocks = new Map(document.blocks.map(b => [b.block_id, b]));
  const statements = buildSourceEvidenceUnits(document);
  const groups = new Map<string, { ids: string[]; statements: typeof statements }>();
  for (const statement of statements) {
    const ids = statement.structure_unit_ids;
    if (!ids.length || ids.some(id => !native.has(id))) continue;
    const key = [...ids].sort().join('|'), group = groups.get(key) ?? { ids, statements: [] };
    group.statements.push(statement); groups.set(key, group);
  }
  const organization = document.structure.organization;
  const continuationIds = new Set([
    ...(organization?.paragraph_continuations ?? []),
    ...(organization?.continuation_recovery?.relations ?? []),
    ...(organization?.continuation_recovery?.unresolved ?? []),
  ].flatMap(edge => [edge.from_unit_id, edge.to_unit_id]));
  const candidates = [...groups.values()].map(group => {
    const units = group.ids.map(id => native.get(id)!);
    const segments = units.flatMap(u => u.source_segments);
    const ids = [...new Set(segments.map(s => s.block_id))].filter(id => blocks.has(id));
    const text = segments.map(s => Array.from(blocks.get(s.block_id)?.text ?? '').slice(s.start, s.end).join('')).join('\n');
    // A line may contain two units or an unmapped tail. Such a line cannot be
    // deferred as a whole, even if its mapped prefix looks uninteresting.
    const whole = ids.length > 0 && ids.every(id => {
      const b = blocks.get(id)!, ranges = segments.filter(s => s.block_id === id).sort((a, b) => a.start - b.start);
      let end = 0;
      for (const s of ranges) {
        if (s.text_version !== document.text_version || s.start > end && Array.from(b.text).slice(end, s.start).join('').trim()) return false;
        end = Math.max(end, s.end);
      }
      return end <= Array.from(b.text).length && !Array.from(b.text).slice(end).join('').trim() &&
        document.structure.units.every(u => group.ids.includes(u.unit_id) || !u.source_segments.some(s => s.block_id === id));
    });
    const complete = whole && units.every(u => ['text', 'list_item', 'other'].includes(u.kind) &&
      ['exact', 'normalized_alignment'].includes(u.mapping.status)) && group.statements.every(s => s.completeness === 'complete') &&
      ids.every(id => available.has(id));
    const seed = visual.test(text) || modality.test(text) || figureTable.test(text) || description.test(text);
    const uncertain = !complete || units.some(u => continuationIds.has(u.unit_id)) || unfamiliar.test(text);
    const guarded = ids.some(id => protectedIds.has(id));
    const keep = seed || uncertain || guarded || refersBack.test(text);
    const choice: PositiveUnitChoice = {
      state: keep ? 'kept' : 'deferred',
      rule: guarded ? 'KEEP_MAPPED_UNIT_CONTEXT' : seed ? 'F_POSITIVE_UNIT' : uncertain ? 'KEEP_UNKNOWN_UNIT' :
        refersBack.test(text) ? 'KEEP_REFERENTIAL_UNIT' : 'F_NOT_PRIORITIZED_UNIT_DEFERRED',
      reason: guarded ? 'Preserve the complete literal unit containing protected structure.' : seed ?
        'A broad visual/modality/description/figure-table hint selects the complete literal paragraph, including its conditions, negation and numbers.' : uncertain ?
        'Incomplete, ambiguous, unfamiliar or continued source unit defaults to kept.' : refersBack.test(text) ?
        'An explicit backward reference needs its paragraph and preceding source context.' :
        'Complete reliably mapped unit has no retrieval seed; not prioritized for initial dispatch, not judged medically irrelevant. Explicit reread remains available.',
      context: [],
    };
    return { ids, text, choice, first: Math.min(...ids.map(id => blocks.get(id)!.reading_order)),
      heading: units.some(u => u.kind === 'section_header') };
  }).sort((a, b) => a.first - b.first);
  // Expand explicit discourse dependencies by whole units, never by deleting or
  // completing their text. A heading/task-scope boundary stops this expansion.
  for (let i = candidates.length - 1; i > 0; i--) {
    const current = candidates[i]!, previous = candidates[i - 1]!;
    if (current.choice.state !== 'kept' || !refersBack.test(current.text) || previous.heading ||
      previous.ids.some(id => !available.has(id)) || explicitBoilerplate.test(previous.text)) continue;
    previous.choice.state = 'kept'; previous.choice.rule = 'KEEP_CONTEXT_NEIGHBOR';
    previous.choice.reason = 'Preserve the complete preceding unit required by an explicit backward reference; relation remains unapproved.';
    previous.choice.context.push(...current.ids);
  }
  for (const candidate of candidates) for (const id of candidate.ids) {
    const previous = choices.get(id);
    if (previous && previous !== candidate.choice) choices.set(id, { state: 'kept', rule: 'KEEP_UNKNOWN_UNIT',
      reason: 'Overlapping retrieval-unit ownership is uncertain; preserve the original line.', context: [] });
    else choices.set(id, candidate.choice);
  }
  return choices;
}

/** Original blocks are never edited. Unknown structure/expressions stay visible. */
export function selectSourceBlocks(document: ExtractionDocument, article: ArticleScopeManifest,
  condition: SourceSelectionCondition = 'B0'): SourceSelectionManifest<SourceSelectionCondition> {
  if (!isSourceSelectionCondition(condition)) throw new ContractError('invalid_source_selection_condition');
  if (document.document_id !== article.document_id || document.file_sha256 !== article.file_sha256 || document.text_version !== article.text_version)
    throw new ContractError('source_selection_binding_mismatch');
  const eligible = new Set(article.included_block_ids), glyphQuarantine = new Set(sourceGlyphQuarantine(document));
  const structural = new Map<string, string[]>(), protectedIds = new Set<string>(), sectionHeaders = new Set<string>(), furnitureIds = new Set<string>();
  if (document.schema_version === '3') {
    for (const u of document.structure.units) {
      for (const s of u.source_segments) {
        const values = structural.get(s.block_id) ?? []; values.push(u.unit_id); structural.set(s.block_id, values);
        if (['caption', 'table', 'table_cell', 'footnote'].includes(u.kind) || ['partial', 'unmapped', 'ambiguous'].includes(u.mapping.status)) protectedIds.add(s.block_id);
        if (u.kind === 'section_header') sectionHeaders.add(s.block_id);
        if (u.content_layer === 'furniture') furnitureIds.add(s.block_id);
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
    const mappedListItem = document.schema_version === '3' && (structural.get(document.blocks[i]!.block_id) ?? []).some(id =>
      document.structure.units.some(u => u.unit_id === id && u.kind === 'list_item'));
    if (heading.test(text) && !mappedListItem && !furnitureIds.has(document.blocks[i]!.block_id) || sectionHeaders.has(document.blocks[i]!.block_id)) region = undefined;
    if (region === 'reference') references.add(i);
    if (region === 'admin') administrative.add(i);
  }
  // Keep the raw document intact. Only complete, explicitly headed bibliography
  // is outside this extraction task, identically for B0 and F. Native list units
  // bound multi-line entries; a raw range through the rest of a page never does.
  const bibliography = new Set<number>();
  const blockIndex = new Map(document.blocks.map((b, i) => [b.block_id, i]));
  const completeEntry = (indices: number[]) => {
    const text = indices.map(i => document.blocks[i]!.text).join('\n').trim();
    return referenceStart.test(text) && authorStart.test(text.replace(referencePrefix, '')) && bibliographicEnd.test(text) &&
      indices.every((i, n) => references.has(i) && !protectedIds.has(document.blocks[i]!.block_id) &&
        (n === 0 || i === indices[n - 1]! + 1 && document.blocks[i]!.page === document.blocks[indices[0]!]!.page &&
          !(referenceStart.test(document.blocks[i]!.text.trim()) && authorStart.test(document.blocks[i]!.text.trim().replace(referencePrefix, '')))));
  };
  if (document.schema_version === '3') for (const unit of document.structure.units) {
    if (unit.kind !== 'list_item' || !['exact', 'normalized_alignment'].includes(unit.mapping.status) || !unit.source_segments.length) continue;
    const indices = [...new Set(unit.source_segments.map(s => blockIndex.get(s.block_id)))].filter((i): i is number => i !== undefined).sort((a, b) => a - b);
    if (!indices.length || !completeEntry(indices)) continue;
    // A block may contain both bibliography and prose. Whole-block exclusion is
    // allowed only if mapping covers every character except its numbered label.
    const wholeBlocks = indices.every((i, n) => {
      const b = document.blocks[i]!, ranges = unit.source_segments.filter(s => s.block_id === b.block_id).sort((a, b) => a.start - b.start);
      let end = 0;
      for (const s of ranges) {
        if (s.text_version !== document.text_version || s.start > end && !(n === 0 && end === 0 && referencePrefix.test(Array.from(b.text).slice(0, s.start).join('')) &&
          Array.from(b.text).slice(0, s.start).join('').replace(referencePrefix, '').trim() === '')) return false;
        end = Math.max(end, s.end);
      }
      if (end !== Array.from(b.text).length) return false;
      return (structural.get(b.block_id) ?? []).every(id => id === unit.unit_id);
    });
    if (wholeBlocks) indices.forEach(i => bibliography.add(i));
  }
  // With no native mapping, require the complete citation on this single line.
  // Unmapped multi-line and cross-page candidates are deliberately retained.
  for (const start of references) {
    if (!structural.has(document.blocks[start]!.block_id) && completeEntry([start])) bibliography.add(start);
  }
  const available = new Set(document.blocks.filter((b, i) => eligible.has(b.block_id) && !bibliography.has(i)).map(b => b.block_id));
  // An incomplete bibliography tail has uncertain scope, not a reliable
  // cue-negative prose unit. Its conservative availability remains intact.
  const retrievalProtected = new Set([...protectedIds, ...[...references].filter(i => !bibliography.has(i) &&
    !explicitBoilerplate.test(document.blocks[i]!.text.trim())).map(i => document.blocks[i]!.block_id)]);
  const unitChoices = condition === 'F' ? positiveUnitChoices(document, available, retrievalProtected) : new Map<string, PositiveUnitChoice>();
  const entries = document.blocks.map((b, i): SourceSelectionEntry => {
    const rules: string[] = [], reasons: string[] = [];
    const add = (rule: string, reason: string) => { rules.push(rule); reasons.push(reason); };
    let state: SourceSelectionState = 'kept';
    const raw = b.text.trim(), isProtected = protectedIds.has(b.block_id) || figureTable.test(raw), unitChoice = unitChoices.get(b.block_id);
    if (!eligible.has(b.block_id)) { state = 'deferred'; add('ARTICLE_QUARANTINE', 'Article membership is pending human review; not dispatched.'); }
    else if (bibliography.has(i)) { state = 'excluded'; add('TASK_BIBLIOGRAPHY_EXCLUDED', 'Complete explicit bibliography is outside this extraction task for both B0 and F; original article membership, PDF and source spans are preserved. Model reread/citation is unavailable.'); }
    else if (glyphQuarantine.has(b.block_id)) { state = 'deferred'; add('SOURCE_GLYPH_QUARANTINE', 'A literal source sentence contains an undecidable embedded-font glyph. Preserved for original-page review; no model read/citation, not completed coverage.'); }
    else if (condition === 'B0') add('B0_ALL_ELIGIBLE', 'All remaining task-scope source blocks; no topic filter.');
    else if (isProtected) add('KEEP_STRUCTURE_OR_FIGURE_TABLE', 'Figure/table/note or uncertain structural mapping; preserve source context.');
    else if (unitChoice) { state = unitChoice.state; add(unitChoice.rule, unitChoice.reason); }
    else if (visual.test(raw) || modality.test(raw) || description.test(raw)) add('F_VISUAL_OR_MODALITY_CUE', 'Broad visual/modality/description retrieval cue; not a medical finding.');
    else if (explicitBoilerplate.test(raw)) {
      state = 'deferred'; add('F_BOILERPLATE_DEFERRED', 'No primary visual evidence expected from this explicit non-content class; may be re-read.');
    }
    else if (qualified.test(raw) || numeric.test(raw)) add('KEEP_QUALIFIER_OR_NUMERIC', 'Preserve negation, uncertainty, numerical values and applicable conditions.');
    else if (administrative.has(i) && /(?:grant|funded|funding|author|consent|ethic|data|利益|基金|资助|作者|同意|伦理)/i.test(raw) || statisticalOnly.test(raw)) {
      state = 'deferred'; add('F_EXPLICIT_NONVISUAL_DEFERRED', 'Explicit administrative/statistical software sentence deferred; ambiguous text is retained.');
    } else add('KEEP_UNKNOWN', 'No safe reason to omit this source block; unknown defaults to kept.');
    return { block_id: b.block_id, document_line_index: i, physical_page: b.page, text_sha256: sha(b.text),
      code_points: Array.from(b.text).length, state, rule_ids: rules, reasons, context_of_block_ids: unitChoice?.context.filter(id => id !== b.block_id) ?? [],
      structure_unit_ids: structural.get(b.block_id) ?? [], article_eligible: eligible.has(b.block_id) };
  });
  if (condition === 'F') {
    // Unmapped source still needs a conservative local fallback. Reliable units
    // have already been selected/expanded as a whole; never restore just a few
    // lines of a deferred paragraph or turn every isolated number into a seed.
    const seeds = entries.filter(e => !unitChoices.has(e.block_id) && e.state === 'kept' &&
      e.rule_ids.some(r => ['F_VISUAL_OR_MODALITY_CUE', 'KEEP_STRUCTURE_OR_FIGURE_TABLE'].includes(r)));
    for (const seed of seeds) {
      for (let i = Math.max(0, seed.document_line_index - 2); i <= Math.min(entries.length - 1, seed.document_line_index + 2); i++) {
        const e = entries[i]!;
        if (!e.article_eligible || glyphQuarantine.has(e.block_id) || e.block_id === seed.block_id || unitChoices.has(e.block_id)) continue;
        // Explicit bibliography/boilerplate is a boundary, not a missing clinical qualifier.
        if (e.rule_ids.some(r => /BIBLIOGRAPHY|BOILERPLATE/.test(r))) continue;
        if (e.state === 'deferred') { e.state = 'kept'; e.rule_ids.push('KEEP_CONTEXT_NEIGHBOR'); e.reasons.push('Restored two-line boundary context around a retrieval seed.'); }
        if (!e.context_of_block_ids.includes(seed.block_id)) e.context_of_block_ids.push(seed.block_id);
      }
      if (document.schema_version === '3') for (const unit of document.structure.units.filter(u =>
        ['exact', 'normalized_alignment'].includes(u.mapping.status) && u.source_segments.some(s => s.block_id === seed.block_id))) {
        for (const s of unit.source_segments) {
          const e = entries.find(x => x.block_id === s.block_id);
          if (!e?.article_eligible || glyphQuarantine.has(e.block_id) || unitChoices.has(e.block_id) || e.rule_ids.some(r => /BIBLIOGRAPHY|BOILERPLATE/.test(r))) continue;
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
    ...(typeof document.parser.config.font_glyph_guard_version === 'string' ? { source_glyph_guard_version: document.parser.config.font_glyph_guard_version } : {}),
    bibliography_scope_rule_version: BIBLIOGRAPHY_SCOPE_RULE_VERSION,
    document_id: document.document_id, file_sha256: document.file_sha256, text_version: document.text_version, article_scope_digest: article.digest,
    entries, kept_block_ids: ids('kept'), deferred_block_ids: ids('deferred'), excluded_block_ids: ids('excluded'), counts, code_points: codePoints,
    original_source_changed: false as const, medical_rules_approved: false as const, unknown_default: 'kept' as const, full_document_coverage_implied: false as const };
  return { ...manifest, digest: sha(JSON.stringify(manifest)) };
}

/** Article membership and this task's model-access scope are separate. Historical
 * input-copy exclusions are not a grant to bypass the current bibliography scope. */
export function taskSourceBlockIds(document: ExtractionDocument, article: ArticleScopeManifest): string[] {
  const excluded = new Set(selectSourceBlocks(document, article, 'B0').excluded_block_ids);
  const unsafe = new Set(sourceGlyphQuarantine(document));
  return article.included_block_ids.filter(id => !excluded.has(id) && !unsafe.has(id));
}

/** Fail closed if an existing candidate/audit packet would expose excluded text. */
export function assertTaskSourceAccess(value: unknown, excludedIds: ReadonlySet<string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach(v => assertTaskSourceAccess(v, excludedIds)); return; }
  const record = value as Record<string, unknown>;
  if (typeof record.block_id === 'string' && excludedIds.has(record.block_id)) throw new ContractError('source_outside_bibliography_task_scope');
  Object.values(record).forEach(v => assertTaskSourceAccess(v, excludedIds));
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
