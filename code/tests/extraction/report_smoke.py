"""Focused report smoke checks: token accounting, history, fixture isolation, escaping, read-only SQLite."""
import hashlib
from html.parser import HTMLParser
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
CODE = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('s4_report', CODE / 'scripts/render-s4-report.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ScriptCounter(HTMLParser):
    def __init__(self):
        super().__init__(); self.scripts = 0

    def handle_starttag(self, tag, attrs):
        if tag == 'script': self.scripts += 1


class ReportSmoke(unittest.TestCase):
    def test_reported_tokens_never_include_unknown_reservations_or_double_count_cache_and_reasoning(self):
        rows = [{'usage_status': 'provider_reported', 'input_tokens': 10, 'output_tokens': 20,
                 'cache_read_tokens': 3, 'cache_write_tokens': 2, 'reasoning_tokens': 5},
                {'usage_status': 'missing_usage_conservative_reservation', 'input_ceiling': 100, 'output_ceiling': 50},
                {'usage_status': 'reserved', 'input_ceiling': 200, 'output_ceiling': 60}]
        totals = MODULE.usage_totals(rows, {})
        self.assertEqual(totals['provider_reported_input_tokens'], 10)
        self.assertEqual(totals['provider_reported_output_tokens'], 20)
        self.assertEqual(totals['unknown_usage_reserved_input_tokens'], 300)
        self.assertEqual(totals['unknown_usage_reserved_output_tokens'], 110)
        self.assertEqual(totals['unknown_usage_requests'], 2)
        self.assertIsNone(totals['actual_bill'])

    def test_verified_flat_price_is_only_a_scenario_and_excludes_unknown_usage(self):
        prices = {'currency': 'CNY', 'models': {'synthetic': {'input': 12.6, 'output': 63}}}
        known = {'model_id': 'synthetic', 'usage_status': 'provider_reported', 'input_tokens': 1_000_000, 'output_tokens': 1_000_000,
                 'cache_read_tokens': 100_000, 'reasoning_tokens': 100_000}
        unknown = {'model_id': 'synthetic', 'usage_status': 'reserved', 'input_ceiling': 2_000_000, 'output_ceiling': 10}
        totals = MODULE.usage_totals([known, unknown], prices)
        self.assertAlmostEqual(totals['known_usage_list_price_estimate'], 75.6)
        self.assertIsNone(totals['unknown_usage_reservation_price_scenario'])
        self.assertIsNone(totals['actual_bill'])

    def test_early_probe_excess_is_detected_even_before_explicit_flags_were_added(self):
        rows = [{'usage_status': 'provider_reported', 'input_tokens': 6163, 'output_tokens': 75, 'payload_bytes': 1092, 'input_ceiling': 1604}]
        totals = MODULE.usage_totals(rows, {})
        self.assertEqual(totals['provider_input_above_local_estimate_requests'], 1)
        self.assertEqual(totals['provider_input_above_reservation_requests'], 1)

    def test_historical_failed_attempts_are_preserved_and_fixture_records_cannot_become_paid_paper_evidence(self):
        with tempfile.TemporaryDirectory(prefix='s4-report-smoke-', dir=CODE / 'docs/acceptance/s4') as temporary:
            root = Path(temporary); out = root / 'docs/acceptance/s4'; out.mkdir(parents=True)
            runtime = root / 'runtime-data/s4/synthetic'; runtime.mkdir(parents=True)
            def save(path, value):
                path.parent.mkdir(parents=True, exist_ok=True); path.write_text(json.dumps(value), encoding='utf-8')
            save(out / 'experiment-register.json', {'batch_id': 'synthetic-test', 'runtime_directory': 'runtime-data/s4/synthetic'})
            old = {'job_id': 'job-01', 'run_id': 'synthetic-old', 'model_id': 'synthetic', 'document_id': 'synthetic', 'strategy': 'baseline',
                   'status': 'interrupted_diagnostic', 'directory': 'runtime-data/s4/synthetic/old'}
            new = {**old, 'run_id': 'synthetic-new', 'status': 'running', 'directory': 'runtime-data/s4/synthetic/new', 'attempt_history': [old]}
            save(out / 'matrix-progress.json', {'planned_runs': 1, 'jobs': [new]})
            record = {'record_id': 'synthetic-candidate', 'feature_name_raw': '<script>alert(1)</script>', 'original_quote': '<script>alert(1)</script>',
                      'quote_span': {'segments': [], 'display_joiner': '\n'}, 'review_status': 'needs_context', 'evidence_validation': {}, 'extraction_trace': {'fixture': True}}
            save(runtime / 'new/result.json', {'run_id': 'synthetic-new', 'state': 'partial', 'records': [{'record': record, 'version': 1, 'actor': 'automatic'}]})
            save(runtime / 'call-ledger.json', {'requests': [
                {'id': 'old-request', 'model_id': 'synthetic', 'purpose': 'synthetic-old:batch-1', 'usage_status': 'missing_usage_conservative_reservation', 'input_ceiling': 10, 'output_ceiling': 20},
                {'id': 'new-request', 'model_id': 'synthetic', 'purpose': 'synthetic-new:batch-1', 'usage_status': 'provider_reported', 'input_tokens': 3, 'output_tokens': 4}]})
            report = MODULE.Report(root, out); data = MODULE.collect(report)
            self.assertEqual(len(data['runs']), 2); self.assertTrue(data['runs'][0]['historical'])
            self.assertEqual(data['runs'][0]['status'], 'interrupted_diagnostic')
            self.assertEqual(data['runs'][0]['evidence_class'], 'unverified_run')
            self.assertEqual(data['runs'][1]['evidence_class'], 'engineering_fixture')
            self.assertEqual(len(data['runs'][1]['records']), 1)
            data['real_candidate_engineering_cases'] = {'cases': [{'case_id': '</script><script>case()</script>',
                'run_id': 'synthetic-new', 'record_id': 'synthetic-candidate', 'record_snapshot': record,
                'findings': {'completeness': '</script><script>finding()</script>'}}]}
            page = MODULE.render(report, data)
            self.assertIn('&lt;script&gt;alert(1)&lt;/script&gt;', page)
            self.assertNotIn('<script>alert(1)</script>', page)
            parsed = ScriptCounter(); parsed.feed(page); self.assertEqual(parsed.scripts, 1)
            self.assertNotIn('<script>finding()', page); self.assertIn('&lt;script&gt;finding()', page)
            self.assertIn('not_evaluable', page); self.assertFalse(data['stage_passed'])

    def test_sqlite_snapshot_does_not_write_or_promote_proposals(self):
        with tempfile.TemporaryDirectory(prefix='s4-report-db-', dir=CODE / 'docs/acceptance/s4') as temporary:
            root = Path(temporary); path = root / 's4.sqlite'
            db = sqlite3.connect(path)
            db.executescript('CREATE TABLE s4_runs(id,input_json,state,metadata_json); CREATE TABLE s4_versions(run_id,envelope_json); CREATE TABLE s4_events(run_id,payload_json); CREATE TABLE s4_batches(run_id,payload_json);')
            db.execute('INSERT INTO s4_runs VALUES(?,?,?,?)', ('run', '{}', 'partial', '{}'))
            for n, status in [(1, 'active'), (2, 'proposed')]:
                db.execute('INSERT INTO s4_versions VALUES(?,?)', ('run', json.dumps({'record': {'record_id': 'record'}, 'version': n, 'status': status})))
            db.commit(); db.close()
            before = hashlib.sha256(path.read_bytes()).hexdigest()
            report = MODULE.Report(root, root); data = report.database(root)
            self.assertEqual(data['run']['candidates'][0]['version'], 1)
            self.assertEqual(len(data['run']['versions']), 2)
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before)

    def test_source_data_is_html_escaped_in_json_details(self):
        rendered = MODULE.json_details('<source>', {'quote': '</pre></script><script>bad()</script>'})
        self.assertNotIn('<script>', rendered)
        self.assertIn('&lt;source&gt;', rendered)
        self.assertIn('&lt;/pre&gt;&lt;/script&gt;&lt;script&gt;', rendered)

    def test_existing_local_paths_are_url_encoded_and_their_labels_remain_text(self):
        with tempfile.TemporaryDirectory(prefix='s4-report-path-', dir=CODE / 'docs/acceptance/s4') as temporary:
            root = Path(temporary); source = root / 'quote"><svg onload=alert(1)>.pdf'; source.write_bytes(b'engineering-path-test')
            report = MODULE.Report(root, root)
            rendered = report.link(str(source), '<script>label</script>', 2)
            self.assertNotIn('<script>', rendered); self.assertNotIn('<svg', rendered)
            self.assertIn('%3Csvg', rendered); self.assertIn('&lt;script&gt;label&lt;/script&gt;', rendered)
            self.assertIn('#page=2', rendered)

    def test_effective_deadline_and_semantic_cases_follow_actual_matching_events_only(self):
        with tempfile.TemporaryDirectory(prefix='s4-report-status-', dir=CODE / 'docs/acceptance/s4') as temporary:
            root = Path(temporary); out = root / 'docs/acceptance/s4'; out.mkdir(parents=True)
            runtime = root / 'runtime-data/s4/sample'; runtime.mkdir(parents=True)
            def save(path, value):
                path.parent.mkdir(parents=True, exist_ok=True); path.write_text(json.dumps(value), encoding='utf-8')
            save(out / 'experiment-register.json', {'batch_id': 'synthetic-test', 'runtime_directory': 'runtime-data/s4/sample'})
            save(out / 'matrix-progress.json', {'planned_runs': 1, 'jobs': [{'job_id': 'j1', 'run_id': 'r1', 'directory': 'runtime-data/s4/sample/j1',
                'document_id': 'synthetic', 'model_id': 'synthetic', 'strategy': 'independent_context_review', 'status': 'finished_quality_pending'}]})
            save(runtime / 'call-ledger.json', {'limits': {'seconds': 7200}, 'wall_clock_adjustments': [{'from_seconds': 7200, 'to_seconds': 14400}], 'requests': []})
            binding = {'document_id': 'synthetic', 'file_sha256': 'a' * 64, 'source_version': 'source-v1', 'text_version': 'text-v1'}
            save(out / 'evidence-validation/semantic-audit-cases.json', {'cases': [
                {'case_id': 'reviewed', 'source_binding': binding, 'question': 'A neutral question', 'not_gold': True, 'medical_approval': False},
                {'case_id': 'pending', 'source_binding': binding, 'question': 'Another neutral question', 'not_gold': True, 'medical_approval': False}]})
            save(runtime / 'j1/result.json', {'run_id': 'r1', 'state': 'partial', 'records': [], 'events': [
                {'type': 'semantic_audit_review', 'timestamp': '2026-11-03T00:00:00Z', 'detail': {'case_id': 'reviewed', 'source_binding': binding,
                    'conclusion': 'context_only', 'reason': 'ACTUAL_UNAPPROVED_REVIEW', 'medical_approval': False}},
                {'type': 'semantic_audit_review', 'timestamp': '2026-11-03T00:00:01Z', 'detail': {'case_id': 'pending',
                    'source_binding': {**binding, 'text_version': 'another-version'}, 'reason': 'WRONG_VERSION_MUST_NOT_MARK_COMPLETE', 'medical_approval': False}}]})
            report = MODULE.Report(root, out); data = MODULE.collect(report); page = MODULE.render(report, data)
            self.assertEqual(data['ledger_limits']['seconds'], 7200)
            self.assertEqual(data['ledger_effective_experiment_seconds'], 14400)
            semantic = page.split('<section id="semantic-audit">', 1)[1].split('</section>', 1)[0]
            self.assertIn('ACTUAL_UNAPPROVED_REVIEW', semantic)
            self.assertIn('not_run：', semantic)
            self.assertNotIn('WRONG_VERSION_MUST_NOT_MARK_COMPLETE', semantic)
            self.assertIn('medical_approval=false', semantic)


if __name__ == '__main__':
    unittest.main(verbosity=2)
