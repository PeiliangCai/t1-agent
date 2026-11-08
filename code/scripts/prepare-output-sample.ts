import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { ContractError, type EvidenceVersion, type FigureAssetCatalog } from '@t1/contracts';
import { assertParsedDocument } from '../packages/agent/src/parser.js';
import { assertLivePdfSource } from '../packages/agent/src/figure-assets.js';
import { buildEvidenceDelivery, auditOutputSample } from '../packages/agent/src/evidence-delivery.js';
import { prepareOutputSample } from '../evaluation/src/output-sampling.js';
import type { ExtractionDocument } from '../packages/agent/src/article-scope.js';

const args = process.argv.slice(2), flags = new Map<string, string>();
if (args[0] === '--help') {
  process.stdout.write('prepare-output-sample.ts --document IR --result RESULT [--figure-catalog FILE] --count N --seed TEXT --method DESCRIPTION --output NEW_FILE\nCount is a user-selected working sample, not a medical acceptance threshold; no reviewer is filled automatically.\n'); process.exit(0);
}
for (let i = 0; i < args.length; i += 2) {
  if (!['--document', '--result', '--figure-catalog', '--count', '--seed', '--method', '--output'].includes(args[i]!) ||
    !args[i + 1] || flags.has(args[i]!)) throw new ContractError('sample_arguments_invalid'); flags.set(args[i]!, args[i + 1]!);
}
for (const flag of ['--document', '--result', '--count', '--seed', '--method', '--output']) if (!flags.has(flag)) throw new ContractError('sample_argument_required');
const code = await realpath(process.cwd()), output = resolve(flags.get('--output')!), parent = await realpath(dirname(output)), rel = relative(code, parent);
if (rel.startsWith('..') || isAbsolute(rel)) throw new ContractError('sample_output_outside_code');
const load = async (flag: string) => JSON.parse(await readFile(resolve(flags.get(flag)!), 'utf8'));
const parsed = await load('--document'), document = (parsed.document ?? parsed) as ExtractionDocument; assertParsedDocument(document); await assertLivePdfSource(document);
const result = await load('--result'), versions = (result.versions ?? result.records) as EvidenceVersion[];
if (!Array.isArray(versions)) throw new ContractError('sample_versioned_result_required');
const catalog = flags.has('--figure-catalog') ? await load('--figure-catalog') as FigureAssetCatalog : undefined;
const delivery = buildEvidenceDelivery(document, versions, catalog);
const prepared = prepareOutputSample(delivery, { count: Number(flags.get('--count')), seed: flags.get('--seed')!, selectionMethod: flags.get('--method')! });
await writeFile(output, JSON.stringify({ ...prepared, run_coverage: result.coverage ?? null, before_human_review: auditOutputSample(delivery) }, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ output: relative(code, output), selected: prepared.selected_count, actual_human_reviewed: 0, paid_calls: 0, stage_passed: false }) + '\n');
