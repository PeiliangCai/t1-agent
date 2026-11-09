import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath, rename } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { ContractError } from '@t1/contracts';
import type { SourceManifest } from '../evaluation/src/contracts.js';
import { assertIndependentCorpus, independentIdentityDigest, recordIndependentExposure, type IndependentCorpus, type IndependentPaper } from '../evaluation/src/corpus-isolation.js';

const args = process.argv.slice(2);
if (args[0] === '--help') {
  process.stdout.write('independent-corpus.ts inspect | register --metadata FILE --pdf FILE | seal --source-id ID --actor REAL_IDENTITY_CHECKER | expose --source-id ID --purpose development|selection|regression|independent_acceptance --actor ACTOR --evidence POINTER\nRegisters new files in evaluation/corpus/independent-sealed; old exposed papers are rejected. Identity checks do not approve medical applicability.\n');
  process.exit(0);
}
const action = args.shift() ?? 'inspect', flags = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  if (!['--metadata', '--pdf', '--source-id', '--actor', '--purpose', '--evidence'].includes(args[i]!) || !args[i + 1] || flags.has(args[i]!)) throw new ContractError('independent_arguments_invalid');
  flags.set(args[i]!, args[i + 1]!);
}
const code = await realpath(process.cwd()), path = resolve(code, 'evaluation/manifests/independent-intake.json');
const original = await readFile(path, 'utf8'); let corpus = JSON.parse(original) as IndependentCorpus;
const historical = JSON.parse(await readFile('evaluation/manifests/source-register.json', 'utf8')) as SourceManifest;
assertIndependentCorpus(corpus, historical);
for (const paper of corpus.papers) {
  const file = await realpath(resolve(code, paper.file.path)), rel = relative(code, file);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new ContractError('independent_file_outside_code');
  const bytes = await readFile(file);
  if (bytes.length !== paper.file.bytes || createHash('sha256').update(bytes).digest('hex') !== paper.file.sha256) throw new ContractError('independent_file_changed');
}
const now = new Date().toISOString();
if (action === 'register') {
  if (!flags.get('--metadata') || !flags.get('--pdf') || flags.size !== 2) throw new ContractError('independent_register_arguments_required');
  const metadata = JSON.parse(await readFile(flags.get('--metadata')!, 'utf8')) as Pick<IndependentPaper, 'source_id' | 'article_family_id' | 'doi' | 'title' | 'source_url'>;
  if (!/^[A-Za-z0-9._-]{1,120}$/u.test(metadata.source_id)) throw new ContractError('independent_source_id_invalid');
  const bytes = await readFile(flags.get('--pdf')!);
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new ContractError('independent_pdf_required');
  const paper: IndependentPaper = { ...metadata, registered_at: now, file: { path: `evaluation/corpus/independent-sealed/${metadata.source_id}.pdf`,
    sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }, identity_review: { status: 'pending', actor: null, checked_at: null },
    state: 'registered', seal: null, exposures: [] };
  corpus.papers.push(paper); assertIndependentCorpus(corpus, historical);
  await mkdir(resolve(code, 'evaluation/corpus/independent-sealed'), { recursive: true, mode: 0o700 });
  await writeFile(resolve(code, paper.file.path), bytes, { flag: 'wx', mode: 0o600 });
} else if (action === 'seal') {
  if (!flags.get('--source-id') || !flags.get('--actor')?.trim() || flags.size !== 2) throw new ContractError('independent_seal_identity_checker_required');
  const paper = corpus.papers.find(p => p.source_id === flags.get('--source-id'));
  if (!paper || paper.state !== 'registered' || paper.exposures.length) throw new ContractError('independent_paper_not_clean_registered');
  paper.identity_review = { status: 'confirmed', actor: flags.get('--actor')!, checked_at: now };
  paper.seal = { actor: flags.get('--actor')!, sealed_at: now, identity_sha256: independentIdentityDigest(paper) }; paper.state = 'sealed';
  assertIndependentCorpus(corpus, historical);
} else if (action === 'expose') {
  const purpose = flags.get('--purpose');
  if (!flags.get('--source-id') || !flags.get('--actor')?.trim() || !flags.get('--evidence')?.trim() || flags.size !== 4 ||
    !purpose || !['development', 'selection', 'regression', 'independent_acceptance'].includes(purpose)) throw new ContractError('independent_exposure_arguments_required');
  corpus = recordIndependentExposure(corpus, historical, flags.get('--source-id')!, {
    purpose: purpose as IndependentPaper['exposures'][number]['purpose'], actor: flags.get('--actor')!,
    recorded_at: now, evidence: flags.get('--evidence')! });
} else if (action !== 'inspect' || flags.size) throw new ContractError('independent_action_invalid');
if (action !== 'inspect') {
  if (await readFile(path, 'utf8') !== original) throw new ContractError('independent_manifest_concurrent_change');
  const tmp = path + '.tmp'; await writeFile(tmp, JSON.stringify(corpus, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(tmp, path);
}
process.stdout.write(JSON.stringify({ action, registered: corpus.papers.length, sealed: corpus.papers.filter(p => p.state === 'sealed').length,
  exposed: corpus.papers.filter(p => p.state === 'exposed').length, formal_sample_count: null, medical_quality_approved: false, paid_calls: 0 }) + '\n');
