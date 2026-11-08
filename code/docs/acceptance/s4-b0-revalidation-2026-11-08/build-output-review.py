"""Offline B0 review adapter. Writes only this round's output-review; zero APIs.

Formal generation requires the owner's terminal, finalized byte-bound handoff.
The familiar renderer is imported read-only; no runtime/evaluation code is edited.
"""
import argparse
from collections import Counter
from hashlib import sha256
from html import escape
import importlib.util
import json
from pathlib import Path
import re
import shutil
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
CODE = ROOT.parents[2]
PLAN_SHA = '702d57baa5bcf68e6b1d8f7e91b859a67286210c728d207b50cf2a34b7316026'
POSTPROCESSING_HELPER_PATH = 'packages/agent/src/strict-source-groups.ts'
RENDERER = CODE / 'scripts/build-current-output-review.py'
RENDERER_SHA = sha256(RENDERER.read_bytes()).hexdigest()
OBSERVATION_LABELS = {
    'normal_tissue': '正常组织信号是否独立列出', 'standalone_conclusion': '纯诊断结论是否独立列出',
    'conditional_appearance_negation': '完整条件句与否定', 'same_source_attribution': '同源成员与来源归属',
    'direct_measurement_observation': '病灶范围量值原文', 'morphology_and_measurement': '形态与角度原文',
    'chinese_source_fidelity': '中文原文与换行', 'chinese_source_fidelity_and_explicit_figure': '中文图注与面板引用',
    'background_quantity_observation': 'AAH量值原句的背景安排', 'standalone_risk_threshold_observation': '风险阈值结论的背景安排',
}
spec = importlib.util.spec_from_file_location('b0_readonly_renderer', RENDERER)
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
# This private imported module instance is only this adapter's renderer. The
# existing files/old pages are unchanged; an absent export need not be a refusal.
base.REVIEW_GROUPS = {**base.REVIEW_GROUPS, 'delivery_rejected': '未进入候选导出的原始记录'}


def key(source):
    return (source['job']['job_id'], source['entry']['record_id'], source['entry']['record_version'])


def anchors(values):
    return [{k: f[k] for k in ['block_id', 'text_version', 'start', 'end', 'exact_quote']} for f in values]


