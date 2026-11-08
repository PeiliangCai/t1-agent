import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Value } from 'typebox/value';
import { evaluate, maximumMatching, metrics } from '../../evaluation/src/evaluator.js';
import { EvaluationInputSchema, type EvaluationInput } from '../../evaluation/src/contracts.js';

const raw = JSON.parse(readFileSync(new URL('../../evaluation/fixtures/scoring/synthetic-example.json', import.meta.url), 'utf8'));
assert.ok(Value.Check(EvaluationInputSchema, raw));
const example = () => structuredClone(raw) as EvaluationInput;
const one = () => {
  const x = example(), d = x.documents[0]!;
  d.gold_units = [d.gold_units[0]!]; d.predictions = [d.predictions[0]!]; d.adjudication.edges = [d.adjudication.edges[0]!];
  return x;
};

test('maximum matching repairs the greedy trap instead of losing a valid TP', () => {
  const edges = [{ prediction_id: 'p1', gold_unit_id: 'g1' }, { prediction_id: 'p1', gold_unit_id: 'g2' }, { prediction_id: 'p2', gold_unit_id: 'g1' }];
  assert.deepEqual([...maximumMatching(['p1', 'p2'], edges)], [['p1', 'g2'], ['p2', 'g1']]);
});

test('maximum cardinality agrees with exhaustive search on every 3 by 3 graph', () => {
  const predictions = ['p0', 'p1', 'p2'], gold = ['g0', 'g1', 'g2'];
  for (let bits = 0; bits < 512; bits++) {
    const edges = predictions.flatMap((p, i) => gold.filter((_, j) => (bits & (1 << (i * 3 + j))) !== 0).map(g => ({ prediction_id: p, gold_unit_id: g })));
    const brute = (index: number, used: Set<string>): number => {
      if (index === predictions.length) return 0;
      let best = brute(index + 1, used);
      for (const edge of edges.filter(e => e.prediction_id === predictions[index])) {
        if (used.has(edge.gold_unit_id)) continue;
        best = Math.max(best, 1 + brute(index + 1, new Set([...used, edge.gold_unit_id])));
      }
      return best;
    };
    const actual = maximumMatching(predictions, edges);
    assert.equal(actual.size, brute(0, new Set()), `graph ${bits}`);
    assert.equal(new Set(actual.values()).size, actual.size);
    assert.deepEqual([...maximumMatching([...predictions].reverse(), [...edges].reverse())], [...actual]);
  }
});

test('duplicate predictions add FP and never add a second TP for one gold unit', () => {
  const x = one(), d = x.documents[0]!;
  d.predictions.push({ ...structuredClone(d.predictions[0]!), prediction_id: 'p2-duplicate' });
  d.adjudication.edges.push({ ...structuredClone(d.adjudication.edges[0]!), prediction_id: 'p2-duplicate' });
  const r = evaluate(x);
  assert.equal(r.status, 'fixture_scored');
  assert.deepEqual(r.totals, { ...metrics({ tp: 1, fp: 1, fn: 0 }) });
  assert.equal(r.official_acceptance, 'not_assessed'); assert.equal(r.stage_passed, null);
});

test('out-of-scope independent predictions count FP; out-of-scope gold never counts FN', () => {
  const x = one(), d = x.documents[0]!;
  d.gold_units[0]!.scope_review.in_scope = false; d.predictions[0]!.scope_review.in_scope = false; d.adjudication.edges = [];
  const r = evaluate(x);
  assert.deepEqual(r.totals, metrics({ tp: 0, fp: 1, fn: 0 }));
  assert.equal(r.documents[0]!.gold_out_of_scope_excluded, 1);
  assert.deepEqual(r.documents[0]!.out_of_scope_predictions, ['p1']);
});

