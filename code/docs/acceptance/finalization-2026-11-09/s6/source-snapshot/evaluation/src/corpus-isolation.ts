import { createHash } from 'node:crypto';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { ContractError } from '@t1/contracts';
import type { SourceManifest } from './contracts.js';

const closed = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 200 });
const nullable = Type.Union([id, Type.Null()]);
const date = Type.String({ minLength: 1 });
const sha = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const IndependentPaperSchema = Type.Object({
  source_id: id, article_family_id: id, doi: nullable, title: id,
  source_url: id, registered_at: date,
  file: Type.Object({ path: id, sha256: sha, bytes: Type.Integer({ minimum: 6 }) }, closed),
  identity_review: Type.Object({ status: Type.Enum(['pending', 'confirmed']), actor: nullable, checked_at: nullable }, closed),
  state: Type.Enum(['registered', 'sealed', 'exposed']),
  seal: Type.Union([Type.Object({ actor: id, sealed_at: date, identity_sha256: sha }, closed), Type.Null()]),
  exposures: Type.Array(Type.Object({ purpose: Type.Enum(['development', 'selection', 'regression', 'independent_acceptance']),
    actor: id, recorded_at: date, evidence: id }, closed)),
}, closed);
export const IndependentCorpusSchema = Type.Object({
  schema_version: Type.Literal('independent-corpus-1'),
  purpose: Type.Literal('new_unexposed_papers_only'),
  formal_sample_count: Type.Null(), medical_quality_approved: Type.Literal(false),
  papers: Type.Array(IndependentPaperSchema),
}, closed);
export type IndependentPaper = Static<typeof IndependentPaperSchema>;
export type IndependentCorpus = Static<typeof IndependentCorpusSchema>;

export const normalizeDoi = (value: string | null) => value?.trim().toLowerCase()
  .replace(/^https?:\/\/(?:dx\.)?doi\.org\//u, '').replace(/^doi:\s*/u, '') || null;
export function independentIdentityDigest(paper: IndependentPaper): string {
  return createHash('sha256').update(JSON.stringify({ source_id: paper.source_id, article_family_id: paper.article_family_id,
    doi: normalizeDoi(paper.doi), title: paper.title, source_url: paper.source_url, file: paper.file,
    registered_at: paper.registered_at, identity_review: paper.identity_review })).digest('hex');
}
const badDate = (value: string) => !Number.isFinite(Date.parse(value));

/** Separation and identity checks only; this cannot verify a medical scope or an unknown paper family. */
export function independentCorpusIssues(value: unknown, historical: SourceManifest): string[] {
  if (!Value.Check(IndependentCorpusSchema, value)) return ['independent_corpus_schema_invalid'];
  const issues: string[] = [], seen = new Set<string>();
  for (const paper of value.papers) {
    const prefix = paper.source_id + ':';
    if (seen.has(paper.source_id)) issues.push(prefix + 'duplicate_source_id');
    seen.add(paper.source_id);
    if (!/^[A-Za-z0-9._-]{1,120}$/u.test(paper.source_id) ||
      paper.file.path !== `evaluation/corpus/independent-sealed/${paper.source_id}.pdf`) issues.push(prefix + 'independent_path_invalid');
    if (badDate(paper.registered_at)) issues.push(prefix + 'registration_date_invalid');
    const doi = normalizeDoi(paper.doi);
    if (historical.sources.some(s => s.source_id === paper.source_id || s.article_family_id === paper.article_family_id ||
      s.access.sha256 === paper.file.sha256 || doi !== null && normalizeDoi(s.doi) === doi)) issues.push(prefix + 'historical_exposure_collision');
    if (value.papers.some(other => other !== paper && (other.article_family_id === paper.article_family_id ||
      other.file.sha256 === paper.file.sha256 || doi !== null && normalizeDoi(other.doi) === doi))) issues.push(prefix + 'duplicate_article_family');
    if (paper.identity_review.status === 'confirmed' && (!paper.identity_review.actor || !paper.identity_review.checked_at ||
      badDate(paper.identity_review.checked_at))) issues.push(prefix + 'identity_review_provenance_missing');
    if (paper.state === 'registered' && paper.seal !== null) issues.push(prefix + 'registered_paper_has_seal');
    if (paper.state === 'sealed' && (!paper.seal || paper.exposures.length || paper.identity_review.status !== 'confirmed')) issues.push(prefix + 'sealed_paper_not_isolated');
    if (paper.seal && (badDate(paper.seal.sealed_at) || paper.seal.identity_sha256 !== independentIdentityDigest(paper))) issues.push(prefix + 'seal_identity_changed');
    if (paper.exposures.some(e => badDate(e.recorded_at))) issues.push(prefix + 'exposure_date_invalid');
    if (paper.exposures.length && paper.state !== 'exposed' || paper.state === 'exposed' && !paper.exposures.length) issues.push(prefix + 'exposure_state_mismatch');
  }
  return [...new Set(issues)].sort();
}

export function assertIndependentCorpus(corpus: unknown, historical: SourceManifest): asserts corpus is IndependentCorpus {
  const issues = independentCorpusIssues(corpus, historical);
  if (issues.length) throw new ContractError('independent_corpus_invalid:' + issues.join(','));
}
export function assertIndependentUse(corpus: IndependentCorpus, historical: SourceManifest, sourceId: string,
  purpose: IndependentPaper['exposures'][number]['purpose']): IndependentPaper {
  assertIndependentCorpus(corpus, historical);
  const paper = corpus.papers.find(p => p.source_id === sourceId);
  if (!paper) throw new ContractError('independent_source_missing');
  if (purpose !== 'independent_acceptance') throw new ContractError('independent_corpus_forbidden_for_development_or_selection');
  if (!paper.seal || paper.identity_review.status !== 'confirmed' || paper.state === 'registered' ||
    paper.exposures.some(e => e.purpose !== 'independent_acceptance')) throw new ContractError('independent_source_not_sealed_or_exposed');
  return paper;
}

/** Registering an exposure never relabels the paper as clean again. */
export function recordIndependentExposure(corpus: IndependentCorpus, historical: SourceManifest, sourceId: string,
  exposure: IndependentPaper['exposures'][number]): IndependentCorpus {
  assertIndependentCorpus(corpus, historical);
  const copy = structuredClone(corpus), paper = copy.papers.find(p => p.source_id === sourceId);
  if (!paper) throw new ContractError('independent_source_missing');
  paper.exposures.push(exposure); paper.state = 'exposed';
  assertIndependentCorpus(copy, historical); return copy;
}
