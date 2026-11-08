"""Audit the frozen S4 selection experiment; never calls a model or edits source PDFs."""
from __future__ import annotations
import argparse
import csv
import datetime as dt
import hashlib
import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/acceptance/s4/selection-optimization'

def read(path):
    return json.loads(Path(path).read_text())

def write(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def accounting(entries):
    return {
        'requests': len(entries),
        'provider_input_tokens_including_cache': sum(e.get('input_tokens', 0) for e in entries),
        'unknown_input_reservation': sum(e['input_ceiling'] for e in entries if 'input_tokens' not in e),
        'provider_output_tokens_including_reasoning': sum(e.get('output_tokens', 0) for e in entries),
        'provider_cache_read_tokens_included_in_input': sum(e.get('cache_read_tokens', 0) for e in entries),
        'provider_cache_write_tokens_included_in_input': sum(e.get('cache_write_tokens', 0) for e in entries),
        'provider_reasoning_tokens_included_in_output': sum(e.get('reasoning_tokens', 0) for e in entries),
        'unknown_output_reservation': sum(e['output_ceiling'] for e in entries if 'output_tokens' not in e),
        'unknown_usage_requests': sum(e['usage_status'] != 'provider_reported' for e in entries),
        'inflight_requests': sum('finished_at' not in e for e in entries),
    }

def covered(segment, candidates):
    intervals = sorted((s['start'], s['end']) for r in candidates for s in r['quote_span']['segments']
                       if s['block_id'] == segment['block_id'] and s['text_version'] == segment['text_version'])
    end = segment['start']
    for a, b in intervals:
        if a > end:
            break
        if b > end:
            end = b
        if end >= segment['end']:
            return True
    return False

def freeze_outputs(registry):
    physical = [j for j in registry['jobs'] if j['independent_model_run']]
    if any(j['status'] in ('pending', 'running') or not j.get('result_path') for j in physical):
        raise ValueError('All unique model outputs must be terminal and frozen before reading AI reference contents.')
    sources = {str(Path(j['result_path']).relative_to(ROOT)): digest(j['result_path']) for j in physical}
    sources.update({str(p.relative_to(ROOT)): digest(p) for p in sorted((OUT / 'selection-masks').glob('*.json'))})
    value = {'schema_version': 's4-selection-outputs-freeze-1', 'source_snapshot': registry['source_snapshot']['digest'],
             'artifacts': sources, 'AI_reference_contents_not_used_before_this_freeze': True}
    path = OUT / 'outputs-freeze.json'
    if path.exists():
        if read(path) != value:
            raise ValueError('Previously frozen outputs changed; posthoc comparison cannot silently overwrite its input.')
    else:
        write(path, value)
    return value

def posthoc(registry, results):
    frozen = freeze_outputs(registry)
    anchor_path = ROOT / 'evaluation/reference-drafts/2026-11-03-l01-l05/source-anchor-index.json'
    draft_path = ROOT / 'evaluation/reference-drafts/2026-11-03-l01-l05/reference-drafts.json'
    anchors, drafts = read(anchor_path), read(draft_path)
    draft_by_id = {e['reference_id']: e for e in drafts['entries']}
    comparisons = []
    for job in registry['jobs']:
        selection = read(OUT / 'selection-masks' / (job['job_id'] + '.json'))
        kept = set(selection['kept_block_ids'])
        result = results.get(job['job_id'], {})
        records = [r['record'] for r in result.get('records', [])]
        completed = set(result.get('coverage', {}).get('completed_source_block_ids', []))
        for row in anchors['records']:
            if row['document_id'] != job['document_id']:
                continue
            eligible = row['literal_coverage']['row_eligible_for_fully_located_literal_comparison']
            units = []
            for unit in row['units']:
                reliable = unit['usable_for_literal_block_retention']
                segments = [{**segment, 'text_version': segment.get('text_version', row['text_version'])}
                            for segment in unit.get('unique_source_segments', [])]
                sets = unit.get('all_candidate_source_block_id_sets', [])
                units.append({
                    'unit_id': unit.get('unit_id'), 'reliable_unique_location': reliable,
                    'unique_source_segments': segments,
                    'all_required_blocks_retained': all(s['block_id'] in kept for s in segments) if reliable and segments else None,
                    'all_required_blocks_explicitly_completed': all(s['block_id'] in completed for s in segments) if reliable and segments else None,
                    'output_literal_source_intervals_covered': all(covered(s, records) for s in segments) if reliable and segments else None,
                    'source_overlapping_output_record_ids': [r['record_id'] for r in records if any(s['block_id'] == t['block_id'] for s in segments for t in r['quote_span']['segments'])],
                    'ambiguous_all_possible_block_positions_retained': all(all(b in kept for b in group) for group in sets) if sets and not reliable else None,
                    'ambiguity_not_resolved_by_choosing_first': True,
                })
            comparable = eligible and bool(units) and all(u['reliable_unique_location'] for u in units)
            comparisons.append({
                'job_id': job['job_id'], 'reference_id': row['reference_id'], 'document_id': row['document_id'],
                'AI_reference_only_not_gold': True, 'row_fully_located_for_literal_comparison': comparable,
                'all_source_units_in_selected_input': all(u['all_required_blocks_retained'] for u in units) if comparable else None,
                'all_source_units_have_literal_output_interval_coverage': all(u['output_literal_source_intervals_covered'] for u in units) if comparable else None,
                'semantic_equivalence_or_medical_correctness_established': False,
                'units': units, 'original_AI_draft_entry_for_manual_review': draft_by_id.get(row['reference_id']),
            })
    value = {'schema_version': 's4-ai-reference-posthoc-literal-review-1', 'created_at': dt.datetime.now(dt.timezone.utc).isoformat(),
             'outputs_freeze': frozen, 'AI_reference_sha256': digest(draft_path), 'anchor_index_sha256': digest(anchor_path),
             'not_precision_recall_f1_or_medical_scoring': True,
             'unlisted_model_candidates_are_not_false_positives': True,
             'unresolved_locations_are_not_forced_into_a_recall_denominator': True,
             'whole_line_output_overlap_is_not_same_feature_assertion': True,
             'comparisons': comparisons}
    write(OUT / 'posthoc-ai-reference-review.json', value)
    return value

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--compare-reference', action='store_true')
    args = parser.parse_args()
    registry = read(OUT / 'experiment-register.json')
    runtime = Path(registry['runtime_directory'])
    ledger = read(runtime / 'call-ledger.json') if (runtime / 'call-ledger.json').exists() else {'requests': []}
    results, rows, candidate_rows, audit_rows = {}, [], [], []
    docs = {s['document_id']: read(s['source_IR_path'])['document'] for s in registry['sources']}
    for job in registry['jobs']:
        selection = read(OUT / 'selection-masks' / (job['job_id'] + '.json'))
        document = docs[job['document_id']]
        if job.get('result_path') and Path(job['result_path']).exists():
            results[job['job_id']] = read(job['result_path'])
        result = results.get(job['job_id'], {})
        physical_job = next((j for j in registry['jobs'] if j['job_id'] == job.get('representative_job_id')), job)
        base_chars = sum(e['code_points'] for e in selection['entries'])
        selected_chars = selection['code_points']['kept']
        rows.append({'job_id': job['job_id'], 'status': job['status'], 'independent_measurement': job['independent_model_run'],
                     'reused_from': job.get('representative_job_id'), 'selected_blocks': len(selection['kept_block_ids']),
                     'all_source_blocks': len(selection['entries']), 'selection_counts': selection['counts'],
                     'source_characters': base_chars, 'selected_characters': selected_chars,
                     'input_character_reduction_percent': (base_chars - selected_chars) / base_chars * 100,
                     'result_path': job.get('result_path'), 'accounting': job.get('accounting') if job['independent_model_run'] else None,
                     'representative_accounting': physical_job.get('accounting'), 'total_seconds': job.get('total_seconds'),
                     'candidate_count': result.get('candidate_count'), 'coverage': result.get('coverage'), 'error': result.get('error'),
                     'character_reduction_is_not_measured_token_or_latency_reduction': True})
        for entry in selection['entries']:
            b = document['blocks'][entry['document_line_index']]
            if b['block_id'] != entry['block_id'] or hashlib.sha256(b['text'].encode()).hexdigest() != entry['text_sha256']:
                raise ValueError('Selection source text binding changed')
            audit_rows.append({'job_id': job['job_id'], **entry, 'exact_original_source_line': b['text']})
        for version in result.get('records', []):
            record = version['record']
            candidate_rows.append({'job_id': job['job_id'], 'reused_from': job.get('representative_job_id'),
                                   'record_id': record['record_id'], 'version': version['version'], 'review_status': record['review_status'],
                                   'feature_name_raw': record['feature_name_raw'], 'feature_category': record['feature_category'],
                                   'evidence_type': record['evidence_type'], 'quote_segments': record['quote_span']['segments'],
                                   'context_fragments': record['context']['fragments'], 'original_record': record,
                                   'original_source_unchanged': True, 'medical_approval': False})
    posthoc_data = posthoc(registry, results) if args.compare_reference else None
    old_before = read(OUT / 'historical-ledger-preservation-before.json')
    old_path = ROOT / old_before['historical_ledger_path']
    history = {'path': str(old_path), 'before_sha256': old_before['sha256'], 'after_sha256': digest(old_path),
               'unchanged': digest(old_path) == old_before['sha256'], 'historical_requests': len(read(old_path)['requests'])}
    source_checks = [{'document_id': s['document_id'], 'original_sha_matches': digest(ROOT / s['original_pdf_path']) == s['original_pdf_sha256'],
                      'source_IR_sha_matches': digest(s['source_IR_path']) == s['source_IR_sha256']} for s in registry['sources']]
    acct = accounting(ledger['requests'])
    metadata = read(OUT / 'model-catalog-readonly.json') if (OUT / 'model-catalog-readonly.json').exists() else {'physical_http_requests': 0}
    metadata_requests = metadata['physical_http_requests']
    combined_requests = acct['requests'] + metadata_requests
    stopped = registry.get('no_automatic_resume', False)
    report = {'schema_version': 's4-selection-audit-report-1', 'created_at': dt.datetime.now(dt.timezone.utc).isoformat(),
              'stage': 'S4', 'stage_passed': False, 'medical_quality_approved': False, 'S5_started': False,
              'formal_review_count': {'used': 2, 'limit': 3, 'final_reserved': True},
              'planned_logical_conditions': 8, 'unique_source_input_conditions': registry['unique_source_inputs'],
              'actual_main_paper_runs': sum(bool(j.get('result_path')) and j['independent_model_run'] for j in registry['jobs']),
              'complete_main_paper_conditions': sum(j['status'] == 'selected_input_finished_quality_pending' and j['independent_model_run'] for j in registry['jobs']),
              'comparison_completed': False if stopped else all(bool(j.get('result_path')) for j in registry['jobs']),
              'paid_inference_stopped': stopped, 'no_automatic_resume': stopped,
              'requested_model_identity_unverified': stopped,
              'paid_source_snapshot_digest': registry['source_snapshot']['digest'],
              'offline_guard_revision_evidence': 'model-identity-guard/guard-validation-summary.json' if (OUT / 'model-identity-guard/guard-validation-summary.json').exists() else 'pending',
              'equivalent_condition_reuse_is_not_independent_retest': True,
              'equivalence_scope_and_limitations': read(OUT / 'identity-equivalence-limitation.json'),
              'model_id': registry['model_id'], 'reasoning_effort': registry['reasoning_effort'],
              'hard_authorization': read(OUT / 'authorization.json')['shared_hard_caps'],
              'effective_operational_limits': {'global_wall_clock_seconds': 7200, 'per_request_seconds': 120,
                  'paper_document_seconds': 1800, 'paper_batch_max_responses': 16,
                  'probe_document_seconds': 300, 'probe_batch_max_responses': 8,
                  'ledger_document_seconds_900_and_batch_responses_8_are_defaults_overridden_by_explicit_paper_options': True},
              'all_new_requests_including_probe_failure_retry': acct, 'historical_ledger': history,
              'inference_ledger_requests': acct['requests'], 'metadata_http_requests': metadata_requests,
              'combined_authorized_physical_requests_used': combined_requests, 'remaining_authorized_requests': 300 - combined_requests,
              'metadata_GET_has_no_inference_token_usage': True,
              'resume_budget_gate_must_include_metadata_requests': True,
              'historical_plus_new_inference_requests': history['historical_requests'] + acct['requests'],
              'historical_plus_new_physical_requests': history['historical_requests'] + combined_requests,
              'probe_separate_from_main_papers': registry['probe'], 'source_preservation': source_checks,
              'actual_bill': None, 'billing_status': 'unknown_gateway_invoice',
              'public_price_scenario_rmb_for_measured_usage_only': round(acct['provider_input_tokens_including_cache'] / 1e6 * .63 + acct['provider_output_tokens_including_reasoning'] / 1e6 * 3.15, 6),
              'rows': rows, 'AI_reference_posthoc_review': 'posthoc-ai-reference-review.json' if posthoc_data else None,
              'pathology_real_paper_feature_extraction_validated': False,
              'no_claim_of_best_medical_strategy_or_default_replacement': True}
    write(OUT / 'report.json', report)
    request_details = []
    for entry in ledger['requests']:
        seconds = ((dt.datetime.fromisoformat(entry['finished_at'].replace('Z', '+00:00')) - dt.datetime.fromisoformat(entry['started_at'].replace('Z', '+00:00'))).total_seconds()
                   if entry.get('finished_at') else None)
        request_details.append({**entry, 'observed_request_seconds': seconds,
                                'latency_is_single_observation_not_causal_filter_effect': True})
    write(OUT / 'per-request-accounting.json', {'schema_version': 's4-selection-physical-request-audit-1',
                                              'all_attempts_including_probe_failure_retry': True, 'requests': request_details})
    write(OUT / 'candidates-with-original-evidence.json', {'schema_version': 's4-original-evidence-candidate-audit-1', 'rows': candidate_rows})
    with (OUT / 'source-selection-audit.csv').open('w', newline='', encoding='utf-8-sig') as stream:
        fields = list(audit_rows[0])
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows({k: json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v for k, v in row.items()} for row in audit_rows)
    e = lambda value: html.escape(str(value))
    parts = ['<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>S4文本选择开发对照</title>',
             '<style>body{font:16px/1.6 system-ui;max-width:1450px;margin:32px auto;padding:0 18px;color:#17212b}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid #ccd5dd;padding:8px;text-align:left;vertical-align:top}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f8;padding:12px}a{color:#1454a3}small{color:#465463}.pending{background:#fff4cf}</style>',
             '<h1>S4文本选择开发对照</h1><p class="pending">工程开发证据；医学质量待复核，S4未验收，S5未启动。AI参考由其它AI生成，不是人工金标。病理只做规则工程夹具，尚无真实病理抽取验证。</p>',
             '<p>请求指定AGICTO gpt-6-luna / medium、Responses，Docling原始IR、开放范围/提示词/输出契约/核验及批参数固定，主实验关闭关联增强。计划8个逻辑条件、5个唯一源mask；等价复用不能算独立复测。</p>',
             '<table><thead><tr><th>论文/策略</th><th>实际执行</th><th>请求</th><th>已知输入/输出tokens</th><th>其中缓存读取/推理</th><th>未知保留 输入/输出</th><th>耗时秒</th><th>候选</th><th>原块/派发/显式完成/未完成</th><th>选择原文字符变化</th></tr></thead><tbody>']
    for row in rows:
        a = row['accounting'] or {}
        c = row['coverage'] or {}
        actual = row['status'] if row['independent_measurement'] else ('复用 ' + str(row['reused_from']) + ' 运行，未独立测试' if row['result_path'] else '未运行；计划与 ' + str(row['reused_from']) + ' 源mask相同')
        parts.append('<tr>' + ''.join('<td>' + e(v) + '</td>' for v in [row['job_id'], actual, a.get('requests', '—'),
            f"{a.get('provider_reported_input_tokens', '—')} / {a.get('provider_reported_output_tokens_including_reasoning', '—')}",
            f"{a.get('provider_reported_cache_read_tokens_included_in_input', '—')} / {a.get('provider_reported_reasoning_tokens_included_in_output', '—')}",
            f"{a.get('missing_usage_input_reservation', '—')} / {a.get('missing_usage_output_reservation', '—')}",
            round(row['total_seconds'], 3) if row['total_seconds'] is not None else '—', row['candidate_count'],
            f"{row['all_source_blocks']} / {row['selected_blocks']} / {c.get('explicitly_completed_source_blocks', '—')} / {row['all_source_blocks']-c.get('explicitly_completed_source_blocks', 0)}",
            f"{row['source_characters']}→{row['selected_characters']}（-{row['input_character_reduction_percent']:.2f}%）"]) + '</tr>')
    parts += ['</tbody></table><p>输入tokens含缓存；输出tokens含推理且不重复相加。字符数按原文Unicode码点计，减少不等于实测token或延迟收益。耗时仅为本轮并发1的单次顺序运行观测，供应商延迟与模型随机性未独立复测，不能全部归因于筛选。未派发块即使在汇总中读回，也不自动成为已抽取/已完成；所有原文与删除清单保留。</p>',
              '<p>复用仅证明选中源块mask与抽取任务契约相同。既有汇总返回的run_id包含策略任务后缀，不能声称完整模型请求逐字相同，也没有独立测试R/FR或证明标识差异的影响可忽略。<a href="identity-equivalence-limitation.json">完整局限登记</a>。当前默认B0保持。</p>',
              '<h2>共享账本与覆盖</h2><pre>' + e(json.dumps({'inference_ledger': acct, 'metadata_http_requests_no_inference_tokens': metadata_requests, 'combined_new_physical_requests': combined_requests, 'remaining_authorized_requests': 300-combined_requests, 'historical_ledger': history, 'historical_plus_new_requests': report['historical_plus_new_physical_requests'], 'probe': registry['probe'], 'limits': report['effective_operational_limits']}, ensure_ascii=False, indent=2)) + '</pre>',
              '<p>账本300请求/600万输入/40万输出为本轮总硬限，含探测、失败和重试。论文有效限制为单篇1800秒、每会话最多16响应、单请求120秒；账本schema的900秒/8响应字段是被显式论文参数覆盖的默认值。网关实际账单未知，公开单价只作场景估算。</p>',
              '<h2>可审核产物</h2><ul><li><a href="experiment-register.json">逐项实验登记</a> / <a href="authorization.json">用户授权</a> / <a href="tool-evaluation.json">官方工具与Luna资料</a></li>',
              '<li><a href="report.json">结构化报告与用量</a> / <a href="per-request-accounting.json">每次物理请求延迟、provider用量和未知保留</a> / <a href="source-selection-audit.csv">每个原块的选择、理由和完整原文</a></li>',
              '<li><a href="candidates-with-original-evidence.json">全部候选、逐段原文与准确定位</a></li>',
              '<li><a href="runtime-validation/budget-validation-summary.json">旧付费冻结版139项抽取与类型检查证据</a> / <a href="model-identity-guard/guard-validation-summary.json">当前身份防护版144项抽取、5项专项子集与typecheck（未跑真实供应商）</a></li>',
              '<li><a href="plan-sync-preservation.json">DOCX增量与JSON/CSV保全凭据</a></li></ul>']
    if stopped:
        parts.insert(3, '<p class="pending"><strong>付费已停止，完整对照未完成。</strong>28条推理请求中记录26条返回gpt-6-luna、2条返回igpt-6-luna，真实型号/别名尚未核验；不能把现有产物当作经核验Luna实验。L01-B0仅409块完成、13候选保全，汇总中断；其余条件未运行。最后一条usage未知，按121594输入/8192输出保留。另做1次只读GET /models（0推理tokens），总API请求29，剩余271；恢复前总闸必须扣除此GET。禁止自动恢复。</p>')
        parts += ['<h2>中断与模型名称核对</h2><p><a href="model-metadata-verification.json">本地采集链查证与两条原始元数据</a> / <a href="model-catalog-readonly.json">只读模型目录</a> / <a href="supplier-model-identity-support.txt">用户可转发厂商的排查材料</a> / <a href="no-auto-resume.json">禁止自动恢复与剩余额度</a> / <a href="interrupted-recovery.json">13候选与原始DB/WAL恢复凭据</a></p><p>本地代码直接复制SDK解析的response.model，未发现正则加前缀路径；历史只存HTTP正文hash，不能回放原始SSE。GET模型目录只列gpt-6-luna，不证明igpt别名。严格名称不符停机防护属于后续离线新源码，不能把其新测试追认为本次旧付费运行使用的版本。AI草稿具体引用仍未进入提示词、规则或本次输出比较。</p>']
    if posthoc_data:
        parts.append('<h2>AI草稿来源对照</h2><p>仅19行全部独立单元可唯一定位；其余37行定位未决，分开列示。只对照源块保留和输出原文区间重合；整行重合不能证明同一医学断言。AI未列的模型候选不记为假阳性，不计算医学精确率/召回率/F1。</p><p><a href="posthoc-ai-reference-review.json">逐行原文保留、区间重合与待复核分歧</a> / <a href="outputs-freeze.json">读取AI具体条目前的规则/输出冻结证据</a></p>')
    parts.append('<h2>候选原文</h2>')
    for row in candidate_rows:
        if row['reused_from']:
            continue
        parts.append('<details><summary>' + e(f"{row['job_id']} / {row['feature_name_raw']} / {row['record_id']} / {row['review_status']}") + '</summary><p>逐段原文，非连续组合引文；翻译与归纳留在独立字段。</p>')
        for s in row['quote_segments']:
            parts.append('<p><small>' + e(f"物理页{s['physical_page']} {s['block_id']} [{s['start']},{s['end']}) {s['text_version']}") + '</small></p><pre>' + e(s['exact_quote']) + '</pre>')
        parts.append('</details>')
    parts.append('</html>')
    (OUT / 'report.html').write_text('\n'.join(parts))
    print(json.dumps({'report': str(OUT / 'report.html'), 'actual_main_runs': report['actual_main_paper_runs'], 'accounting': acct, 'posthoc': bool(posthoc_data)}, ensure_ascii=False))

if __name__ == '__main__':
    main()
