import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, mkdtemp, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EvidenceRecord, EvidenceSubmission, EvidenceValidationContext } from '@t1/contracts';
import { validateEvidenceSubmission, locateEvidenceFragment } from '../../packages/agent/src/evidence-validation.js';
import { buildEvidenceDelivery } from '../../packages/agent/src/evidence-delivery.js';
import { visualStatementIssues, VISUAL_STATEMENT_POLICY_VERSION } from '../../packages/agent/src/visual-evidence-policy.js';
import { ExtractionStore } from '../../packages/agent/src/extraction-store.js';
import { reconcileEvidence } from '../../packages/agent/src/reconciliation.js';
import { runExtractionDocument } from '../../packages/agent/src/extraction-run.js';
import { ExtractionBudget } from '../../packages/agent/src/extraction-budget.js';
import { developmentProfile } from '../../packages/agent/src/extraction-pi.js';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';
import { createRuntimeResponsesFixture } from './fixtures/runtime-responses.js';

const root = 'docs/acceptance/s0-s4-recheck-2026-11-08';
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const fragment = ({ block_id, exact_quote, occurrence }: any) => ({ block_id, exact_quote, occurrence });
const observation = (v: any) => v ? { ...v, evidence: v.evidence.map(fragment) } : null;
function submission(record: EvidenceRecord): EvidenceSubmission {
  return { binding: record.extraction_trace.source_binding, source_fragments: record.quote_span.segments.map(fragment),
    context_fragments: [], display_joiner: record.quote_span.display_joiner, feature_binding_id: null,
    feature_name_raw: record.feature_name_raw, feature_category: record.feature_category, evidence_type: record.evidence_type,
    disease_or_lesion: observation(record.disease_or_lesion), modality: observation(record.modality),
    sequence_or_phase: observation(record.sequence_or_phase), assertion: { ...record.assertion, evidence: record.assertion.evidence.map(fragment) },
    applicability: { ...record.applicability, evidence: record.applicability.evidence.map(fragment) },
    numeric_expressions: record.numeric_expressions.map(v => ({ ...v, evidence: v.evidence.map(fragment) })),
    provenance: { ...record.context.source_attribution, evidence: record.context.source_attribution.evidence.map(fragment) }, translation_zh: null };
}

test('both actual saved L07 field-derived partial contexts fail before persistence', async () => {
  const document = (await json(root + '/production/L07/parser-result.json')).document;
  const plan = await json(root + '/comparison/plan.json');
  const db = new DatabaseSync(root + '/comparison/offline-delivery-recovery/evidence-snapshot.sqlite', { readOnly: true });
  try {
    const row = db.prepare("SELECT * FROM s4_runs WHERE id LIKE '%:source-L07:%'").get()!;
    const versions = db.prepare('SELECT envelope_json FROM s4_versions WHERE run_id=? ORDER BY rowid').all(row.id as string)
      .map(v => JSON.parse(v.envelope_json as string));
    const current = new Map<string, any>(); for (const v of versions) if (v.status !== 'proposed') current.set(v.record.record_id, v);
    const context: EvidenceValidationContext = { input: JSON.parse(row.input_json as string), document, catalog: plan.config.catalog,
      metadata: JSON.parse(row.metadata_json as string), allowedBlockIds: document.blocks.map((b: any) => b.block_id),
      readBlockIds: document.blocks.map((b: any) => b.block_id), toolCallId: 'offline-saved-case', evidencePolicyVersion: VISUAL_STATEMENT_POLICY_VERSION };
    for (const id of ['ev-a3a491a7921d5c18180c5d6adafecf7d86dd0826', 'ev-76970ec1cb9d2a47aa412896e88086001744c8d5']) {
      const v = current.get(id), r: EvidenceRecord = v.record, before = JSON.stringify(r), value = submission(r);
      assert.deepEqual(value.context_fragments, [], 'this reproduces context introduced by fields after the old check');
      const rejected = validateEvidenceSubmission(value, context);
      assert.equal(rejected.accepted, false); assert.ok(rejected.issues.some(i => i.code === 'incomplete_context_statement' && i.severity === 'reject'));
      assert.throws(() => buildEvidenceDelivery(document, [v]), /delivery_visual_statement_policy_failed/);
      assert.equal(JSON.stringify(r), before, 'the rejected original version and source are unchanged');
    }
  } finally { db.close(); }
});

function sourceUnits(f: ReturnType<typeof makeEvidenceFixture>) {
  for (const [id, indices] of [['primary', [0]], ['context', [1, 2]]] as const) {
    const u: any = { unit_id: id, native_ref: '#/texts/' + id, kind: 'text', native_label: 'text', native_text: 'not authoritative',
      native_original_text: null, native_text_role: 'processed_native_not_literal_quote', content_layer: 'body',
      source_segments: indices.map(i => ({ block_id: f.document.blocks[i]!.block_id, text_version: f.document.text_version,
        start: 0, end: f.document.blocks[i]!.text.length })),
      provenance: indices.map(i => ({ physical_page: 1, bbox: f.document.blocks[i]!.bbox, coordinate_system: 'crop_rotated_top_left_pt',
        native_ref: '#/texts/' + id, native_bbox: {}, native_page_size: [600, 800], precision: 'native_element_bbox', native_charspan: null })),
      mapping: { status: 'exact', method: 'geometry_and_nfkd_whitespace_hyphen_alignment_4', matched_native_code_points: 1,
        alignable_native_code_points: 1, transformations: [], warnings: [] } };
    f.document.structure.units.push(u); f.document.structure.reading_order.push(id);
  }
}

