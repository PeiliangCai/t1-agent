import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ExtractionStore, ExtractionBudget, buildSourceEvidenceUnits, developmentProfile, runExtractionDocument } from '@t1/agent';
import { WorkbenchWorkflow, unavailableMedicalCatalog } from '../src/workflow.js';
import { createRuntimeResponsesFixture } from '../../../tests/extraction/fixtures/runtime-responses.js';

test('uploaded synthetic PDF uses the actual configured Docling CPU parser and installed Pi B0 tools against loopback only', { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(resolve('runtime-data/s5-cpu-pi-')), inputPath = resolve(directory, 'synthetic.pdf');
  await promisify(execFile)(resolve('.venv/bin/python'), ['-c',
    'import sys\nfrom reportlab.pdfgen.canvas import Canvas\nc=Canvas(sys.argv[1]);c.drawString(72,750,"ENGINEERING WORKFLOW FIXTURE");c.drawString(72,710,"CT shows a round nodule.");c.drawString(72,670,"Synthetic text; not medical evidence.");c.showPage();c.save()', inputPath]);
  const store = new ExtractionStore(resolve(directory, 'workflow.sqlite'));
  let localRequests = 0, parserId = '', resultCoverage: unknown;
  const workflow = new WorkbenchWorkflow(store, { directory, sources: false, runner: { controlled: true, provider: 'loopback-fixture', model_id: 's4-synthetic-responses', execute: async context => {
    parserId = context.document.parser.id;
    const unit = buildSourceEvidenceUnits(context.document).find(u => u.segments.map(s => s.exact_quote).join('\n').includes('CT shows a round nodule.'));
    assert.ok(unit, 'actual parsed original sentence remains selectable');
    const scripted = await createRuntimeResponsesFixture([
      { calls: [{ name: 'read_document_blocks', arguments: {} }, { name: 'submit_candidate_records', arguments: { records: [{
        source_unit_ids: [unit.unit_id], feature_name_raw: null, feature_category: 'synthetic-workflow-fixture', evidence_type: 'imaging_observation', assertion: 'affirmed', origin: 'study_authors',
      }], batch_complete: true } }] },
      { calls: [{ name: 'get_document_context', arguments: {} }, { name: 'submit_candidate_records', arguments: {
        summary: 'Controlled synthetic PDF workflow test. No medical approval.', reviews: [], links: [], updates: [], summary_complete: true,
      } }] },
    ], { summaryAssessments: () => store.current(context.input.run_id).map(v => ({ record_id: v.record.record_id, expected_version: v.version, issue_codes: [], primary_assessment: 'uncertain' })) });
    try {
      const result = await runExtractionDocument({ input: context.input, document: context.document, catalog: unavailableMedicalCatalog, metadata: context.metadata,
        profile: developmentProfile(scripted.config.modelId), config: scripted.config, budget: new ExtractionBudget(resolve(context.directory, 'loopback-ledger.json'), scripted.endpoint),
        store, directory: context.directory, strategy: 'baseline', sourceSelectionCondition: 'B0', figureCatalog: context.catalog, figureDiscovery: 'not_requested',
        signal: context.signal, precreatedRun: true });
      localRequests = scripted.requests.length; resultCoverage = result.coverage;
      assert.equal(result.task_processing_complete, true); assert.equal(result.candidate_count, 1);
      return { coverage: result.coverage };
    } finally { await scripted.close(); }
  } } });
  try {
    const uploaded = await workflow.upload(await readFile(inputPath), 'synthetic.pdf', 'ENGINEERING FIXTURE ONLY');
    const run = (await workflow.start(uploaded.paper.id, workflow.scopeCatalog().default_scope)).run;
    await workflow.waitForIdle();
    const detail = await workflow.runDetail(run.run_id);
    assert.equal(parserId, 'docling-standard-cpu'); assert.equal(detail.output.state, 'completed'); assert.equal(detail.output.records.length, 1);
    assert.equal(detail.output.origin, 'controlled_fixture'); assert.equal(localRequests, 2);
    assert.equal(detail.output.records[0]!.fragments.map(f => f.exact_quote).join('\n'), 'CT shows a round nodule.');
    assert.equal(detail.output.records[0]!.text_approved, false);
    const report = { schema_version: 's5-cpu-pi-loopback-1', synthetic_pdf: true, actual_fresh_Docling_CPU_parse: true, parser_id: parserId,
      actual_installed_Pi_B0_runtime: true, requests: { loopback_only: localRequests, paid: 0 }, source_checks: 'live uploaded PDF/SHA + source units + existing delivery guards',
      task_processing_complete: true, medical_quality_approved: false, state: detail.output.state, coverage: resultCoverage };
    await writeFile(resolve('docs/acceptance/s5-workflow-2026-11-09/cpu-pi-loopback-report.json'), JSON.stringify(report, null, 2) + '\n');
  } finally { await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
