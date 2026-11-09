import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import { ExtractionStore, RunStore, evidenceScopeIssues } from '@t1/agent';
import { ContractError } from '@t1/contracts';
import { WorkbenchSources } from '../src/workbench.js';
import { WorkbenchWorkflow, unavailableMedicalCatalog } from '../src/workflow.js';
import { buildApp } from '../src/app.js';
import { configuredWorkflowRunner } from '../src/workflow-runner.js';
import { controlledFixture } from './controlled-fixture.js';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const until = async (condition: () => boolean | Promise<boolean>) => {
  for (let n = 0; n < 150; n++) { if (await condition()) return; await delay(20); } throw new Error('controlled_condition_timeout');
};

test('pinned legacy compatibility permits only absent additive groups; changed original text is rejected', async () => {
  const directory = await mkdtemp(resolve('runtime-data/s5-legacy-regression-'));
  try {
    const original = await new WorkbenchSources().detail('L01'); assert.equal(original.outputs.length, 2); assert.ok(original.outputs[0]!.records.length);
    const registry = JSON.parse(await readFile('config/pi-web-workbench.json', 'utf8'));
    const artifact = registry.papers.find((p: { id: string }) => p.id === 'L01').outputs[0].delivery;
    const delivery = JSON.parse(await readFile(artifact.path, 'utf8'));
    delivery.records[0].original_fragments[0].exact_quote = 'This is rewritten and must be refused.';
    const bytes = Buffer.from(JSON.stringify(delivery)), path = resolve(directory, 'changed-delivery.json'); await writeFile(path, bytes);
    artifact.path = relative(process.cwd(), path); artifact.sha256 = sha(bytes);
    const registryPath = resolve(directory, 'registry.json'); await writeFile(registryPath, JSON.stringify(registry));
    await assert.rejects(new WorkbenchSources(process.cwd(), registryPath).detail('L01'), /workbench_delivery_changed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('server defaults do not authorize model calls; unavailable/development catalog never silently widens selections', () => {
  assert.equal(configuredWorkflowRunner({} as NodeJS.ProcessEnv), undefined);
  const configured = configuredWorkflowRunner({ T1_WORKBENCH_MODEL_ENABLED: 'true', T1_MODEL_PROVIDER: 'configured-test-only', T1_MODEL_BASE_URL: 'https://example.invalid/v1',
    T1_MODEL_ID: 'explicit-test-model', T1_MODEL_API_KEY: 'not-a-real-key' } as NodeJS.ProcessEnv);
  assert.equal(configured?.controlled, false); assert.equal(configured?.model_id, 'explicit-test-model'); // Construction does not contact any endpoint.
  const all = { scope_version: '1' as const, cancers: { mode: 'all' as const, ids: [] }, image_types: { mode: 'all' as const, ids: [] }, features: { mode: 'all' as const, binding_ids: [] }, catalog_version: 'medical-unavailable-1', matching_policy_version: 'exact-explicit-synonyms-1' };
  assert.deepEqual(evidenceScopeIssues(all, unavailableMedicalCatalog), []);
  const empty = { ...all, cancers: { mode: 'selected' as const, ids: [] } };
  assert.ok(evidenceScopeIssues(empty, unavailableMedicalCatalog).includes('cancers_selected_empty'));
  const fixture = { ...unavailableMedicalCatalog, fixture: true, status: 'approved' as const,
    cancers: [{ id: 'fixture-A', name: 'ENGINEERING A', synonyms: [], source: 'explicit nonmedical fixture', approval_status: 'approved' as const }],
    image_types: [{ id: 'fixture-X', name: 'ENGINEERING X', cancer_ids: ['fixture-A'], synonyms: [], source: 'explicit nonmedical fixture', approval_status: 'approved' as const }] };
  const selected = { ...all, cancers: { mode: 'selected' as const, ids: ['fixture-A'] }, image_types: { mode: 'selected' as const, ids: ['fixture-X'] } };
  assert.ok(evidenceScopeIssues(selected, fixture).length); // Production cannot use the test catalog.
  assert.deepEqual(evidenceScopeIssues(selected, fixture, { fixture: true }), []);
  assert.ok(evidenceScopeIssues({ ...selected, cancers: { mode: 'selected', ids: ['missing'] } }, fixture, { fixture: true }).length);
});

test('real retained S4 data and controlled overlapping tasks preserve versions, approvals, sources, exports and SSE across restart', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(resolve('runtime-data/s5-backend-test-')), database = resolve(directory, 'workflow.sqlite');
  let store = new ExtractionStore(database), legacy = new RunStore();
  const entered = new Set<string>(), releases = new Map<string, () => void>();
  const fixture = await controlledFixture({ delayMs: 100, onExecute: id => entered.add(id), pause: (id, signal) => new Promise<void>(accept => {
    releases.set(id, accept); signal.addEventListener('abort', () => accept(), { once: true });
  }) });
  let workflow = new WorkbenchWorkflow(store, { directory, ...fixture }), app = buildApp(legacy, undefined, workflow);
  const report: Record<string, unknown> = { all_workflow_assertions_passed: false, controlled_fixture: true, new_paid_provider_calls: 0, source: 'pinned real S4 saved records; local replay only' };
  try {
    await app.ready();
    const caps = (await app.inject('/api/workbench/capabilities')).json(); assert.equal(caps.controlled_fixture, true); assert.equal(caps.paper_upload, true);
    const historical = (await app.inject('/api/workbench/papers/L07')).json();
    const current = historical.outputs[0]; assert.equal(current.records.length, 26); assert.equal(current.origin, 'historical_compatibility_replay');
    const oldL01 = await workflow.detail('L01'); assert.ok(oldL01.outputs.some(o => o.strategy === 'F' && o.origin === 'historical_compatibility_replay'));
    assert.equal(current.same_source_review_index.same_source_multi_member_group_count, 3); assert.ok(current.records.every((r: { text_approved: boolean }) => !r.text_approved));
    report.latest_S4_import = { L07: 26, same_source_multi_member_groups: 3, inherited_business_approvals: 0 };
    const scope = (await app.inject('/api/workbench/catalog')).json().default_scope;
    const invalid = await app.inject({ method: 'POST', url: '/api/workbench/papers/L07/runs', payload: { scope: { ...scope, cancers: { mode: 'selected', ids: [] } } } });
    assert.equal(invalid.statusCode, 400); assert.match(invalid.json().error, /selected_empty/);
    const alternateMethod = await app.inject({ method: 'POST', url: '/api/workbench/papers/L07/runs', payload: { scope, method: 'F' } }); assert.equal(alternateMethod.statusCode, 400);
    const first = (await workflow.start('L07', scope)).run, second = (await workflow.start('L01', scope)).run;
    await until(() => entered.has(first.run_id) && entered.has(second.run_id) && store.current(first.run_id).length > 0 && store.current(second.run_id).length > 0);
    assert.equal(store.snapshot(first.run_id).state, 'extracting'); assert.equal(store.snapshot(second.run_id).state, 'extracting');
    assert.equal((await workflow.runDetail(first.run_id)).run.document_id, 'L07'); assert.equal((await workflow.runDetail(second.run_id)).run.document_id, 'L01');
    const bothAt = new Date().toISOString(); await workflow.cancel(second.run_id); releases.get(first.run_id)!(); await workflow.waitForIdle();
    assert.equal(store.snapshot(first.run_id).state, 'completed'); assert.equal(store.snapshot(second.run_id).state, 'cancelled'); assert.ok(store.current(second.run_id).length);
    report.overlap = { both_extracting_observed_at: bothAt, first: first.run_id, second: second.run_id, first_state: 'completed', second_state: 'cancelled', independent_cancellation: true };
    const runUrl = '/api/workbench/runs/' + encodeURIComponent(first.run_id), record = (await workflow.runDetail(first.run_id)).output.records[0]!;
    const checks = { reviewer: 'engineering-workflow-tester', source_text_checked: true, relevance_checked: true, context_checked: true };
    const approved = (await app.inject({ method: 'POST', url: runUrl + '/records/' + record.id + '/review', payload: { ...checks, action: 'approve_text', expected_version: record.version } })).json().record;
    assert.equal(approved.text_approved, true); assert.equal(approved.figures_approved, false);
    const conflict = await app.inject({ method: 'PATCH', url: runUrl + '/records/' + record.id, payload: { reviewer: checks.reviewer, expected_version: record.version, labels: { tags: ['stale'] } } });
    assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().current_version, approved.version);
    store.modelReview(first.run_id, record.id, approved.version, 'controlled-model-proposal', []);
    assert.equal(store.current(first.run_id).find(v => v.record.record_id === record.id)!.version, approved.version);
    assert.equal((await workflow.runDetail(first.run_id)).output.records.find(r => r.id === record.id)!.text_approved, true);
    const arbitrary = await app.inject({ method: 'PATCH', url: runUrl + '/records/' + record.id, payload: { reviewer: checks.reviewer, expected_version: approved.version, original_quote: 'free rewrite' } });
    assert.equal(arbitrary.statusCode, 400); assert.equal(arbitrary.json().error, 'source_reselection_only_no_free_text');
    const revised = await workflow.revise(first.run_id, record.id, { expected_version: approved.version, source_unit_ids: record.source_unit_ids, context_unit_ids: record.context_unit_ids, reviewer: checks.reviewer, labels: { tags: ['exact-original'], comment: 'Human comment kept apart from source text.', evidence_role: 'background_suggestion' } });
    assert.equal(revised.record.text_approved, false); assert.deepEqual(revised.record.fragments.map(f => f.exact_quote), record.fragments.map(f => f.exact_quote));
    const reapproved = await workflow.reviewRecord(first.run_id, record.id, { ...checks, action: 'approve_text', expected_version: revised.record.version });
    const added = await workflow.revise(first.run_id, undefined, { source_unit_ids: record.source_unit_ids, reviewer: checks.reviewer, labels: { tags: ['manual-add'] } });
    assert.equal(added.record.actor, 'human'); await workflow.deleteRecord(first.run_id, added.record.id, { expected_version: added.record.version, reviewer: checks.reviewer });
    assert.ok(!(await workflow.runDetail(first.run_id)).output.records.some(r => r.id === added.record.id));
    const jsonl = await app.inject(runUrl + '/exports/approved_jsonl'); assert.equal(jsonl.statusCode, 200); assert.match(jsonl.headers['content-disposition'] as string, /attachment/);
    const exported = JSON.parse(jsonl.body.trim()); assert.equal(exported.record_id, record.id); assert.equal(exported.export_review_status, 'approved_text_only'); assert.deepEqual(exported.figure_association.figure_ids, []);
    assert.equal(exported.human_role_selection.role, 'background_suggestion');
    const pkg = await app.inject(runUrl + '/exports/approved_package'); assert.equal(pkg.statusCode, 200); assert.equal(pkg.rawPayload.subarray(0, 2).toString('hex'), '1f8b');
    const tar = gunzipSync(pkg.rawPayload), archiveNames: string[] = [];
    for (let offset = 0; offset + 512 <= tar.length;) { const name = tar.subarray(offset, offset + 100).toString().replace(/\0.*$/s, ''); if (!name) break;
      archiveNames.push(name.replace(/^\.\//u, '')); const size = parseInt(tar.subarray(offset + 124, offset + 136).toString().replace(/\0.*$/s, '').trim() || '0', 8); offset += 512 + Math.ceil(size / 512) * 512; }
    for (const name of ['source-record-versions.jsonl', 'human-annotations.json', 'manifest.json', 'coverage.json']) assert.ok(archiveNames.includes(name), name);
    const csv = await app.inject(runUrl + '/exports/candidate_csv'); assert.equal(csv.statusCode, 200); assert.match(csv.body, /record_id,record_version/);
    report.versions_and_exports = { stale_write_409: true, model_proposal_preserved_human: true, exact_source_reselection: true, manual_add_delete: true, text_only_approval_without_figures: true, downloadable_jsonl_csv_gzip: true };
    // A known legacy paired Figure can be confirmed separately; the text decision never approves it implicitly.
    const l05 = await workflow.detail('L05'), pairedOutput = l05.outputs.find(o => o.records.some(r => r.association === 'paired'))!;
    const paired = pairedOutput.records.find(r => r.association === 'paired')!;
    const text = await workflow.reviewRecord(pairedOutput.id, paired.id, { ...checks, action: 'approve_text', expected_version: paired.version }); assert.equal(text.record.figures_approved, false);
    const image = await workflow.reviewRecord(pairedOutput.id, paired.id, { reviewer: checks.reviewer, action: 'approve_figures', figure_pairing_checked: true, expected_version: text.record.version }); assert.equal(image.record.figures_approved, true);
    const imageBytes = await workflow.export(pairedOutput.id, 'approved_jsonl'); assert.equal(JSON.parse(imageBytes.bytes.toString().trim()).export_review_status, 'approved_text_and_figures');
    report.separate_figure_confirmation = true;
    const pairedRun = await workflow.runDetail(pairedOutput.id), assetSha = pairedRun.figures.find(f => paired.figure_ids.includes(f.id))!.assets[0]!.sha256;
    const originalPinnedRead = workflow['readPinned'].bind(workflow);
    workflow['readPinned'] = async artifact => { if (artifact.sha256 === assetSha) throw new ContractError('source_file_missing'); return originalPinnedRead(artifact); };
    try {
      const afterAssetFailure = (await workflow.runDetail(pairedOutput.id)).output.records.find(r => r.id === paired.id)!;
      assert.equal(afterAssetFailure.text_approved, true); assert.equal(afterAssetFailure.figures_approved, false);
      const degraded = await workflow.export(pairedOutput.id, 'approved_jsonl'); assert.equal(JSON.parse(degraded.bytes.toString().trim()).export_review_status, 'approved_text_only');
    } finally { workflow['readPinned'] = originalPinnedRead; }
    report.missing_image_fault_injection_keeps_confirmed_text = true;
    const pending = (await workflow.runDetail(first.run_id)).output.records.find(r => r.association === 'pending' && r.proposed_figure_ids.length === 1 && r.reasons.length === 1 && r.reasons[0]!.includes('source-page verification'))!;
    assert.ok(pending);
    const figureBefore = await workflow.runDetail(first.run_id), figureId = pending.proposed_figure_ids[0]!;
    const figureChecks = { expected_catalog_sha256: figureBefore.figure_catalog_sha256!, reviewer: checks.reviewer, all_panels_included: true, caption_figure_identity_checked: true,
      notes: 'Engineering fixture source-page confirmation; not a medical approval.' };
    const figureRoute = runUrl + '/figures/' + figureId + '/verify';
    const missingChecks = await app.inject({ method: 'POST', url: figureRoute, payload: { ...figureChecks, all_panels_included: false } }); assert.equal(missingChecks.statusCode, 400);
    const verifiedFigure = (await app.inject({ method: 'POST', url: figureRoute, payload: figureChecks })).json();
    assert.equal(verifiedFigure.record_approval_added, false); assert.notEqual(verifiedFigure.figure_catalog_sha256, figureChecks.expected_catalog_sha256);
    assert.equal(verifiedFigure.run_detail.output.records.find((r: { id: string }) => r.id === pending.id).text_approved, false);
    assert.equal(verifiedFigure.run_detail.output.records.find((r: { id: string }) => r.id === pending.id).association, 'paired');
    const figureConflict = await app.inject({ method: 'POST', url: figureRoute, payload: figureChecks }); assert.equal(figureConflict.statusCode, 409);
    const targetText = await workflow.reviewRecord(first.run_id, pending.id, { ...checks, action: 'approve_text', expected_version: pending.version });
    const targetFigure = await workflow.reviewRecord(first.run_id, pending.id, { reviewer: checks.reviewer, action: 'approve_figures', figure_pairing_checked: true, expected_version: targetText.record.version });
    assert.equal(targetFigure.record.figures_approved, true); report.versioned_source_figure_check_before_record_approval = true;
    const address = await app.listen({ host: '127.0.0.1', port: 0 }), cursor = workflow.events(first.run_id).at(-3)!.seq;
    const controller = new AbortController(), response = await fetch(address + runUrl + '/events', { headers: { 'Last-Event-ID': String(cursor) }, signal: controller.signal });
    const reader = response.body!.getReader(); let frame = '';
    while (!frame.includes('\n\n')) frame += new TextDecoder().decode((await reader.read()).value);
    assert.equal(Number(/^id: (\d+)/m.exec(frame)![1]), cursor + 1); controller.abort(); await reader.cancel().catch(() => {});
    report.SSE = { persisted_cursor: cursor, first_replayed_seq: cursor + 1, run_isolated: true };
    const activeThird = (await workflow.start('L01', scope)).run; await until(() => entered.has(activeThird.run_id));
    const beforeVersions = store.versions(first.run_id).length, beforeApprovedVersion = reapproved.record.version;
    await app.close(); store.close(); legacy.close();
    store = new ExtractionStore(database); legacy = new RunStore(); workflow = new WorkbenchWorkflow(store, { directory, ...fixture }); app = buildApp(legacy, undefined, workflow); await app.ready();
    assert.equal(store.snapshot(activeThird.run_id).state, 'interrupted'); assert.equal(store.versions(first.run_id).length, beforeVersions);
    const restored = (await workflow.runDetail(first.run_id)).output.records.find(r => r.id === record.id)!;
    assert.equal(restored.version, beforeApprovedVersion); assert.equal(restored.text_approved, true); assert.ok(!store.current(first.run_id).some(v => v.record.record_id === added.record.id && !workflow['annotation'](first.run_id, v).deleted));
    assert.equal((await workflow.runDetail(first.run_id)).figure_catalog_sha256, verifiedFigure.figure_catalog_sha256);
    assert.equal((await workflow.runDetail(first.run_id)).output.records.find(r => r.id === pending.id)!.figures_approved, true);
    assert.ok(workflow.events(first.run_id, cursor).length); assert.equal(entered.has(activeThird.run_id), true);
    report.restart = { interrupted_run: activeThird.run_id, no_auto_resume: true, approvals_and_deleted_versions_preserved: true, import_idempotent: true };
    // Uploaded duplicate PDFs share retained bytes, while source removal never hides historical SQLite results.
    const pdfBytes = await readFile('evaluation/corpus/development-candidates/L01.pdf');
    const uploaded = await app.inject({ method: 'POST', url: '/api/workbench/papers', headers: { 'content-type': 'application/pdf', 'x-t1-filename': 'source.pdf' }, payload: pdfBytes });
    assert.equal(uploaded.statusCode, 201); const uploadedId = uploaded.json().paper.id;
    const duplicate = await workflow.upload(pdfBytes, 'same.pdf'); await workflow.deletePaper(uploadedId); assert.equal((await workflow.pdf(duplicate.paper.id)).length, pdfBytes.length);
    const uploadedRun = (await workflow.start(duplicate.paper.id, scope)).run; await until(() => entered.has(uploadedRun.run_id)); releases.get(uploadedRun.run_id)!(); await workflow.waitForIdle();
    const uploadedRecord = (await workflow.runDetail(uploadedRun.run_id)).output.records[0]!;
    await workflow.reviewRecord(uploadedRun.run_id, uploadedRecord.id, { ...checks, action: 'approve_text', expected_version: uploadedRecord.version });
    const sourceRow = JSON.parse(store.db.prepare('SELECT payload_json FROM workbench_papers WHERE id=?').get(duplicate.paper.id)!.payload_json as string);
    const sourcePath = resolve(process.cwd(), sourceRow.pdf.path); await writeFile(sourcePath, Buffer.from('wrong SHA'));
    assert.equal((await workflow.detail(duplicate.paper.id)).source_status, 'mismatch'); assert.ok((await workflow.detail(duplicate.paper.id)).outputs[0]!.records.length);
    await assert.rejects(workflow.start(duplicate.paper.id, scope), /source_integrity_blocked/); await assert.rejects(workflow.export(uploadedRun.run_id, 'approved_jsonl'), /source_integrity_blocked/);
    await assert.rejects(workflow.restorePdf(duplicate.paper.id, Buffer.from('different')), /restore_requires_identical_pdf/);
    await workflow.restorePdf(duplicate.paper.id, pdfBytes); await rm(sourcePath);
    assert.equal((await workflow.detail(duplicate.paper.id)).source_status, 'missing'); await assert.rejects(workflow.export(uploadedRun.run_id, 'approved_csv'), /source_integrity_blocked/);
    await workflow.restorePdf(duplicate.paper.id, pdfBytes);
    const sourceRunRow = JSON.parse(store.db.prepare('SELECT payload_json FROM workbench_runs WHERE id=?').get(uploadedRun.run_id)!.payload_json as string);
    await writeFile(resolve(process.cwd(), sourceRunRow.source.ir.path), '{}');
    await assert.rejects(workflow.start(duplicate.paper.id, scope), /source_integrity_blocked/); await assert.rejects(workflow.export(uploadedRun.run_id, 'approved_jsonl'), /source_integrity_blocked/);
    assert.ok((await workflow.runDetail(uploadedRun.run_id)).output.records.length);
    const invalidPdf = await app.inject({ method: 'POST', url: '/api/workbench/papers', headers: { 'content-type': 'application/pdf', 'x-t1-filename': '../bad.pdf' }, payload: pdfBytes }); assert.equal(invalidPdf.statusCode, 400);
    report.source_integrity = { missing_pdf_blocked: true, wrong_pdf_sha_blocked: true, wrong_ir_sha_blocked: true, history_remains_viewable: true, identical_pdf_restore: true, shared_pdf_reference_retained: true };
    const deletedOriginalPdf = await workflow.pdf('MED03'); await workflow.deletePaper('MED03');
    await app.close(); store.close(); legacy.close();
    store = new ExtractionStore(database); legacy = new RunStore(); workflow = new WorkbenchWorkflow(store, { directory, ...fixture }); app = buildApp(legacy, undefined, workflow); await app.ready();
    await assert.rejects(workflow.detail('MED03'), /workbench_paper_not_found/);
    assert.ok(!(await workflow.papers()).some(p => p.id === 'MED03'));
    const newUpload = await workflow.upload(deletedOriginalPdf, 'explicit-reupload.pdf');
    assert.notEqual(newUpload.paper.id, 'MED03'); assert.equal((await workflow.detail(newUpload.paper.id)).outputs.length, 0);
    report.paper_deletion_restart = { automatic_reimport_blocked: true, original_S4_files_retained: true, explicit_same_PDF_upload_creates_new_paper_without_old_approvals: true };
    report.all_workflow_assertions_passed = true;
  } finally {
    for (const release of releases.values()) release(); await app.close(); store.close(); legacy.close(); await rm(directory, { recursive: true, force: true });
    await writeFile(resolve('docs/acceptance/s5-workflow-2026-11-09/backend-workflow-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
});
