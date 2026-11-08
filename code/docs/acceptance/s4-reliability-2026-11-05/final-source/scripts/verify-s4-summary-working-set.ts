/** Offline reproduction against the frozen pre-fix summary module. No credentials, remote API or evidence store is opened. */
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { ExtractionSummaryTools } from '../packages/agent/src/extraction-summary.js';
import { ExtractionStore } from '../packages/agent/src/extraction-store.js';
import { buildArticleScope } from '../packages/agent/src/article-scope.js';
import { VISUAL_STATEMENT_POLICY_VERSION } from '../packages/agent/src/visual-evidence-policy.js';
import { makeEvidenceFixture } from '../tests/extraction/fixtures/evidence-fixtures.js';

const directory = resolve('docs/acceptance/s4-reliability-2026-11-05');
const outputName = process.argv[2] ?? '03-summary-window-direct-before-after.json';
if (!/^[a-zA-Z0-9.-]+\.json$/.test(outputName)) throw new Error('offline_report_filename_invalid');
const originalPath = join(directory, 'before-source/packages/agent/src/extraction-summary.ts');
const original = await readFile(originalPath, 'utf8');
const temporary = await mkdtemp(resolve('runtime-data/agent-notes/summary-window-offline-'));
try {
  // Only relative dependency specifiers are relocated. The pre-fix class body remains byte-identical.
  const replayModule = original.replace(/from '(\.\/[^']+)'/g, (_all, specifier: string) =>
    `from '${pathToFileURL(resolve('packages/agent/src', specifier)).href}'`);
  const replayPath = join(temporary, 'summary-before.ts'); await writeFile(replayPath, replayModule, { flag: 'wx' });
  const before = await import(pathToFileURL(replayPath).href) as { ExtractionSummaryTools: typeof ExtractionSummaryTools };
  const raw = JSON.parse(await readFile(resolve('docs/acceptance/user-feedback-2026-11-05/revalidation/sources/L05/parser-result.json'), 'utf8'));
  const document = raw.document ?? raw;
  const observe = async (Tools: typeof ExtractionSummaryTools) => {
    const fixture = makeEvidenceFixture(), store = new ExtractionStore(':memory:');
    fixture.input.document_id = document.document_id; fixture.input.file_sha256 = document.file_sha256;
    fixture.context.document = document; fixture.context.metadata.source_version.file_sha256 = document.file_sha256;
    store.create(fixture.input, fixture.context.metadata); store.transition(fixture.input.run_id, 'extracting'); store.transition(fixture.input.run_id, 'reconciling');
    const tools = new Tools({ ...fixture.context, evidencePolicyVersion: VISUAL_STATEMENT_POLICY_VERSION }, buildArticleScope(document), store, 'baseline');
    const read = tools.definitions().find(t => t.name === 'read_document_blocks')!, observations: object[] = [];
    try {
      const priorIds = new Set<string>();
      for (const start of [0, 128, 256, 384, 512]) {
        const indices = Array.from({ length: Math.min(128, 615 - start) }, (_, i) => start + i);
        const output = await read.execute(`offline-L05-${start}`, { line_indices: indices }, undefined, undefined, {} as Parameters<typeof read.execute>[4]);
        const body = JSON.parse((output.content[0] as { text: string }).text), units = body.source_units as Array<{ unit_id: string; line_spans: Array<{ line_index: number }> }>;
        const expectedStart = Math.max(0, Math.min(start + 128, 615) - 128);
        const outside = units.filter(u => u.line_spans.some(s => s.line_index < expectedStart || s.line_index >= Math.min(start + 128, 615)));
        observations.push({ requested_indices: indices, returned_blocks: body.blocks.length,
          all_returned_source_lines_exact: body.blocks.every((b: { line_index: number; text: string }) => b.text === document.blocks[b.line_index].text),
          source_units: units.length, units_already_returned_in_prior_calls: units.filter(u => priorIds.has(u.unit_id)).length,
          units_outside_current_128_line_window: outside.length,
          outside_unit_id_examples: outside.slice(0, 5).map(u => u.unit_id), result_bytes: Buffer.byteLength(JSON.stringify(body)) });
        units.forEach(u => priorIds.add(u.unit_id));
      }
      return { observations, actually_read_unique_blocks: tools.readBlocks.size, summary_completed: tools.completed,
        candidates: store.current(fixture.input.run_id).length };
    } finally { store.close(); }
  };
  const report = { schema_version: 'offline-actual-L05-summary-window-1', paid_api_requests: 0,
    source: 'Frozen public L05 IR,615 blocks; deterministic tool invocations only, not a new model result.',
    before_module: originalPath, before_module_sha256: createHash('sha256').update(original).digest('hex'),
    replay_body_unchanged_except_relative_import_relocation: true,
    after_module_sha256: createHash('sha256').update(await readFile(resolve('packages/agent/src/extraction-summary.ts'))).digest('hex'),
    before: await observe(before.ExtractionSummaryTools), after: await observe(ExtractionSummaryTools),
    draft_before_test_note: '03-summary-reliability-before.log contains a draft assertion that failed on a not-yet-existing source_window property; this report directly measures old returned unit spans and establishes the cumulative-output cause without relying on that missing field.' };
  await writeFile(join(directory, outputName), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify({ before_outside_units: report.before.observations.map((o: any) => o.units_outside_current_128_line_window),
    after_outside_units: report.after.observations.map((o: any) => o.units_outside_current_128_line_window), paid_api_requests: 0 }) + '\n');
} finally { await rm(temporary, { recursive: true, force: true }); }
