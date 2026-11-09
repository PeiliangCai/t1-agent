import { createHash } from 'node:crypto';
import type { Agent, AgentTurnContext } from '@earendil-works/pi-agent-core';
import { TOOL_NAMES } from './tools.js';

const correctable = [ 'schema_validation_failed', 'choose_one_read_selection', 'choose_source_units_or_source_lines',
  'choose_context_units_or_context_lines', 'choose_exact_fragments_or_whole_source_lines', 'source_line_index_out_of_range',
  'source_evidence_index_out_of_range', 'source_unit_not_available', 'batch_completion_requires_all_assigned_blocks_read',
  'bibliography_read_outside_task_scope' ];
const fatal = ['host_identity_override_or_unregistered_tool', 'summary_update_validation_failed', 'summary_source_not_authorized',
  'cross_task_or_batch_access_denied', 'cross_task_access_denied', 'source_binding_mismatch', 'update_target_missing_or_outside_bound_run',
  'update_target_feature_mismatch', 'block_not_authorized', 'source_block_not_read', 'evidence_version_conflict'];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const registered = (name: string) => (TOOL_NAMES as readonly string[]).includes(name);
const identityKeys = new Set(['binding', 'run_id', 'task_id', 'document_id', 'file_sha256', 'source_version', 'text_version',
  'scope', 'path', 'endpoint', 'url', 'api_key', 'token']);
function changesIdentity(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(changesIdentity);
  return !!value && typeof value === 'object' && Object.entries(value).some(([key, item]) => identityKeys.has(key) || changesIdentity(item));
}
/** Retain exact safe selector arrays, never arbitrary source text, SDK errors, credentials or a wire body. */
export function toolArgumentDiagnostic(value: unknown): { argument_sha256: string; argument_characters: number; property_names: string[]; selectors: Record<string, unknown> } {
  const raw = JSON.stringify(value) ?? 'null', p = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const selectors = Object.fromEntries(Object.entries(p).flatMap(([key, item]) => {
    if ((key === 'line_indices' || key.endsWith('_line_indices')) && Array.isArray(item)) return [[key, item.filter(v => Number.isSafeInteger(v))]];
    if (['block_ids', 'source_unit_ids', 'context_unit_ids'].includes(key) && Array.isArray(item)) return [[key, item.filter(v =>
      typeof v === 'string' && /^(?:su-\d{1,12}|[a-f\d]{8,80}-p\d+-l\d+|synthetic-[a-z\d-]+)$/i.test(v))]];
    if ((key === 'records' || key === 'updates') && Array.isArray(item)) return [[key, item.slice(0, 6).map(toolArgumentDiagnostic)]];
    if (['batch_complete', 'summary_complete', 'expected_version'].includes(key) && ['boolean', 'number'].includes(typeof item)) return [[key, item]];
    return [];
  }));
  return { argument_sha256: digest(raw), argument_characters: raw.length,
    property_names: Object.keys(p).map(k => /^[a-z_]{0,64}$/.test(k) ? k : '[unrecognized_property]'), selectors };
}
export function classifyToolError(text: string): string {
  return fatal.find(code => text.includes(code)) ?? correctable.find(code => text.includes(code)) ??
    (/Validation failed for tool|Invalid arguments for tool|invalid tool arguments/i.test(text) ? 'schema_validation_failed' :
      'sdk_tool_argument_validation_failed_or_unclassified_tool_error');
}

/** A correction is another ordinary metered response in this session, never a hidden retry or parameter rewrite. */
export class BoundedToolRecovery {
  stopped = false;
  private corrections = 0;
  private readonly corrected = new Set<string>();
  constructor(readonly agent: Agent, readonly diagnostic: (type: string, detail: Record<string, unknown>) => void) {
    const previousBeforeTool = agent.beforeToolCall;
    agent.beforeToolCall = async (context, signal) => {
      const unsafeTurn = context.assistantMessage.content.some(block => block.type === 'toolCall' &&
        (!registered(block.name) || changesIdentity(block.arguments)));
      if (unsafeTurn) return { block: true, terminate: true, reason: 'host_identity_override_or_unregistered_tool' };
      return previousBeforeTool?.(context, signal);
    };
  }
  afterTurn(turn: AgentTurnContext): { action: 'continue' | 'end' } | undefined {
    const failed = turn.toolResults.filter(r => r.isError);
    if (!failed.length) return;
    const calls = turn.message.content.filter(block => block.type === 'toolCall');
    const samples = failed.map(r => {
      const call = calls.find(c => c.id === r.toolCallId);
      const errorText = JSON.stringify(r.content);
      return { tool: registered(r.toolName) ? r.toolName : 'unregistered', call_id: r.toolCallId,
        error_code: classifyToolError(errorText), error_response_sha256: digest(errorText),
        ...toolArgumentDiagnostic(call?.arguments), changes_identity: changesIdentity(call?.arguments) };
    });
    const signatures = samples.map(s => `${s.tool}:${s.error_code}:${s.argument_sha256}`);
    const unsafe = samples.some(s => s.tool === 'unregistered' || s.changes_identity || !correctable.includes(s.error_code) ||
      s.error_code === 'bibliography_read_outside_task_scope' && s.tool !== 'read_document_blocks');
    const repeated = signatures.some(signature => this.corrected.has(signature));
    const allowed = !unsafe && !repeated && this.corrections < 2;
    const detail = { error_code: samples[0]!.error_code, error_response_sha256: digest(JSON.stringify(failed)),
      failed_argument_samples: samples, correction_number: this.corrections + (allowed ? 1 : 0), correction_limit: 2,
      parameters_rewritten: false, same_session: true,
      ...(allowed ? {} : { stop_reason: unsafe ? 'not_in_safe_correction_allowlist' : repeated ? 'repeated_invalid_arguments' : 'correction_limit' }) };
    this.diagnostic(allowed ? 'protocol_correction' : 'protocol_diagnostic_pause', detail);
    if (!allowed) { this.stopped = true; return { action: 'end' }; }
    this.corrections++; signatures.forEach(signature => this.corrected.add(signature));
    this.agent.steer({ role: 'user', timestamp: Date.now(), content:
      `Host protocol diagnostic: ${samples.map(s => s.error_code).join(', ')}. The invalid call was rejected. ` +
      'Correct only your tool arguments within this same immutable task and source binding, using the registered schema and IDs actually returned by tools. ' +
      'Do not guess, pad or normalize an opaque ID. Choose exactly one source selector and at most one context selector. ' +
      'For a batch read use {} or line_indices; a summary read requires exactly one nonempty line_indices or block_ids array. ' +
      (samples.some(s => s.error_code === 'bibliography_read_outside_task_scope') ?
        'This read hit confirmed bibliography outside the extraction task. No requested source text was returned or marked read. Choose only authorized task-scope lines from get_document_context; do not retry the same excluded selector. ' : '') +
      `No arguments were rewritten by the host. ${2 - this.corrections} further distinct correction opportunities remain; all calls use the existing budget.` });
    return { action: 'continue' };
  }
}
