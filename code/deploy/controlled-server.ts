import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ContractError } from '@t1/contracts';
import { ExtractionStore, RunStore, ExtractionBudget, buildSourceEvidenceUnits, developmentProfile, runExtractionDocument } from '@t1/agent';
import { buildApp } from '../apps/server/src/app.js';
import { WorkbenchWorkflow, unavailableMedicalCatalog } from '../apps/server/src/workflow.js';
import { serverRuntime } from '../apps/server/src/runtime-config.js';
import { createRuntimeResponsesFixture } from '../tests/extraction/fixtures/runtime-responses.js';

// Verification entrypoint only. No credentials/configured external provider is ever loaded.
const runtime = serverRuntime();
const summaryDelay = Number(process.env.T1_S7_FIXTURE_SUMMARY_DELAY_MS ?? 0);
if (!Number.isSafeInteger(summaryDelay) || summaryDelay < 0 || summaryDelay > 30_000) throw new ContractError('invalid_controlled_summary_delay');
await mkdir(runtime.directory, { recursive: true, mode: 0o700 });
const store = new ExtractionStore(runtime.database), legacy = new RunStore(runtime.database);
const workflow = new WorkbenchWorkflow(store, { directory: runtime.workflowDirectory, sources: false,
  runner: { controlled: true, provider: 'loopback-fixture', model_id: 's4-synthetic-responses', execute: async context => {
    const unit = buildSourceEvidenceUnits(context.document).find(unit => unit.segments.map(s => s.exact_quote).join('\n') === 'CT shows a round nodule.');
    if (!unit) throw new ContractError('deployment_fixture_requires_synthetic_source');
    const scripted = await createRuntimeResponsesFixture([
      { calls: [{ name: 'read_document_blocks', arguments: {} }, { name: 'submit_candidate_records', arguments: { records: [{
        source_unit_ids: [unit.unit_id], feature_name_raw: null, feature_category: 'synthetic-workflow-fixture', evidence_type: 'imaging_observation', assertion: 'affirmed', origin: 'study_authors',
      }], batch_complete: true } }] },
      { ...(summaryDelay ? { response_gate: delay(summaryDelay, undefined, { signal: context.signal }).catch(() => undefined) } : {}), calls: [{ name: 'get_document_context', arguments: {} }, { name: 'submit_candidate_records', arguments: {
        summary: 'S7 container engineering fixture. No medical approval.', reviews: [], links: [], updates: [], summary_complete: true,
      } }] },
    ], { summaryAssessments: () => store.current(context.input.run_id).map(version => ({ record_id: version.record.record_id, expected_version: version.version, issue_codes: [], primary_assessment: 'uncertain' })) });
    try {
      const result = await runExtractionDocument({ input: context.input, document: context.document, catalog: unavailableMedicalCatalog, metadata: context.metadata,
        profile: developmentProfile(scripted.config.modelId), config: scripted.config, budget: new ExtractionBudget(resolve(context.directory, 'loopback-ledger.json'), scripted.endpoint),
        store, directory: context.directory, strategy: 'baseline', sourceSelectionCondition: 'B0', figureCatalog: context.catalog, figureDiscovery: 'not_requested',
        signal: context.signal, precreatedRun: true });
      store.event(context.input.run_id, 'deployment_fixture_completed', { loopback_requests: scripted.requests.length, paid_requests: 0, actual_Docling_CPU: true, medical_quality_approved: false });
      return { coverage: result.coverage };
    } finally { await scripted.close(); }
  } },
});
const app = buildApp(legacy, undefined, workflow);
await app.listen({ host: runtime.host, port: runtime.port });
console.log('S7 CONTROLLED container verification: fresh CPU parse, scripted loopback Responses, 0 external model requests.');
const close = async () => { await app.close(); legacy.close(); store.close(); };
process.once('SIGTERM', () => void close()); process.once('SIGINT', () => void close());