class B0Review(base.Builder):
    def __init__(self, binding_path=None, expected_binding=None, postprocessing_path=None, expected_postprocessing=None):
        super().__init__(ROOT, PLAN_SHA)
        self.prepared = ROOT / 'prepared'
        self.execution = self.prepared / 'execution'
        self.binding_path = binding_path or ROOT / 'output-binding.json'
        self.expected_binding = expected_binding
        self.postprocessing_path = postprocessing_path
        self.expected_postprocessing = expected_postprocessing
        self.postprocessing = None
        self.review_source_groups = []
        self.source_transition = None
        self.source_groups = []
        self.observation_results = []
        self.source_bytes(RENDERER, RENDERER_SHA)

    def preflight(self):
        plan = self.read(self.prepared / 'plan.json', PLAN_SHA)
        if plan['schema_version'] != 'b0-prepared-revalidation-1' or plan['method'] != 'B0' or len(plan['papers']) != 3 or \
                len(plan['source_hashes']) != 66 or len(plan['observations']) != 10:
            raise ValueError('the frozen single-B0 three-paper plan is required')
        if self.postprocessing_path or self.expected_postprocessing:
            self.read_postprocessing(plan)
        for path, expected in plan['source_hashes'].items():
            original = self.source_bytes(self.prepared / 'source-snapshot' / path, expected)
            if self.source_transition and path == POSTPROCESSING_HELPER_PATH:
                current = self.source_bytes(path, self.source_transition['postprocessing_source_sha256'])
                if not current.startswith(original):
                    raise ValueError('the sole post-run helper change must preserve the complete model-run source prefix')
            else:
                self.source_bytes(path, expected)
        for paper in plan['papers']:
            for path, expected in {paper['pdf_path']: paper['pdf_sha256'], paper['ir_path']: paper['ir_sha256'],
                    paper['figure_catalog_path']: paper['figure_catalog_sha256'], **paper['assets']}.items():
                self.source_bytes(path, expected)
                self.source_bytes(self.prepared / 'input-snapshot' / path, expected)
        return plan

    def read_postprocessing(self, plan):
        if not self.postprocessing_path or not self.expected_postprocessing:
            raise ValueError('postprocessing needs its separate owner-supplied path and SHA')
        value = self.read(self.postprocessing_path, self.expected_postprocessing)
        if value.get('schema_version') != 'b0-derived-source-review-binding-1' or value.get('finalized') is not True or \
                value.get('helper_source_path') != POSTPROCESSING_HELPER_PATH or \
                value.get('model_runtime_sha256') != plan['source_hashes'][POSTPROCESSING_HELPER_PATH] or \
                not isinstance(value.get('postprocessing_source_sha256'), str) or \
                len(value['postprocessing_source_sha256']) != 64:
            raise ValueError('sole authorized post-run helper old/new source binding required')
        if not self.expected_binding or value.get('parent_output_binding_sha256') != self.expected_binding or \
                base.inside(value['parent_output_binding_path']) != base.inside(self.binding_path):
            raise ValueError('postprocessing must bind the already-frozen paid output handoff')
        if value.get('helper_used_in_paid_model_execution') is not False or value.get('additional_real_model_provider_requests') != 0 or \
                value.get('original_paid_outputs_rewritten') is not False or value.get('medical_quality_approved') is not False or \
                any(v is not True for v in value.get('guard_policy', {}).values()) or \
                base.inside(value['model_runtime_source_snapshot_path']) != self.prepared / 'source-snapshot' / POSTPROCESSING_HELPER_PATH:
            raise ValueError('post-run view must retain the original model execution and every source guard')
        self.check_declared_sources(value)
        self.source_bytes(value['parent_output_binding_path'], value['parent_output_binding_sha256'])
        self.source_bytes(value['helper_source_path'], value['postprocessing_source_sha256'])
        self.same_source_review_index = self.read(value['source_review_index_path'], value['source_review_index_sha256'])
        self.postprocessing = value
        self.source_transition = {k: value[k] for k in ['helper_source_path', 'model_runtime_sha256', 'postprocessing_source_sha256']}

    def check_declared_sources(self, value):
        if isinstance(value, list):
            for item in value:
                self.check_declared_sources(item)
        elif isinstance(value, dict):
            for name, item in value.items():
                if name.endswith('_path') and isinstance(item, str) and name[:-5] + '_sha256' in value:
                    self.source_bytes(item, value[name[:-5] + '_sha256'])
                elif isinstance(item, (dict, list)):
                    self.check_declared_sources(item)

    def attach_review_index(self, records, plan):
        payload = self.same_source_review_index
        if payload.get('schema_version') != 'same-source-review-index-1' or \
                {j['job_id'] for j in payload['jobs']} != set(plan['execution_order']) or \
                payload.get('parent_output_binding_sha256') != self.expected_binding or \
                payload.get('extra_model_requests') != 0 or any(payload.get(k) is not False for k in
                    ['changed_original_records', 'automatic_medical_deduplication', 'human_approval_propagated', 'used_in_paid_model_execution']):
            raise ValueError('current-job same-source review index required')
        by_id = {(r['job']['job_id'], r['entry']['record_id']): r for r in records}
        for job in payload['jobs']:
            view = job['index']
            bound = self.output_binding_jobs[job['job_id']]
            if job['result_path'] != bound['result_path'] or job['result_sha256'] != bound['result_sha256'] or \
                    job.get('original_strict_groups_replaced') is not False or \
                    job['original_strict_source_group_count'] != sum(g['job_id'] == job['job_id'] for g in self.source_groups):
                raise ValueError('derived job must preserve original result and strict group count')
            if view.get('schema_version') != 'same-source-review-index-1' or view.get('read_only_derived_view') is not True or \
                    any(view.get(k) is not False for k in ['clinical_deduplication_claimed', 'original_strict_groups_replaced',
                        'source_records_modified', 'human_approval_modified', 'medical_quality_approved']):
                raise ValueError('derived view cannot replace records/groups or propagate approval')
            seen = set()
            for group in view['groups']:
                if group['member_count'] != len(group['members']) or any(group.get(k) is not False for k in
                        ['patient_equivalence_claimed', 'automatic_member_selection', 'automatic_record_merge', 'approval_propagated']):
                    raise ValueError('derived source group cannot merge or select members')
                for member in group['members']:
                    source = by_id.get((job['job_id'], member['record_id']))
                    if not source or member['record_id'] in seen or member['record_version'] != source['entry']['record_version'] or \
                            member['source_record_sha256'] != source['binding']['source_record_sha256']:
                        raise ValueError('derived member must match an actual saved current version and fingerprint')
                    seen.add(member['record_id'])
                    raw, shared = source['record'], group['shared_literal_source']
                    if shared['document_id'] != source['paper']['document_id'] or shared['file_sha256'] != source['paper']['pdf_sha256'] or \
                            shared['text_version'] != source['paper']['text_version'] or shared['original_quote'] != raw['original_quote'] or \
                            shared['quote_segments'] != raw['quote_span']['segments'] or shared['context_before'] != raw['context']['before'] or \
                            shared['context_after'] != raw['context']['after'] or shared['context_fragments'] != raw['context']['fragments']:
                        raise ValueError('derived group changed the complete original/context source identity')
                    for field, value in member['evidence_fields'].items():
                        if value != (raw['context']['source_attribution'] if field == 'source_attribution' else raw.get(field)):
                            raise ValueError('derived view rewrote member clinical/model metadata: ' + field)
                    if member['original_duplicate_and_conflict_links'] != raw['duplicate_and_conflict_links']:
                        raise ValueError('derived view changed original relation links')
                    if source['binding'].get('source_group_id') is not None and source['binding']['source_group_id'] != 'source-group-' + member['strict_source_key']:
                        raise ValueError('derived view lost original strict source group identity')
                    source['derived_source_review_group'] = {'job_id': job['job_id'], **group}
                    source['binding'].update(postprocessing_binding_sha256=self.expected_postprocessing,
                        same_source_review_index_sha256=self.postprocessing['source_review_index_sha256'],
                        source_review_group_id=group['group_id'], source_review_group_projection_sha256=base.digest(group))
                self.review_source_groups.append({'job_id': job['job_id'], **group})
            actual_ids = {r['entry']['record_id'] for r in records if r['job']['job_id'] == job['job_id']}
            if seen != actual_ids or view['raw_current_record_count'] != len(actual_ids) or view['source_context_group_count'] != len(view['groups']):
                raise ValueError('derived index must preserve all original current records exactly once')
            for hint in view['internal_reference_hints']:
                source = by_id.get((job['job_id'], hint['record_id']))
                if not source or hint['record_version'] != source['entry']['record_version'] or \
                        hint['source_record_sha256'] != source['binding']['source_record_sha256'] or \
                        hint.get('reference_role_needs_review') is not True or hint.get('origin_modified') is not False or \
                        hint.get('external_attribution_established') is not False:
                    raise ValueError('internal Figure hint must preserve original attribution and approval state')
                source.setdefault('internal_reference_hints', []).append(hint)

    def handoff(self, plan):
        if not self.expected_binding:
            raise ValueError('formal generation needs the owner-supplied finalized binding SHA')
        binding = self.read(self.binding_path, self.expected_binding)
        if binding.get('finalized') is not True or binding.get('plan_sha256') != PLAN_SHA:
            raise ValueError('wait for finalized B0 output binding')
        if base.inside(binding['plan_path']) != self.prepared / 'plan.json' or \
                base.inside(binding['execution_report_path']) != self.execution / 'report.json':
            raise ValueError('B0 handoff points to another execution')
        self.check_declared_sources(binding)
        report = self.read(binding['execution_report_path'], binding['execution_report_sha256'])
        if report.get('purpose') != plan['purpose'] or report.get('method') != 'B0' or \
                report['status'] not in ['finished_b0_runs_outputs_unreviewed', 'stopped_after_failure'] or \
                binding.get('execution_status', report['status']) != report['status']:
            raise ValueError('terminal single-B0 report required; running outputs cannot be frozen')
        jobs = binding['jobs']
        if len(jobs) != 3 or {j['job_id'] for j in jobs} != set(plan['execution_order']):
            raise ValueError('binding must explicitly include actual and unstarted B0 jobs')
        self.output_binding = binding
        self.output_binding_jobs = {j['job_id']: j for j in jobs}
        return report

    def load_records(self, plan, report):
        rows = {r['job_id']: r for r in report['jobs']}
        records, jobs = [], []
        for paper in plan['papers']:
            bound = self.output_binding_jobs[paper['job_id']]
            row = rows.get(paper['job_id'], {})
            document = self.read(paper['ir_path'], paper['ir_sha256'])['document']
            catalog = self.read(paper['figure_catalog_path'], paper['figure_catalog_sha256'])
            if document['file_sha256'] != paper['pdf_sha256'] or document['text_version'] != paper['text_version'] or \
                    catalog['file_sha256'] != paper['pdf_sha256'] or catalog['text_version'] != paper['text_version']:
                raise ValueError('PDF/IR/catalog binding mismatch')
            self.pdfs[paper['document_id']] = self.asset(paper['pdf_path'], paper['pdf_sha256'])
            job = {'job_id': paper['job_id'], 'condition': 'B0', 'selection': paper['selection']}
            started = bound.get('started', bool(row))
            unverified_pages = (row.get('coverage') or {}).get('image_text_unverified_pages')
            view = {'job_id': paper['job_id'], 'representative_job_id': paper['job_id'], 'independent': True,
                'started': started, 'state': row.get('state'), 'task_processing_complete': row.get('task_processing_complete'),
                'execution_status': 'saved_result' if bound.get('result_path') else 'not_started' if not started else 'no_saved_result',
                'result_available': bool(bound.get('result_path')), 'error': row.get('error'),
                'frozen_status': row.get('status'), 'failure_codes': row.get('failure_codes', []),
                'parser_status': paper['parser_status'], 'image_text_unverified_pages': len(unverified_pages) if isinstance(unverified_pages, list) else unverified_pages,
                'task_source_blocks': len(paper['selection']['kept_block_ids']),
                'shared_bibliography_excluded_source_blocks': len(paper['selection']['excluded_block_ids']),
                'primary_candidate_count': 0 if started else None, 'background_suggestion_count': 0 if started else None,
                'rejected_current_record_count': 0 if started else None, 'method_requests': row.get('requests', 0),
                'coverage': row.get('coverage'), 'delivery_validation': row.get('delivery_validation')}
            jobs.append(view)
            if not bound.get('result_path'):
                if row.get('result_path'):
                    raise ValueError('unbound saved result must not disappear from the page')
                continue
            if row.get('result_path') != bound['result_path']:
                raise ValueError('binding and terminal report disagree on result')
            result = self.read(bound['result_path'], bound['result_sha256'])
            if result['document_id'] != paper['document_id'] or result['run_id'] != plan['batch_id'] + ':source-' + paper['document_id'] or \
                    result['model_id'] != plan['common']['model']['model_id'] or \
                    result['reasoning_effort'] != plan['common']['model']['reasoning_effort'] or \
                    result['source_selection_digest'] != paper['selection']['digest']:
                raise ValueError('current B0 result identity mismatch')
            view['primary_assessment_validation'] = result.get('primary_assessment_validation')
            current = {}
            for version in result['versions']:
                rid = version['record']['record_id']
                if version['status'] != 'proposed' and version['version'] > current.get(rid, {}).get('version', -1):
                    current[rid] = version
            export = bound.get('candidate_export')
            delivered = []
            if export:
                folder = base.inside(export['directory'])
                if isinstance(export.get('file_sha256'), dict):
                    for name, expected in export['file_sha256'].items():
                        if expected is None:
                            if (folder / name).exists():
                                raise ValueError('a declared-absent export sidecar exists: ' + name)
                            continue
                        self.source_bytes(folder / name, expected)
                manifest = self.read(export.get('manifest_path', folder / 'manifest.json'), export['manifest_sha256'])
                delivery = self.read(export.get('delivery_path', folder / 'delivery.json'), export['delivery_sha256'])
                self.validate_delivery_groups(delivery, manifest)
                delivered = delivery['records'] + delivery.get('background_records', [])
                if manifest['mode'] != 'candidates' or manifest['medical_quality_approved'] or manifest['record_level_human_confirmation'] or \
                        manifest['record_count'] != len(delivered) or manifest['file_sha256'] != paper['pdf_sha256'] or manifest['text_version'] != paper['text_version']:
                    raise ValueError('unapproved source-bound B0 candidate export required')
                for name, values in [('records', delivery['records']), ('background-records', delivery.get('background_records', []))]:
                    path = folder / (name + '.jsonl')
                    if name == 'background-records' and 'background_records' not in delivery and not path.exists():
                        continue
                    if [json.loads(line) for line in self.source_bytes(path).splitlines() if line.strip()] != values:
                        raise ValueError('JSONL/delivery group mismatch')
                    self.source_bytes(folder / (name + '.csv'))
                for asset in manifest['assets']:
                    self.asset(folder / asset['package_path'], asset['sha256'])
                self.validate_source_groups(delivery, current, paper['job_id'])
            delivered_ids = {r['record_id'] for r in delivered}
            if not delivered_ids <= set(current) or len(delivered_ids) != len(delivered):
                raise ValueError('delivery/current version population mismatch')
            for entry in delivered:
                version = current[entry['record_id']]
                record = version['record']
                if entry['record_version'] != version['version'] or entry['run_id'] != result['run_id'] or entry.get('human_confirmation') is not None or \
                        entry['original_fragments'] != record['quote_span']['segments'] or entry['context_fragments'] != record['context']['fragments']:
                    raise ValueError('delivery rewrote or approved a current record')
                self.verify_fingerprints(entry, record, catalog)
                binding = {'plan_sha256': PLAN_SHA, 'output_binding_sha256': self.expected_binding,
                    'pdf_path': paper['pdf_path'], 'pdf_sha256': paper['pdf_sha256'], 'ir_path': paper['ir_path'], 'ir_sha256': paper['ir_sha256'],
                    'text_version': paper['text_version'], 'figure_catalog_sha256': paper['figure_catalog_sha256'],
                    'job_id': paper['job_id'], 'logical_job_ids': [paper['job_id']], 'run_id': result['run_id'],
                    'result_path': bound['result_path'], 'result_sha256': bound['result_sha256'],
                    'candidate_export_manifest_sha256': export['manifest_sha256'], 'delivery_file_sha256': export['delivery_sha256'],
                    **{k: entry[k] for k in ['record_id', 'record_version', 'source_record_sha256', 'text_fingerprint', 'delivery_fingerprint']},
                    'artifact_kind': 'unreviewed_B0_delivery_candidate', 'primary_assessment': entry.get('primary_assessment')}
                records.append(self.source(paper, document, catalog, job, entry, record, binding, result))
            # A stopped/incomplete run can have saved records but no legal export.
            # Keep original views distinct; no invented legal text/delivery hash.
            for rid in sorted(set(current) - delivered_ids):
                version, raw = current[rid], current[rid]['record']
                source_sha = self.js_digests([raw])[0]
                entry = {'record_id': rid, 'record_version': version['version'], 'run_id': result['run_id'],
                    'original_fragments': raw['quote_span']['segments'], 'context_fragments': raw['context']['fragments'],
                    'source_record_sha256': source_sha, 'delivery_fingerprint': None, 'review_status': raw['review_status'],
                    'figure_association': {'status': 'not_checked', 'figure_ids': [], 'proposed_figure_ids': [],
                        'reasons': ['本条没有本轮候选导出中的配图，图目录仅供原页对照。']}}
                binding = {'plan_sha256': PLAN_SHA, 'output_binding_sha256': self.expected_binding,
                    'pdf_path': paper['pdf_path'], 'pdf_sha256': paper['pdf_sha256'], 'ir_path': paper['ir_path'], 'ir_sha256': paper['ir_sha256'],
                    'text_version': paper['text_version'], 'figure_catalog_sha256': paper['figure_catalog_sha256'],
                    'job_id': paper['job_id'], 'logical_job_ids': [paper['job_id']], 'run_id': result['run_id'],
                    'result_path': bound['result_path'], 'result_sha256': bound['result_sha256'], 'record_id': rid,
                    'record_version': version['version'], 'source_record_sha256': source_sha, 'delivery_fingerprint': None,
                    'raw_view_fingerprint': base.digest({'version': version, 'result_sha256': bound['result_sha256']}),
                    'artifact_kind': 'B0_saved_record_without_legal_delivery'}
                source = self.source(paper, document, catalog, job, entry, raw, binding, result)
                source.update(rejected_view={'issues': {'run_failure_codes': row.get('failure_codes', []),
                    'saved_delivery_validation': result.get('delivery_validation')}}, diagnostic_missing_fragments=[])
                records.append(source)
            counts = self.group_counts([r for r in records if r['job']['job_id'] == paper['job_id']])
            view.update(primary_candidate_count=counts['primary_candidate'], background_suggestion_count=counts['background_suggestion'],
                rejected_current_record_count=counts['delivery_rejected'])
        by_id = {(r['job']['job_id'], r['entry']['record_id']): r for r in records}
        for group in self.source_groups:
            for member in group['members']:
                source = by_id[(group['job_id'], member['record_id'])]
                source['source_group'] = group
                source['binding']['source_group_id'] = group['group_id']
                source['binding']['source_group_projection_sha256'] = base.digest({k: v for k, v in group.items() if k != 'job_id'})
        return jobs, records

    def source(self, paper, document, catalog, job, entry, record, binding, result):
        if record['extraction_trace']['run_id'] != result['run_id'] or record['extraction_trace']['fixture']:
            raise ValueError('non-fixture current B0 source record required')
        excluded = set(paper['selection']['excluded_block_ids'])
        return {'paper': paper, 'document': document, 'catalog': catalog, 'job': job, 'entry': entry, 'record': record, 'binding': binding,
            'originals': self.fragments(entry['original_fragments'], document, excluded),
            'contexts': self.fragments(entry['context_fragments'], document, excluded),
            'task_processing_complete': result.get('task_processing_complete'), 'observation_matches': []}

    def validate_source_groups(self, delivery, current, job_id):
        groups = delivery.get('strict_source_groups')
        entries = {r['record_id']: r for r in delivery['records'] + delivery.get('background_records', [])}
        if delivery.get('source_grouping_policy_version') != 'strict-source-groups-1' or not isinstance(groups, list) or \
                delivery.get('unique_source_group_count') != len(groups):
            raise ValueError('actual strict-source group projection required')
        seen = set()
        for group in groups:
            if group['member_count'] != len(group['members']) or group['automatic_member_selection'] is not False or group['medical_quality_approved'] is not False:
                raise ValueError('source grouping cannot approve or select members')
            for member in group['members']:
                rid = member['record_id']
                if rid in seen or rid not in entries or rid not in current or member['record_version'] != entries[rid]['record_version'] or \
                        member['source_record_sha256'] != entries[rid]['source_record_sha256'] or \
                        member['effective_role'] != entries[rid].get('primary_assessment', {}).get('effective_role', 'primary_candidate'):
                    raise ValueError('source group member lost or changed')
                seen.add(rid)
            self.source_groups.append({'job_id': job_id, **group})
        if seen != set(entries):
            raise ValueError('source groups must partition every primary and background delivered member')

    def observations(self, plan, records, jobs):
        for observation in plan['observations']:
            matches = []
            for source in records:
                if source['paper']['document_id'] != observation['document_id']:
                    continue
                if source['binding']['pdf_sha256'] != observation['file_sha256'] or source['binding']['text_version'] != observation['text_version']:
                    raise ValueError('observation source binding mismatch')
                overlaps = {}
                for field in ['original_fragments', 'context_fragments']:
                    overlaps[field] = sum(max(0, min(a['end'], b['end']) - max(a['start'], b['start']))
                        for a in observation['source_fragments'] for b in source['entry'][field]
                        if a['block_id'] == b['block_id'] and a['text_version'] == b['text_version'])
                if not any(overlaps.values()):
                    continue
                match = {'observation_id': observation['case_id'], 'concern': observation['concern'],
                    'judgement_basis': observation['judgement_basis'], **overlaps,
                    'exact_original_spans_equal': anchors(source['entry']['original_fragments']) == anchors(observation['source_fragments'])}
                source['observation_matches'].append(match)
                if observation['judgement_basis'] == 'user_confirmed_isolated_negative' and match['exact_original_spans_equal'] and \
                        not source['entry']['context_fragments'] and self.review_group(source) == 'primary_candidate':
                    label = '单独正常组织描述' if observation['concern'] == 'normal_tissue' else '这类纯诊断结论'
                    source['known_scope_deviation'] = '你已确认' + label + '仅作必要背景；本轮仍列为独立描述，这是规则执行偏差。只核对展示，不重新决策范围，不套用旧票。'
                matches.append({'job_id': key(source)[0], 'record_id': key(source)[1], 'record_version': key(source)[2],
                    'review_group': self.review_group(source), **match})
            paper_job = next(j for j in jobs if j['job_id'] == observation['document_id'] + '-B0')
            state = 'matched_saved_current_output' if matches else 'no_current_output_job_not_started' if not paper_job['started'] else 'not_found_in_saved_current_outputs'
            self.observation_results.append({'observation_id': observation['case_id'], 'document_id': observation['document_id'],
                'label': OBSERVATION_LABELS.get(observation['concern'], '源跨度观察'),
                'source_reference_fragments_not_current_candidates': observation['source_fragments'],
                'concern': observation['concern'], 'judgement_basis': observation['judgement_basis'], 'status': state,
                'matches': matches, 'complete_gold': False, 'recall_pass_or_fail': None,
                'meaning': 'Source-span overlap only; missing outputs do not measure recall or prove a correct background decision.'})

    def select_records(self, records):
        selected = {}
        for job_id in sorted({r['job']['job_id'] for r in records}):
            group = sorted([r for r in records if r['job']['job_id'] == job_id], key=lambda r: base.digest({
                'seed': PLAN_SHA, 'job': job_id, 'record': r['entry']['record_id'], 'version': r['entry']['record_version'],
                'fingerprint': r['entry']['delivery_fingerprint'] or r['binding']['raw_view_fingerprint']}))
            for source in group[:6]:
                selected[key(source)] = (source, 'fixed_seed_development_sample')
            for source in group:
                if source['observation_matches'] or source.get('rejected_view'):
                    selected.setdefault(key(source), (source, 'directed_risk_not_random_sample'))
        # Never select one member as the automatic winner of a same-source group.
        by_id = {(r['job']['job_id'], r['entry']['record_id']): r for r in records}
        for group in self.source_groups:
            members = [by_id[(group['job_id'], m['record_id'])] for m in group['members']]
            if group['needs_review'] or any(key(m) in selected for m in members):
                for member in members:
                    selected.setdefault(key(member), (member, 'directed_risk_not_random_sample'))
        for group in self.review_source_groups:
            if group['member_count'] > 1 or group['internal_reference_role_needs_review']:
                for member in group['members']:
                    source = by_id[(group['job_id'], member['record_id'])]
                    selected.setdefault(key(source), (source, 'directed_risk_not_random_sample'))
        return list(selected.values())

    @staticmethod
    def risk_reasons(source):
        reasons = []
        if source.get('known_scope_deviation'):
            reasons.append(source['known_scope_deviation'])
        if source.get('rejected_view'):
            reasons.append('本条保留已保存原始记录，未进入本轮候选导出；普通意见不会生成业务批准')
        if source['observation_matches']:
            reasons.append('定向观察：' + '、'.join(OBSERVATION_LABELS.get(m['concern'], '源跨度') for m in source['observation_matches']) + '；只是观察项匹配，不是正确答案或召回结论')
        if source.get('derived_source_review_group', {}).get('member_count', 0) > 1:
            reasons.append('同一完整原文和语境有多条记录；疾病、数字或来源等模型字段差异待核，全部成员保留，未合并医学记录')
        if source.get('internal_reference_hints'):
            reasons.append('文内图号出现在模型的引用来源字段；图号本身不证明外部文献，来源归属仍待核，原值未改')
        return reasons

    @staticmethod
    def run_status(job):
        if not job['started']:
            return '未启动'
        if job.get('failure_codes') or str(job.get('frozen_status', '')).startswith('failed') or job.get('error'):
            return '失败/未完成；已保存记录仍待核'
        return '本次范围处理完成；输出尚未审核' if job.get('task_processing_complete') is True else '尚未完整完成；已保存记录仍待核'

    def run_table(self, jobs):
        parts = ['<table class="run-table"><thead><tr><th>文献</th><th>本轮处理</th><th>主 / 背景 / 原始待核</th><th>任务范围与来源限制</th></tr></thead><tbody>']
        for job in jobs:
            counts = ' / '.join('—' if job.get(k) is None else str(job[k]) for k in ['primary_candidate_count', 'background_suggestion_count', 'rejected_current_record_count'])
            limits = ['任务源 ' + str(job['task_source_blocks']) + ' 块', '共同书目排除 ' + str(job['shared_bibliography_excluded_source_blocks']) + ' 块']
            if job.get('parser_status') == 'partial':
                limits.append('原解析保留 partial 标记')
            if job.get('image_text_unverified_pages'):
                limits.append(str(job['image_text_unverified_pages']) + ' 页图中文字尚未核验')
            parts.append('<tr data-job-id="' + escape(job['job_id'], quote=True) + '"><td>' + escape(job['job_id']) + '</td><td>' +
                escape(self.run_status(job)) + '</td><td>' + counts + '</td><td>' + escape('；'.join(limits)) + '</td></tr>')
        parts.append('</tbody></table><p class="hint">完成依据本次任务源范围及汇总状态；共同排除的书目不计任务未完成。整篇文章块数与任务源块数分别保留，原解析 partial 和图中文字限制也保留。处理完成不代表医学质量通过。</p>')
        return ''.join(parts)

    def case(self, source, number, sampling):
        case = super().case(source, number, sampling)
        case['kind'] = source['paper']['document_id']
        case['observation_matches'] = source['observation_matches']
        if source.get('derived_source_review_group'):
            group = source['derived_source_review_group']
            case['derived_source_review'] = {'group_id': group['group_id'], 'member_count': group['member_count'],
                'strict_source_key_count': group['strict_source_key_count'], 'evidence_field_differences': group['evidence_field_differences']}
            if group['member_count'] > 1:
                case['after']['sections'].append({'type': 'text', 'title': '同原文与语境的待核成员（后处理视图）',
                    'text': '这段完整原文和语境对应 ' + str(group['member_count']) + ' 条保存记录。原严格组、各自字段、关系和意见仍分别保留；这里不自动合并、选优或传播审核。'})
        if source.get('internal_reference_hints'):
            case['internal_reference_hints'] = source['internal_reference_hints']
            case['after']['sections'].append({'type': 'text', 'title': '文内图号与引用来源待核',
                'text': '模型在引用来源字段填入了 ' + '、'.join(marker for hint in source['internal_reference_hints'] for marker in hint['internal_structure_markers']) +
                    '。这是文内图号，本身不能证明外部文献；模型当前来源归属原样保留，尚未批准。'})
        if source.get('source_group'):
            group = source['source_group']
            case['strict_source_group'] = {'group_id': group['group_id'], 'member_count': group['member_count'], 'status': group['status'],
                **{k: group[k] for k in ['attribution_conflict', 'role_conflict', 'figure_association_conflict',
                    'human_review_disagreement', 'internal_reference_attribution_needs_review']}}
            case['after']['sections'].append({'type': 'text', 'title': '同源组（未批准）',
                'text': '这一来源组保留 ' + str(group['member_count']) + ' 个成员；分组不作医学去重或自动选优。可在“同源组、全部成员与冲突”入口逐一核对。'})
        case['explanation'] = 'B0 已选定。本条为本轮真实输出，原文、语境和图参考均按当前版本显示。' + \
            ('固定种子基础样本，每篇最多 6 条。' if sampling == 'fixed_seed_development_sample' else '额外定向条目，不能当作随机样本。') + \
            (' ' + '；'.join(self.risk_reasons(source)) if self.risk_reasons(source) else '') + \
            (' 本篇任务未完整完成，已保存候选不表示没有遗漏。' if source['task_processing_complete'] is not True else '')
        case['questions'][0]['text'] = '原文、必要语境与原页对应吗？'
        background = self.review_group(source) == 'background_suggestion'
        case['questions'][1]['text'] = '这段背景对理解目标描述有用吗？' if background else '这段是否在描述肿瘤或病灶的外观？'
        case['questions'][1]['hint'] = '只核对是否有理解作用；无需保留、更像主描述、看不懂或不确定都可以写明，不默认同意。' if background else \
            '可包括形态、信号、病灶直接量值及必要条件和否定。看不懂或不确定可直接选“无法判断”。'
        case['questions'][2]['text'] = '配图或未配图说明合理吗？'
        if source.get('rejected_view'):
            for section in case['after']['sections']:
                if section['title'] == '交付校验未通过：原始记录仍保留':
                    section.update(title='原始记录尚未形成候选导出', text='本条只展示保存的原版本。运行未完成、交付失败或导出失败的实际状态见下方；未导出不一律解释为源文字错误，普通意见不能生成业务批准。')
                elif section['title'] == '原机械校验诊断（可展开）':
                    section['title'] = '实际运行与交付状态（可展开）'
        association = source['entry']['figure_association']
        figure_applicable = bool(association['figure_ids'] or association['proposed_figure_ids'] or association.get('exact_markers'))
        if source.get('rejected_view'):
            figure_applicable = figure_applicable or bool(re.search(r'(?i)(?:\bFig(?:ure)?s?\.?\s*\d+|图\s*\d+)',
                '\n'.join(f['exact_quote'] for f in source['entry']['original_fragments'] + source['entry']['context_fragments'])))
        case['figure_question_applicable'] = figure_applicable
        case['figure_review_fact'] = '有配图或明确待核图引用，图文仍需核验' if figure_applicable else '本轮未配图；无明确待核图引用，不要求图片回答，也不算配对正确'
        if not figure_applicable:
            case['questions'] = [q for q in case['questions'] if q['question_id'] != 'figure_correspondence']
        if source.get('known_scope_deviation'):
            case['after']['sections'].append({'type': 'text', 'title': '已确认范围的执行偏差', 'text': source['known_scope_deviation']})
            case['questions'][1].update(review_intent='confirmed_scope_execution_deviation_visibility',
                text='已知范围偏差说明清楚吗？', hint=source['known_scope_deviation'] + '回答只表示展示清晰度，不代表目标相关性、范围重决或批准。')
        case['case_version'] = base.digest({k: v for k, v in case.items() if k != 'case_version'})
        return case

    def write_ui(self, jobs):
        super().write_ui(jobs)
        html_path, js_path = self.output / 'index.html', self.output / 'review.js'
        html = html_path.read_text()
        html = re.sub(r'<p class="scope">.*?</p>', '<p class="scope">B0 已选定，本页只核验本轮三篇文献的真实输出。普通意见不改变业务审核版本，也不等于医学或产品批准。图片题仅在有配图或明确待核图引用时出现；没有图片不算文字错误，也不算配对正确。</p>', html, count=1)
        html = re.sub(r'<select id="kind-filter">.*?</select>', '<select id="kind-filter"><option value="all">全部文献</option>' +
            ''.join('<option value="' + p + '">' + p + ' · B0</option>' for p in ['L07', 'L01', 'L05']) + '</select>', html, count=1, flags=re.S)
        html = html.replace('risk-comparisons.html', 'source-groups.html').replace('并排看同源分组差异与可能重复（待核）', '查看同源组、全部成员与冲突（待核）')
        html = html.replace('复用行不再加入总分母或费用。', '').replace('本轮候选少则全列，抽样不设置正式质量门槛。', '基础样本每篇最多6条，另列定向观察及同源成员，不设置医学准确率门槛。')
        html = html.replace('<p id="pack-summary"', '<p><a href="source-observations.html">查看10项源跨度观察的实际匹配与未发现项</a></p><p id="pack-summary"')
        html_path.write_text(html)
        js = js_path.read_text()
        js = js.replace("({ B0: '单独智能体 B0', F: '正向预筛 F' })[c.kind]", "c.source_id + ' · B0'")
        js = js.replace('交付拒绝', '原始待核').replace('无合法交付指纹（校验拒绝）；原始待核视图指纹：', '无本轮候选导出指纹；原始待核视图指纹：')
        js = re.sub(r"\$\('pack-summary'\)\.textContent = .*?;\n", "$('pack-summary').textContent = 'B0 已选定。本轮 ' + pack.total_current_candidates + ' 条保存的当前记录，本页 ' + pack.cases.length + ' 条；基础每篇固定种子最多6条，另列实际观测匹配与同源成员。抽样不代表准确率或完整召回。';\n", js, count=1)
        js = js.replace('资料指纹校验失败，未加载或套用任何意见。', '资料指纹校验失败，未加载或套用任何意见。')
        js_path.write_text(js)

    def indexes(self, records, pack):
        selected = {key_from_case(c): c for c in pack['cases']}
        header = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="review.css"><link rel="icon" href="data:,">'
        links = '<p><a href="index.html">三问与导出意见</a> · <a href="all-candidates.html">全部实际记录</a> · <a href="source-groups.html">同源组与冲突</a> · <a href="source-observations.html">10项源跨度观察</a></p>'
        parts = [header, '<header class="page-header"><h1>B0 本轮全部实际记录</h1><p>主待核、背景和无合法交付的原始记录均保留；本轮共 ' + str(len(records)) + ' 条，不代表独立有效描述数。</p>' + links + '</header><main class="risk-comparison-main">']
        membership = []
        for source in records:
            job_id, rid, version = key(source)
            case = selected.get(key(source))
            membership.append({'job_id': job_id, 'record_id': rid, 'record_version': version, 'review_group': self.review_group(source),
                'source_binding': source['binding'], 'included_in_simple_review': bool(case),
                'selection': case['sampling'] if case else 'not_in_simple_review', 'observation_matches': source['observation_matches']})
            parts.append('<details class="opinion-card" id="' + self.candidate_anchor(source) + '" data-review-group="' + self.review_group(source) + '" data-job-id="' + job_id + '" data-record-id="' + escape(rid, quote=True) + '"><summary>' + escape(job_id + ' · ' + base.REVIEW_GROUPS[self.review_group(source)] + ' · v' + str(version)) + '</summary>')
            if case:
                parts.append('<p><a href="index.html#' + case['case_id'] + '">为本条填写三问与备注</a></p>')
            else:
                parts.append('<p>未纳入本次有限样本；没有默认审核意见。</p>')
            for title, fragments in [('原文（逐字保留）', source['originals']), ('必要语境（单独显示）', source['contexts'])]:
                parts.append('<section class="parsed-section"><h3>' + title + '</h3>')
                if not fragments:
                    parts.append('<p>未附语境</p>')
                for fragment in fragments:
                    parts.append('<pre class="original-text">' + escape(fragment['text']) + '</pre>')
                parts.append('</section>')
            parts.append('<p>' + escape('；'.join(self.risk_reasons(source))) + '</p><details><summary>版本与来源绑定</summary><pre class="original-text">' + escape(json.dumps(source['binding'], ensure_ascii=False, indent=2)) + '</pre></details></details>')
        parts.append('</main></html>')
        (self.output / 'all-candidates.html').write_text('\n'.join(parts) + '\n')
        groups = [header, '<header class="page-header"><h1>同源原文、全部成员与冲突（待核）</h1><p>原严格组 ' + str(len(self.source_groups)) +
            ' 组保持原样；付费结束后另生成 ' + str(len(self.review_source_groups)) + ' 个原文/语境核验索引组。两个组数都不是有效特征数，不作医学去重，不选择胜出成员，也不把背景变成独立目标。</p>' + links + '</header><main class="risk-comparison-main">',
            '<h2>相同原文/语境及内部图号的定向待核视图</h2><p>同一原文可能因疾病、数字或模型归属字段不同而分开。下列视图保留全部原记录、差异和各自意见入口；不会合并或传播意见。</p>']
        by_id = {(r['job']['job_id'], r['entry']['record_id']): r for r in records}
        field_labels = {'disease_or_lesion': '疾病/病灶字段', 'numeric_expressions': '数字字段', 'source_attribution': '来源归属',
            'feature_category': '特征类别', 'feature_name_raw': '特征命名', 'modality': '成像方式', 'sequence_or_phase': '序列/时相',
            'assertion': '断言字段', 'applicability': '适用条件', 'evidence_type': '记录类型', 'normalized_terms': '标准词字段'}
        for group in self.review_source_groups:
            if group['member_count'] <= 1 and not group['internal_reference_role_needs_review']:
                continue
            differences = '、'.join(field_labels.get(f, '模型字段') for f in group['evidence_field_differences']) or '无列出的模型字段差异'
            groups.append('<section class="risk-comparison" data-source-review-group-id="' + escape(group['group_id'], quote=True) + '"><h3>' +
                escape(group['job_id'] + ' · ' + str(group['member_count']) + ' 个原记录成员；' + differences) + '</h3><div class="risk-grid">')
            for member in group['members']:
                source = by_id[(group['job_id'], member['record_id'])]
                case = selected.get(key(source))
                groups.append('<article class="risk-member" data-record-id="' + escape(member['record_id'], quote=True) + '"><h4>' +
                    escape(base.REVIEW_GROUPS[self.review_group(source)] + ' · v' + str(member['record_version'])) + '</h4>')
                for title, fragments, css in [('原文（逐字保留）', source['originals'], 'review-original'), ('语境（单独显示）', source['contexts'], 'review-context')]:
                    groups.append('<section class="' + css + '"><h5>' + title + '</h5>')
                    if not fragments:
                        groups.append('<p>未附语境</p>')
                    for fragment in fragments:
                        groups.append('<pre class="original-text">' + escape(fragment['text']) + '</pre>')
                    groups.append('</section>')
                if source.get('internal_reference_hints'):
                    groups.append('<p class="explanation">文内图号 ' + escape('、'.join(marker for hint in source['internal_reference_hints'] for marker in hint['internal_structure_markers'])) +
                        ' 出现在引用来源字段；图号本身不是外部文献依据，原来源归属仍保留待核。</p>')
                groups.append('<p><a href="' + ('index.html#' + case['case_id'] if case else 'all-candidates.html#' + self.candidate_anchor(source)) +
                    '">单独核验这一成员</a></p><details><summary>模型字段、原关系与来源绑定（未批准）</summary><pre class="original-text">' +
                    escape(json.dumps({'member': member, 'source_binding': source['binding']}, ensure_ascii=False, indent=2)) + '</pre></details></article>')
            groups.append('</div></section>')
        groups.append('<h2>原候选交付中的严格来源组（全部保留）</h2>')
        for n, group in enumerate(self.source_groups, 1):
            flags = [label for field, label in [('attribution_conflict', '来源归属不同'), ('role_conflict', '主/背景分组不同'),
                ('figure_association_conflict', '配图标记不同'), ('human_review_disagreement', '业务审核存在分歧'),
                ('internal_reference_attribution_needs_review', '图表内部引用被当成来源归属，待核')] if group[field]]
            groups.append('<details class="opinion-card" id="' + escape(group['group_id'], quote=True) + '" data-source-group-id="' + escape(group['group_id'], quote=True) + '"><summary>' +
                escape(group['job_id'] + ' · 同源组 ' + str(n) + ' · ' + str(group['member_count']) + ' 个成员；' + ('；'.join(flags) if flags else '无已记录冲突，不表示已审核')) + '</summary>')
            for member in group['members']:
                source = by_id[(group['job_id'], member['record_id'])]
                case = selected.get(key(source))
                groups.append('<article data-record-id="' + escape(member['record_id'], quote=True) + '"><h3>' + escape(base.REVIEW_GROUPS[member['effective_role']] + ' · v' + str(member['record_version'])) + '</h3>')
                for fragment in source['originals']:
                    groups.append('<pre class="original-text">' + escape(fragment['text']) + '</pre>')
                groups.append('<p><a href="' + ('index.html#' + case['case_id'] if case else 'all-candidates.html#' + self.candidate_anchor(source)) + '">查看这一成员并核验</a></p></article>')
            groups.append('<details><summary>全部成员与原始冲突字段</summary><pre class="original-text">' + escape(json.dumps(group, ensure_ascii=False, indent=2)) + '</pre></details></details>')
        groups.append('</main></html>')
        (self.output / 'source-groups.html').write_text('\n'.join(groups) + '\n')
        observations = [header, '<header class="page-header"><h1>10项源跨度观察</h1><p>仅按实际当前记录匹配源跨度；未发现不叫召回通过或失败，也不证明背景被正确保留。</p>' + links + '</header><main class="risk-comparison-main">']
        for observation in self.observation_results:
            label = '在保存的当前输出中有匹配' if observation['matches'] else '本篇未启动，没有本轮记录可比' if observation['status'] == 'no_current_output_job_not_started' else '未在本轮保存结果中发现'
            observations.append('<section class="opinion-card"><h2>' + escape(observation['document_id'] + ' · ' + observation['observation_id'].split('-')[0] + ' · ' + observation['label']) + '</h2><p>' + label + '</p>')
            observations.append('<details><summary>原有观测参照片段（不是本轮候选，不产生审核题）</summary>')
            for fragment in observation['source_reference_fragments_not_current_candidates']:
                observations.append('<pre class="original-text">' + escape(fragment['exact_quote']) + '</pre>')
            observations.append('</details>')
            for match in observation['matches']:
                source = by_id[(match['job_id'], match['record_id'])]
                case = selected.get(key(source))
                observations.append('<p><a href="' + ('index.html#' + case['case_id'] if case else 'all-candidates.html#' + self.candidate_anchor(source)) + '">' + escape(match['job_id'] + ' · ' + base.REVIEW_GROUPS[match['review_group']] + ' · v' + str(match['record_version'])) + '</a></p>')
            observations.append('</section>')
        observations.append('</main></html>')
        (self.output / 'source-observations.html').write_text('\n'.join(observations) + '\n')
        return membership

    def build_b0(self):
        if self.output.exists():
            raise ValueError('output-review exists; preserve user opinions and create no overwrite')
        plan = self.preflight()
        if not self.postprocessing:
            raise ValueError('wait for both original and independent postprocessing bindings before generating the final page')
        report = self.handoff(plan)
        protected = self.protected_reviews()
        old_round = CODE / 'docs/acceptance/output-feedback-2026-11-08/output-review'
        protected[str(old_round.relative_to(CODE))] = {str(p.relative_to(CODE)): sha256(p.read_bytes()).hexdigest() for p in old_round.rglob('*') if p.is_file()}
        self.output.mkdir(mode=0o700)
        (self.output / 'assets').mkdir()
        try:
            jobs, records = self.load_records(plan, report)
            self.attach_review_index(records, plan)
            self.observations(plan, records, jobs)
            selected = self.select_records(records)
            counts = self.group_counts(records)
            pack = {'schema_version': base.SCHEMA, 'questionnaire_version': base.QUESTIONNAIRE, 'review_scope': base.SCOPE,
                'pack_id': 'b0-revalidation-2026-11-08-' + PLAN_SHA[:12], 'plan_sha256': PLAN_SHA,
                'execution_report_sha256': self.output_binding['execution_report_sha256'], 'output_binding_sha256': self.expected_binding,
                'postprocessing_binding_sha256': self.expected_postprocessing, 'postprocessing_source_transition': self.source_transition,
                'postprocessing_phase': 'read_only_offline_view_after_paid_run_not_part_of_model_execution',
                'method': 'B0', 'method_selected': True, 'batch_id': plan['batch_id'], 'execution_status': report['status'],
                'model': plan['common']['model'], 'logical_jobs': jobs, 'total_current_candidates': len(records),
                'group_counts': counts, 'sample_group_counts': self.group_counts([r for r, _ in selected]),
                'sampling': 'fixed_seed_six_per_paper_plus_observations_and_all_same_source_members', 'sampling_seed': PLAN_SHA,
                'actual_independent_runs_with_model_requests': sum(j['method_requests'] > 0 for j in jobs),
                'strict_source_groups': self.source_groups, 'unique_source_group_count': len(self.source_groups),
                'same_source_review_index': self.same_source_review_index,
                'derived_source_context_group_count': len(self.review_source_groups),
                'derived_same_source_multi_member_group_count': sum(g['member_count'] > 1 for g in self.review_source_groups),
                'derived_internal_reference_hint_count': sum(len(j['index']['internal_reference_hints']) for j in self.same_source_review_index['jobs']),
                'source_observations': self.observation_results, 'full_recall_measured': False,
                'human_approved': False, 'medical_quality_approved': False, 'product_export_approved': False,
                'actual_human_reviews': 0, 'ordinary_feedback_changes_business_version': False,
                'cases': [self.case(r, n, mode) for n, (r, mode) in enumerate(selected, 1)]}
            pack['figure_question_cases'] = sum(c['figure_question_applicable'] for c in pack['cases'])
            pack['no_figure_question_cases'] = len(pack['cases']) - pack['figure_question_cases']
            pack['sampling_summary'] = {'base_cases': sum(mode == 'fixed_seed_development_sample' for _, mode in selected),
                'additional_directed_cases': sum(mode == 'directed_risk_not_random_sample' for _, mode in selected),
                'per_paper': [{'job_id': job['job_id'], 'current_records': sum(r['job']['job_id'] == job['job_id'] for r in records),
                    'base_cases': sum(r['job']['job_id'] == job['job_id'] and mode == 'fixed_seed_development_sample' for r, mode in selected),
                    'additional_directed_cases': sum(r['job']['job_id'] == job['job_id'] and mode == 'directed_risk_not_random_sample' for r, mode in selected)} for job in jobs],
                'not_a_formal_accuracy_or_recall_sample': True}
            pack['pack_sha256'] = base.digest(pack)
            (self.output / 'data.json').write_text(json.dumps(pack, ensure_ascii=False, indent=2) + '\n')
            self.write_ui(jobs)
            membership = self.indexes(records, pack)
            for path, expected in self.sources.items():
                if sha256(base.inside(path).read_bytes()).hexdigest() != expected:
                    raise ValueError('source changed during static build: ' + path)
            for inventory in protected.values():
                for path, expected in inventory.items():
                    if sha256(base.inside(path).read_bytes()).hexdigest() != expected:
                        raise ValueError('old review/opinion changed: ' + path)
            manifest = {'schema_version': 'b0-output-review-manifest-1', 'pack_id': pack['pack_id'], 'pack_sha256': pack['pack_sha256'],
                'plan_sha256': PLAN_SHA, 'output_binding_sha256': self.expected_binding, 'method': 'B0', 'cases': len(pack['cases']),
                'questions': sum(len(c['questions']) for c in pack['cases']), 'group_counts': counts,
                'sample_group_counts': pack['sample_group_counts'], 'source_group_count': len(self.source_groups),
                'derived_source_context_group_count': pack['derived_source_context_group_count'],
                'derived_same_source_multi_member_group_count': pack['derived_same_source_multi_member_group_count'],
                'derived_internal_reference_hint_count': pack['derived_internal_reference_hint_count'],
                'sampling_summary': pack['sampling_summary'],
                'all_candidate_membership': membership, 'source_observations': self.observation_results,
                'question_semantics_counts': dict(Counter(q['review_intent'] for c in pack['cases'] for q in c['questions'])),
                'question_semantics_interpretation': {'background_retention_suitability': '本轮背景对理解目标描述是否有作用；与肿瘤外观问题分别计数。',
                    'confirmed_scope_execution_deviation_visibility': '只核对已知偏差的展示，不代表目标相关性、范围重决或批准。',
                    'figure_correspondence_and_completeness': '只统计有配图或明确待核引用的条目；未提问条目不能计作配对正确。'},
                'figure_question_cases': pack['figure_question_cases'], 'no_figure_question_cases': pack['no_figure_question_cases'],
                'source_files': self.sources, 'frozen_runtime_files_checked': len(plan['source_hashes']),
                'protected_old_review_inventories_sha256': {name: base.digest(inventory) for name, inventory in protected.items()},
                'model_run_source_snapshot_66_and_all_original_inputs_results_exports_reviews_unchanged': True,
                'current_source_transition_separately_bound': self.source_transition,
                'postprocessing_binding_sha256': self.expected_postprocessing,
                'postprocessing_code_was_not_used_by_the_model_run': True,
                'files': {str(p.relative_to(self.output)): sha256(p.read_bytes()).hexdigest() for p in self.output.rglob('*') if p.is_file()},
                'generator_sha256': sha256(Path(__file__).read_bytes()).hexdigest(), 'readonly_renderer_sha256': sha256(RENDERER.read_bytes()).hexdigest(),
                'actual_human_reviews': 0, 'medical_quality_approved': False, 'model_or_API_calls': 0, 'entry': 'index.html'}
            (self.output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
            print(json.dumps({'entry': str(self.output / 'index.html'), 'cases': len(pack['cases']), 'records': len(records),
                'groups': len(self.source_groups), 'pack_sha256': pack['pack_sha256'], 'API_calls': 0}, ensure_ascii=False))
        except Exception:
            shutil.rmtree(self.output)
            raise


def key_from_case(case):
    binding = case['source_binding']
    return (binding['job_id'], binding['record_id'], binding['record_version'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binding', type=Path)
    parser.add_argument('--expected-binding-sha256')
    parser.add_argument('--postprocessing-binding', type=Path)
    parser.add_argument('--expected-postprocessing-sha256')
    parser.add_argument('--check-preparation', action='store_true')
    parser.add_argument('--verify-opinions', type=Path)
    args = parser.parse_args()
    instance = B0Review(args.binding, args.expected_binding_sha256, args.postprocessing_binding, args.expected_postprocessing_sha256)
    if args.verify_opinions:
        base.verify_opinions(ROOT, args.verify_opinions)
    elif args.check_preparation:
        value = instance.preflight()
        print(json.dumps({'plan_sha256': PLAN_SHA, 'frozen_source_files': len(value['source_hashes']), 'B0_only': True,
            'source_observations': len(value['observations']), 'formal_page_generated': False, 'API_calls': 0}))
    else:
        instance.build_b0()
