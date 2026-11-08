import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractError } from '@t1/contracts';
import { ExtractionBudget } from '../packages/agent/src/extraction-budget.js';
import { ExtractionStore } from '../packages/agent/src/extraction-store.js';
import { ExtractionSummaryTools } from '../packages/agent/src/extraction-summary.js';
import { buildArticleScope } from '../packages/agent/src/article-scope.js';
import { createExtractionSession, developmentProfile, promptExtractionSession } from '../packages/agent/src/extraction-pi.js';
import { loadModelConfig, ModelConfig } from '../packages/agent/src/config.js';
import { ORIGINAL_SUMMARY_PROMPT, TARGETED_REREAD_ADDITION, neutralInitialPayload, restoreSummaryCohort } from './summary-reread-replay.js';
import { sha256, SUMMARY_RESUME_JOBS } from './lib/summary-time-window.js';

/** Build real current-date Pi payloads, intercept before budget.begin/network, and preserve the real experiment ledger. */
async function main() {
  const [directoryArg, outputArg] = process.argv.slice(2);
  if (!directoryArg || !outputArg || process.argv.length !== 4) throw new ContractError('offline_summary_check_directory_and_output_required');
  const code = process.cwd(), directory = resolve(directoryArg), output = resolve(outputArg);
  for (const path of [directory, output]) if (relative(code, path).startsWith('..')) throw new ContractError('offline_summary_check_outside_code');
  const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
  const manifest = await json(join(directory, 'manifest.json')), plan = await json(join(code, manifest.parent_directory, 'plan.json'));
  const owner = 'runtime-data/s4-budget-owners/' + sha256((await json(join(code, manifest.parent_directory, 'authorization.json'))).authorization_id);
  const ledgerPath = join(code, owner, 'call-ledger.json'), ledgerBefore = await readFile(ledgerPath);
  const realConfig = loadModelConfig();
  const config = new ModelConfig(realConfig.provider, realConfig.baseUrl, realConfig.modelId, 'offline-pre-network-capture-no-provider-credential');
  const pilotBytes = await readFile(join(directory, 'L01-F/before/first-actual-request.body.json'), 'utf8'), pilot = JSON.parse(pilotBytes);
  await mkdir(join(code, 'runtime-data/agent-notes'), { recursive: true });
  const temporary = await mkdtemp(join(code, 'runtime-data/agent-notes/summary-payload-offline-'));
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new ContractError('offline_summary_network_forbidden'); };
  const checks = [];
  try {
    for (const id of SUMMARY_RESUME_JOBS) {
      const item = manifest.cohorts.find((c: any) => c.job_id === id), cohortBytes = await readFile(join(directory, item.file));
      assert.equal(sha256(cohortBytes), item.sha256);
      const cohort = JSON.parse(cohortBytes.toString('utf8'));
      const document = (await json(join(code, cohort.source.ir_path))).document;
      const captured: Record<string, { raw: string; body: Record<string, any> }> = {};
      for (const arm of ['before', 'after'] as const) {
        const armDir = join(temporary, id, arm), store = new ExtractionStore(':memory:');
        restoreSummaryCohort(store, cohort);
        try {
          const tools = new ExtractionSummaryTools({ input: cohort.input, metadata: cohort.metadata, document, catalog: plan.config.catalog },
            buildArticleScope(document), store, 'baseline', [], cohort.selection);
          const budget = new ExtractionBudget(join(armDir, 'synthetic-ledger.json'), config.baseUrl);
          budget.guardedFetch = () => async (input, init) => {
            assert.equal(captured[arm], undefined);
            const raw = await new Request(input, init).clone().text(); captured[arm] = { raw, body: JSON.parse(raw) };
            throw new ContractError('offline_summary_payload_captured_before_accounting_and_network');
          };
          const session = await createExtractionSession(config, developmentProfile(plan.config.model.model_id, plan.config.model.api), tools.definitions(),
            armDir, budget, manifest.replay_id + ':' + id + ':' + arm, 0, plan.config.proposed_limits.batch_responses);
          await promptExtractionSession(session, arm === 'before' ? ORIGINAL_SUMMARY_PROMPT : ORIGINAL_SUMMARY_PROMPT + TARGETED_REREAD_ADDITION, budget);
          assert.equal(budget.totals().requests, 0);
          assert.ok(captured[arm]);
        } finally { store.close(); }
      }
      const before = captured.before!, after = captured.after!;
      const comparable = (body: Record<string, any>) => body.input.filter((message: any) => ['developer', 'system'].includes(message.role));
      const record = { job_id: id, checked_at: new Date().toISOString(), current_before_sha256: sha256(before.raw),
        original_before_sha256: cohort.baseline_first_request_sha256,
        current_before_matches_original_sha: sha256(before.raw) === cohort.baseline_first_request_sha256,
        fresh_before_after_controls_identical: sha256(JSON.stringify(neutralInitialPayload(before.body, ORIGINAL_SUMMARY_PROMPT))) ===
          sha256(JSON.stringify(neutralInitialPayload(after.body, ORIGINAL_SUMMARY_PROMPT + TARGETED_REREAD_ADDITION))),
        current_system_equals_saved_pilot: JSON.stringify(comparable(before.body)) === JSON.stringify(comparable(pilot)),
        current_system_sha256: sha256(JSON.stringify(comparable(before.body))), saved_pilot_system_sha256: sha256(JSON.stringify(comparable(pilot))) };
      if (!record.current_before_matches_original_sha || !record.fresh_before_after_controls_identical) {
        await writeFile(join(output + '.' + id + '.payload-diff.json'), JSON.stringify({ current_before: before.body, current_after: after.body,
          saved_pilot: pilot, saved_pilot_is_exact_original_for_this_job: sha256(pilotBytes) === cohort.baseline_first_request_sha256 }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      }
      checks.push(record);
    }
    assert.equal(networkCalls, 0);
    const ledgerAfter = await readFile(ledgerPath); assert.deepEqual(ledgerAfter, ledgerBefore);
    const report = { schema_version: 'summary-offline-current-payload-check-1', checked_at: new Date().toISOString(),
      checks, all_initial_controls_passed: checks.every(c => c.current_before_matches_original_sha && c.fresh_before_after_controls_identical),
      provider_network_calls: networkCalls, experiment_requests_added: 0, original_ledger_unchanged: true,
      ledger_sha256: sha256(ledgerAfter), clock_spoofed: false, budget_or_source_timestamps_modified: false };
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify(report) + '\n');
    assert.equal(report.all_initial_controls_passed, true, 'actual current-day initial payload controls changed; inspect saved diff before any paid calls');
  } finally { globalThis.fetch = originalFetch; await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
