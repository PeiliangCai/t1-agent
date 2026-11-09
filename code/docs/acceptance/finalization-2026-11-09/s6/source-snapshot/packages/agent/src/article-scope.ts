import { createHash } from 'node:crypto';
import { ContractError, type DocumentIR } from '@t1/contracts';
export type ExtractionDocument = Exclude<DocumentIR, { schema_version: '1' }>;
export interface ArticleScopeManifest {
  schema_version: 's4-article-scope-1'; document_id: string; file_sha256: string; text_version: string;
  included_block_ids: string[]; quarantined_block_ids: string[]; human_approved: false;
  regions: Array<{ physical_page: number; bbox: number[]; marker_block_id: string; marker_text: string;
    status: 'quarantined_pending_human'; reason: string; block_ids: string[]; basis: 'source_marker_and_geometry'; }>;
  warnings: string[]; digest: string;
}
/** Does not remove or rewrite any source. Suspicion is a visible coverage gap, never an approved exclusion. */
export function buildArticleScope(document: ExtractionDocument): ArticleScopeManifest {
  const regions: ArticleScopeManifest['regions'] = [];
  for (const marker of document.blocks.filter(b => /上接\s*第?\s*[0-9０-９]+\s*页/.test(b.text))) {
    const page = document.pages.find(p => p.physical_page === marker.page);
    if (!page?.height || !page.width) throw new ContractError('article_boundary_geometry_unavailable');
    const y = marker.bbox[1]!;
    const blocks = document.blocks.filter(b => b.page === marker.page && b.bbox[3]! >= y - 1).map(b => b.block_id);
    regions.push({ physical_page: marker.page, bbox: [0, y, page.width, page.height], marker_block_id: marker.block_id,
      marker_text: marker.text, status: 'quarantined_pending_human', reason: 'continuation_marker_may_belong_to_another_article',
      block_ids: blocks, basis: 'source_marker_and_geometry' });
  }
  const knownL02 = document.file_sha256 === '14a37c26847110e3dce0fad50e95cec4459348b0c6da7ef793a1d333bd6e1c12';
  if (knownL02 && !regions.some(r => r.physical_page === 3)) throw new ContractError('known_article_boundary_marker_not_recovered');
  const quarantined = new Set(regions.flatMap(r => r.block_ids));
  const manifest = { schema_version: 's4-article-scope-1' as const, document_id: document.document_id,
    file_sha256: document.file_sha256, text_version: document.text_version,
    included_block_ids: document.blocks.filter(b => !quarantined.has(b.block_id)).map(b => b.block_id),
    quarantined_block_ids: [...quarantined], human_approved: false as const, regions,
    warnings: regions.length ? ['article_membership_pending_human_review', 'quarantine_is_not_approved_exclusion'] : [] };
  return { ...manifest, digest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex') };
}
export interface ExtractionBatch { batch_id: string; assigned_block_ids: string[]; context_block_ids: string[];
  physical_pages: number[]; source_code_points: number; order_basis: 'native_mapped_then_source_fallback'; warnings: string[]; }
/** Every non-quarantined emitted source block occurs in exactly one assigned batch. */
export function planExtractionBatches(document: ExtractionDocument, scope: ArticleScopeManifest,
  options: { maxCodePoints?: number; maxBlocks?: number; contextBlocks?: number } = {}): ExtractionBatch[] {
  if (document.file_sha256 !== scope.file_sha256 || document.text_version !== scope.text_version || document.document_id !== scope.document_id) throw new ContractError('article_scope_version_mismatch');
  const maxChars = options.maxCodePoints ?? 8500, maxBlocks = options.maxBlocks ?? 128, contextCount = options.contextBlocks ?? 6;
  if (maxChars < 100 || maxBlocks < 1 || maxBlocks > 256 || contextCount < 0) throw new ContractError('invalid_batch_limits');
  const allowed = new Set(scope.included_block_ids), seen = new Set<string>(), order: string[] = [];
  if (document.schema_version === '3') for (const id of document.structure.reading_order) {
    const unit = document.structure.units.find(u => u.unit_id === id);
    if (!unit || !['exact', 'normalized_alignment'].includes(unit.mapping.status)) continue;
    for (const s of unit.source_segments) if (allowed.has(s.block_id) && !seen.has(s.block_id)) { order.push(s.block_id); seen.add(s.block_id); }
  }
  const fallback = document.blocks.filter(b => allowed.has(b.block_id) && !seen.has(b.block_id)).map(b => b.block_id);
  order.push(...fallback);
  const byId = new Map(document.blocks.map(b => [b.block_id, b]));
  const batches: ExtractionBatch[] = []; let ids: string[] = [], chars = 0;
  const flush = () => {
    if (!ids.length) return;
    const positions = ids.map(id => byId.get(id)!.reading_order);
    const min = Math.max(0, Math.min(...positions) - contextCount), max = Math.min(document.blocks.length - 1, Math.max(...positions) + contextCount);
    const context = document.blocks.filter(b => allowed.has(b.block_id) && !ids.includes(b.block_id) &&
      (b.reading_order >= min && b.reading_order < Math.min(...positions) || b.reading_order > Math.max(...positions) && b.reading_order <= max))
      .slice(0, contextCount * 2).map(b => b.block_id);
    batches.push({ batch_id: 'batch-' + String(batches.length + 1).padStart(4, '0'), assigned_block_ids: ids,
      context_block_ids: context, physical_pages: [...new Set(ids.map(id => byId.get(id)!.page))], source_code_points: chars,
      order_basis: 'native_mapped_then_source_fallback', warnings: ['reading_order_not_human_verified', ...(fallback.some(id => ids.includes(id)) ? ['contains_source_order_fallback'] : [])] });
    ids = []; chars = 0;
  };
  for (const id of order) {
    const n = Array.from(byId.get(id)!.text).length;
    if (ids.length && (chars + n > maxChars || ids.length >= maxBlocks)) flush();
    ids.push(id); chars += n;
  }
  flush();
  const assigned = batches.flatMap(b => b.assigned_block_ids);
  if (assigned.length !== allowed.size || new Set(assigned).size !== assigned.length || assigned.some(id => !allowed.has(id))) throw new ContractError('batch_inventory_incomplete');
  return batches;
}
