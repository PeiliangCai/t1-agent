import { setTimeout as delay } from 'node:timers/promises';
import { ContractError } from '@t1/contracts';
import { assertParsedDocument, type ExtractionDocument } from '@t1/agent';
import { WorkbenchSources } from '../src/workbench.js';
import type { WorkflowOptions } from '../src/workflow.js';

/** Local saved-source replay for workflow acceptance only. This module never loads credentials or invokes a provider. */
export async function controlledFixture(options: { delayMs?: number; onExecute?: (runId: string) => void; pause?: (runId: string, signal: AbortSignal) => Promise<void> } = {}): Promise<Pick<WorkflowOptions, 'runner' | 'parse' | 'discover'>> {
  const retained = await new WorkbenchSources().retained(true);
  const seedFor = (sha: string) => { const seed = retained.findLast(r => r.document.file_sha256 === sha); if (!seed) throw new ContractError('controlled_fixture_requires_known_retained_pdf'); return seed; };
  return {
    parse: async (input, path) => {
      const document = structuredClone(seedFor(input.file_sha256).document);
      document.document_id = input.document_id; document.source.file_reference = path;
      for (const block of document.blocks) block.document_id = input.document_id;
      assertParsedDocument(document); return document;
    },
    discover: async document => { const catalog = structuredClone(seedFor(document.file_sha256).catalog); catalog.document_id = document.document_id; return catalog; },
    runner: { controlled: true, provider: 'controlled-local-replay', model_id: 'saved-S4-records-no-model-call', execute: async context => {
      options.onExecute?.(context.input.run_id);
      context.store.transition(context.input.run_id, 'extracting');
      context.store.event(context.input.run_id, 'controlled_fixture', { summary: 'Controlled local saved-source replay. No new model or medical extraction validation.', paid_requests: 0 });
      const seed = seedFor(context.document.file_sha256), versions = seed.outputs.at(-1)?.result.records ?? [];
      let saved = 0;
      for (const version of versions) {
        if (context.signal.aborted) throw new ContractError('run_cancelled');
        const record = structuredClone(version.record);
        record.document_id = context.input.document_id;
        record.record_id = 'controlled-' + record.record_id;
        record.article_family_id = context.metadata.article_family_id;
        record.source_version = context.metadata.source_version;
        record.extraction_trace.task_id = context.metadata.task_id; record.extraction_trace.run_id = context.input.run_id;
        record.extraction_trace.scope = structuredClone(context.input.scope); record.extraction_trace.catalog_version = context.input.scope.catalog_version;
        record.extraction_trace.provider = 'controlled-local-replay'; record.extraction_trace.model_id = 'saved-S4-records-no-model-call';
        Object.assign(record.extraction_trace.source_binding, { task_id: context.metadata.task_id, run_id: context.input.run_id, document_id: context.input.document_id, source_version: context.metadata.source_version.version });
        record.review_status = 'pending'; record.review_events = []; record.handoff_status = 'candidate_only'; record.duplicate_and_conflict_links = [];
        context.store.apply(context.input.run_id, { action: 'insert', record, expected_version: null, target_record_id: null, related_record_ids: [], issues: [],
          changes: [{ kind: 'insert', record_id: record.record_id, expected_version: null, record }] }); saved++;
        if (saved === 1 && options.pause) await options.pause(context.input.run_id, context.signal);
        await delay(Math.max(1, Math.floor((options.delayMs ?? 2500) / Math.max(1, versions.length))), undefined, { signal: context.signal });
      }
      if (!versions.length) await delay(options.delayMs ?? 2500, undefined, { signal: context.signal });
      context.store.transition(context.input.run_id, 'reconciling'); context.store.transition(context.input.run_id, 'completed');
      return { coverage: { controlled_saved_source_replay: true, copied_record_count: saved, whole_document_summary_complete: false,
        task_processing_complete: false, new_model_requests: 0, medical_quality_approved: false } };
    } },
  };
}
