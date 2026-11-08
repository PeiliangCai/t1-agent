import test from 'node:test';
import assert from 'node:assert/strict';
import { containsLiteral, evidenceScopeIssues, matchEvidenceScope } from '../../packages/agent/src/scope-matching.js';
import { makeEvidenceFixture, syntheticApprovedCatalog } from './fixtures/evidence-fixtures.js';

function restricted(line = 'We observed spiculation on CT in lung cancer.') {
  const fixture = makeEvidenceFixture([line]); fixture.catalog = syntheticApprovedCatalog(); fixture.context.catalog = fixture.catalog;
  fixture.input.scope.catalog_version = fixture.catalog.catalog_version;
  fixture.input.scope.cancers = { mode: 'selected', ids: ['lung'] };
  fixture.input.scope.image_types = { mode: 'selected', ids: ['ct'] };
  fixture.input.scope.features = { mode: 'selected', binding_ids: ['spiculation-lung-ct'] };
  fixture.submission.feature_binding_id = 'spiculation-lung-ct';
  return fixture;
}

test('the initial all/all/all scope accepts new terms with an empty unavailable formal catalog', () => {
  const fixture = makeEvidenceFixture();
  const match = matchEvidenceScope(fixture.submission, fixture.input.scope, fixture.catalog);
  assert.equal(match.status, 'in_scope'); assert.equal(match.feature_match, 'new_term'); assert.equal(match.matched_binding_id, null);
  assert.ok(match.issues.includes('new_term_pending_human_review')); assert.equal(match.development_catalog_used, false);
});

test('restricted mode without an approved catalog or bindings is blocked and never widened', () => {
  const fixture = makeEvidenceFixture(); fixture.input.scope.features = { mode: 'selected', binding_ids: ['missing'] };
  let match = matchEvidenceScope(fixture.submission, fixture.input.scope, fixture.catalog);
  assert.equal(match.status, 'blocked'); assert.ok(match.issues.includes('restricted_scope_requires_approved_catalog'));
  assert.equal(fixture.input.scope.features.mode, 'selected'); assert.deepEqual(fixture.input.scope.features.binding_ids, ['missing']);
  const strict = restricted(); strict.catalog.bindings = [];
  match = matchEvidenceScope(strict.submission, strict.input.scope, strict.catalog, { fixture: true });
  assert.equal(match.status, 'blocked'); assert.ok(match.issues.includes('feature_binding_unapproved_or_missing:spiculation-lung-ct'));
});

test('approved taxonomy selections do not require any feature catalog when features are unrestricted', () => {
  const fixture = restricted(); fixture.catalog.features = []; fixture.catalog.bindings = [];
  fixture.input.scope.features = { mode: 'all', binding_ids: [] }; fixture.submission.feature_binding_id = null;
  const match = matchEvidenceScope(fixture.submission, fixture.input.scope, fixture.catalog, { fixture: true });
  assert.equal(match.status, 'in_scope'); assert.equal(match.feature_match, 'new_term'); assert.equal(match.matched_binding_id, null);
});

test('open extraction retains a feature in a different sourced cancer without forcing an existing inapplicable binding', () => {
  const fixture = restricted('We observed spiculation on CT in colon cancer.'); fixture.submission.disease_or_lesion.value = 'colon cancer';
  fixture.input.scope.cancers = { mode: 'all', ids: [] }; fixture.input.scope.features = { mode: 'all', binding_ids: [] };
  fixture.submission.feature_binding_id = null;
  const match = matchEvidenceScope(fixture.submission, fixture.input.scope, fixture.catalog, { fixture: true });
  assert.equal(match.status, 'in_scope'); assert.equal(match.feature_match, 'new_term'); assert.equal(match.matched_binding_id, null);
});

test('selected-empty, invalid selections, version drift and inapplicable upstream changes block the run', () => {
  const fixture = restricted(); fixture.input.scope.features.binding_ids = [];
  assert.ok(evidenceScopeIssues(fixture.input.scope, fixture.catalog, { fixture: true }).includes('features_selected_empty'));
  fixture.input.scope.features.binding_ids = ['spiculation-lung-ct']; fixture.input.scope.cancers.ids = ['colon'];
  assert.ok(evidenceScopeIssues(fixture.input.scope, fixture.catalog, { fixture: true }).includes('feature_binding_cancer_inapplicable:spiculation-lung-ct'));
  fixture.input.scope.catalog_version = 'another-catalog';
  assert.ok(evidenceScopeIssues(fixture.input.scope, fixture.catalog, { fixture: true }).includes('catalog_version_mismatch'));
});

test('canonical names and explicitly approved sourced synonyms match exact selected bindings', () => {
  const fixture = restricted();
  let match = matchEvidenceScope(fixture.submission, fixture.input.scope, fixture.catalog, { fixture: true });
  assert.equal(match.status, 'in_scope'); assert.equal(match.feature_match, 'canonical');
  const alias = restricted('We observed spiculated margin on computed tomography in pulmonary carcinoma.');
  alias.submission.feature_name_raw = 'spiculated margin'; alias.submission.modality.value = 'computed tomography';
  alias.submission.disease_or_lesion.value = 'pulmonary carcinoma';
  match = matchEvidenceScope(alias.submission, alias.input.scope, alias.catalog, { fixture: true });
  assert.equal(match.status, 'in_scope'); assert.equal(match.feature_match, 'synonym');
  assert.equal(match.basis.filter(b => b.kind === 'synonym').length, 3);
  assert.ok(match.basis.every(b => b.source.length > 0));
});

