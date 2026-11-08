/** General local-PDF entry. No run config means CPU preparation only, with zero model/API calls. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { ContractError, defaultScope, type EvidenceCatalog, type FigureAssetCatalog, type RunInput, type Scope } from '@t1/contracts';
import { createConfiguredPdfParserAdapter } from '../packages/agent/src/parser-selection.js';
import { assertLivePdfSource, discoverPdfFigures } from '../packages/agent/src/figure-assets.js';
import { buildEvidenceDelivery, exportEvidenceDelivery } from '../packages/agent/src/evidence-delivery.js';
import { safeError, loadModelConfig } from '../packages/agent/src/config.js';
import { ExtractionBudget, type ExtractionBudgetOptions } from '../packages/agent/src/extraction-budget.js';
import { ExtractionStore } from '../packages/agent/src/extraction-store.js';
import { developmentProfile } from '../packages/agent/src/extraction-pi.js';
import { runExtractionDocument } from '../packages/agent/src/extraction-run.js';
import { isSourceSelectionCondition, type SourceSelectionCondition } from '../packages/agent/src/source-selection.js';

interface RunConfig {
  schema_version: 'paper-extraction-run-config-1'; status: 'authorized'; execute_model_calls: true;
  model_id: string; reasoning_effort: 'medium'; api: 'openai-responses' | 'openai-completions';
  scope?: Scope; catalog?: EvidenceCatalog; source_selection: SourceSelectionCondition;
  budget: Required<Pick<ExtractionBudgetOptions, 'limits' | 'authorization'>> & Pick<ExtractionBudgetOptions, 'responseModelAliasPolicy'>;
}
const args = process.argv.slice(2), flags = new Map<string, string>();
if (args.length === 1 && args[0] === '--help') {
  process.stdout.write('node --import tsx scripts/extract-paper.ts --pdf FILE --document-id ID --directory NEW_DIRECTORY [--run-config NEW_AUTHORIZED_CONFIG.json]\nWithout --run-config: local CPU PDF/IR/Figure preparation only, no model/API calls.\n');
  process.exit(0);
}
for (let i = 0; i < args.length; i += 2) {
  const name = args[i]!, value = args[i+1];
  if (!['--pdf', '--document-id', '--directory', '--run-config'].includes(name) || !value || flags.has(name)) throw new ContractError('invalid_paper_cli_arguments');
  flags.set(name, value);
}
for (const name of ['--pdf', '--document-id', '--directory']) if (!flags.has(name)) throw new ContractError('missing_paper_cli_argument');
let phase = 'input', budget: ExtractionBudget | undefined, store: ExtractionStore | undefined;
try {
  const code = await realpath(process.cwd()), directory = resolve(flags.get('--directory')!);
  const parent = await realpath(dirname(directory)), rel = relative(code, parent);
  if (rel.startsWith('..') || isAbsolute(rel) || !relative(code, directory) || relative(code, directory).startsWith('..')) throw new ContractError('paper_output_outside_code');
  const documentId = flags.get('--document-id')!;
  if (!/^[A-Za-z0-9._-]{1,120}$/u.test(documentId)) throw new ContractError('paper_document_id_invalid');
  const pdfPath = await realpath(flags.get('--pdf')!), pdfRel = relative(code, pdfPath);
  if (pdfRel.startsWith('..') || isAbsolute(pdfRel)) throw new ContractError('paper_pdf_outside_code');
  const pdfBytes = await readFile(pdfPath), pdfSha = createHash('sha256').update(pdfBytes).digest('hex');
  let runConfig: RunConfig | undefined;
  if (flags.has('--run-config')) {
    runConfig = JSON.parse(await readFile(flags.get('--run-config')!, 'utf8')) as RunConfig;
    if (runConfig.schema_version !== 'paper-extraction-run-config-1' || runConfig.status !== 'authorized' || runConfig.execute_model_calls !== true ||
      !/^[A-Za-z0-9_./:@+-]{1,160}$/u.test(runConfig.model_id) || runConfig.reasoning_effort !== 'medium' ||
      !['openai-responses', 'openai-completions'].includes(runConfig.api) || !isSourceSelectionCondition(runConfig.source_selection) ||
      !runConfig.budget?.limits || !runConfig.budget.authorization || runConfig.budget.limits.request_seconds !== 120 ||
      runConfig.budget.limits.transient_retries !== 2 || runConfig.budget.limits.response_output_tokens !== 8192 ||
      runConfig.budget.limits.batch_responses > 16 || runConfig.budget.limits.document_seconds > 1800) throw new ContractError('new_explicit_run_configuration_required');
  }
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const runId = `paper-${randomUUID()}`;
  phase = 'parsing';
  const parser = createConfiguredPdfParserAdapter({ logDirectory: resolve(directory, 'parser-logs') });
  const parsed = await parser.parseResult({ run_id: runId, document_id: documentId, file_reference: pdfRel, file_sha256: pdfSha, fixture: false });
  await writeFile(resolve(directory, 'parser-result.json'), JSON.stringify(parsed, null, 2)+'\n', { flag: 'wx' });
  if (!parsed.document) throw new ContractError(parsed.error?.code ?? 'paper_parser_failed');
  const document = parsed.document;
  phase = 'figures';
  let figureCatalog: FigureAssetCatalog | undefined, figureStatus: { status: string; error_code?: string };
  try { figureCatalog = await discoverPdfFigures(document, directory); figureStatus = { status: 'local_discovery_complete' }; }
  catch (cause) { await assertLivePdfSource(document); figureStatus = { status: 'failed_text_still_deliverable', error_code: safeError(cause).code }; }
  await writeFile(resolve(directory, 'prepared.json'), JSON.stringify({ schema_version: 'prepared-source-paper-1', run_id: runId,
    document_id: documentId, file_sha256: pdfSha, text_version: document.text_version, parser_status: parsed.status,
    figure_discovery: figureStatus, figure_catalog: figureCatalog ? 'figure-assets/catalog.json' : null,
    model_extraction_performed: false, candidate_count: 0, paid_calls: 0, full_document_extraction_claimed: false,
    next: runConfig ? 'explicit configured extraction' : 'A separate new explicitly authorized run config is needed for model extraction; do not reuse a terminal old experiment.' }, null, 2)+'\n', { flag: 'wx' });
  if (!runConfig) {
    await writeFile(resolve(directory, 'delivery.json'), JSON.stringify(buildEvidenceDelivery(document, [], figureCatalog), null, 2)+'\n', { flag: 'wx' });
    process.stdout.write(JSON.stringify({ status: 'prepared_only_no_model_extraction', directory, parser_status: parsed.status,
      figure_discovery: figureStatus, figure_candidates: figureCatalog?.figures.length ?? 0, paid_calls: 0 })+'\n');
  } else {
    phase = 'extracting';
    const modelConfig = loadModelConfig(), profile = developmentProfile(runConfig.model_id, runConfig.api);
    budget = new ExtractionBudget(resolve(directory, 'call-ledger.json'), modelConfig.baseUrl, Date.now, runConfig.budget);
    store = new ExtractionStore(resolve(directory, 'evidence.sqlite'));
    const catalog: EvidenceCatalog = runConfig.catalog ?? { catalog_version: 'medical-unavailable-1', status: 'unavailable', fixture: false,
      cancers: [], image_types: [], features: [], bindings: [] };
    const scope = runConfig.scope ?? defaultScope(catalog.catalog_version);
    const input: RunInput = { schema_version: '1', run_id: runId, document_id: documentId, file_sha256: pdfSha, fixture: false,
      scope, rule_version: 'verbatim-figure-evidence-1', runtime_profile: { provider: modelConfig.provider, model_id: profile.model_id,
        endpoint: modelConfig.baseUrl, pi_version: '1.4.0', version: profile.profile_version } };
    const result = await runExtractionDocument({ input, document, catalog,
      metadata: { task_id: runId, source_version: { file_sha256: pdfSha, source_kind: 'user_uploaded_public_published_pdf', version: pdfSha, obtained_at: new Date().toISOString() },
        article_family_id: 'file-sha256-'+pdfSha, created_at: new Date().toISOString() },
      config: modelConfig, profile, budget, store, directory: resolve(directory, 'extraction'), strategy: 'baseline',
      sourceSelectionCondition: runConfig.source_selection, figureCatalog, figureDiscovery: 'not_requested',
      documentTimeoutMs: runConfig.budget.limits.document_seconds*1000, batchMaxResponses: runConfig.budget.limits.batch_responses });
    phase = 'exporting';
    await exportEvidenceDelivery(document, store.current(runId), { codeRoot: code, directory: resolve(directory, 'candidate-export'), mode: 'candidates',
      catalog: figureCatalog, coverage: result.coverage });
    process.stdout.write(JSON.stringify({ status: result.state, directory, candidates: result.candidate_count, paid_calls: budget.totals().requests,
      task_processing_complete: result.task_processing_complete, summary_complete: result.coverage.whole_document_summary_complete,
      delivery: 'extraction/delivery.json', candidate_export: 'candidate-export', human_approval: false })+'\n');
  }
} catch (error) {
  const errorCode = error instanceof ContractError ? error.code : (error as NodeJS.ErrnoException)?.code;
  process.stdout.write(JSON.stringify({ status: 'failed', phase, error_code: errorCode ?? 'paper_processing_failed',
    paid_calls: budget?.totals().requests ?? 0, previous_artifacts_overwritten: false })+'\n');
  process.exitCode = 1;
} finally { store?.close(); }