test('explicitly complete known context keeps field evidence without rewriting or dropping it', () => {
  const f = makeEvidenceFixture(['CT shows spiculation in lung cancer.', 'MRI context begins here and', 'continues in this sentence.']);
  sourceUnits(f);
  const value = structuredClone(f.submission), context = { ...f.context, evidencePolicyVersion: VISUAL_STATEMENT_POLICY_VERSION };
  value.modality = { value: 'MRI', status: 'source_observed', evidence: [{ block_id: f.document.blocks[1]!.block_id, exact_quote: f.document.blocks[1]!.text }] };
  value.context_fragments = f.document.blocks.slice(1).map(b => ({ block_id: b.block_id, exact_quote: b.text }));
  const result = validateEvidenceSubmission(value, context); assert.equal(result.accepted, true, JSON.stringify(result.issues));
  assert.deepEqual(result.record!.modality.evidence.map(fragment), value.modality.evidence.map(v => ({ ...v, occurrence: 0 })));
  assert.equal(result.record!.context.fragments.map(v => v.exact_quote).join('\n'), value.context_fragments.map(v => v.exact_quote).join('\n'));
  assert.equal(buildEvidenceDelivery(f.document, [{ record: result.record!, version: 1, status: 'active', actor: 'automatic' }]).records.length, 1);
});

test('a delivery refusal preserves raw result and real completion facts without a rejected delivery', async () => {
  const f = makeEvidenceFixture(['CT shows spiculation in lung cancer.', 'MRI context begins here and', 'continues in this sentence.']);
  sourceUnits(f);
  const validated = validateEvidenceSubmission(f.submission, { ...f.context, evidencePolicyVersion: VISUAL_STATEMENT_POLICY_VERSION });
  assert.equal(validated.accepted, true);
  const bad = structuredClone(validated.record!);
  bad.context.fragments.push(locateEvidenceFragment(f.document, { block_id: f.document.blocks[1]!.block_id, exact_quote: f.document.blocks[1]!.text }));
  assert.ok(visualStatementIssues(f.document, bad, bad.quote_span.segments, bad.context.fragments, [], []).some(i => i.code === 'incomplete_context_statement'));
  class SavedInvalidStore extends ExtractionStore {
    override transition(runId: string, next: Parameters<ExtractionStore['transition']>[1]) {
      super.transition(runId, next);
      if (next === 'extracting') this.apply(runId, reconcileEvidence(bad, [])); // Replica of an already persisted pre-fix record.
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'delivery-persist-'));
  const server = await createRuntimeResponsesFixture([
    { calls: [{ name: 'read_document_blocks', arguments: {} }] },
    { calls: [{ name: 'submit_candidate_records', arguments: { records: [], batch_complete: true } }] },
    { calls: [{ name: 'get_document_context', arguments: {} }] },
    { calls: [{ name: 'submit_candidate_records', arguments: { summary: 'Local saved-record transport fixture.', reviews: [], links: [], updates: [], summary_complete: true } }] },
  ], { summaryAssessments: () => store.current(f.input.run_id).map(v => ({ record_id: v.record.record_id,
    expected_version: v.version, issue_codes: [], primary_assessment: 'uncertain' })) });
  const store = new SavedInvalidStore(':memory:');
  try {
    const result = await runExtractionDocument({ input: f.input, document: f.document, metadata: f.context.metadata, catalog: f.catalog,
      config: server.config, profile: developmentProfile(server.config.modelId), budget: new ExtractionBudget(join(directory, 'ledger.json'), server.endpoint),
      store, directory: join(directory, 'run'), strategy: 'baseline' });
    assert.equal(result.error?.code, 'delivery_visual_statement_policy_failed'); assert.equal(result.state, 'partial');
    assert.equal(result.task_processing_complete, false); assert.equal(result.coverage.selected_source_block_processing_complete, true);
    assert.equal(result.coverage.whole_document_summary_complete, true); assert.equal(result.delivery_validation.status, 'rejected');
    assert.equal(result.candidate_count, 1); assert.equal(result.ledger_totals.requests, 4);
    const saved = await json(join(directory, 'run/result.json')); assert.deepEqual(saved.records, result.records);
    assert.equal(saved.error.code, 'delivery_visual_statement_policy_failed'); assert.equal(saved.task_processing_complete, false);
    await assert.rejects(access(join(directory, 'run/delivery.json')));
    assert.deepEqual(store.current(f.input.run_id)[0]!.record.context.fragments, bad.context.fragments);
  } finally { store.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
