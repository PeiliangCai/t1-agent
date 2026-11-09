import { resolve } from 'node:path';
import { ContractError } from '@t1/contracts';
import { ExtractionBudget, S4_LIMITS, loadModelConfig, runExtractionDocument, type ModelConfig } from '@t1/agent';
import { unavailableMedicalCatalog, type WorkflowRunner, type WorkflowExecution } from './workflow.js';
import { workbenchModelPolicy } from './model-policy.js';

export async function executeWorkbenchExtraction(context: WorkflowExecution, config: ModelConfig, budget: ExtractionBudget, documentTimeoutMs = 1800_000, stopOnBatchFailure = false) {
  const { profile } = workbenchModelPolicy(config);
  const result = await runExtractionDocument({ input: context.input, document: context.document, catalog: context.evidence_catalog ?? unavailableMedicalCatalog,
    metadata: context.metadata, profile, config, budget, store: context.store, directory: context.directory,
    strategy: 'baseline', sourceSelectionCondition: 'B0', signal: context.signal, figureCatalog: context.catalog,
    figureDiscovery: 'not_requested', precreatedRun: true, documentTimeoutMs, stopOnBatchFailure,
    batchOptions: { maxCodePoints: 8500, maxBlocks: 128, contextBlocks: 6 }, batchMaxResponses: 16 });
  return { coverage: result.coverage, summary: result.summary };
}

/** Credentials/configuration stay on the server. Existing experimental credentials never enable product calls by themselves. */
export function configuredWorkflowRunner(environment = process.env): WorkflowRunner | undefined {
  if (environment.T1_WORKBENCH_MODEL_ENABLED !== 'true') return undefined;
  const config = loadModelConfig('.env', environment), { responseModelAliasPolicy, profile } = workbenchModelPolicy(config);
  const integer = (key: string, fallback: number, maximum: number) => {
    const n = Number(environment[key] ?? fallback);
    if (!Number.isSafeInteger(n) || n < 1 || n > maximum) throw new ContractError('invalid_workbench_server_limit'); return n;
  };
  const limits = { ...S4_LIMITS, requests: integer('T1_WORKBENCH_MAX_REQUESTS', 80, S4_LIMITS.requests),
    input_tokens: integer('T1_WORKBENCH_MAX_INPUT_TOKENS', 2_000_000, S4_LIMITS.input_tokens),
    output_tokens: integer('T1_WORKBENCH_MAX_OUTPUT_TOKENS', 120_000, S4_LIMITS.output_tokens), seconds: 1800, document_seconds: 1800, batch_responses: 16 };
  return { controlled: false, provider: config.provider, model_id: config.modelId,
    public_runtime: { provider: config.provider, model_id: config.modelId, reasoning_effort: profile.reasoning_effort,
      limits: { requests: limits.requests, input_tokens: limits.input_tokens, output_tokens: limits.output_tokens, execution_seconds: limits.seconds } },
    execute: async context => {
    const budget = new ExtractionBudget(resolve(context.directory, 'request-ledger.json'), config.baseUrl, Date.now, {
      limits, responseModelAliasPolicy, authorization: { id: 'workbench-server-limits-1', source: 'server_workbench_configuration', recorded_at: new Date().toISOString() } });
    // Queue waiting is separate; parsing already used part of the 30 min execution slot.
    budget.ledger.experiment_started_at = context.execution_started_at ?? context.metadata.created_at; budget.persist(); budget.check();
    const remaining = Math.max(1, Math.floor((limits.seconds - budget.totals().elapsed_seconds) * 1000));
    return executeWorkbenchExtraction(context, config, budget, remaining);
  } };
}
