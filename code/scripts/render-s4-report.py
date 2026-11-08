#!/usr/bin/env python3
"""Render a local, self-contained S4 evidence report. Reads runtime files/SQLite only."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import sqlite3
from urllib.parse import quote, unquote, urlsplit


STATUS = {
    'pending': '待开始 / 待人工审核', 'running': '运行中', 'completed': '程序处理完成', 'partial': '部分完成',
    'failed': '失败', 'cancelled': '已取消', 'interrupted': '已中断', 'interrupted_diagnostic': '诊断中断（历史）',
    'engineering_incomplete': '工程运行未完成', 'finished_quality_pending': '运行结束，医学质量待核',
    'not_performed': '尚未执行', 'reviewed_unapproved': '模型已复核，未经人工批准', 'needs_context': '需要语境 / 人工核对',
    'passed': '程序有限检查通过', 'requires_review': '程序发现待核事项', 'active': '当前版本', 'proposed': '更新建议',
    'baseline': '直接抽取＋全文汇总', 'independent_context_review': '抽取＋独立语境复核',
    'real_paid_paper_run': '真实 API 论文运行', 'paid_synthetic_compatibility': '真实 API 合成兼容探针',
    'engineering_fixture': '合成 / loopback 工程夹具', 'unverified_run': '未证实关联付费请求',
    'provider_reported': '供应商实报', 'reserved': '进行中：预算预留',
    'missing_usage_conservative_reservation': 'usage 缺失：预算预留',
    'unknown': '未知', 'affirmed': '肯定', 'negated': '否定', 'uncertain': '不确定',
    'conditional': '条件性', 'comparative': '比较性', 'study_authors': '论文作者 / 本研究',
    'cited_research': '转引他人研究', 'background_definition': '背景定义', 'unclear': '来源归属不明',
}


def esc(value):
    return html.escape(str(value), quote=True)


def label(value):
    return STATUS.get(value, str(value)) if value is not None else '未记录'


def number(value):
    if value is None:
        return '未知'
    return f'{value:,.2f}' if isinstance(value, float) else f'{value:,}' if isinstance(value, int) else str(value)


def anchor(*parts):
    return 'e-' + hashlib.sha256('|'.join(map(str, parts)).encode()).hexdigest()[:22]


def duration(start, end):
    try:
        return max(0, (datetime.fromisoformat(end.replace('Z', '+00:00')) - datetime.fromisoformat(start.replace('Z', '+00:00'))).total_seconds())
    except (TypeError, ValueError, AttributeError):
        return None


class Report:
    def __init__(self, code_root: Path, output: Path):
        self.root = code_root.resolve()
        self.output = output.resolve()
        self.warnings = []
        self.inputs = {}
        self.documents = {}

    def project_path(self, value):
        if not value:
            return None
        path = Path(str(value))
        path = (self.root / path).resolve() if not path.is_absolute() else path.resolve()
        if not path.is_relative_to(self.root):
            self.warnings.append({'path': str(value), 'issue': 'outside_code_root_not_followed'})
            return None
        return path

    def relative(self, path):
        return str(path.relative_to(self.root)) if path and path.is_relative_to(self.root) else None

    def load(self, path, default=None):
        path = self.project_path(path)
        if path is None or not path.exists():
            return default
        for _ in range(3):
            try:
                raw = path.read_bytes()
                value = json.loads(raw)
                self.inputs[self.relative(path)] = hashlib.sha256(raw).hexdigest()
                return value
            except (OSError, json.JSONDecodeError):
                pass  # A running producer may briefly be replacing a JSON file.
        self.warnings.append({'path': self.relative(path), 'issue': 'json_unavailable_or_mid_write'})
        return default

    def href(self, value, page=None):
        path = self.project_path(value)
        if path is None or not path.is_file():
            return None
        href = quote(os.path.relpath(path, self.output), safe='/.-_')
        return href + (f'#page={int(page)}' if page else '')

    def link(self, value, title, page=None):
        href = self.href(value, page)
        return f'<a href="{esc(href)}">{esc(title)}</a>' if href else esc(title) + '（本地文件未找到）'

    def database(self, runtime):
        path = runtime / 's4.sqlite'
        if not path.is_file():
            return {}
        db = None
        try:
            db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=2)
            db.execute('BEGIN')
            runs = {row[0]: {'input': json.loads(row[1]), 'state': row[2], 'metadata': json.loads(row[3]),
                             'versions': [], 'events': [], 'batches': []}
                    for row in db.execute('SELECT id,input_json,state,metadata_json FROM s4_runs')}
            for table, field, column in [('s4_versions', 'versions', 'envelope_json'), ('s4_events', 'events', 'payload_json'),
                                          ('s4_batches', 'batches', 'payload_json')]:
                for run_id, raw in db.execute(f'SELECT run_id,{column} FROM {table}'):
                    if run_id in runs:
                        runs[run_id][field].append(json.loads(raw))
            for run in runs.values():
                current = {}
                run['versions'].sort(key=lambda v: (v['record']['record_id'], v['version']))
                for version in run['versions']:
                    if version.get('status') != 'proposed':
                        current[version['record']['record_id']] = version
                run['candidates'] = list(current.values())
                run['events'].sort(key=lambda event: event.get('seq', 0))
            return runs
        except (sqlite3.Error, ValueError, KeyError) as error:
            self.warnings.append({'path': self.relative(path), 'issue': 'readonly_snapshot_unavailable', 'detail': type(error).__name__})
            return {}
        finally:
            if db is not None:
                db.close()

    def source(self, provenance):
        path = self.project_path(provenance.get('parser_result_path'))
        parsed = self.load(path) if path else None
        document = (parsed or {}).get('document')
        if not document:
            return None
        key = anchor(document['document_id'], document['file_sha256'], document['text_version'])
        if key not in self.documents:
            self.documents[key] = {key: document[key] for key in ['document_id', 'file_sha256', 'text_version', 'fixture', 'evidence_kind', 'title', 'parser', 'blocks', 'pages', 'coverage']}
            self.documents[key].update({'key': key, 'pdf_path': provenance.get('original_pdf_path'), 'parser_result_path': self.relative(path)})
        return key

    def attempt(self, job, historical, db):
        directory = self.project_path(job.get('directory'))
        result = self.load(directory / 'result.json') if directory else None
        diagnostic = self.load(directory / 'diagnostic-interruption.json', {}) if directory else {}
        snapshot = (diagnostic or {}).get('snapshot') or db.get(job.get('run_id'), {})
        provenance = self.load(directory / 'source-provenance.json', {}) if directory else {}
        archived_configuration = self.load(Path(provenance['runtime_source_snapshot']) / 'config/extraction-development.json', {}) if provenance.get('runtime_source_snapshot') else {}
        article = self.load(directory / 'article-scope.json', {}) if directory else {}
        plan = self.load(directory / 'batch-plan.json', []) if directory else []
        attempts = []
        if directory and directory.is_dir():
            for path in sorted(directory.glob('batch-*-attempt-*.json')):
                attempt = self.load(path)
                if attempt:
                    attempts.append({'path': self.relative(path), **attempt})
        key = self.source(provenance)
        document = self.documents.get(key, {})
        versions = (result or {}).get('versions', snapshot.get('versions', []))
        records = (result or {}).get('records', snapshot.get('candidates', []))
        if not versions and records:
            versions = records
        batches = snapshot.get('batches', [])
        observations = attempts + batches
        reads = set(block_id for batch in observations for block_id in batch.get('read_block_ids', []))
        completed = set(block_id for batch in observations if batch.get('explicit_completion_received') and batch.get('status') == 'completed'
                        for block_id in batch.get('assigned_block_ids', []))
        coverage = (result or {}).get('coverage', job.get('coverage', {})) or {}
        completed.update(coverage.get('completed_source_block_ids', []))
        failed = set(coverage.get('failed_source_block_ids', []))
        if not result:
            last_batches = {batch['batch_id']: batch for batch in observations if 'batch_id' in batch}
            failed.update(block_id for batch in last_batches.values() if batch.get('status') == 'failed'
                          for block_id in batch.get('assigned_block_ids', []) if block_id not in completed)
        all_ids = [block['block_id'] for block in document.get('blocks', [])]
        assigned = article.get('included_block_ids') or list(dict.fromkeys(block_id for batch in plan for block_id in batch.get('assigned_block_ids', [])))
        quarantine = article.get('quarantined_block_ids', coverage.get('quarantined_source_block_ids', []))
        assigned_counts = Counter(block_id for batch in plan for block_id in batch.get('assigned_block_ids', []))
        context_counts = Counter(block_id for batch in plan for block_id in batch.get('context_block_ids', []))
        recorded_reads = Counter(block_id for batch in attempts for block_id in batch.get('read_block_ids', []))
        inventory = {'all_source_block_ids': all_ids, 'assigned_block_ids': assigned, 'read_observed_block_ids': sorted(reads),
                     'not_observed_read_block_ids': [block_id for block_id in all_ids if block_id not in reads],
                     'explicitly_completed_block_ids': sorted(completed), 'failed_block_ids': sorted(failed),
                     'unprocessed_block_ids': [block_id for block_id in assigned if block_id not in completed and block_id not in failed],
                     'quarantined_block_ids': quarantine,
                     'assigned_overlap_block_ids': [block_id for block_id, count in assigned_counts.items() if count > 1],
                     'context_unique_block_ids': list(context_counts), 'planned_context_exposures': sum(context_counts.values()),
                     'context_repeated_exposures': sum(max(0, count - 1) for count in context_counts.values()),
                     'recorded_repeated_read_exposures': sum(max(0, count - 1) for count in recorded_reads.values()),
                     'reported_context_exposures_including_overlap': coverage.get('context_block_exposures_including_overlap'),
                     'read_inventory_note': '仅已持久化的批次读块证据；运行中尚未落盘的读取未知。读过不等于明确完成，完成不等于医学召回。'}
        events = (result or {}).get('events', (diagnostic or {}).get('events', snapshot.get('events', [])))
        first_saved = next((event.get('timestamp') for event in sorted(events, key=lambda event: event.get('seq', 0))
                            if event.get('type') == 'candidate'), None)
        input_data = snapshot.get('input', {})
        fixture = input_data.get('fixture', document.get('fixture', any(v.get('record', {}).get('extraction_trace', {}).get('fixture') for v in records)))
        source_fixture = document.get('fixture') is True or fixture is True
        verified_real_source = document.get('fixture') is False and document.get('evidence_kind') == 'real_paper' and \
            document.get('file_sha256') == provenance.get('file_sha256')
        return {'key': anchor(job.get('job_id'), job.get('run_id'), job.get('directory'), historical), 'job': job,
                'historical': historical, 'run_id': (result or {}).get('run_id', job.get('run_id')),
                'document_id': job.get('document_id'), 'model_id': job.get('model_id'), 'strategy': job.get('strategy'),
                'status': job.get('status'), 'state': (result or {}).get('state', snapshot.get('state', job.get('state'))),
                'directory': self.relative(directory), 'result_path': self.relative(directory / 'result.json') if directory and result else None,
                'diagnostic_path': self.relative(directory / 'diagnostic-interruption.json') if directory and diagnostic else None,
                'source_key': key, 'provenance': provenance, 'input': input_data, 'metadata': snapshot.get('metadata', {}),
                'archived_run_configuration': archived_configuration,
                'source_is_fixture': source_fixture, 'source_is_verified_real_paper': verified_real_source,
                'coverage': coverage, 'inventory': inventory, 'article_scope': article,
                'records': records, 'versions': versions, 'batch_attempts': attempts, 'events': events,
                'summary': (result or {}).get('summary'), 'error': (result or {}).get('error', job.get('error')),
                'resources': (result or {}).get('resources'), 'recorded_first_candidate_seconds': (result or {}).get('first_candidate_seconds'),
                'first_saved_candidate_event_seconds_approx': duration(job.get('started_at'), first_saved),
                'total_seconds': (result or {}).get('total_seconds', duration(job.get('started_at'), job.get('finished_at'))),
                'result_available': bool(result), 'evidence_class': 'engineering_fixture' if source_fixture else 'unverified_run'}


def request_cost(request, pricing, reserve=False):
    model = (pricing or {}).get('models', {}).get(request.get('model_id'))
    if not model:
        return None
    try:
        if 'input' in model and 'output' in model:
            # The supplied AGICTO document explicitly requests a flat normalized-token scenario.
            # Cache/account billing is unknown; missing-usage requests are excluded by that policy.
            if reserve or request.get('usage_status') != 'provider_reported':
                return None
            return (request['input_tokens'] * model['input'] + request['output_tokens'] * model['output']) / 1_000_000
        if reserve:
            return (request['input_ceiling'] * model['input_per_million'] + request['output_ceiling'] * model['output_per_million']) / 1_000_000
        cache_read, cache_write = request.get('cache_read_tokens', 0), request.get('cache_write_tokens', 0)
        uncached = request['input_tokens'] - cache_read - cache_write
        if uncached < 0:
            return None
        total = uncached * model['input_per_million'] + request['output_tokens'] * model['output_per_million']
        if cache_read:
            total += cache_read * model['cache_read_per_million']
        if cache_write:
            total += cache_write * model['cache_write_per_million']
        return total / 1_000_000
    except (KeyError, TypeError):
        return None


def usage_totals(requests, pricing):
    known = [r for r in requests if r.get('usage_status') == 'provider_reported']
    unknown = [r for r in requests if r.get('usage_status') != 'provider_reported']
    known_costs = [request_cost(r, pricing) for r in known]
    reserve_costs = [request_cost(r, pricing, True) for r in unknown]
    return {'requests': len(requests), 'provider_reported_requests': len(known), 'unknown_usage_requests': len(unknown),
            'provider_reported_input_tokens': sum(r.get('input_tokens', 0) for r in known),
            'provider_reported_output_tokens': sum(r.get('output_tokens', 0) for r in known),
            'cache_read_tokens_included_in_reported_input': sum(r.get('cache_read_tokens', 0) for r in known),
            'cache_write_tokens_included_in_reported_input': sum(r.get('cache_write_tokens', 0) for r in known),
            'reasoning_tokens_included_in_reported_output': sum(r.get('reasoning_tokens', 0) for r in known),
            'unknown_usage_reserved_input_tokens': sum(r.get('input_ceiling', 0) for r in unknown),
            'unknown_usage_reserved_output_tokens': sum(r.get('output_ceiling', 0) for r in unknown),
            'known_usage_list_price_estimate': sum(known_costs) if known_costs and all(v is not None for v in known_costs) else None,
            'unknown_usage_reservation_price_scenario': sum(reserve_costs) if reserve_costs and all(v is not None for v in reserve_costs) else None,
            'actual_bill': None, 'actual_bill_status': 'unknown',
            'provider_input_above_local_estimate_requests': sum(r.get('usage_status') == 'provider_reported' and
                r.get('input_tokens', 0) > r.get('local_payload_estimate', r.get('payload_bytes', 0) + 512) for r in requests),
            'provider_input_above_reservation_requests': sum(r.get('usage_status') == 'provider_reported' and
                r.get('input_tokens', 0) > r.get('input_ceiling', float('inf')) for r in requests),
            'finished_request_wall_seconds_sum': sum(duration(r.get('started_at'), r.get('finished_at')) or 0 for r in requests)}


def collect(report, pricing_path=None):
    base = report.root / 'docs/acceptance/s4'
    register = report.load(base / 'experiment-register.json', {})
    matrix = report.load(base / 'matrix-progress.json', {'jobs': []})
    runtime = report.project_path(register.get('runtime_directory'))
    ledger = report.load(runtime / 'call-ledger.json', {}) if runtime else {}
    compatibility = report.load(base / 'api-compatibility.json', {})
    pricing = report.load(pricing_path, {}) if pricing_path else {}
    snapshots = report.database(runtime) if runtime else {}
    runs = []
    for job in matrix.get('jobs', []):
        for old in job.get('attempt_history', []):
            runs.append(report.attempt(old, True, snapshots))
        current = {key: value for key, value in job.items() if key != 'attempt_history'}
        runs.append(report.attempt(current, False, snapshots))
    requests = []
    for original in ledger.get('requests', []):
        request = dict(original)
        matching = [run for run in runs if run.get('run_id') and str(request.get('purpose', '')).startswith(run['run_id'] + ':')]
        run = max(matching, key=lambda item: len(item['run_id'])) if matching else None
        request['run_key'] = run['key'] if run else None
        request['strategy'] = run['strategy'] if run else 'compatibility' if request.get('purpose') == 'synthetic_tool_compatibility' else 'unassigned'
        request['evidence_class'] = ('engineering_fixture' if run['source_is_fixture'] else 'real_paid_paper_run' if run['source_is_verified_real_paper'] else 'unverified_run') if run else (
            'paid_synthetic_compatibility' if request.get('purpose') == 'synthetic_tool_compatibility' else 'unverified_run')
        request['wall_seconds'] = duration(request.get('started_at'), request.get('finished_at'))
        request['list_price_estimate'] = request_cost(request, pricing) if request.get('usage_status') == 'provider_reported' else None
        request['reservation_price_scenario'] = request_cost(request, pricing, True) if request.get('usage_status') != 'provider_reported' else None
        requests.append(request)
    for run in runs:
        run['requests'] = [r for r in requests if r.get('run_key') == run['key']]
        if run['requests']:
            run['evidence_class'] = 'engineering_fixture' if run['source_is_fixture'] else 'real_paid_paper_run' if run['source_is_verified_real_paper'] else 'unverified_run'
        run['usage'] = usage_totals(run['requests'], pricing)
        source = report.documents.get(run.get('source_key'), {})
        blocks = {block['block_id']: block for block in source.get('blocks', [])}
        for envelope in run['records']:
            record = envelope.get('record', {})
            segments = record.get('quote_span', {}).get('segments', [])
            warnings = []
            previous_order = previous_end = None
            exact = bool(segments)
            for segment in segments:
                block = blocks.get(segment.get('block_id'))
                if block is None or block.get('text_version') != segment.get('text_version') or \
                        block.get('text', '')[segment.get('start', 0):segment.get('end', 0)] != segment.get('exact_quote'):
                    exact = False
                if block is not None:
                    order = block.get('reading_order', 0)
                    if previous_order is not None and (order > previous_order + 1 or order == previous_order and segment.get('start', 0) > previous_end):
                        warnings.append('nonadjacent_source_segments_require_context')
                    previous_order, previous_end = order, segment.get('end', 0)
            if not exact:
                warnings.append('report_source_span_mismatch')
            if segments and record.get('quote_span', {}).get('display_joiner', '').join(segment.get('exact_quote', '') for segment in segments) != record.get('original_quote'):
                warnings.append('report_composite_display_mismatch')
            envelope['report_display_checks'] = {'kind': 'AI_engineering_source_consistency_only_not_medical_gold',
                'all_source_segments_exact_in_loaded_IR': exact, 'warnings': list(dict.fromkeys(warnings)),
                'source_snapshot_modified': False, 'medical_semantics_verified': False}
    groups = defaultdict(list)
    for request in requests:
        groups[(request.get('model_id'), request.get('strategy'), request['evidence_class'])].append(request)
    grouped = [{'model_id': model, 'strategy': strategy, 'evidence_class': kind, **usage_totals(items, pricing)}
               for (model, strategy, kind), items in sorted(groups.items())]
    checks = {'pure_functions': report.load(base / 'evidence-validation/acceptance.json', {}),
              'pure_functions_nonadjacent_supplement': report.load(base / 'evidence-validation/nonadjacent-source-supplement.json', {}),
              'runtime_and_regressions': report.load(base / 'runtime-validation/summary.json', {})}
    candidate_cases = report.load(base / 'evidence-validation/real-candidate-cases.json', {})
    semantic_cases = report.load(base / 'evidence-validation/semantic-audit-cases.json', {})
    semantic_reviews = []
    for run in runs:
        for event in run.get('events', []):
            if event.get('type') == 'semantic_audit_review':
                semantic_reviews.append({'run_key': run['key'], 'run_id': run['run_id'], 'model_id': run['model_id'],
                    'strategy': run['strategy'], 'historical_attempt': run['historical'], 'timestamp': event.get('timestamp'), 'detail': event.get('detail', {})})
    adjustments = ledger.get('wall_clock_adjustments', [])
    effective_seconds = ledger.get('limits', {}).get('seconds')
    for adjustment in adjustments:
        if isinstance(adjustment.get('to_seconds'), (int, float)):
            effective_seconds = adjustment['to_seconds']
    generated = datetime.now(timezone.utc).isoformat()
    execution_counts = {
        'planned_conditions': matrix.get('planned_runs', sum(not run['historical'] for run in runs)),
        'actual_paper_runs': sum(bool(run.get('run_id')) for run in runs),
        'historical_paper_runs': sum(run['historical'] and bool(run.get('run_id')) for run in runs),
        'current_actual_paper_runs': sum(not run['historical'] and bool(run.get('run_id')) for run in runs),
        'pending_conditions': sum(not run['historical'] and run['status'] == 'pending' and not run.get('run_id') for run in runs),
        'model_requests_including_probes_and_failures': len(requests),
    }
    return {'schema_version': 's4-readable-report-1', 'generated_at': generated,
            'batch_id': register.get('batch_id'), 'stage_passed': False, 'S5_UI_started': False,
            'medical_quality_approved': False, 'human_gold_complete': False, 'precision': 'not_evaluable', 'recall': 'not_evaluable',
            'formal_model_selected': False, 'matrix': matrix, 'runs': runs, 'execution_counts': execution_counts, 'sources': list(report.documents.values()),
            'requests': requests, 'usage_totals': usage_totals(requests, pricing), 'usage_by_model_strategy': grouped,
            'ledger_limits': ledger.get('limits'), 'ledger_halted': ledger.get('halted'), 'pricing_assumptions': pricing or None,
            'ledger_wall_clock_adjustments': adjustments, 'ledger_effective_experiment_seconds': effective_seconds,
            'actual_bill': None, 'actual_bill_status': 'unknown',
            'compatibility': {'results': compatibility.get('results', []), 'medical_quality_acceptance': False},
            'timing': {'experiment_first_request_at': ledger.get('experiment_started_at'),
                       'experiment_wall_seconds_since_first_request': duration(ledger.get('experiment_started_at'), generated),
                       'historical_attempt_recorded_wall_seconds_sum': sum(run['total_seconds'] or 0 for run in runs if run['historical']),
                       'development_total_wall_seconds': None,
                       'notes': '首候选/全文运行从已解析IR开始；旧尝试、供应商请求和开发等待分别计时。首次实验请求以来的墙钟不等于全部开发时长，开发总时长未知。'},
            'engineering_checks': checks, 'read_warnings': report.warnings, 'source_file_sha256': report.inputs,
            'real_candidate_engineering_cases': candidate_cases,
            'semantic_audit_development_cases': semantic_cases, 'semantic_audit_recorded_reviews': semantic_reviews,
            'limits': ['无人工阅读全文金标，精确率和召回率均不可评价；候选数不能用于质量排名。',
                       '供应商实报、缺 usage 的预算预留和实际账单分开。预留不是供应商强制 token 上限。',
                       '缓存 token 已包含于实报输入、推理 token 已包含于实报输出，不重复相加。',
                       'AGICTO 实报输入高于本地 payload 估算的原因未知；不替网关计费口径作推断。',
                       '本轮复用真实 Docling IR；运行耗时不包含重新解析 PDF，不能称上传到完成端到端耗时。',
                       'PDF 框为整行定位；跨段展示保留片段边界，不能宣称逐字高亮或连续原句。',
                       '程序检查、模型语义复核与人工批准独立；模型复核未见问题不等于医学或人工批准。',
                       'S2 金标/医学词表与规则/独立分组、S3 人类忠实度及最终阈值仍待办；S4 未正式通过，S5 产品 UI 未启动。']}


def badge(text, kind=''):
    return f'<span class="badge {esc(kind)}">{esc(text)}</span>'


def json_details(title, value, opened=False):
    return f'<details{" open" if opened else ""}><summary>{esc(title)}</summary><pre>{esc(json.dumps(value, ensure_ascii=False, indent=2))}</pre></details>'


def table(headers, rows, css=''):
    return f'<div class="table-wrap"><table class="{css}"><thead><tr>' + ''.join(f'<th>{esc(h)}</th>' for h in headers) + '</tr></thead><tbody>' + ''.join('<tr>' + ''.join(f'<td>{cell}</td>' for cell in row) + '</tr>' for row in rows) + '</tbody></table></div>'


def validate_snapshot(page, data, output):
    class Links(HTMLParser):
        def __init__(self):
            super().__init__(); self.ids = set(); self.hrefs = []; self.scripts = 0

        def handle_starttag(self, tag, attrs):
            attributes = dict(attrs)
            if attributes.get('id'): self.ids.add(attributes['id'])
            if tag == 'a' and attributes.get('href'): self.hrefs.append(attributes['href'])
            if tag == 'script': self.scripts += 1

    links = Links(); links.feed(page)
    missing_anchors, missing_files = [], []
    for href in links.hrefs:
        parsed = urlsplit(href)
        if href.startswith('#') and unquote(parsed.fragment) not in links.ids:
            missing_anchors.append(href)
        elif not parsed.scheme and parsed.path and not (output / unquote(parsed.path)).is_file():
            missing_files.append(href)
    source_mismatches = [{'run_id': run['run_id'], 'record_id': envelope.get('record', {}).get('record_id'),
                          'checks': envelope.get('report_display_checks')} for run in data['runs'] for envelope in run['records']
                         if any(code in envelope.get('report_display_checks', {}).get('warnings', [])
                                for code in ['report_source_span_mismatch', 'report_composite_display_mismatch'])]
    return {'schema_version': 's4-report-render-validation-1', 'generated_at': data['generated_at'],
            'html_parsed': True, 'script_elements': links.scripts, 'missing_internal_anchors': sorted(set(missing_anchors)),
            'missing_local_link_files': sorted(set(missing_files)), 'source_span_or_composite_mismatches': source_mismatches,
            'passed': links.scripts == 1 and not missing_anchors and not missing_files and not source_mismatches,
            'medical_semantics_verified': False, 'stage_passed': False,
            'html_sha256': hashlib.sha256(page.encode()).hexdigest(),
            'generator_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}


def render_usage(data):
    rows = []
    for group in data['usage_by_model_strategy']:
        rows.append([esc(group['model_id']), esc(label(group['strategy'])), esc(label(group['evidence_class'])), number(group['requests']),
                     number(group['provider_reported_input_tokens']), number(group['provider_reported_output_tokens']),
                     number(group['unknown_usage_requests']), number(group['unknown_usage_reserved_input_tokens']), number(group['unknown_usage_reserved_output_tokens']),
                     number(group['known_usage_list_price_estimate']), number(group['unknown_usage_reservation_price_scenario']), 'unknown'])
    return table(['模型', '策略', '证据类别', '全部请求', '实报输入', '实报输出', 'usage 未知请求', '未知输入预算预留', '未知输出预算预留',
                  '已知 usage 标价估算', '预留 token 标价情景', '实际账单'], rows)


def candidate_html(report, run, envelope, data):
    record = envelope.get('record', envelope)
    record_id = record.get('record_id', 'unknown')
    segments = record.get('quote_span', {}).get('segments', [])
    source = report.documents.get(run.get('source_key'), {})
    auto = record.get('evidence_validation', {})
    model = auto.get('model_semantic_review', {})
    context = record.get('context', {})
    source_pdf = source.get('pdf_path') or run.get('provenance', {}).get('original_pdf_path')
    parts = []
    for segment in segments:
        location = f"物理 p{segment.get('physical_page')} · {segment.get('block_id')} · Unicode [{segment.get('start')},{segment.get('end')}) · 行框 {segment.get('bbox')}"
        parts.append(f'<div class="segment"><p>{report.link(source_pdf, location, segment.get("physical_page"))}</p><blockquote>{esc(segment.get("exact_quote", ""))}</blockquote></div>')
    links = []
    for related in record.get('duplicate_and_conflict_links', []):
        target = anchor(run['key'], related.get('record_id'))
        links.append(f'<a href="#{target}">{esc(related.get("relationship"))} → {esc(related.get("record_id"))}</a>')
    version_links = []
    for version in run.get('versions', []):
        if version.get('record', {}).get('record_id') == record_id:
            version_links.append(f'<a href="#{anchor(run["key"], record_id, version.get("version"))}">v{esc(version.get("version"))} {esc(label(version.get("status")))}</a>')
    warning_codes = auto.get('warnings', [])
    attribution = context.get('source_attribution', {})
    display = envelope.get('report_display_checks', {})
    display_note = '来源片段逐段列出；显示连接符不建立语义连续性。' if len(segments) > 1 else '单一来源片段。'
    if 'nonadjacent_source_segments_require_context' in display.get('warnings', []):
        display_note += ' AI 工程检查：这些片段之间存在未展示的原始文本，缺失语境及跨段关联待核；这不是医学金标判断。'
    return f'''<article class="candidate" id="{anchor(run['key'], record_id)}">
      <h4>{esc(record.get('feature_name_raw') or '未命名特征')} <small>{esc(record.get('evidence_type'))}</small></h4>
      <p>{badge(label(record.get('review_status')), 'warn')} {badge(record.get('handoff_status', 'candidate_only'))} {badge(label(run['evidence_class']))}
      <span class="muted">{esc(record_id)} · v{esc(envelope.get('version', '未知'))}</span></p>
      <p>疾病/病灶：{esc(record.get('disease_or_lesion', {}).get('value') or 'unknown')} · 模态：{esc(record.get('modality', {}).get('value') or 'unknown')} ·
      序列/期相：{esc((record.get('sequence_or_phase') or {}).get('value') or 'unknown')} · 表述：{esc(label(record.get('assertion', {}).get('value')))} ·
      来源：{esc(label(attribution.get('origin')))} {esc(', '.join(attribution.get('cited_references', [])))}</p>
      {''.join(parts)}
      <p class="notice">{esc(display_note)}</p>
      <p class="muted">显示连接符：<code>{esc(repr(record.get('quote_span', {}).get('display_joiner', '')))}</code>；
      {esc(record.get('quote_span', {}).get('quote_kind'))}；框只覆盖整行，不能逐字高亮。</p>
      <div class="checks"><div><strong>程序检查</strong><p>{esc(label(auto.get('automatic_checks', {}).get('status')))}</p><p>{esc('；'.join(warning_codes) or '未记录异常；医学语义仍未经验证')}</p></div>
      <div><strong>模型语义复核</strong><p>{esc(label(model.get('status')))}</p><p>{esc(model.get('model_id') or '未记录模型')} · {esc('；'.join(model.get('issue_codes', [])))}</p></div>
      <div><strong>人工批准</strong><p>{esc(label(record.get('review_status')))}</p><p>审核事件 {len(record.get('review_events', []))}；医学验证字段 {esc(auto.get('medical_semantics_verified'))}</p></div></div>
      {json_details('必要上下文（保留原片段及其定位）', context)}
      {json_details('报告层来源一致性检查（不改原候选与原审核状态）', display)}
      <p>单篇关联：{' · '.join(links) or '尚无记录'}；版本：{' · '.join(version_links) or '无版本清单'}</p>
      {json_details(f'完整 {len(record)} 字段 JSON（来源事实、建议及审核状态分别保留）', record)}
    </article>'''


def render(report, data):
    totals = data['usage_totals']
    current = [run for run in data['runs'] if not run['historical']]
    historical = [run for run in data['runs'] if run['historical']]
    paid_candidates = sum(len(run['records']) for run in current if run['evidence_class'] == 'real_paid_paper_run')
    controls = '<label>模型<select id="model-filter"><option value="">全部</option>' + ''.join(f'<option>{esc(model)}</option>' for model in sorted({r['model_id'] for r in data['runs'] if r['model_id']})) + '</select></label>'
    controls += '<label>策略<select id="strategy-filter"><option value="">全部</option><option value="baseline">直接抽取＋汇总</option><option value="independent_context_review">独立语境复核</option></select></label>'
    controls += '<label>检索运行 / 特征 / 原文<input id="search-filter" placeholder="输入癌种、特征、块 ID 或问题代码"></label>'
    cards = ''.join(f'<div class="stat"><span>{esc(title)}</span><strong>{esc(value)}</strong></div>' for title, value in [
        ('计划条件', data['execution_counts']['planned_conditions']), ('实际论文运行（含历史）', data['execution_counts']['actual_paper_runs']),
        ('历史论文运行（全部保留）', data['execution_counts']['historical_paper_runs']),
        ('当前完整源块＋汇总条件', sum(r['coverage'].get('source_block_processing_complete') is True and r['coverage'].get('whole_document_summary_complete') is True for r in current)),
        ('待运行计划', data['execution_counts']['pending_conditions']), ('当前真实 API 待审候选', paid_candidates),
        ('实报输入 / 输出 token', f"{totals['provider_reported_input_tokens']:,} / {totals['provider_reported_output_tokens']:,}"),
        ('usage 未知请求 / 全请求', f"{totals['unknown_usage_requests']} / {totals['requests']}"),
        ('精确率 / 召回率', 'not_evaluable'), ('S4 正式通过 / S5 UI', '否 / 未启动')])
    matrix_rows = []
    for run in data['runs']:
        inventory = run['inventory']
        pending = run['status'] == 'pending' and not run.get('run_id')
        attrs = f'data-model="{esc(run["model_id"])}" data-strategy="{esc(run["strategy"])}"'
        cells = [f'<a href="#{run["key"]}">{esc(run["job"].get("job_id"))} {"历史实跑" if run["historical"] else "待运行计划" if pending else "当前实跑"}</a>',
                 esc(run['document_id']), esc(run['model_id']), esc(label(run['strategy'])), esc('待运行计划（尚无实际尝试）' if pending else label(run['status'])), esc('尚未创建运行' if pending else label(run['state'])),
                 str(len(run['records'])) if run.get('run_id') else '尚未运行',
                 f"{len(inventory['read_observed_block_ids'])} / {len(inventory['all_source_block_ids'])}" if inventory['all_source_block_ids'] else '未记录',
                 f"{len(inventory['explicitly_completed_block_ids'])} / {len(inventory['assigned_block_ids'])}" if inventory['assigned_block_ids'] else '未记录',
                 str(len(inventory['failed_block_ids'])), str(len(inventory['unprocessed_block_ids'])), str(len(inventory['quarantined_block_ids'])),
                 number(run['total_seconds'])]
        matrix_rows.append(f'<tr class="matrix-row" {attrs}>' + ''.join(f'<td>{cell}</td>' for cell in cells) + '</tr>')
    matrix_table = '<div class="table-wrap"><table><thead><tr>' + ''.join(f'<th>{title}</th>' for title in ['计划 / 实跑', '文献', '模型', '策略', '状态', '程序状态', '候选', '已记录读 / 全部块', '明确完成 / 分派', '失败', '未处理', '隔离', '运行秒数']) + '</tr></thead><tbody>' + ''.join(matrix_rows) + '</tbody></table></div>'
    run_sections = []
    for run in data['runs']:
        if run['status'] == 'pending' and not run.get('run_id'):
            run_sections.append(f'''<section class="run-panel" id="{run['key']}" data-model="{esc(run['model_id'])}" data-strategy="{esc(run['strategy'])}">
              <h3>{esc(run['job'].get('job_id'))} · {esc(run['document_id'])} · {esc(run['model_id'])} · {esc(label(run['strategy']))}
              {badge('待运行计划（尚无实际尝试）', 'warn')}</h3>
              <p>该登记条件尚未创建实际论文运行。候选、覆盖、耗时、归档参数和用量均无实跑记录；不能据此判断论文是否存在相关特征。</p>
            </section>''')
            continue
        inv = run['inventory']; source = report.documents.get(run['source_key'], {})
        profile = run.get('metadata', {}).get('model_profile', {})
        configuration = run.get('archived_run_configuration', {})
        maxima = configuration.get('per_run_authorized_maxima', {})
        operation_limits = configuration.get('operation_limits', {})
        concurrency = run.get('provenance', {}).get('matrix_concurrency', (run.get('resources') or {}).get('matrix_concurrency'))
        conditions = ('协议 ' + str(run.get('provenance', {}).get('protocol_version') or '未记录') +
            '；并发 ' + str(concurrency if concurrency is not None else '未记录') +
            '；reasoning ' + str(profile.get('reasoning_effort') or '未记录') +
            '；profile context ' + str(profile.get('context_window') or '未记录') +
            '；单批响应上限 ' + str(maxima.get('batch_responses', '未记录')) +
            '；本次文档上限 ' + str(maxima.get('document_seconds', operation_limits.get('document_seconds', '未记录'))) + ' 秒' +
            '；请求上限 ' + str(operation_limits.get('request_seconds', '未记录')) + ' 秒。')
        statuses = {name: set(inv[name]) for name in ['read_observed_block_ids', 'explicitly_completed_block_ids', 'failed_block_ids', 'unprocessed_block_ids', 'quarantined_block_ids']}
        block_rows = []
        for block in source.get('blocks', []):
            bid = block['block_id']; flags = []
            for field, title in [('read_observed_block_ids', '读过（已持久化）'), ('explicitly_completed_block_ids', '明确完成'), ('failed_block_ids', '失败'), ('unprocessed_block_ids', '未处理'), ('quarantined_block_ids', '隔离待核')]:
                if bid in statuses[field]: flags.append(title)
            if bid not in statuses['read_observed_block_ids']: flags.append('未记录读取')
            block_rows.append([f'<a href="#{anchor(run["source_key"], bid)}">{esc(bid)}</a>', str(block['page']), esc('；'.join(flags)), esc(block['text'][:120])])
        coverage_table = table(['原始块', '物理页', '状态（允许并列）', '原文前 120 字'], block_rows)
        candidates = ''.join(candidate_html(report, run, env, data) for env in run['records'])
        if not candidates:
            candidates = '<p class="muted">当前没有已持久化候选。运行未完成时不能据此断言论文没有符合范围的特征。</p>'
        versions = ''.join(f'<details id="{anchor(run["key"], env.get("record", {}).get("record_id"), env.get("version"))}"><summary>{esc(env.get("record", {}).get("record_id"))} · v{esc(env.get("version"))} · {esc(label(env.get("status")))} · {esc(env.get("actor"))} · {esc(env.get("reason"))}</summary><pre>{esc(json.dumps(env, ensure_ascii=False, indent=2))}</pre></details>' for env in run['versions'])
        artifact_links = [report.link(path, title) for path, title in [(run.get('result_path'), 'result.json'), (run.get('diagnostic_path'), '旧中断诊断')] if path]
        artifact_links += [report.link(source.get('pdf_path'), '原 PDF'), report.link(source.get('parser_result_path'), 'Docling IR')] if source else []
        metrics = table(['全部原始块', '已持久化读块', '未记录读取', '明确完成', '最终失败', '未处理', '隔离待核', '上下文唯一块', '计划上下文曝光', '计划上下文重复曝光', '记录的重复读取曝光'], [[
            str(len(inv[k])) for k in ['all_source_block_ids', 'read_observed_block_ids', 'not_observed_read_block_ids', 'explicitly_completed_block_ids', 'failed_block_ids', 'unprocessed_block_ids', 'quarantined_block_ids', 'context_unique_block_ids']
        ] + [str(inv[k]) for k in ['planned_context_exposures', 'context_repeated_exposures', 'recorded_repeated_read_exposures']]])
        run_sections.append(f'''<section class="run-panel" id="{run['key']}" data-model="{esc(run['model_id'])}" data-strategy="{esc(run['strategy'])}">
          <h3>{esc(run['job'].get('job_id'))} · {esc(run['document_id'])} · {esc(run['model_id'])} · {esc(label(run['strategy']))}
          {badge('历史尝试' if run['historical'] else '当前尝试')} {badge(label(run['status']), 'warn')}</h3>
          <p>{esc(run.get('run_id') or '尚未创建 run')} · {esc(label(run['evidence_class']))} · {' · '.join(artifact_links)}</p>
          <p class="muted">本次归档条件：{esc(conditions)} 跨版本条件不自动视为可比；共享进程资源采样不能当作单模型独占资源。</p>
          <p>程序状态：{esc(label(run['state']))}；S4 从既有 IR 到本次结束耗时：{number(run['total_seconds'])} s；批次采样首候选延迟：{number(run['recorded_first_candidate_seconds'])} s；
          首次持久化候选事件距本次运行开始约：{number(run['first_saved_candidate_event_seconds_approx'])} s。
          耗时从复用 IR 开始；运行中的指标可能尚未落盘。</p>{metrics}<p class="muted">{esc(inv['read_inventory_note'])} 状态可能重叠，不能将列简单相加。</p>
          {json_details('覆盖原始数据、重叠与隔离块 ID', {'reported_coverage': run['coverage'], 'inventory': inv, 'article_scope': run['article_scope']})}
          <details><summary>逐块查看原文、读过 / 完成 / 失败 / 未读 / 隔离状态</summary>{coverage_table}</details>
          {('<p class="error">运行错误：' + esc(json.dumps(run['error'], ensure_ascii=False)) + '</p>') if run['error'] else ''}
          {('<p class="summary">全文汇总：' + esc(run['summary']) + '</p>') if run['summary'] else ''}
          <h4>候选原文与审核状态（{len(run['records'])} 条）</h4>{candidates}
          <details><summary>全部记录版本、更新建议与人工保护（{len(run['versions'])} 个版本）</summary>{versions or '<p>尚无版本。</p>'}</details>
          {json_details('全部批次尝试（包括失败）', run['batch_attempts'])}
          {json_details('持久化事件与拒绝原因', run['events'])}
          {json_details('本次运行输入、源码版本与资源证据', {'input': run['input'], 'metadata': run['metadata'], 'provenance': run['provenance'], 'archived_configuration': run['archived_run_configuration'], 'resources': run['resources'], 'usage': run['usage']})}
        </section>''')
    source_sections = []
    for source in data['sources']:
        rows = []
        for block in source['blocks']:
            bid = block['block_id']; target = anchor(source['key'], bid)
            rows.append(f'<tr id="{target}"><td>{esc(bid)}</td><td>{report.link(source["pdf_path"], "物理 p" + str(block["page"]), block["page"])}</td><td>{esc(block["bbox"])}</td><td class="source-text">{esc(block["text"])}</td></tr>')
        source_sections.append(f'<details><summary>{esc(source["document_id"])} · {len(source["pages"])} 物理页 · {len(source["blocks"])} 原始行块 · SHA {esc(source["file_sha256"][:16])}…</summary><p>text_version={esc(source["text_version"])}；{report.link(source["pdf_path"], "原 PDF")}；框单位为 pt，整行精度。</p><div class="table-wrap"><table><thead><tr><th>块 ID</th><th>物理页</th><th>行框 [x0,y0,x1,y1]</th><th>权威原文</th></tr></thead><tbody>{"".join(rows)}</tbody></table></div></details>')
    request_rows = []
    for request in data['requests']:
        known = request.get('usage_status') == 'provider_reported'
        request_rows.append([esc(request['model_id']), esc(label(request['strategy'])), esc(label(request['evidence_class'])),
                             esc(label(request.get('usage_status'))), str(request.get('status', '未知')),
                             number(request.get('input_tokens')) if known else '未知', number(request.get('output_tokens')) if known else '未知',
                             '—' if known else number(request.get('input_ceiling')), '—' if known else number(request.get('output_ceiling')),
                             number(request.get('wall_seconds')), esc(request.get('error_code', '')),
                             json_details(request.get('id', 'request'), request)])
    engineering = json_details('最初纯函数模块 48 项实跑及历史失败记录', data['engineering_checks']['pure_functions']) + \
        json_details('真实候选触发的非相邻片段警示补测：当前纯函数 50 项（含原 48 项，不相加）', data['engineering_checks']['pure_functions_nonadjacent_supplement']) + \
        json_details('运行层 / 既有回归实跑与各自源码版本', data['engineering_checks']['runtime_and_regressions'])
    case_sections = []
    for case in data.get('real_candidate_engineering_cases', {}).get('cases', []):
        findings = case.get('findings', {})
        related_run = next((run for run in data['runs'] if run.get('run_id') == case.get('run_id')), None)
        candidate_link = f'<a href="#{anchor(related_run["key"], case.get("record_id"))}">查看候选及原片段</a>' if related_run else ''
        case_sections.append(f'''<article class="candidate"><h4>{esc(case.get('case_id'))} · {esc(case.get('record_snapshot', {}).get('feature_name_raw'))}</h4>
          <p>{badge('AI 工程样例检查，非医生金标', 'warn')} {badge('needs_review')} {candidate_link}</p>
          <p><strong>文本与分类：</strong>{esc(findings.get('textual_content', ''))}</p>
          <p><strong>原文完整性：</strong>{esc(findings.get('completeness', ''))}</p>
          <p><strong>数值与单位：</strong>{esc(findings.get('numbers_units', ''))}</p>
          <p><strong>范围与事实：</strong>{esc(findings.get('scope_fact_separation', ''))}</p>
          <p><strong>视觉证据边界：</strong>{esc(findings.get('visual_boundary', ''))}</p>
          <p><strong>后续核对：</strong>{esc(findings.get('recommendation', ''))}</p>
          {json_details('样例的逐段定位、原页截图出处及完整记录快照', case)}</article>''')
    candidate_cases_section = ('<section id="case-review"><h2>少量真实候选的 AI 工程样例核验</h2><p>有目的选择的样例，不具统计代表性，不是医生金标。只核验可定位文本、显式数值和分类边界；全部医学适用与收录判断仍待人工复核。不据此计算准确率或召回率。</p>' +
        report.link('docs/acceptance/s4/evidence-validation/real-candidate-cases.json', '查看 real-candidate-cases.json') + ''.join(case_sections) + '</section>') if case_sections else ''
    semantic_sections = []
    for case in data.get('semantic_audit_development_cases', {}).get('cases', []):
        binding = case.get('source_binding', {})
        reviews = [review for review in data['semantic_audit_recorded_reviews'] if review.get('detail', {}).get('case_id') == case.get('case_id') and
                   all(review.get('detail', {}).get('source_binding', {}).get(key) == binding.get(key) for key in ['document_id', 'file_sha256', 'source_version', 'text_version'])]
        rows = [[esc(review['model_id']), esc(label(review['strategy'])), '历史' if review['historical_attempt'] else '当前',
                 esc(review['timestamp']), esc(review['detail'].get('conclusion')), esc(review['detail'].get('reason')), '未经批准',
                 json_details('源引用、实际读取和关联版本记录', review)] for review in reviews]
        status = '已记录模型判断，未经批准' if reviews else 'not_run：尚无匹配来源版本的实际复核事件'
        semantic_sections.append(f'<article class="candidate"><h4>{esc(case.get("case_id"))}</h4><p>{badge(status,"warn")} {badge("not_gold=true / medical_approval=false")}</p>' +
            f'<p>{esc(case.get("question"))}</p><p class="muted">候选ID只作定位线索；按PDF SHA、source_version、text_version与源块匹配跨运行问题。此处不预填应保留或排除的医学结论，也不把模型判断冒充已经纠正。</p>' +
            (table(['模型','策略','尝试','记录时间','模型未批准判断','理由','批准状态','实际证据'], rows) if rows else '<p>未运行不填“完成”。后续是否实际修改候选，需另核候选版本与事件。</p>') +
            json_details('中立问题、精确源片段与必要上下文', case) + '</article>')
    semantic_section = '<section id="semantic-audit"><h2>中立开发复核问题与实际执行记录</h2><p>这些问题不是金标或医学参考答案。仅已实际保存且来源版本匹配的 semantic_audit_review 事件可标为已记录判断；其余保持 not_run。</p>' + ''.join(semantic_sections) + '</section>' if semantic_sections else ''
    limitations = ''.join(f'<li>{esc(item)}</li>' for item in data['limits'])
    pricing_note = f'计价假设（{data["pricing_assumptions"].get("currency", "币种未知")}）：{json.dumps(data["pricing_assumptions"], ensure_ascii=False)}' if data['pricing_assumptions'] else '未提供已核验模型单价；标价估算为 unknown。供应商实报 token 可核对，实际账单始终 unknown。'
    css = '''*{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#172b3a;font:15px/1.65 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}main{max-width:1480px;margin:auto;padding:34px 30px 80px}h1{font-size:34px;line-height:1.25;margin:10px 0}h2{margin-top:42px;border-bottom:2px solid #d8e1e8;padding-bottom:9px}h3{font-size:20px}h4{font-size:17px}a{color:#0c638c;text-decoration:none}a:hover{text-decoration:underline}header{background:#132f42;color:#fff;padding:36px 30px}header>div{max-width:1420px;margin:auto}header p{color:#d5e3ec}.muted,small{color:#60717e}.notice{background:#fff2d5;border-left:5px solid #cf8b1d;padding:15px 20px;margin:20px 0}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}.stat{background:white;border:1px solid #dce3e9;padding:16px;border-radius:8px}.stat span{display:block;color:#526977}.stat strong{display:block;font-size:22px;margin-top:8px}.controls{display:flex;flex-wrap:wrap;gap:20px;padding:18px;background:#e6eef3;border-radius:8px}.controls label{display:flex;flex-direction:column;font-size:13px;gap:5px}.controls input{min-width:330px}input,select{font:inherit;border:1px solid #b8c7d0;border-radius:5px;padding:8px;background:white}.table-wrap{overflow:auto;max-height:700px;background:white;margin:12px 0}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:9px 12px;border:1px solid #e0e6eb;text-align:left;vertical-align:top}th{background:#e9f0f4;position:sticky;top:0;z-index:1;white-space:nowrap}td{min-width:65px}tr:target,.candidate:target,details:target{background:#fff5cf;outline:2px solid #d29c30}.badge{display:inline-block;font-size:12px;border-radius:4px;background:#e7edf2;color:#344f61;padding:2px 8px;margin:2px}.badge.warn{background:#fff0cd;color:#77520e}.run-panel{border:1px solid #d6e0e7;background:#fff;padding:20px;margin:25px 0;border-radius:8px}.candidate{background:#f8fafc;border:1px solid #d5e2ea;border-left:4px solid #3b819f;border-radius:6px;padding:18px;margin:16px 0}.candidate h4{margin-top:0}.segment p{font-size:12px;color:#5a6c7a;overflow-wrap:anywhere}blockquote{background:#fff;border-left:3px solid #95b9ca;margin:10px 0;padding:12px 16px;white-space:pre-wrap;overflow-wrap:anywhere}.checks{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.checks>div{background:#eaf0f5;padding:12px;border-radius:5px}.checks p{margin:5px 0;overflow-wrap:anywhere}details{margin:10px 0;border:1px solid #dce5eb;border-radius:5px;padding:10px;background:#fff}summary{cursor:pointer;font-weight:600;color:#38566a;overflow-wrap:anywhere}pre{font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f6f9;padding:14px;max-height:520px;overflow:auto}code{overflow-wrap:anywhere}.error{background:#fff0ec;color:#873327;padding:12px}.summary{white-space:pre-wrap}.source-text{white-space:pre-wrap;min-width:350px}nav{margin-top:14px;display:flex;flex-wrap:wrap;gap:18px}nav a{color:#dbeaf3}li{margin:8px 0}footer{margin-top:35px;color:#637988}section[hidden],tr[hidden]{display:none}@media(max-width:700px){main{padding:20px 12px}header{padding:24px 12px}h1{font-size:27px}.checks{grid-template-columns:1fr}.controls input{min-width:230px}.run-panel{padding:12px}}@media print{.controls{display:none}details{break-inside:avoid}.table-wrap{max-height:none}body{background:white}}'''
    javascript = '''const model=document.getElementById('model-filter'),strategy=document.getElementById('strategy-filter'),search=document.getElementById('search-filter');function filter(){for(const el of document.querySelectorAll('.run-panel,.matrix-row'))el.hidden=!!((model.value&&el.dataset.model!==model.value)||(strategy.value&&el.dataset.strategy!==strategy.value)||(search.value&&!el.textContent.toLowerCase().includes(search.value.toLowerCase())))}for(const el of [model,strategy,search])el.addEventListener('input',filter);function reveal(){const id=decodeURIComponent(location.hash.slice(1));if(!id)return;const target=document.getElementById(id);if(!target)return;for(let p=target;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;target.scrollIntoView({block:'center'})}addEventListener('hashchange',reveal);reveal();'''
    return f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>T1 · S4 抽取工程实证报告</title><style>{css}</style></head><body>
    <header><div><p>T1 / S4 · 真实运行与证据阅览</p><h1>按范围抽取与语境核验：工程实证</h1><p>快照 {esc(data['generated_at'])} · {esc(data['batch_id'])}</p><nav><a href="#overview">运行矩阵</a><a href="#cost">请求与费用口径</a><a href="#runs">候选与版本</a><a href="#sources">原始块</a><a href="#engineering">工程验证</a></nav></div></header><main>
    <div class="notice"><strong>当前结论：工程开发 / 医学质量待核，S4 未正式通过。</strong> 无人工全文金标，precision / recall = not_evaluable。全部候选、自动检查和模型复核均未经医学或人工批准；不按候选数量选择模型。S5 产品界面尚未启动。</div>
    <div class="stats">{cards}</div><section id="overview"><h2>计划矩阵、实际运行与历史尝试</h2><p>计划条件与实际论文运行分别计数；模型请求包括兼容探针及全部失败，不能当作论文运行次数。矩阵顺序保留原计划；失败历史与新尝试并列，不挑选最好一次。筛选仅改变下方运行和候选的显示，顶部与费用统计仍为全部请求。</p><div class="controls">{controls}</div>{matrix_table}</section>
    <section id="cost"><h2>供应商实报、缺 usage 预留与实际账单</h2><p><strong>实报输入 {totals['provider_reported_input_tokens']:,} / 输出 {totals['provider_reported_output_tokens']:,}</strong>；
    usage 未知 {totals['unknown_usage_requests']} 个请求，单独预留输入 {totals['unknown_usage_reserved_input_tokens']:,} / 输出 {totals['unknown_usage_reserved_output_tokens']:,}。
    预留不是已消费 token 或供应商强制上限，不能直接相加称“实际消耗”。缓存/推理已经包含于输入/输出，不重复计入。</p>
    <p>{esc(pricing_note)} 预留标价情景也不代表账单或保证的费用上限。供应商实报高于本地 payload 估算的原因未知。</p>{render_usage(data)}
    <p>实验总墙钟初始归档上限：{number((data['ledger_limits'] or {}).get('seconds'))} 秒；当前有效上限：<strong>{number(data['ledger_effective_experiment_seconds'])} 秒</strong>，
    均从同一最初实验开始时间计。后续授权调整逐条保留；每篇/每批上限以各次运行归档条件为准，不用初始900秒或8响应覆盖新运行。</p>
    {json_details('授权限制、历史调整、停止原因、时延口径与总量拆分', {'initial_limits': data['ledger_limits'], 'wall_clock_adjustments': data['ledger_wall_clock_adjustments'], 'effective_experiment_seconds': data['ledger_effective_experiment_seconds'], 'halted': data['ledger_halted'], 'usage': totals, 'timing': data['timing']})}
    <details><summary>逐请求账本：兼容探针、所有失败与当前尝试（{len(data['requests'])} 请求）</summary>{table(['模型','策略','证据类别','usage 状态','HTTP','实报输入','实报输出','未知输入预留','未知输出预留','请求秒数','错误','完整记账'], request_rows)}</details></section>
    <section id="runs"><h2>每次运行的覆盖、原文候选与版本</h2>{''.join(run_sections)}</section>
    <section id="sources"><h2>原始 PDF 文本行块（唯一引用权威）</h2><p>Docling 的加工结构和表/图关联是未核提示。这里完整保存各源 IR 的行块，段落引用按码点定位；原 PDF 未改写。物理页链接由本地 PDF 阅读器支持，行框信息用于人工对照。</p>{''.join(source_sections) or '<p>尚无可读取的来源 IR。</p>'}</section>
    {candidate_cases_section}
    {semantic_section}
    <section id="engineering"><h2>合成 / loopback 工程证据单列</h2><p>真实 API 合成兼容探针也计费，但不构成论文抽取质量证据；本机 loopback 与合成单测只说明工具、状态与边界行为。</p>
    <p>各轮测试按其源码版本留证。原完整 144 项属于 compact 协议改动前；后续只记录受影响运行层及纯函数补测，不将原 144 项冒充新版全量验收，也不重复累计其子集。</p>{engineering}{json_details('真实 API 合成兼容探针（不得作为论文金标）', data['compatibility'])}</section>
    <section><h2>本报告的边界</h2><ul>{limitations}</ul>{json_details('报告读取提示', data['read_warnings'])}{json_details('输入文件 SHA256 快照', data['source_file_sha256'])}</section>
    <footer>本页为静态工程证据快照。更新命令：<code>python3 scripts/render-s4-report.py</code>（从 code/ 执行）。
    <a href="report-data.json">完整 report-data.json</a>。实际账单 unknown；正式模型待共同决定。</footer></main><script>{javascript}</script></body></html>'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--code-root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--output-dir', type=Path, default=Path('docs/acceptance/s4'))
    parser.add_argument('--pricing-file', type=Path, help='Optional independently verified pricing assumptions; never an actual bill.')
    args = parser.parse_args()
    root = args.code_root.resolve()
    output = args.output_dir if args.output_dir.is_absolute() else root / args.output_dir
    if not output.resolve().is_relative_to(root):
        parser.error('report output must remain under code/')
    report = Report(root, output)
    data = collect(report, args.pricing_file)
    page = render(report, data)
    output.mkdir(parents=True, exist_ok=True)
    for filename, content in [('report-data.json', json.dumps(data, ensure_ascii=False, indent=2) + '\n'), ('index.html', page)]:
        temporary = output / (filename + '.tmp')
        temporary.write_text(content, encoding='utf-8')
        temporary.replace(output / filename)
    validation = validate_snapshot(page, data, output)
    (output / 'report-validation.json').write_text(json.dumps(validation, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'html': str(output / 'index.html'), 'data': str(output / 'report-data.json'),
                      **data['execution_counts'], 'requests': len(data['requests']),
                      'current_real_paid_candidates': sum(len(run['records']) for run in data['runs'] if not run['historical'] and run['evidence_class'] == 'real_paid_paper_run'),
                      'read_warnings': len(report.warnings), 'render_validation_passed': validation['passed'], 'stage_passed': False}, ensure_ascii=False))


if __name__ == '__main__':
    main()