test('draft aliases, feature categories and parent/child terms are not implicit synonyms', () => {
  for (const feature of ['irregular margin', 'margin', 'spiculation severity']) {
    const fixture = restricted(`We observed ${feature} on CT in lung cancer.`); fixture.submission.feature_name_raw = feature;
    const match = matchEvidenceScope(fixture.submission, fixture.input.scope, fixture.catalog, { fixture: true });
    assert.equal(match.status, 'out_of_scope'); assert.ok(match.issues.includes('feature_not_selected_or_explicit_synonym'));
  }
});

test('development catalog usage requires explicit enablement and remains labelled development_only', () => {
  const fixture = restricted(); fixture.catalog.status = 'development_only';
  for (const entry of [...fixture.catalog.cancers, ...fixture.catalog.image_types, ...fixture.catalog.features, ...fixture.catalog.bindings]) {
    entry.approval_status = 'development_only';
  }
  let match = matchEvidenceScope(fixture.submission, fixture.input.scope, fixture.catalog, { fixture: true });
  assert.equal(match.status, 'blocked'); assert.ok(match.issues.includes('development_catalog_requires_explicit_enable'));
  match = matchEvidenceScope(fixture.submission, fixture.input.scope, fixture.catalog, { fixture: true, allowDevelopmentCatalog: true });
  assert.equal(match.status, 'in_scope'); assert.equal(match.development_catalog_used, true);
  assert.equal(fixture.catalog.status, 'development_only');
});

test('the S1 fixture catalog cannot become a real approved medical vocabulary', () => {
  const fixture = restricted();
  const match = matchEvidenceScope(fixture.submission, fixture.input.scope, fixture.catalog, { fixture: false });
  assert.equal(match.status, 'blocked'); assert.ok(match.issues.includes('restricted_scope_requires_approved_catalog'));
});

test('source cancer and modality mismatches are out of scope despite valid user selections', () => {
  const colon = restricted('We observed spiculation on CT in colon cancer.'); colon.submission.disease_or_lesion.value = 'colon cancer';
  const cancerMatch = matchEvidenceScope(colon.submission, colon.input.scope, colon.catalog, { fixture: true });
  assert.equal(cancerMatch.status, 'out_of_scope'); assert.ok(cancerMatch.issues.includes('cancer_out_of_scope'));
  const mri = restricted('We observed spiculation on MRI in lung cancer.'); mri.submission.modality.value = 'MRI';
  const modalityMatch = matchEvidenceScope(mri.submission, mri.input.scope, mri.catalog, { fixture: true });
  assert.equal(modalityMatch.status, 'out_of_scope'); assert.ok(modalityMatch.issues.includes('modality_out_of_scope'));
});

test('unknown source facts need context instead of borrowing the selected cancer or modality', () => {
  const fixture = restricted('We observed spiculation in the lesion.');
  fixture.submission.disease_or_lesion = { value: null, status: 'unknown', evidence: [] };
  fixture.submission.modality = { value: null, status: 'unknown', evidence: [] };
  const match = matchEvidenceScope(fixture.submission, fixture.input.scope, fixture.catalog, { fixture: true });
  assert.equal(match.status, 'needs_context'); assert.ok(match.issues.includes('cancer_not_grounded_in_source'));
  assert.ok(match.issues.includes('modality_not_grounded_in_source')); assert.equal(fixture.submission.disease_or_lesion.value, null);
});

test('a selected binding ID cannot force a different raw source feature into scope', () => {
  const fixture = restricted('We observed lobulation on CT in lung cancer.'); fixture.submission.feature_name_raw = 'lobulation';
  const match = matchEvidenceScope(fixture.submission, fixture.input.scope, fixture.catalog, { fixture: true });
  assert.equal(match.status, 'out_of_scope'); assert.ok(match.issues.includes('feature_binding_not_supported_by_source_name'));
});

test('sequence conditions are checked explicitly and unspecified sequences require context', () => {
  const fixture = restricted('We observed spiculation on CT in lung cancer in the venous phase.');
  fixture.catalog.bindings[0]!.sequence_or_phase_conditions = ['arterial phase'];
  let match = matchEvidenceScope(fixture.submission, fixture.input.scope, fixture.catalog, { fixture: true });
  assert.equal(match.status, 'needs_context'); assert.ok(match.issues.includes('feature_binding_sequence_requires_context'));
  fixture.submission.sequence_or_phase = { value: 'venous phase', status: 'source_observed', evidence: fixture.submission.source_fragments };
  match = matchEvidenceScope(fixture.submission, fixture.input.scope, fixture.catalog, { fixture: true });
  assert.equal(match.status, 'out_of_scope'); assert.ok(match.issues.includes('feature_binding_sequence_mismatch'));
});

test('multiple equally matching bindings need explicit disambiguation and do not take the first', () => {
  const fixture = restricted(); fixture.input.scope.features = { mode: 'all', binding_ids: [] }; fixture.submission.feature_binding_id = null;
  fixture.catalog.bindings.push({ ...fixture.catalog.bindings[0]!, binding_id: 'second-spiculation-binding' });
  const match = matchEvidenceScope(fixture.submission, fixture.input.scope, fixture.catalog, { fixture: true });
  assert.equal(match.status, 'needs_context'); assert.equal(match.matched_binding_id, null); assert.ok(match.issues.includes('feature_binding_ambiguous'));
});

test('a source-less approval entry is unusable and literal matching respects word boundaries', () => {
  const fixture = restricted(); fixture.catalog.features[0]!.source = '';
  assert.equal(matchEvidenceScope(fixture.submission, fixture.input.scope, fixture.catalog, { fixture: true }).status, 'blocked');
  assert.equal(containsLiteral('effect and ACTH', 'CT'), false); assert.equal(containsLiteral('on CT imaging', 'CT'), true);
  assert.equal(containsLiteral('肺癌CT检查', 'CT'), true); assert.equal(containsLiteral('computed  tomography', 'computed tomography'), true);
});