test('failed/partial/cancelled/interrupted papers retain all their missed gold', () => {
  const x = one(), original = x.documents[0]!;
  x.documents = ['failed', 'partial', 'cancelled', 'interrupted'].map((state, i) => {
    const d = structuredClone(original); d.document_id = 'doc-' + i;
    d.prediction_run.state = state as typeof d.prediction_run.state; d.predictions = []; d.adjudication.edges = [];
    return d;
  });
  const r = evaluate(x);
  assert.equal(r.documents.length, 4); assert.ok(r.documents.every(d => d.failed_or_incomplete));
  assert.deepEqual(r.totals, metrics({ tp: 0, fp: 0, fn: 4 }));
});

test('multiple cross-page/block segments remain a single evidence unit', () => {
  const x = one(), d = x.documents[0]!;
  assert.equal(d.gold_units[0]!.segments.length, 2);
  d.predictions[0]!.segments.push({ ...d.predictions[0]!.segments[0]!, block_id: 'overlap-chunk-copy' });
  const r = evaluate(x);
  assert.deepEqual(r.totals, metrics({ tp: 1, fp: 0, fn: 0 }));
  assert.equal(r.documents[0]!.gold_in_scope, 1);
});

test('duplicated canonical gold IDs or prediction record IDs are invalid inputs', () => {
  const x = one(), d = x.documents[0]!;
  d.gold_units.push(structuredClone(d.gold_units[0]!));
  assert.ok(evaluate(x).reasons.some(s => s.includes('duplicate_gold_evidence_unit_id')));
  d.gold_units.pop(); d.predictions.push(structuredClone(d.predictions[0]!));
  assert.ok(evaluate(x).reasons.some(s => s.includes('duplicate_prediction_record_id')));
  assert.equal(evaluate(x).totals, null);
});

test('unknown, duplicated or contradictory matching edges cannot silently affect scores', () => {
  const x = one(), d = x.documents[0]!;
  d.adjudication.edges[0]!.gold_unit_id = 'missing';
  assert.equal(evaluate(x).status, 'invalid_input');
  assert.ok(evaluate(x).reasons.some(s => s.includes('match_edge_unknown_record')));
  d.adjudication.edges[0]!.gold_unit_id = 'g1';
  d.adjudication.edges.push({ ...structuredClone(d.adjudication.edges[0]!), decision: 'no_match' });
  assert.ok(evaluate(x).reasons.some(s => s.includes('duplicate_or_conflicting_match_edge')));
});

test('a positive edge cannot override a failed context or scope check', () => {
  const x = one(), d = x.documents[0]!;
  for (const check of Object.keys(d.adjudication.edges[0]!.context_checks) as (keyof typeof d.adjudication.edges[0]['context_checks'])[]) {
    const y = structuredClone(x); y.documents[0]!.adjudication.edges[0]!.context_checks[check] = false;
    assert.ok(evaluate(y).reasons.some(s => s.includes('match_edge_conflicts_with_scope_or_context')));
  }
  d.predictions[0]!.scope_review.in_scope = false;
  assert.equal(evaluate(x).status, 'invalid_input');
});

test('identical text is not automatically a medical semantic match', () => {
  const x = one(), d = x.documents[0]!;
  assert.deepEqual(d.predictions[0]!.segments, d.gold_units[0]!.segments);
  d.adjudication.edges[0]!.decision = 'no_match';
  const r = evaluate(x);
  assert.deepEqual(r.totals, metrics({ tp: 0, fp: 1, fn: 1 }));
  assert.equal(r.semantic_matching, 'human_adjudicated_edges_only_no_string_or_model_inference');
});

test('zero denominators yield null/not applicable, never fabricated full marks', () => {
  for (const c of [{ tp: 0, fp: 0, fn: 0 }, { tp: 0, fp: 0, fn: 1 }, { tp: 0, fp: 1, fn: 0 }]) {
    const m = metrics(c);
    assert.equal(m.precision, c.fp === 0 ? null : 0);
    assert.equal(m.recall, c.fn === 0 ? null : 0);
  }
  const x = one(), d = x.documents[0]!;
  d.gold_units = []; d.predictions = []; d.adjudication.edges = [];
  assert.deepEqual(evaluate(x).totals, metrics({ tp: 0, fp: 0, fn: 0 }));
});

