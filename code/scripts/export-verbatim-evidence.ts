import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DeliveryReview, EvidenceVersion, FigureAssetCatalog, OutputSampleReview } from '@t1/contracts';
import { assertParsedDocument } from '../packages/agent/src/parser.js';
import { allDeliveredRecords, deliveryRecordCounts, exportEvidenceDelivery } from '../packages/agent/src/evidence-delivery.js';
import type { ExtractionDocument } from '../packages/agent/src/article-scope.js';

const args = process.argv.slice(2), allowed = new Set(['--document', '--result', '--figure-catalog', '--reviews', '--sample-review', '--mode', '--directory']);
const flags = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  const key = args[i]!, value = args[i+1];
  if (!allowed.has(key) || !value || flags.has(key)) throw new Error('invalid_export_arguments');
  flags.set(key, value);
}
for (const name of ['--document', '--result', '--mode', '--directory']) if (!flags.has(name)) throw new Error('missing_argument:' + name);
const load = async (name: string) => JSON.parse(await readFile(resolve(flags.get(name)!), 'utf8'));
const payload = await load('--document'), document = (payload.document ?? payload) as ExtractionDocument;
assertParsedDocument(document);
const result = await load('--result');
const versions = (result.versions ?? result.records) as EvidenceVersion[];
if (!Array.isArray(versions)) throw new Error('versioned_extraction_result_required');
const mode = flags.get('--mode'); if (mode !== 'candidates' && mode !== 'approved') throw new Error('export_mode_invalid');
const exported = await exportEvidenceDelivery(document, versions, { codeRoot: process.cwd(), directory: resolve(flags.get('--directory')!), mode,
  catalog: flags.has('--figure-catalog') ? await load('--figure-catalog') as FigureAssetCatalog : undefined,
  reviews: flags.has('--reviews') ? await load('--reviews') as DeliveryReview[] : undefined,
  sampleReview: flags.has('--sample-review') ? await load('--sample-review') as OutputSampleReview : undefined,
  coverage: result.coverage ?? { status: 'not_supplied', full_document_complete_claimed: false } });
process.stdout.write(JSON.stringify({ mode, records: allDeliveredRecords(exported.delivery).length, ...deliveryRecordCounts(exported.delivery), output: flags.get('--directory'), sample: exported.sample.status,
  paid_calls: 0, legacy_artifacts_modified: false })+'\n');
