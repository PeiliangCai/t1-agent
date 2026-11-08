"""Current-round review contracts, using disposable synthetic files and zero APIs."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest

CODE = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('current_output_builder_group_tests', CODE / 'scripts/build-current-output-review.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    return builder.sha256(path.read_bytes()).hexdigest()


def rel(path):
    return str(path.relative_to(CODE))


def fixture_pdf():
    # A real, one-page PDF for the page renderer. This is synthetic test data,
    # never a historical output or a source for medical acceptance.
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
    content = b'BT /F1 20 Tf 20 250 Td (SYNTHETIC UI FIXTURE ONLY) Tj ET'
    objects.append(b'<< /Length ' + str(len(content)).encode() + b' >>\nstream\n' + content + b'\nendstream')
    data, offsets = b'%PDF-1.4\n', [0]
    for n, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data += str(n).encode() + b' 0 obj\n' + obj + b'\nendobj\n'
    start = len(data)
    data += b'xref\n0 6\n0000000000 65535 f \n' + b''.join(f'{n:010d} 00000 n \n'.encode() for n in offsets[1:])
    return data + b'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + str(start).encode() + b'\n%%EOF\n'


def make_fixture(root, terminal_status='stopped'):
    """Build the owner handoff, including mixed/background/raw/failed/unstarted."""
    comparison = root / 'comparison'
    audit_path = comparison / 'automatic-audit/comparison.json'
    execution_path = comparison / 'execution/report.json'
    plan = {'schema_version': 'two-method-prepared-comparison-1', 'batch_id': 'synthetic-current-review-only',
        'config': {'model': {'model_id': 'synthetic-no-api', 'reasoning_effort': 'medium'},
            'experiment_scope': {'shared_protocol': builder.PRIMARY_POLICY}}, 'papers': []}
    execution = {'batch_id': plan['batch_id'], 'status': terminal_status, 'jobs': []}
    audit = {'batch_id': plan['batch_id'], 'execution_status': execution['status'], 'rows': [], 'automatic_audits': []}
    bound_jobs, rejected = [], []
    total_primary = total_background = 0
    for paper_index, prefix in enumerate(['L01', 'L05', 'L07']):
        folder = root / 'sources' / prefix
        folder.mkdir(parents=True)
        pdf_path, ir_path, catalog_path = [folder / name for name in ['source.pdf', 'ir.json', 'catalog.json']]
        pdf_path.write_bytes(fixture_pdf())
        pdf_sha = builder.sha256(pdf_path.read_bytes()).hexdigest()
        document_id, text_version, block_id = 'synthetic-' + prefix, 'synthetic-text-v1', prefix + '-b1'
        text = 'Original fixture <&> text\nwith ≤ 4 mm; not a medical result.'
        document = {'document_id': document_id, 'file_sha256': pdf_sha, 'text_version': text_version, 'title': 'Synthetic test only',
            'blocks': [{'block_id': block_id, 'page': 1, 'reading_order': 0, 'text': text}]}
        ir_sha = write_json(ir_path, {'document': document})
        catalog_sha = write_json(catalog_path, {'file_sha256': pdf_sha, 'text_version': text_version, 'figures': []})
        jobs = [{'job_id': prefix + '-' + method, 'condition': method,
            'representative_job_id': 'L01-B0' if prefix == 'L01' and method == 'F' else None,
            'independent_model_run': not (prefix == 'L01' and method == 'F'),
            'source_selection_digest': prefix + '-' + method + '-digest', 'selection': {'excluded_block_ids': []}}
            for method in ['B0', 'F']]
        paper = {'document_id': document_id, 'pdf_path': rel(pdf_path), 'pdf_sha256': pdf_sha, 'ir_path': rel(ir_path),
            'ir_sha256': ir_sha, 'figure_catalog_path': rel(catalog_path), 'figure_catalog_sha256': catalog_sha,
            'text_version': text_version, 'methods': {'jobs': jobs}}
        plan['papers'].append(paper)
        representative_row = representative_export = None
        for job in jobs:
            job_id = job['job_id']
            if not job['independent_model_run']:
                copied = {**representative_row, 'job_id': job_id, 'representative_job_id': 'L01-B0',
                    'independent_model_run': False, 'status': 'reused', 'candidate_export': representative_export}
                bound_jobs.append(copied)
                audit['rows'].append({**audit['rows'][-1], 'job_id': job_id, 'additional_physical_requests': 0})
                continue
            if job_id == 'L07-F':
                bound_jobs.append({'job_id': job_id, 'representative_job_id': None, 'independent_model_run': True,
                    'status': 'not_started', 'state': None, 'started': False, 'result_path': None, 'result_sha256': None,
                    'source_binding': None, 'candidate_export': None})
                audit['rows'].append({'job_id': job_id, 'state': None, 'candidate_count': None,
                    'task_processing_complete': False, 'method_requests': 0, 'additional_physical_requests': 0,
                    'unstarted_reason': 'synthetic stop', 'primary_candidate_count': None, 'background_suggestion_count': None})
                continue
            run_id = 'synthetic-run-' + job_id
            failed = job_id == 'L07-B0'
            span = {'block_id': block_id, 'text_version': text_version, 'physical_page': 1, 'start': 0, 'end': len(text), 'exact_quote': text}
            versions, primary, background = [], [], []
            for index, assessment_value in enumerate(['mixed_or_needs_context', 'context_only_suggested'] + (['uncertain'] if failed else [])):
                record_id = job_id + '-record-' + str(index)
                record = {'record_id': record_id, 'document_id': document_id, 'evidence_type': 'imaging_observation',
                    'review_status': 'needs_context' if index == 2 else 'unreviewed',
                    'quote_span': {'segments': [span]}, 'context': {'fragments': [], 'status': 'complete'},
                    'evidence_validation': {'model_semantic_review': {'status': 'reviewed_unapproved', 'model_id': 'synthetic-no-api',
                        'assessment_policy_version': builder.PRIMARY_POLICY, 'primary_assessment': assessment_value, 'issue_codes': []}},
                    'extraction_trace': {'run_id': run_id, 'fixture': False, 'primary_assessment_policy_version': builder.PRIMARY_POLICY}}
                versions.append({'record': record, 'version': 2, 'actor': 'automatic', 'status': 'active'})
                record_sha = builder.Builder.js_digests([record])[0]
                if index == 2:
                    rejected.append({'job_id': job_id, 'run_id': run_id, 'record_id': record_id, 'record_version': 2,
                        'source_record_sha256': record_sha, 'record': record,
                        'source_binding': {'pdf_sha256': pdf_sha, 'ir_sha256': ir_sha, 'text_version': text_version,
                            'result_sha256': None, 'delivery_fingerprint': None},
                        'delivery_fingerprint': None, 'issues': [{'code': 'synthetic_guard_rejection_without_missing_spans'}]})
                    continue
                entry = {'record_id': record_id, 'record_version': 2, 'run_id': run_id, 'document_id': document_id,
                    'original_fragments': [span], 'context_fragments': [], 'source_record_sha256': record_sha}
                entry['text_fingerprint'] = builder.Builder.js_digests([entry])[0]
                entry.update(figure_association={'status': 'no_explicit_reference', 'figure_ids': [], 'proposed_figure_ids': [], 'reasons': ['Synthetic: no explicit reference']},
                    review_status=record['review_status'], primary_assessment={'policy_version': builder.PRIMARY_POLICY, 'value': assessment_value,
                        'status': 'reviewed_unapproved', 'model_id': 'synthetic-no-api', 'record_version': 2, 'source_record_sha256': record_sha,
                        'record_actor': 'automatic', 'effective_role': 'background_suggestion' if index == 1 else 'primary_candidate', 'human_approved': False})
                entry['delivery_fingerprint'] = builder.Builder.js_digests([{**entry, 'figure_content': []}])[0]
                (background if index == 1 else primary).append(entry)
            result_path = comparison / 'execution' / (job_id + '-result.json')
            result = {'document_id': document_id, 'run_id': run_id, 'model_id': 'synthetic-no-api', 'reasoning_effort': 'medium',
                'source_selection_digest': job['source_selection_digest'], 'versions': versions, 'task_processing_complete': not failed,
                'state': 'failed' if failed else 'completed', 'error': {'code': 'delivery_visual_statement_policy_failed'} if failed else None}
            result_sha = write_json(result_path, result)
            for view in rejected:
                if view['job_id'] == job_id:
                    view['source_binding']['result_sha256'] = result_sha
            export_dir = audit_path.parent / (job_id + '-candidates')
            delivery = {'records': primary, 'background_records': background, 'primary_assessment_policy_version': builder.PRIMARY_POLICY}
            manifest = {'mode': 'candidates', 'medical_quality_approved': False, 'record_level_human_confirmation': False,
                'file_sha256': pdf_sha, 'text_version': text_version, 'record_count': 2,
                'primary_candidate_count': 1, 'background_suggestion_count': 1, 'assets': []}
            manifest_sha = write_json(export_dir / 'manifest.json', manifest)
            delivery_sha = write_json(export_dir / 'delivery.json', delivery)
            for name, values in [('records', primary), ('background-records', background)]:
                (export_dir / (name + '.jsonl')).write_text(''.join(json.dumps(v, ensure_ascii=False) + '\n' for v in values))
                (export_dir / (name + '.csv')).write_text('record_id,record_version\n' + ''.join(v['record_id'] + ',2\n' for v in values))
            exported = {'directory': rel(export_dir), 'manifest_path': rel(export_dir / 'manifest.json'), 'manifest_sha256': manifest_sha,
                'delivery_path': rel(export_dir / 'delivery.json'), 'delivery_sha256': delivery_sha,
                'records_path': rel(export_dir / 'records.jsonl'), 'background_records_path': rel(export_dir / 'background-records.jsonl'),
                'primary_count': 1, 'background_count': 1, 'total_count': 2}
            row = {'job_id': job_id, 'result_path': rel(result_path), 'candidate_count': len(versions)}
            execution['jobs'].append(row)
            audit['rows'].append({'job_id': job_id, 'state': result['state'], 'candidate_count': len(versions),
                'task_processing_complete': not failed, 'method_requests': 1, 'additional_physical_requests': 1,
                'valid_source_delivery_records': 2, 'rejected_current_record_count': int(failed),
                'primary_candidate_count': 1, 'background_suggestion_count': 1, 'primary_assessment_policy_version': builder.PRIMARY_POLICY})
            audit['automatic_audits'].append({'job_id': job_id, 'coverage': {}, 'error': result['error'], 'whole_live_delivery_passed': not failed})
            bound_row = {'job_id': job_id, 'representative_job_id': None, 'independent_model_run': True,
                'status': 'failed' if failed else 'finished', 'state': result['state'], 'started': True, 'result_path': rel(result_path),
                'result_sha256': result_sha, 'source_binding': {'pdf_sha256': pdf_sha, 'ir_sha256': ir_sha, 'text_version': text_version},
                'candidate_export': exported}
            bound_jobs.append(bound_row)
            representative_row, representative_export = bound_row, exported
            total_primary += 1
            total_background += 1
    plan_path = comparison / 'plan.json'
    plan_sha, execution_sha, audit_sha = write_json(plan_path, plan), write_json(execution_path, execution), write_json(audit_path, audit)
    ledger_path = comparison / 'execution/fixture-ledger.json'
    ledger_sha = write_json(ledger_path, {'synthetic_fixture_only': True, 'requests': []})
    rejected_path = comparison / 'rejected-views.json'
    rejected_sha = write_json(rejected_path, {'schema_version': 'current-output-rejected-views-1', 'views': rejected})
    binding = {'schema_version': 'current-output-binding-1', 'finalized': True, 'plan_path': rel(plan_path), 'plan_sha256': plan_sha,
        'execution_report_path': rel(execution_path), 'execution_report_sha256': execution_sha, 'execution_status': execution['status'],
        'audit_path': rel(audit_path), 'audit_sha256': audit_sha, 'ledger_path': rel(ledger_path), 'ledger_sha256': ledger_sha,
        'rejected_views_path': rel(rejected_path), 'rejected_views_sha256': rejected_sha, 'jobs': bound_jobs,
        'total_current_records': total_primary + total_background + len(rejected), 'primary_candidate_records': total_primary,
        'background_suggestions': total_background, 'rejected_current_records': len(rejected)}
    write_json(comparison / 'output-binding.json', binding)
    return plan_sha


class CurrentOutputReview(unittest.TestCase):
    def test_closed_owner_binding_preserves_both_groups_raw_rejections_and_unstarted_jobs(self):
        with tempfile.TemporaryDirectory(prefix='new-review-fixture-', dir=CODE / '.tools') as folder:
            root = Path(folder)
            plan_sha = make_fixture(root, 'finished_runs_human_quality_and_selection_pending')
            with contextlib.redirect_stdout(io.StringIO()):
                builder.Builder(root, plan_sha).build()
            pack = json.loads((root / 'output-review/data.json').read_text())
            self.assertEqual(pack['group_counts'], {'primary_candidate': 4, 'background_suggestion': 4,
                'delivery_rejected': 1, 'total_current_records': 9, 'legal_delivery_records': 8})
            self.assertEqual(pack['actual_independent_runs_with_model_requests'], 4)
            self.assertEqual(pack['logical_jobs'][-1]['started'], False)
            raw = next(c for c in pack['cases'] if c['review_group'] == 'delivery_rejected')
            self.assertIsNone(raw['source_binding']['delivery_fingerprint'])
            self.assertFalse(any('缺失原文' in s['title'] for s in raw['after']['sections']))
            main = next(c for c in pack['cases'] if c['review_group'] == 'primary_candidate')
            background = next(c for c in pack['cases'] if c['review_group'] == 'background_suggestion')
            self.assertNotEqual(main['questions'][1]['review_intent'], background['questions'][1]['review_intent'])
            self.assertIn('背景建议', background['questions'][1]['text'])
            self.assertEqual(main['source_binding']['primary_assessment']['value'], 'mixed_or_needs_context')
            self.assertIn('未启动', (root / 'output-review/index.html').read_text())
            self.assertIn('失败', (root / 'output-review/all-candidates.html').read_text())
            self.assertEqual(len(json.loads((root / 'output-review/manifest.json').read_text())['all_candidate_membership']), 9)

    def test_partial_parser_limit_is_separate_from_current_task_completion(self):
        job = {'job_id': 'synthetic', 'representative_job_id': 'synthetic', 'independent': True, 'state': 'partial',
            'task_processing_complete': True, 'started': True, 'execution_status': 'saved_result',
            'result_available': True, 'parser_status': 'partial', 'image_text_unverified_pages': 2, 'f_unselected_source_blocks': 3}
        self.assertEqual(builder.Builder.run_status(job), '本次范围处理完成；候选仍待核')
        instance = builder.Builder(CODE / '.tools/synthetic-not-written', 'fixed-seed')
        table = instance.run_table([job])
        self.assertIn('原解析保留 partial', table)
        self.assertIn('2 页图中文字未核验', table)
        self.assertIn('预筛未选入 3', table)

    def test_c14_page_scope_risk_requires_exact_source_and_never_copies_historical_votes(self):
        span = {'block_id': 'b', 'text_version': 'v', 'start': 0, 'end': 3, 'exact_quote': 'raw', 'physical_page': 1}
        source = {'job': {'job_id': 'L07-F'}, 'entry': {'record_id': 'current', 'record_version': 3,
            'original_fragments': [span]}, 'binding': {'pdf_sha256': 'pdf', 'ir_sha256': 'ir', 'text_version': 'v'}}
        anchor = {'historical_case_id': 'C14-483dd5716867', 'old_original_fragments': [span],
            'source_binding': dict(source['binding']), 'current_source_span_overlap': [{'job_id': 'L07-F',
                'record_id': 'current', 'record_version': 3, 'effective_role': 'primary_candidate'}],
            'hypothetical_historical_vote_must_not_be_copied': 'has_problem'}
        instance = builder.Builder(CODE / '.tools/synthetic-not-written', 'fixed-seed')
        instance.output_binding = {'terminal_audit_sha256': 'f' * 64}
        instance.terminal_audit = {'historical_feedback_source_anchor_checks': [anchor]}
        instance.attach_page_scope_risks([source])
        risk = source['directed_review_risks'][0]
        self.assertTrue(risk['scope_execution_deviation'])
        self.assertIn('这是规则执行偏差', instance.directed_risk_label(risk))
        self.assertNotIn('has_problem', json.dumps(risk))
        self.assertEqual(source['entry']['original_fragments'], [span])
        source['binding']['pdf_sha256'] = 'changed'
        with self.assertRaisesRegex(ValueError, 'exact frozen historical/current source spans'):
            instance.attach_page_scope_risks([source])

    def test_running_or_changed_owner_handoff_cannot_create_a_pack(self):
        with tempfile.TemporaryDirectory(prefix='new-review-binding-', dir=CODE / '.tools') as folder:
            root = Path(folder)
            plan_sha = make_fixture(root)
            path = root / 'comparison/output-binding.json'
            binding = json.loads(path.read_text())
            binding['finalized'] = False
            write_json(path, binding)
            with self.assertRaisesRegex(ValueError, 'not finalized'):
                builder.Builder(root, plan_sha).build()
            self.assertFalse((root / 'output-review').exists())
            binding['finalized'] = True
            write_json(path, binding)
            result_path = builder.inside(binding['jobs'][0]['result_path'])
            result_path.write_text(result_path.read_text() + ' ')
            with self.assertRaisesRegex(ValueError, 'source hash mismatch'):
                builder.Builder(root, plan_sha).build()
            self.assertFalse((root / 'output-review').exists())

    def test_all_rejected_result_never_requires_or_forges_a_legal_export_fingerprint(self):
        with tempfile.TemporaryDirectory(prefix='new-review-all-rejected-', dir=CODE / '.tools') as folder:
            root = Path(folder)
            plan_sha = make_fixture(root)
            comparison = root / 'comparison'
            binding_path = comparison / 'output-binding.json'
            binding = json.loads(binding_path.read_text())
            bound = next(j for j in binding['jobs'] if j['job_id'] == 'L07-B0')
            result_path = builder.inside(bound['result_path'])
            result = json.loads(result_path.read_text())
            result['versions'] = result['versions'][-1:]
            bound['result_sha256'] = write_json(result_path, result)
            shutil.rmtree(builder.inside(bound['candidate_export']['directory']))
            bound['candidate_export'] = None
            views_path = builder.inside(binding['rejected_views_path'])
            views = json.loads(views_path.read_text())
            views['views'][0]['source_binding']['result_sha256'] = bound['result_sha256']
            binding['rejected_views_sha256'] = write_json(views_path, views)
            binding.update(total_current_records=7, primary_candidate_records=3, background_suggestions=3)
            write_json(binding_path, binding)
            with contextlib.redirect_stdout(io.StringIO()):
                builder.Builder(root, plan_sha).build()
            pack = json.loads((root / 'output-review/data.json').read_text())
            raw = next(c for c in pack['cases'] if c['review_group'] == 'delivery_rejected')
            self.assertIsNone(raw['source_binding']['delivery_fingerprint'])
            self.assertNotIn('candidate_export_manifest_sha256', raw['source_binding'])
            self.assertEqual(pack['group_counts']['total_current_records'], 7)

    def test_delivery_groups_do_not_reclassify_mixed_uncertain_or_legacy_issue_strings(self):
        source = {'entry': {}, 'record': {'evidence_validation': {'model_semantic_review': {'issue_codes': ['only_background']}}}}
        self.assertEqual(builder.Builder.review_group(source), 'primary_candidate')
        for value in ['mixed_or_needs_context', 'uncertain', 'visual_evidence_suggested']:
            a = {'policy_version': builder.PRIMARY_POLICY, 'value': value, 'record_version': 1,
                'source_record_sha256': 'sha', 'effective_role': 'background_suggestion', 'human_approved': False}
            delivery = {'records': [], 'background_records': [{'record_id': 'x', 'record_version': 1,
                'source_record_sha256': 'sha', 'primary_assessment': a}], 'primary_assessment_policy_version': builder.PRIMARY_POLICY}
            with self.assertRaisesRegex(ValueError, 'assessment/version/group'):
                builder.Builder.validate_delivery_groups(delivery, {'primary_candidate_count': 0, 'background_suggestion_count': 1})

    def test_sampling_keeps_base_ranking_both_roles_and_all_rejected_views(self):
        instance = builder.Builder(CODE / '.tools/synthetic-not-written', 'fixed-seed')
        population = []
        for n in range(35):
            source = {'job': {'job_id': 'single-run'}, 'entry': {'record_id': str(n), 'record_version': 1,
                'delivery_fingerprint': str(n), 'review_status': 'unreviewed', 'figure_association': {'status': 'no_explicit_reference'}},
                'record': {'evidence_type': 'imaging_observation', 'context': {'status': 'complete'},
                    'evidence_validation': {'model_semantic_review': {'issue_codes': []}}}, 'binding': {}}
            population.append(source)
        initial = instance.select_records(population)
        base_ids = [r['entry']['record_id'] for r, mode in initial if mode != 'directed_risk_not_random_sample']
        self.assertEqual(len(base_ids), 6)
        for n, source in enumerate(r for r in population if r['entry']['record_id'] not in base_ids):
            if n == 0:
                source['entry']['primary_assessment'] = {'effective_role': 'background_suggestion'}
            elif n <= 4:
                source['rejected_view'] = {'synthetic': True}
                source['binding']['raw_view_fingerprint'] = 'raw-' + source['entry']['record_id']
            elif n in [20, 21, 22]:
                source['directed_review_risks'] = [{'job_id': 'single-run', 'record_id': source['entry']['record_id'],
                    'record_version': 1, 'reason': 'synthetic mandated risk'}]
        selected = instance.select_records(population)
        self.assertEqual(base_ids, [r['entry']['record_id'] for r, mode in selected if mode != 'directed_risk_not_random_sample'])
        self.assertEqual(len(selected), len({r['entry']['record_id'] for r, _ in selected}))
        self.assertEqual(sum(bool(r.get('rejected_view')) for r, _ in selected), 4)
        self.assertEqual(sum(bool(r.get('directed_review_risks')) for r, _ in selected), 3)
        self.assertTrue(any(instance.review_group(r) == 'background_suggestion' for r, _ in selected))
        self.assertEqual([(r['entry']['record_id'], mode) for r, mode in selected],
            [(r['entry']['record_id'], mode) for r, mode in instance.select_records(list(reversed(population)))])


if __name__ == '__main__':
    import sys
    if len(sys.argv) == 3 and sys.argv[1] == '--write-browser-fixture':
        root = Path(sys.argv[2])
        plan_sha = make_fixture(root)
        builder.Builder(root, plan_sha).build()
    else:
        unittest.main()