test('fixture/real or purpose mixing is rejected even for otherwise complete sample inputs', () => {
  const x = one(); x.documents[0]!.gold_units[0]!.fixture = false;
  assert.ok(evaluate(x).reasons.some(s => s.includes('mixed_real_and_fixture')));
  const y = one(); y.purpose = 'development_measurement';
  assert.ok(evaluate(y).reasons.includes('fixture_purpose_mismatch'));
});

test('empty real preparation template is not evaluable and has no metrics or acceptance result', () => {
  const x = JSON.parse(readFileSync(new URL('../../evaluation/fixtures/scoring/unevaluable-real-input.json', import.meta.url), 'utf8'));
  const r = evaluate(x);
  assert.equal(r.status, 'not_evaluable'); assert.equal(r.fixture, false);
  assert.equal(r.totals, null); assert.equal(r.stage_passed, null); assert.equal(r.official_acceptance, 'not_assessed');
  assert.ok(r.reasons.includes('no_documents_no_complete_human_gold'));
  assert.ok(r.reasons.includes('scoring_rules_pending_confirmation'));
});

test('missing full human annotation, medical review and matching adjudication cannot yield real scores', () => {
  // Deliberately incomplete real-shaped input, used only as a negative engineering test. No reviewer is fabricated.
  const x = one(), d = x.documents[0]!;
  x.fixture = false; x.purpose = 'development_measurement'; d.fixture = false;
  d.annotation.status = 'pending'; d.annotation.medical_review.status = 'pending';
  d.adjudication.review.status = 'pending'; d.adjudication.edges = [];
  for (const u of [...d.gold_units, ...d.predictions]) { u.fixture = false; u.scope_review.status = 'pending'; }
  const r = evaluate(x);
  assert.equal(r.status, 'not_evaluable'); assert.equal(r.totals, null);
  for (const gate of ['independent_full_text_annotation_incomplete', 'medical_gold_review_pending', 'matching_adjudication_incomplete', 'scope_adjudication_pending']) {
    assert.ok(r.reasons.some(s => s.includes(gate)), gate);
  }
});

test('one unadjudicated document prevents partial corpus scoring that could hide omissions', () => {
  const x = one(); x.documents[0]!.adjudication.all_gold_reviewed = false;
  const r = evaluate(x);
  assert.equal(r.status, 'not_evaluable'); assert.equal(r.totals, null); assert.deepEqual(r.documents, []);
});

test('selected-empty scope is rejected without widening it', () => {
  const x = one(); x.scope.features.mode = 'selected';
  assert.equal(evaluate(x).status, 'invalid_input'); assert.equal(x.scope.features.mode, 'selected');
});

test('segment offsets and original physical-page requirements reject invalid mappings', () => {
  const x = one(), segment = x.documents[0]!.gold_units[0]!.segments[0]!;
  segment.start = 3; segment.end = 2;
  assert.ok(evaluate(x).reasons.some(s => s.includes('invalid_segment_offsets')));
  segment.start = 0; segment.end = 3; segment.text_version = null;
  assert.ok(evaluate(x).reasons.some(s => s.includes('offset_mapping_missing')));
});

test('overall and stratum counts include failed documents and preserve matches/basis', () => {
  const x = one(), d = structuredClone(x.documents[0]!); d.document_id = 'failed-2'; d.strata.language = 'other-synthetic';
  d.prediction_run.state = 'failed'; d.predictions = []; d.adjudication.edges = []; x.documents.push(d);
  const r = evaluate(x);
  assert.deepEqual(r.totals, metrics({ tp: 1, fp: 0, fn: 1 }));
  assert.equal(r.by_stratum.find(s => s.dimension === 'language' && s.value === 'other-synthetic')!.metrics.fn, 1);
  assert.equal(r.documents.find(d => d.document_id === 'synthetic-document-1')!.matched_pairs[0]!.basis, 'synthetic_fixture');
  assert.deepEqual(evaluate(structuredClone(x)), r);
});

test('malformed or extra fields cannot become valid scores', () => {
  assert.equal(evaluate({ ...one(), invented: true }).status, 'invalid_input');
  assert.equal(evaluate(null).status, 'invalid_input');
});
