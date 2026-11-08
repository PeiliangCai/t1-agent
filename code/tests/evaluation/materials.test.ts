import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Value } from 'typebox/value';
import { SourceManifestSchema, SplitManifestSchema, type SourceManifest, type SplitManifest } from '../../evaluation/src/contracts.js';
import { manifestIssues } from '../../evaluation/src/manifests.js';

const read = (path: string) => JSON.parse(readFileSync(new URL('../../' + path, import.meta.url), 'utf8'));
const sources = read('evaluation/manifests/source-register.json') as SourceManifest;
const splits = read('evaluation/manifests/family-split-draft.json') as SplitManifest;

test('the complete source register and family draft meet the contracts without sealing exposed papers', () => {
  assert.ok(Value.Check(SourceManifestSchema, sources)); assert.ok(Value.Check(SplitManifestSchema, splits));
  assert.deepEqual(manifestIssues(sources, splits), []);
  assert.equal(sources.sources.length, 14); assert.equal(splits.assignments.length, 13);
  assert.equal(sources.independent_acceptance_source_count, 0); assert.deepEqual(splits.acceptance_seal.source_ids, []);
  assert.ok(sources.sources.every(s => !s.exposure.independent_acceptance_eligible && s.annotation_status === 'pending' && s.medical_review_status === 'pending'));
});

test('MED04 and L07 share a family and cannot be split across development and regression', () => {
  const family = sources.sources.find(s => s.source_id === 'MED04')!.article_family_id;
  assert.equal(family, sources.sources.find(s => s.source_id === 'L07')!.article_family_id);
  const x = structuredClone(splits), i = x.assignments.findIndex(a => a.article_family_id === family);
  x.assignments.splice(i, 1, { article_family_id: family, source_ids: ['MED04'], split: 'development', status: 'candidate_only', reason: 'negative leakage test' },
    { article_family_id: family, source_ids: ['L07'], split: 'regression', status: 'candidate_only', reason: 'negative leakage test' });
  assert.ok(manifestIssues(sources, x).some(s => s.includes('article_family_crosses_splits')));
});

test('historically exposed sources cannot be re-labelled independent acceptance', () => {
  const x = structuredClone(splits); x.assignments[0]!.split = 'independent_acceptance';
  assert.ok(manifestIssues(sources, x).some(s => s.startsWith('exposed_source_not_independent:')));
});

test('current file bytes match this round and old hashes/pages do not stand in for absent files', () => {
  for (const source of sources.sources) {
    if (source.access.file_verified) {
      const bytes = readFileSync(new URL('../../' + source.access.local_path!, import.meta.url));
      assert.equal(bytes.subarray(0, 5).toString(), '%PDF-'); assert.equal(bytes.length, source.access.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), source.access.sha256);
    } else {
      assert.equal(source.access.sha256, null); assert.equal(source.access.bytes, null); assert.equal(source.current_composition.physical_pages, null);
    }
  }
  const x = structuredClone(sources), source = x.sources.find(s => !s.access.file_verified)!;
  source.access.sha256 = '0'.repeat(64);
  assert.ok(manifestIssues(x, splits).some(s => s.includes('historical_values_must_not_be_current')));
});

test('35 historical IDs and source records are retained; no draft becomes the product catalog', () => {
  const old = read('../方案/首批医学影像特征清单.json');
  const draft = read('evaluation/catalog/feature-screening-draft.json');
  assert.equal(draft.features.length, 35);
  assert.deepEqual(draft.features.map((f: any) => f.historical_record), old.features);
  assert.ok(draft.features.every((f: any) => !f.product_default_catalog_enabled && f.medical_review_status === 'pending'));
  assert.ok(draft.features.filter((f: any) => f.feature_id.startsWith('META')).every((f: any) => f.standalone_eligibility_draft === 'excluded_as_independent_visual_feature'));
  for (const id of ['COLON04', 'RECT05', 'RECT06']) {
    assert.equal(draft.features.find((f: any) => f.feature_id === id).screening_class_draft, 'mixed_visual_description_or_clinical_conclusion');
  }
  const product = read('resources/feature-catalog/engineering-demo.json');
  assert.equal(product.fixture, true); assert.equal(product.catalog_version, 'engineering-demo-1');
});
