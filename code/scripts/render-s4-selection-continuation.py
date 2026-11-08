"""Render the continuation and joint budget without changing any extraction input."""
import argparse
import csv
import datetime as dt
import hashlib
import html
import importlib.util
import json
import os
from collections import Counter
from pathlib import Path

CODE = Path(__file__).resolve().parents[1]
BASE = CODE / 'docs/acceptance/s4/selection-optimization'
OUT = BASE / 'continuation-2026-11-03'
spec = importlib.util.spec_from_file_location('s4_literal_audit_helpers', CODE / 'scripts/render-s4-selection-report.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
helpers.OUT = OUT
read, write, digest = helpers.read, helpers.write, helpers.digest

def freeze_continuation_outputs(registry):
    """Freeze every failed and selected attempt, not just the chosen representative."""
    physical=[job for job in registry['jobs'] if job['independent_model_run']]
    if any(job['status']=='running' or not job.get('result_path') for job in physical):
        raise ValueError('All unique conditions and necessary attempts must be terminal before reading AI reference contents')
    artifacts={}
    for job in physical:
        for attempt in job.get('attempts') or [job]:
            if attempt.get('status')=='running' or not attempt.get('result_path'):
                raise ValueError('Attempt still active')
            for path in sorted(Path(attempt['directory']).rglob('*.json')):
                artifacts[str(path.relative_to(CODE))]=digest(path)
    for cohort in registry.get('pilot_cohorts',[]):
        pilot_path=CODE/cohort['registry_path']
        if digest(pilot_path)!=cohort['registry_sha256']:
            raise ValueError('Archived pilot register changed')
        pilot=read(pilot_path)
        artifacts[str(pilot_path.relative_to(CODE))]=digest(pilot_path)
        ledger_path=CODE/cohort['ledger_at_end_path']
        artifacts[str(ledger_path.relative_to(CODE))]=digest(ledger_path)
        for job in pilot['jobs']:
            if job['independent_model_run'] and job.get('directory'):
                for path in sorted(Path(job['directory']).rglob('*.json')):
                    artifacts[str(path.relative_to(CODE))]=digest(path)
    for path in sorted((OUT/'selection-masks').glob('*.json')):
        artifacts[str(path.relative_to(CODE))]=digest(path)
    for path in [OUT/'experiment-register.json',Path(registry['runtime_directory'])/'call-ledger.json']:
        artifacts[str(path.relative_to(CODE))]=digest(path)
    value={'schema_version':'s4-selection-outputs-freeze-1','source_snapshot':registry['source_snapshot']['digest'],
        'all_failed_and_selected_attempt_artifacts_included':True,'archived_pilot_artifacts_included':True,
        'artifacts':artifacts,'AI_reference_contents_not_used_before_this_freeze':True}
    path=OUT/'outputs-freeze.json'
    if path.exists() and read(path)!=value:
        raise ValueError('Previously frozen output artifact changed')
    if not path.exists():write(path,value)
    return value

helpers.freeze_outputs=freeze_continuation_outputs

def interval_overlap(a, b):
    return a['block_id']==b['block_id'] and a['text_version']==b['text_version'] and max(a['start'],b['start'])<min(a['end'],b['end'])

def terminal_current_versions_for_literal_comparison(registry,results):
    """Compare persisted current candidates, never a union of their history/proposals."""
    filtered,rows={},[]
    job_by_id={job['job_id']:job for job in registry['jobs']}
    for job_id,result in results.items():
        latest={}
        for version in result['versions']:
            if version.get('status')=='proposed':continue
            key=version['record']['record_id']
            if key not in latest or version['version']>latest[key]['version']:latest[key]=version
        current=result['records']
        if len({version['record']['record_id'] for version in current})!=len(current):
            raise ValueError('Duplicate record IDs in terminal current-version snapshot')
        if {version['record']['record_id']:version for version in current}!=latest:
            raise ValueError('Terminal current candidates differ from latest non-proposed persisted versions')
        eligible=[version for version in current if version.get('status')=='active' and version['record']['review_status']!='rejected'
            and version['record']['evidence_validation']['quote_located'] is True]
        eligible_keys={(version['record']['record_id'],version['version']) for version in eligible}
        filtered[job_id]={**result,'records':eligible}
        rows.append({'job_id':job_id,'original_result_path':job_by_id[job_id]['result_path'],
            'original_result_sha256':digest(job_by_id[job_id]['result_path']),
            'eligible_current_versions':[{'record_id':version['record']['record_id'],'version':version['version'],
                'status':version.get('status'),'review_status':version['record']['review_status']} for version in eligible],
            'history_proposals_and_ineligible_current_audit_only':[{'record_id':version['record']['record_id'],'version':version['version'],
                'status':version.get('status'),'actor':version['actor'],'review_status':version['record']['review_status'],
                'reason':('proposed_not_effective' if version.get('status')=='proposed' else
                    'superseded_version' if latest[version['record']['record_id']]['version']!=version['version'] else 'ineligible_current_version'),
                'eligible_for_main_quote_union':False} for version in result['versions']
                if (version['record']['record_id'],version['version']) not in eligible_keys]})
    contract={'schema_version':'s4-terminal-current-version-literal-contract-1','target_cohort_id':registry['cohort_id'],
        'qualification':['terminal result.records equals latest persisted non-proposed version per record_id',
            'version.status is exactly active','record.review_status is not rejected','record.evidence_validation.quote_located is true'],
        'pending_and_needs_context_remain_unapproved_candidates_not_medically_correct_findings':True,
        'history_superseded_and_proposed_never_extend_main_quote_or_context_interval_union':True,
        'duplicate_or_conflict_links_do_not_create_extra_independent_medical_discoveries':True,
        'same_interval_repetition_does_not_add_interval_union_coverage':True,'rows':rows}
    write(OUT/'posthoc-comparison-contract.json',contract)
    return filtered,contract

def add_posthoc_evidence_layers(posthoc, results):
    """Only runs after helpers.posthoc has frozen every actual model output."""
    summaries={}
    for row in posthoc['comparisons']:
        result=results.get(row['job_id'],{})
        condition_complete=bool(result.get('coverage',{}).get('selected_source_block_processing_complete') and result.get('coverage',{}).get('whole_document_summary_complete'))
        row['engineering_selected_input_and_summary_complete']=condition_complete
        row['literal_overlap_is_not_condition_completion_or_medical_quality']=True
        records=[version['record'] for version in result.get('records',[])]
        contextual=[{'quote_span':{'segments':record['context']['fragments']}} for record in records]
        readback=set(result.get('coverage',{}).get('summary_reread_source_block_ids',[]))
        for unit in row['units']:
            segments=unit['unique_source_segments']
            reliable=unit['reliable_unique_location'] and bool(segments)
            primary_full=unit['output_literal_source_intervals_covered'] if reliable else None
            context_full=all(helpers.covered(segment,contextual) for segment in segments) if reliable else None
            unit['evidence_layers']={
                'initial_selected_input_retains_all_anchored_lines':unit['all_required_blocks_retained'] if reliable else None,
                'primary_quote_exact_source_interval_union_covers_all':primary_full,
                'one_primary_record_covers_all_segments':[record['record_id'] for record in records if reliable and all(helpers.covered(segment,[record]) for segment in segments)],
                'primary_quote_interval_overlapping_record_ids':[record['record_id'] for record in records if any(interval_overlap(a,b) for a in segments for b in record['quote_span']['segments'])],
                'context_exact_source_interval_union_covers_all':context_full,
                'context_only_without_full_primary_quote':context_full and not primary_full if reliable else None,
                'all_anchored_lines_explicitly_reread_in_summary':all(segment['block_id'] in readback for segment in segments) if reliable else None,
                'same_block_overlap_is_location_hint_only_not_extracted_description':True,
                'context_or_readback_is_not_primary_feature_extraction':True,
                'semantic_or_medical_correctness_established':False}
        eligible=row['row_fully_located_for_literal_comparison']
        row['three_layer_row_review']={
            'initial_input_retains_all_units':all(u['evidence_layers']['initial_selected_input_retains_all_anchored_lines'] for u in row['units']) if eligible else None,
            'primary_quote_intervals_cover_all_units':all(u['evidence_layers']['primary_quote_exact_source_interval_union_covers_all'] for u in row['units']) if eligible else None,
            'all_units_in_context_but_not_fully_in_primary_quotes':all(u['evidence_layers']['context_exact_source_interval_union_covers_all'] for u in row['units']) and not all(u['evidence_layers']['primary_quote_exact_source_interval_union_covers_all'] for u in row['units']) if eligible else None,
            'not_a_claim_that_the_reference_description_was_medically_extracted':True}
        summary=summaries.setdefault(row['job_id'],{'reliably_located_rows':0,'unresolved_rows':0,'initial_input_retains_all_units_rows':0,
            'primary_quote_interval_union_covers_all_units_rows':0,'context_without_full_primary_quote_rows':0,
            'engineering_selected_input_and_summary_complete':condition_complete})
        if not eligible:
            summary['unresolved_rows']+=1
        else:
            summary['reliably_located_rows']+=1
            summary['initial_input_retains_all_units_rows']+=int(row['three_layer_row_review']['initial_input_retains_all_units'])
            summary['primary_quote_interval_union_covers_all_units_rows']+=int(row['three_layer_row_review']['primary_quote_intervals_cover_all_units'])
            summary['context_without_full_primary_quote_rows']+=int(row['three_layer_row_review']['all_units_in_context_but_not_fully_in_primary_quotes'])
    posthoc['evidence_layer_policy']='initial input retention;primary quote exact intervals;context/readback exposure are separate;block overlap is not extraction'
    posthoc['partial_outputs_do_not_make_incomplete_conditions_complete']=True
    posthoc['three_layer_summaries']=summaries
    write(OUT/'posthoc-ai-reference-review.json',posthoc)
    write(OUT/'posthoc-source-layer-summary.json',{'schema_version':'s4-posthoc-source-layer-summary-1','not_medical_precision_recall_or_f1':True,'rows':summaries})
    anchors=read(CODE/'evaluation/reference-drafts/2026-11-03-l01-l05/source-anchor-index.json')
    write(OUT/'posthoc-unresolved-reference-rows.json',{'schema_version':'s4-posthoc-unresolved-reference-rows-1',
        'not_medical_errors_or_forced_recall_denominator':True,'ambiguous_positions_not_resolved_by_first_match':True,
        'records':[row for row in anchors['records'] if not row['literal_coverage']['row_eligible_for_fully_located_literal_comparison']]})
    return posthoc

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--compare-reference', action='store_true')
    args = parser.parse_args()
    registry = read(OUT / 'experiment-register.json')
    runtime = Path(registry['runtime_directory'])
    carry = registry['budget_carry_forward']
    old_ledger = read(carry['prior_ledger_path'])
    if digest(carry['prior_ledger_path']) != carry['prior_ledger_sha256']:
        raise ValueError('Original halted ledger was changed')
    ledger = read(runtime / 'call-ledger.json') if (runtime / 'call-ledger.json').exists() else {'requests': []}
    new = helpers.accounting(ledger['requests'])
    cohort_id=registry.get('cohort_id','pilot1')
    target_requests=[entry for entry in ledger['requests'] if (':'+cohort_id+':') in entry['purpose']] if registry.get('cohort_id') else ledger['requests']
    target_accounting=helpers.accounting(target_requests)
    pilot_accounting=[]
    for cohort in registry.get('pilot_cohorts',[]):
        pilot=read(CODE/cohort['registry_path'])
        pilot_ledger=read(CODE/cohort['ledger_at_end_path'])
        pilot_accounting.append({'cohort_id':cohort['cohort_id'],'excluded_from_main_comparison':True,
            'accounting':helpers.accounting(pilot_ledger['requests']),
            'conditions':[{k:job.get(k) for k in ['job_id','status','result_path','candidate_count','accounting','total_seconds']} for job in pilot['jobs'] if job['independent_model_run']]})
    original = helpers.accounting(old_ledger['requests'])
    joint = {'requests': carry['prior_combined_requests'] + new['requests'],
        'prior_inference_requests': 28, 'prior_metadata_requests_no_inference_tokens': 1, 'continuation_inference_requests': new['requests'],
        'provider_input_tokens_including_cache': original['provider_input_tokens_including_cache'] + new['provider_input_tokens_including_cache'],
        'provider_output_tokens_including_reasoning': original['provider_output_tokens_including_reasoning'] + new['provider_output_tokens_including_reasoning'],
        'provider_cache_read_tokens_included_in_input':original['provider_cache_read_tokens_included_in_input']+new['provider_cache_read_tokens_included_in_input'],
        'provider_cache_write_tokens_included_in_input':original['provider_cache_write_tokens_included_in_input']+new['provider_cache_write_tokens_included_in_input'],
        'provider_reasoning_tokens_included_in_output':original['provider_reasoning_tokens_included_in_output']+new['provider_reasoning_tokens_included_in_output'],
        'unknown_input_reservation': original['unknown_input_reservation'] + new['unknown_input_reservation'],
        'unknown_output_reservation': original['unknown_output_reservation'] + new['unknown_output_reservation'],
        'unknown_usage_requests': original['unknown_usage_requests'] + new['unknown_usage_requests'],
        'conservative_input_tokens': carry['prior_conservative_input_tokens'] + new['provider_input_tokens_including_cache'] + new['unknown_input_reservation'],
        'conservative_output_tokens': carry['prior_conservative_output_tokens'] + new['provider_output_tokens_including_reasoning'] + new['unknown_output_reservation'],
        'remaining_requests': 300-carry['prior_combined_requests']-new['requests'],
        'joint_hard_caps': carry['joint_authorized_caps'], 'old_unknown_reservation_retained': True}
    joint['remaining_input_tokens']=6000000-joint['conservative_input_tokens']
    joint['remaining_output_tokens']=400000-joint['conservative_output_tokens']
    rows, results, audit, candidates, recovery_evidence = [], {}, [], [], []
    docs = {s['document_id']: read(s['source_IR_path'])['document'] for s in registry['sources']}
    for job in registry['jobs']:
        selection = read(OUT / 'selection-masks' / (job['job_id'] + '.json'))
        result = read(job['result_path']) if job.get('result_path') and Path(job['result_path']).exists() else {}
        if result:
            results[job['job_id']] = result
        coverage = result.get('coverage', {})
        context_reads, batch_reads = set(), set()
        for event in result.get('events', []):
            if event['type'] == 'batch':
                detail = event['detail']
                batch_reads.update(detail.get('read_block_ids', []))
                context_reads.update(set(detail.get('context_block_ids', [])) & set(detail.get('read_block_ids', [])))
        if result and job['independent_model_run']:
            request_packet=read(Path(job['directory'])/'request-accounting.json')
            document_requests=request_packet['requests']
            failed_attempt_ids=set()
            for path in list(Path(job['directory']).glob('batch-*-attempt-*.json'))+list(Path(job['directory']).glob('whole-document-summary-attempt-*.json')):
                attempt=read(path)
                if attempt.get('result',{}).get('error'):
                    failed_attempt_ids.update(entry['id'] for entry in attempt.get('request_accounting',[]))
            phases={
                'batch_extraction_including_retries':helpers.accounting([entry for entry in document_requests if entry['purpose'].rsplit(':',1)[-1].startswith('batch-')]),
                'summary_including_readback_and_retries':helpers.accounting([entry for entry in document_requests if entry['purpose'].rsplit(':',1)[-1]=='whole-document-summary']),
                'failed_attempt_requests_overlay':helpers.accounting([entry for entry in document_requests if entry['id'] in failed_attempt_ids]),
                'retry_attempt_requests_overlay':helpers.accounting([entry for entry in document_requests if entry['attempt']>0]),
                'recovery_overlays_are_already_in_stage_totals_do_not_add_again':True,
                'readback_only_tokens_not_separately_identifiable_from_whole_request_usage':True}
            batch_attempts=[{'batch_id':event['detail'].get('batch_id'),'attempt':event['detail'].get('attempt'),
                'status':event['detail'].get('status'),'candidate_count_so_far':event['detail'].get('candidate_count_so_far'),
                'read_source_blocks':len(event['detail'].get('read_block_ids',[])),
                'explicit_completion_received':event['detail'].get('explicit_completion_received'),
                'error':event['detail'].get('result',{}).get('error')} for event in result['events'] if event['type']=='batch']
            recovery_evidence.append({'job_id':job['job_id'],'cohort_id':cohort_id,'batch_attempts':batch_attempts,
                'summary_attempts':result.get('summary_attempts',[]),'final_active_candidates':result['candidate_count'],
                'immutable_candidate_versions':result['candidate_versions'],
                'reconciliation_action_counts':dict(Counter(event['detail'].get('action','unknown') for event in result['events'] if event['type']=='reconciliation')),
                'actual_context_issue_events':sum(event['type']=='context_issue' for event in result['events']),
                'actual_successful_batch_context_issue_calls':sum(call.get('name')=='report_context_issue' and call.get('status')=='ok'
                    for event in result['events'] if event['type']=='batch' for call in event['detail'].get('tool_calls',[])),
                'issue_binding_branch_validation_scope':'local fixtures verify authorization;real call counts describe exercised branches only',
                'phase_accounting':phases,
                'failed_attempt_candidates_remain_in_version_history':True,
                'active_human_versions_in_actual_run':sum(version['actor']=='human' for version in result['records']),
                'human_revision_protection_tested_locally_not_medical_approval':True})
        all_reads = batch_reads | set(coverage.get('summary_reread_source_block_ids', []))
        source_chars = sum(e['code_points'] for e in selection['entries'])
        rows.append({'job_id': job['job_id'], 'document_id': job['document_id'], 'status': job['status'],
            'independent_measurement': job['independent_model_run'], 'reused_from': job.get('representative_job_id'),
            'result_path': job.get('result_path'), 'accounting': job.get('accounting') if job['independent_model_run'] else None,
            'selected_attempt_id':job.get('selected_attempt_id','initial' if result and job['status']=='selected_input_finished_quality_pending' else None),
            'selected_attempt_policy':job.get('selected_attempt_policy','initial_attempt'),
            'all_attempts_accounting':job.get('all_attempts_accounting'), 'failed_attempts_accounting':job.get('failed_attempts_accounting'),
            'attempts':job.get('attempts',[]),
            'phase_accounting':phases if result and job['independent_model_run'] else None,
            'total_seconds': job.get('total_seconds'), 'candidate_count': result.get('candidate_count'), 'coverage': coverage or None,
            'whole_document_summary_complete':coverage.get('whole_document_summary_complete') if result else None,
            'summary_attempt_errors':[{'attempt':attempt['attempt'],'error':attempt['error']} for attempt in result.get('summary_attempts',[]) if attempt.get('error')],
            'all_source_blocks': len(selection['entries']), 'selected_blocks': len(selection['kept_block_ids']), 'selection_counts': selection['counts'],
            'logical_selection_counts_are_not_separate_alias_execution_measurements': True,
            'actually_read_selected_blocks': len(all_reads & set(selection['kept_block_ids'])) if result else None,
            'actually_read_context_blocks': len(context_reads) if result else None,
            'unselected_readback_blocks': len(all_reads-set(selection['kept_block_ids'])) if result else None,
            'source_characters': source_chars, 'selected_characters': selection['code_points']['kept'],
            'input_character_reduction_percent': (source_chars-selection['code_points']['kept'])/source_chars*100,
            'error': result.get('error')})
        doc = docs[job['document_id']]
        for entry in selection['entries']:
            block = doc['blocks'][entry['document_line_index']]
            if block['block_id'] != entry['block_id'] or hashlib.sha256(block['text'].encode()).hexdigest() != entry['text_sha256']:
                raise ValueError('Source block identity changed')
            audit.append({'job_id': job['job_id'], **entry, 'exact_original_source_line': block['text']})
        for version in result.get('records', []):
            record = version['record']
            candidates.append({'job_id': job['job_id'], 'reused_from': job.get('representative_job_id'), 'record_id': record['record_id'],
                'version': version['version'], 'feature_name_raw': record['feature_name_raw'], 'feature_category': record['feature_category'],
                'review_status': record['review_status'], 'evidence_type': record['evidence_type'], 'quote_segments': record['quote_span']['segments'],
                'context_fragments': record['context']['fragments'], 'original_record': record, 'medical_approval': False})
    posthoc=None
    if args.compare_reference:
        freeze_continuation_outputs(registry)
        comparison_results,comparison_contract=terminal_current_versions_for_literal_comparison(registry,results)
        posthoc=add_posthoc_evidence_layers(helpers.posthoc(registry,comparison_results),comparison_results)
        posthoc['current_version_qualification_contract']='posthoc-comparison-contract.json'
        write(OUT/'posthoc-ai-reference-review.json',posthoc)
    source_preservation = [{'document_id': s['document_id'], 'original_sha_matches': digest(CODE / s['original_pdf_path']) == s['original_pdf_sha256'],
        'source_IR_sha_matches': digest(s['source_IR_path']) == s['source_IR_sha256']} for s in registry['sources']]
    physical = [j for j in registry['jobs'] if j['independent_model_run']]
    drift=read(OUT/'concurrent-package-script-drift.json') if (OUT/'concurrent-package-script-drift.json').exists() else None
    observations=[]
    for document_id in ['L01','L05']:
        baseline=next(row for row in rows if row['job_id']==document_id+'-B0')
        for row in rows:
            if row['document_id']!=document_id or not row['independent_measurement'] or row['job_id'].endswith('-B0'):
                continue
            complete=all(value['status']=='selected_input_finished_quality_pending' for value in [baseline,row])
            ba,va=baseline['accounting'] or {},row['accounting'] or {}
            observations.append({'job_id':row['job_id'],'baseline_job_id':baseline['job_id'],'both_engineering_complete':complete,
                'initial_source_character_reduction_percent':row['input_character_reduction_percent'],
                'baseline_provider_input_tokens_including_cache':ba.get('provider_reported_input_tokens'),
                'variant_provider_input_tokens_including_cache':va.get('provider_reported_input_tokens'),
                'provider_known_input_ratio_to_baseline':va['provider_reported_input_tokens']/ba['provider_reported_input_tokens'] if complete and ba.get('provider_reported_input_tokens') else None,
                'baseline_unknown_input_reservation':ba.get('missing_usage_input_reservation'),
                'variant_unknown_input_reservation':va.get('missing_usage_input_reservation'),
                'single_observation_not_causal_or_medical_quality_ranking':True})
    report = {'schema_version': 's4-selection-continuation-report-1', 'created_at': dt.datetime.now(dt.timezone.utc).isoformat(),
        'stage': 'S4', 'stage_passed': False, 'medical_quality_approved': False, 'S5_started': False,
        'formal_review_count': {'used': read(BASE.parent/'review-index.json')['formal_astra_reviews_used'], 'limit': 3,
            'final_reserved':read(BASE.parent/'review-index.json')['formal_astra_reviews_used']<3}, 'requested_model_id': 'gpt-6-luna', 'model_id': 'gpt-6-luna', 'reasoning_effort': 'medium',
        'supplier_alias_confirmation': read(OUT / 'supplier-alias-confirmation.json'),
        'alias_operational_basis': 'user_relayed_supplier_statement_exact_mapping;not_independent_agent_contact_or_weight_verification',
        'target_cohort_id':cohort_id,'target_source_snapshot':registry['source_snapshot'],
        'host_batch_protocol':registry['common_model_view'].get('host_batch_protocol','s4-unified-batch-lines-6'),
        'medical_instruction_and_tool_schema_controls':registry.get('reliability_controls'),
        'response_name_distribution': dict(Counter(r.get('provider_response_model', 'not_yet_reported') for r in target_requests)),
        'response_name_distribution_scope':'first explicit raw name per physical target request;all event names remain in observations',
        'response_identity_status_distribution': dict(Counter(r.get('response_model_identity_status', 'unknown') for r in target_requests)),
        'planned_logical_conditions': 8, 'unique_source_input_conditions': 5, 'actual_main_paper_runs': sum(bool(j.get('result_path')) for j in physical),
        'actual_document_attempts':sum(len(j.get('attempts',[])) or int(bool(j.get('result_path'))) for j in physical),
        'started_target_article_attempts':sum(bool(job.get('run_id')) for job in physical),
        'archived_pilot_article_attempts':sum(len(cohort['conditions']) for cohort in pilot_accounting),
        'precontinuation_interrupted_article_attempts':1,
        'all_current_experiment_article_attempts_including_pilots_and_interrupt':1+sum(len(cohort['conditions']) for cohort in pilot_accounting)+sum(bool(job.get('run_id')) for job in physical),
        'article_attempt_count_scope':'reliability target plus necessary pilot retries and historical interruption;synthetic probe separate;not extra logical strategy conditions',
        'complete_selected_input_chains': sum(j['status'] == 'selected_input_finished_quality_pending' for j in physical),
        'comparison_completed': all(j['status'] == 'selected_input_finished_quality_pending' for j in physical),
        'equivalent_condition_reuse_is_not_independent_retest': True, 'equivalence_scope_and_limitations': read(BASE / 'identity-equivalence-limitation.json'),
        'execution_concurrency_limit': 2, 'actual_concurrency_timeline': registry['actual_concurrency_timeline'],
        'latency_scope': 'single concurrent environment observation;queueing/provider latency/resources/randomness_not_isolated',
        'continuation_accounting': new,'continuation_accounting_scope':'entire continuation ledger including archived pilot and target',
        'target_cohort_accounting':target_accounting,'pilot_cohort_accounting':pilot_accounting,
        'joint_accounting': joint, 'prior133_historical_requests_independently_preserved': 133,
        'historical_plus_current_joint_physical_requests': 133+joint['requests'],
        'all_new_requests_including_probe_failure_retry': new,
        'effective_operational_limits': {'continuation_seconds':10800,'paper_document_seconds':1800,'batch_max_responses':16,'request_seconds':120,
            'original7200second_window_unchanged':True,'new_local_window_does_not_expand_user_call_or_token_budget':True},
        'source_preservation': source_preservation, 'old_halted_ledger_sha_matches': True,
        'current_workspace_frozen_manifest_drift':drift,
        'current_workspace_equals_entire_paid_snapshot':False if drift else None,
        'actual_bill': None, 'billing_status':'unknown_gateway_invoice',
        'public_price_scenario_rmb_for_joint_known_usage_only': round(joint['provider_input_tokens_including_cache']/1e6*.63+joint['provider_output_tokens_including_reasoning']/1e6*3.15,6),
        'public_price_scenario_scope':'0.63/3.15 RMB per million;known usage only;cache-specific invoice rates and all unknown usage absent;not actual fee',
        'rows':rows,'AI_reference_posthoc_review':'posthoc-ai-reference-review.json' if posthoc else None,
        'cost_observations':observations,
        'pathology_real_paper_feature_extraction_medically_validated':False,'no_claim_of_best_medical_strategy_or_default_replacement':True}
    write(OUT / 'report.json', report)
    write(OUT/'recovery-evidence.json',{'schema_version':'s4-actual-recovery-version-evidence-1','rows':recovery_evidence,
        'counts_describe_engineering_not_medical_deduplication_quality':True})
    write(OUT / 'candidates-with-original-evidence.json', {'schema_version':'s4-original-evidence-candidate-audit-1','rows':candidates})
    with (OUT/'source-selection-audit.csv').open('w',newline='',encoding='utf-8-sig') as stream:
        writer=csv.DictWriter(stream,fieldnames=list(audit[0]));writer.writeheader()
        writer.writerows({k:json.dumps(v,ensure_ascii=False) if isinstance(v,(list,dict)) else v for k,v in row.items()} for row in audit)
    requests=[]
    for entry in ledger['requests']:
        seconds=(dt.datetime.fromisoformat(entry['finished_at'].replace('Z','+00:00'))-dt.datetime.fromisoformat(entry['started_at'].replace('Z','+00:00'))).total_seconds() if entry.get('finished_at') else None
        requests.append({**entry,'request_cohort':cohort_id if entry in target_requests else 'pilot1',
            'observed_request_seconds':seconds,'single_environment_observation_not_causal_filter_effect':True})
    write(OUT/'per-request-accounting.json',{'schema_version':'s4-selection-physical-request-audit-1','requests':requests})
    e=lambda value:html.escape(str(value))
    parts=['<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>S4文本选择继续执行</title>',
        '<style>body{font:15px/1.6 system-ui;max-width:1550px;margin:28px auto;padding:0 18px;color:#17212b}table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #ccd5dd;padding:7px;text-align:left;vertical-align:top}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f8;padding:12px}a{color:#1454a3}.notice{background:#fff4d8;padding:14px}details{margin:10px 0}</style>',
        '<h1>S4文本选择开发对照</h1><p class="notice">医学质量待复核，S4未验收，S5未启动。请求固定gpt-6-luna / medium；igpt-6-luna仅依用户转述厂商的同模型部署地区说明作为精确响应别名，原值保留，不做通配去前缀。</p>',
        '<p>共同目标协议已完成所选块与汇总 '+e(report['complete_selected_input_chains'])+'/5 个真实条件。联合API '+e(joint['requests'])+'/300；已知输入/输出 '+e(joint['provider_input_tokens_including_cache'])+' / '+e(joint['provider_output_tokens_including_reasoning'])+' tokens，未知预留另为 '+e(joint['unknown_input_reservation'])+' / '+e(joint['unknown_output_reservation'])+'。结果是工程探索，暂不足以替换默认B0或选出医学质量最佳方案。</p>',
        '<p>旧29次API与279503输入/22617输出保守已用全部携带，新账本只使用剩余271/5720497/377383。旧28条推理及1次GET、旧unknown预留、旧中断13候选和原7200秒窗口不改。另设最多10800秒本地保护窗口，未增加用户预算。5个新运行均从头开始。</p>',
        '<p>计划8逻辑条件、5唯一源mask。3个别名条件仅复用F同一次产物，未独立测试；源mask/任务契约等价不等于完整请求逐字相同，run_id仍含任务标签。所有真实条件采用同样最大并发2的调度规则、独立session与原子共享预算。耗时含资源共享/队列/供应商随机因素，不能全归因于筛选；当前默认B0保持。</p>',
        '<p>首轮pilot1仅1/5条件工程完整，全部结果保留为故障证据，排除本主比较。统一修复版reliability-v2-main在同账本/起点重新运行全部5条件；仅修复诊断工具行号绑定与SSE缺终态有界恢复，医学指令、范围、筛选、28字段合同与timeout保持。下表只列共同新协议版本，旧轮失败与完整F均不跨版本择优。当前实验实际论文启动共 '+e(report['all_current_experiment_article_attempts_including_pilots_and_interrupt'])+' 次（早期中断1＋pilot1的5＋当前目标已启动'+e(report['started_target_article_attempts'])+'），不隐藏必要复测开销，合成probe另列。</p>',
        '<table><thead><tr><th>条件</th><th>实际执行</th><th>当前attempt请求</th><th>已知输入/输出</th><th>其中缓存读取/推理</th><th>未知保留输入/输出</th><th>秒</th><th>候选</th><th>原块/派发/已读选中/已读上下文/显式完成</th><th>未派发补读</th><th>deferred/excluded</th><th>原文码点</th></tr></thead><tbody>']
    for row in rows:
        a=row['accounting'] or {};c=row['coverage'] or {}
        status=row['status'] if row['independent_measurement'] else ('复用'+str(row['reused_from'])+'，未独立测试' if row['result_path'] else '等待F代表运行，未独立测试')
        values=[row['job_id'],status,a.get('requests','—'),f"{a.get('provider_reported_input_tokens','—')} / {a.get('provider_reported_output_tokens_including_reasoning','—')}",
            f"{a.get('provider_reported_cache_read_tokens_included_in_input','—')} / {a.get('provider_reported_reasoning_tokens_included_in_output','—')}",
            f"{a.get('missing_usage_input_reservation','—')} / {a.get('missing_usage_output_reservation','—')}",round(row['total_seconds'],3) if row['total_seconds'] is not None else '—',row['candidate_count'],
            f"{row['all_source_blocks']} / {row['selected_blocks']} / {row['actually_read_selected_blocks']} / {row['actually_read_context_blocks']} / {c.get('explicitly_completed_source_blocks','进行中/待运行')}",
            row['unselected_readback_blocks'],
            f"{row['selection_counts']['deferred']} / {row['selection_counts']['excluded']}",f"{row['source_characters']}→{row['selected_characters']}（-{row['input_character_reduction_percent']:.2f}%）"]
        parts.append('<tr>'+''.join('<td>'+e(v)+'</td>' for v in values)+'</tr>')
    parts += ['</tbody></table><p>字符按Unicode码点计，不等于最终LLM输入tokens或延迟收益；pilot1的L01-F曾把65个未派发源块全部在汇总读回，不能据初筛缩减宣称总LLM输入缩减。本主cohort补读按上表实际统计。输出含推理、输入含缓存且不重复相加。读回不自动成为显式完成，更不能宣称医学全文召回通过。仅同目标协议版本内首次工程完整attempt可作有效baseline，不按候选质量或速度择优。</p>',
        '<h2>初筛与实际输入成本</h2><table><thead><tr><th>条件对B0</th><th>初筛原文码点减少</th><th>已知输入tokens（B0 → 条件）</th><th>已知输入比</th><th>未知输入预留（B0 / 条件）</th></tr></thead><tbody>']
    for observation in observations:
        ratio=observation['provider_known_input_ratio_to_baseline']
        values=[observation['job_id'],f"{observation['initial_source_character_reduction_percent']:.2f}%",
            f"{observation['baseline_provider_input_tokens_including_cache']} → {observation['variant_provider_input_tokens_including_cache']}",
            f"{ratio:.3f}倍" if ratio is not None else '尚未共同完成',
            f"{observation['baseline_unknown_input_reservation']} / {observation['variant_unknown_input_reservation']}"]
        parts.append('<tr>'+''.join('<td>'+e(value)+'</td>' for value in values)+'</tr>')
    parts += ['</tbody></table><p>已知usage包含整个抽取与汇总（含补读/恢复）；未知usage只列保守上限，不能当作实际消耗。单次并发运行及模型随机性未隔离，不能将差异全部归因于筛选。候选条数与版本/粒度只作描述，AI草稿不构成医学质量排序。</p>',
        '<h2>联合账本</h2><pre>'+e(json.dumps(joint,ensure_ascii=False,indent=2))+'</pre>',
        '<h2>逐项可审核产物</h2><ul><li><a href="experiment-register.json">登记与实际并发时间线</a> / <a href="supplier-alias-confirmation.json">用户转述厂商确认</a> / <a href="budget-carry-forward.json">额度/窗口继承</a></li>',
        '<li><a href="report.json">结构化报告</a> / <a href="per-request-accounting.json">每次请求原始名称、用量与延迟</a> / <a href="source-selection-audit.csv">逐块保留/排除、理由与原文</a></li>',
        '<li><a href="../report.html">原29次API停止交接（历史）</a>：当时模型名称阻塞依据已由后续用户转述厂商精确说明解除，原halted账本与13条中断候选不改写。</li>',
        '<li><a href="candidates-with-original-evidence.json">主cohort候选及原始分段定位</a> / <a href="recovery-evidence.json">实际失败前后候选、版本与重复关联处理</a> / <a href="offline-validation-reliability-v2.json">当前154项抽取/类型检查（恢复6为子集）</a> / <a href="reliability-v2-control-manifest.json">医学指令/范围合同不变证明</a> / <a href="reliability-v2-tool-schema-control.json">工具schema协议变更</a></li>',
        '<li>原PDF：'+ ' / '.join('<a href="'+e(os.path.relpath(CODE/source['original_pdf_path'],OUT))+'">'+e(source['document_id'])+'</a>' for source in registry['sources'])+'；<a href="../tool-evaluation.json">第三方资料与本轮取舍（未集成外部重包）</a></li></ul>',
        '<p>显式图/表号关联仅生成离线待核链接：<a href="selection-masks/L01-explicit-links-offline.json">L01</a> / <a href="selection-masks/L05-explicit-links-offline.json">L05</a>。分别检查病例、病灶、模态、成像条件与面板冲突，缺身份条件保留为待核；不凭同篇合并断言，不进入主实验，也不将其收益混算为筛选效果。</p>',
        '<h2>pilot1故障与全部开销（不入主比较）</h2><pre>'+e(json.dumps(pilot_accounting,ensure_ascii=False,indent=2))+'</pre><p><a href="pilot1/experiment-register.json">原轮冻结登记</a> / <a href="stream-terminal-error-diagnosis.json">缺SSE终态诊断</a> / <a href="local-missing-terminal-reproduction.json">零外部调用的本地复现</a>。旧失败、unknown与完整F全部保留，不把可靠性修复冒称筛选医学效果提升。</p>']
    if any(row['failed_attempts_accounting'] for row in rows):
        parts+=['<h2>必要复测与失败开销</h2><pre>'+e(json.dumps([{'job_id':row['job_id'],'selected_attempt_id':row['selected_attempt_id'],
            'policy':row['selected_attempt_policy'],'all_attempts_accounting':row['all_attempts_accounting'],
            'failed_attempts_accounting':row['failed_attempts_accounting'],'attempts':[{k:a.get(k) for k in ['attempt_id','run_id','status','result_path','result_sha256','accounting','total_seconds']} for a in row['attempts']]} for row in rows if row['attempts']],ensure_ascii=False,indent=2))+'</pre><p>原失败响应SSE缺终态，不能称120秒超时；缺usage继续按保守预留记账，失败产物不覆盖。</p>']
    if posthoc:
        parts+=['<h2>AI草稿字面来源复核</h2><p>56条草稿来自其它AI，未作人工医学金标；19行全部独立单元可唯一定位、37行定位未决。分开记录初始输入保留、主引文精确区间覆盖、仅上下文或补读曝光。主比较只使用终态当前有效active、非rejected且原文已定位的候选版本，历史/被替代/proposed版本仅审计，不用其并集补覆盖。重复/冲突链接不当成额外独立医学发现。只同block不算已抽取，上下文/补读也不算主引文证据；不证明同一医学断言，不计算医学precision/recall/F1，AI未列的候选不记假阳性。</p><p><a href="outputs-freeze.json">全部输出冻结</a> / <a href="posthoc-comparison-contract.json">当前版本资格与历史/提议单列契约</a> / <a href="posthoc-ai-reference-review.json">逐条三层来源与待复核分歧</a> / <a href="posthoc-source-layer-summary.json">19已定位/37未决的字面来源统计</a> / <a href="posthoc-unresolved-reference-rows.json">37行定位未决独立清单（不计医学错误）</a></p>']
        parts+=['<table><thead><tr><th>条件</th><th>测量归属</th><th>可靠定位/未决行</th><th>输入保留全部单元</th><th>主quote精确区间并集覆盖全部单元</th><th>仅上下文覆盖全部单元</th></tr></thead><tbody>']
        row_by_id={row['job_id']:row for row in rows}
        for job_id,summary in posthoc['three_layer_summaries'].items():
            job=row_by_id[job_id]
            values=[job_id,'独立真实运行' if job['independent_measurement'] else '复用'+str(job['reused_from'])+'，未独立测试',
                f"{summary['reliably_located_rows']} / {summary['unresolved_rows']}",summary['initial_input_retains_all_units_rows'],
                summary['primary_quote_interval_union_covers_all_units_rows'],summary['context_without_full_primary_quote_rows']]
            parts.append('<tr>'+''.join('<td>'+e(value)+'</td>' for value in values)+'</tr>')
        parts+=['</tbody></table><p>L01的12条可靠定位行中，B0主引文字面覆盖3条，F为9条；L05的7条可靠定位行中三次真实运行均为4条。所有可靠定位参考行的初筛输入锚点都保留。L01的F同时有更高总输入成本、全部未派发块被补读；L05这一字面指标相同。只能说明当前源区间覆盖差异，不能由此推断医学召回、语义正确率或全局最优；默认B0保持，进一步选择需可靠人工医学复核。</p>']
    if recovery_evidence:
        parts+=['<h2>批抽取、汇总含补读与恢复开销</h2><table><thead><tr><th>条件</th><th>阶段</th><th>请求</th><th>已知输入/输出</th><th>缓存读/写（已含输入）</th><th>推理（已含输出）</th><th>未知预留输入/输出</th></tr></thead><tbody>']
        phase_names={'batch_extraction_including_retries':'批抽取（含恢复）','summary_including_readback_and_retries':'汇总（含补读/恢复）',
            'failed_attempt_requests_overlay':'其中失败attempt（叠加标记）','retry_attempt_requests_overlay':'其中恢复attempt（叠加标记）'}
        for row in recovery_evidence:
            for key,label in phase_names.items():
                a=row['phase_accounting'][key]
                values=[row['job_id'],label,a['requests'],f"{a['provider_input_tokens_including_cache']} / {a['provider_output_tokens_including_reasoning']}",
                    f"{a['provider_cache_read_tokens_included_in_input']} / {a['provider_cache_write_tokens_included_in_input']}",a['provider_reasoning_tokens_included_in_output'],
                    f"{a['unknown_input_reservation']} / {a['unknown_output_reservation']}"]
                parts.append('<tr>'+''.join('<td>'+e(v)+'</td>' for v in values)+'</tr>')
        parts+=['</tbody></table><details><summary>阶段计数与版本处理原始数据</summary><pre>'+e(json.dumps([{'job_id':row['job_id'],'phases':row['phase_accounting'],
            'final_active_candidates':row['final_active_candidates'],'immutable_versions':row['immutable_candidate_versions'],
            'reconciliation_action_counts':row['reconciliation_action_counts']} for row in recovery_evidence],ensure_ascii=False,indent=2))+'</pre></details><p>批抽取与汇总两阶段可加总；失败attempt和重试是阶段内部叠加标记，不能再加一次。无法从整次请求usage精确分离补读自身tokens。候选/版本/重复关联数量只描述机械处理及粒度变化，不能作为准确性或医学去重质量。</p>']
    if drift:
        parts+=['<h2>并行工作区变更与来源限制</h2><p>最终全源hash一致断言失败：冻结manifest共'+e(drift['frozen_manifest_total_files'])+'项，'+e(drift['matching_current_files'])+'项匹配；package.json在运行期间新增4条web/annotation脚本。依赖/type/exports与lock不变，抽取核心、driver、医学指令/筛选/合同原hash均匹配。同一owner在15:38启动前加载配置和静态模块，本次直接Node调用未调用这4条npm脚本；未发现抽取变量受到影响。全工作区与旧快照逐字一致的说法不成立，新增来源未知，保留原快照和发现时文件，不回滚并行修改。</p><p><a href="concurrent-package-script-drift.json">差异/调用路径/影响范围证据</a> / <a href="concurrent-package-scripts.diff">精确4脚本diff</a> / <a href="real-run-completion.json">owner退出与零在途凭据</a></p>']
    parts += ['<h2>候选原文</h2>']
    for row in candidates:
        if row['reused_from']:continue
        parts.append('<details><summary>'+e(f"{row['job_id']} / {row['feature_name_raw']} / {row['record_id']} / {row['review_status']}")+'</summary>')
        for s in row['quote_segments']:
            parts.append('<p>'+e(f"物理页{s['physical_page']} {s['block_id']} [{s['start']},{s['end']}) {s['text_version']}")+'</p><pre>'+e(s['exact_quote'])+'</pre>')
        parts.append('</details>')
    parts.append('<p>原文、条件与冲突保留。病理细胞/细胞核/组织结构尚无医学验证；工程定位/规则测试不代替医学验收。</p></html>')
    (OUT/'report.html').write_text('\n'.join(parts))
    print(json.dumps({'report':str(OUT/'report.html'),'actual_runs':report['actual_main_paper_runs'],'complete_chains':report['complete_selected_input_chains'],'joint':joint,'posthoc':bool(posthoc)},ensure_ascii=False))

if __name__=='__main__':main()
