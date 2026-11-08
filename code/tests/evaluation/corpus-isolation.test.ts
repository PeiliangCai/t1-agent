import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { SourceManifest } from '../../evaluation/src/contracts.js';
import { independentCorpusIssues, independentIdentityDigest, assertIndependentUse, recordIndependentExposure,
  type IndependentCorpus, type IndependentPaper } from '../../evaluation/src/corpus-isolation.js';

const historical = JSON.parse(readFileSync(new URL('../../evaluation/manifests/source-register.json', import.meta.url), 'utf8')) as SourceManifest;
const paper = (): IndependentPaper => ({ source_id: 'UNSEEN-TEST', article_family_id: 'synthetic-not-a-real-paper', doi: '10.0000/fixture',
  title: 'Synthetic identity only', source_url: 'https://example.invalid/fixture', registered_at: '2026-11-04T00:00:00Z',
  file: { path: 'evaluation/corpus/independent-sealed/UNSEEN-TEST.pdf', sha256: '1'.repeat(64), bytes: 99 },
  identity_review: { status: 'confirmed', actor: 'fixture-checker', checked_at: '2026-11-04T00:00:00Z' }, state: 'sealed', seal: null, exposures: [] });
function fixture(): IndependentCorpus {
  const p = paper(); p.seal = { actor: 'fixture-checker', sealed_at: '2026-11-04T00:00:00Z', identity_sha256: independentIdentityDigest(p) };
  return { schema_version: 'independent-corpus-1', purpose: 'new_unexposed_papers_only', formal_sample_count: null, medical_quality_approved: false, papers: [p] };
}
test('the current independent intake is empty; exposed historical papers are not a holdout', () => {
  const current = JSON.parse(readFileSync(new URL('../../evaluation/manifests/independent-intake.json', import.meta.url), 'utf8'));
  assert.deepEqual(independentCorpusIssues(current, historical), []); assert.deepEqual(current.papers, []);
  for (const collision of ['id', 'family', 'sha', 'doi'] as const) {
    const c = fixture(), p = c.papers[0]!, old = historical.sources.find(s => s.doi && s.access.sha256)!;
    if (collision === 'id') { p.source_id = old.source_id; p.file.path = `evaluation/corpus/independent-sealed/${p.source_id}.pdf`; }
    if (collision === 'family') p.article_family_id = old.article_family_id;
    if (collision === 'sha') p.file.sha256 = old.access.sha256!;
    if (collision === 'doi') p.doi = 'https://doi.org/' + old.doi!.toUpperCase();
    p.seal!.identity_sha256 = independentIdentityDigest(p);
    assert.ok(independentCorpusIssues(c, historical).some(i => i.includes('historical_exposure_collision')), collision);
  }
});
test('sealed papers reject development/selection/regression use and changed bytes/identity', () => {
  const c = fixture(); assert.equal(assertIndependentUse(c, historical, 'UNSEEN-TEST', 'independent_acceptance').source_id, 'UNSEEN-TEST');
  for (const use of ['development', 'selection', 'regression'] as const) assert.throws(() => assertIndependentUse(c, historical, 'UNSEEN-TEST', use), /forbidden/);
  const altered = structuredClone(c); altered.papers[0]!.file.sha256 = '2'.repeat(64);
  assert.ok(independentCorpusIssues(altered, historical).some(i => i.includes('seal_identity_changed')));
  const pending = structuredClone(c); pending.papers[0]!.identity_review.status = 'pending';
  assert.ok(independentCorpusIssues(pending, historical).some(i => i.includes('not_isolated')));
});
test('a recorded tuning exposure permanently disqualifies the paper; duplicate families cannot create more independent samples', () => {
  const c = fixture(), changed = recordIndependentExposure(c, historical, 'UNSEEN-TEST', { purpose: 'selection', actor: 'fixture',
    recorded_at: '2026-11-04T01:00:00Z', evidence: 'fixture exposure only' });
  assert.throws(() => assertIndependentUse(changed, historical, 'UNSEEN-TEST', 'independent_acceptance'), /not_sealed_or_exposed/);
  assert.equal(c.papers[0]!.state, 'sealed');
  const other = structuredClone(c.papers[0]!); other.source_id = 'SECOND'; other.file.path = 'evaluation/corpus/independent-sealed/SECOND.pdf';
  other.seal!.identity_sha256 = independentIdentityDigest(other); c.papers.push(other);
  assert.ok(independentCorpusIssues(c, historical).some(i => i.includes('duplicate_article_family')));
});
test('actual isolated CLI registration, identity sealing and exposure retain bytes and never approve medical quality', () => {
  const code = fileURLToPath(new URL('../../', import.meta.url)), directory = mkdtempSync(join(code, '.tools/corpus-cli-fixture-'));
  try {
    mkdirSync(join(directory, 'evaluation/manifests'), { recursive: true });
    writeFileSync(join(directory, 'evaluation/manifests/source-register.json'), JSON.stringify(historical));
    writeFileSync(join(directory, 'evaluation/manifests/independent-intake.json'), JSON.stringify({ schema_version: 'independent-corpus-1',
      purpose: 'new_unexposed_papers_only', formal_sample_count: null, medical_quality_approved: false, papers: [] }));
    writeFileSync(join(directory, 'metadata.json'), JSON.stringify({ source_id: 'CLI-FIXTURE', article_family_id: 'cli-fixture-family', doi: null,
      title: 'Synthetic fixture identity, not a paper', source_url: 'https://example.invalid/fixture' }));
    const bytes = Buffer.from('%PDF-1.7\nSynthetic identity bytes only; no real paper or medical evidence.');
    writeFileSync(join(directory, 'fixture.pdf'), bytes);
    const invoke = (...args: string[]) => {
      const r = spawnSync(process.execPath, ['--import', 'tsx', join(code, 'scripts/independent-corpus.ts'), ...args], {
        cwd: directory, encoding: 'utf8', timeout: 15000 }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
    };
    assert.equal(invoke('register', '--metadata', 'metadata.json', '--pdf', 'fixture.pdf').registered, 1);
    assert.equal(invoke('seal', '--source-id', 'CLI-FIXTURE', '--actor', 'fixture-identity-check-only').sealed, 1);
    assert.deepEqual(readFileSync(join(directory, 'evaluation/corpus/independent-sealed/CLI-FIXTURE.pdf')), bytes);
    const done = invoke('expose', '--source-id', 'CLI-FIXTURE', '--purpose', 'selection', '--actor', 'fixture', '--evidence', 'synthetic-test-only');
    assert.equal(done.exposed, 1); assert.equal(done.medical_quality_approved, false);
    const corpus = JSON.parse(readFileSync(join(directory, 'evaluation/manifests/independent-intake.json'), 'utf8'));
    assert.throws(() => assertIndependentUse(corpus, historical, 'CLI-FIXTURE', 'independent_acceptance'), /not_sealed_or_exposed/);
    assert.equal(invoke('inspect').medical_quality_approved, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
