#!/usr/bin/env python3
"""Read-only operational projections; never applies or expands any model-call limit."""
from pathlib import Path
from datetime import datetime, timezone, timedelta
import json
import math

CODE = Path(__file__).resolve().parents[1]
OUT = CODE / 'docs/acceptance/s4'
registry = json.loads((OUT / 'experiment-register.json').read_text())
ledger = json.loads((CODE / registry['runtime_directory'] / 'call-ledger.json').read_text())
matrix = json.loads((OUT / 'matrix-progress.json').read_text())
inventory = {d['document_id']: d for d in json.loads((OUT / 'source-inventory/summary.json').read_text())['documents']}
measurement = json.loads((OUT / 'evidence-validation/summary-model-view-real/measurement.json').read_text())
compression = {d['model_id']: d for d in measurement['results']}
pricing = json.loads((OUT / 'pricing-assumptions.json').read_text())
known = [e for e in ledger['requests'] if e['usage_status'] == 'provider_reported']
unknown = [e for e in ledger['requests'] if e['usage_status'] != 'provider_reported']
used_input = sum(e.get('input_tokens', e['input_ceiling']) for e in ledger['requests'])
used_output = sum(e.get('output_tokens', e['output_ceiling']) for e in ledger['requests'])
now = datetime.now(timezone.utc)
effective_seconds = ledger.get('wall_clock_adjustments', [{}])[-1].get('to_seconds', ledger['limits']['seconds'])
deadline = datetime.fromisoformat(ledger['experiment_started_at'].replace('Z', '+00:00')) + timedelta(seconds=effective_seconds)
samples = []
for job in [matrix['jobs'][0], matrix['jobs'][5]]:
    result = json.loads((CODE / job['directory'] / 'result.json').read_text())
    assert result['coverage']['source_block_processing_complete'] and result['coverage']['whole_document_summary_complete']
    entries = [e for e in ledger['requests'] if e['purpose'].startswith(job['run_id'] + ':')]
    assert all(e['usage_status'] == 'provider_reported' for e in entries)
    summary_input = sum(e['input_tokens'] for e in entries if e['purpose'].endswith(':whole-document-summary'))
    sample = {'job_id': job['job_id'], 'run_id': job['run_id'], 'model_id': job['model_id'],
        'result_path': job['directory'] + '/result.json', 'assigned_blocks': result['coverage']['assigned_source_blocks'],
        'requests': len(entries), 'input_tokens': sum(e['input_tokens'] for e in entries), 'output_tokens': sum(e['output_tokens'] for e in entries),
        'summary_input_tokens': summary_input, 'seconds': result['total_seconds'], 'candidates': result['candidate_count'],
        'medical_quality_approved': False}
    sample['flat_price_scenario_CNY'] = (sample['input_tokens'] * pricing['models'][job['model_id']]['input'] +
        sample['output_tokens'] * pricing['models'][job['model_id']]['output']) / 1000000
    samples.append(sample)
projections = []
for sample in samples:
    pending = [j for j in matrix['jobs'] if j['status'] == 'pending' and j['model_id'] == sample['model_id']]
    blocks = sum(inventory[j['document_id']]['assigned_blocks'] for j in pending)
    factor = blocks / sample['assigned_blocks']
    old_input = sample['input_tokens'] * factor
    # This is deliberately labelled a byte-ratio thought experiment, not measured provider-token savings.
    ratio = compression[sample['model_id']]['packet_to_legacy_ratio']
    byte_ratio_input_scenario = ((sample['input_tokens'] - sample['summary_input_tokens']) + sample['summary_input_tokens'] * ratio) * factor
    output = sample['output_tokens'] * factor
    prices = pricing['models'][sample['model_id']]
    projections.append({'model_id': sample['model_id'], 'pending_job_ids': [j['job_id'] for j in pending],
        'pending_assigned_blocks': blocks, 'L01_block_multiplier': factor,
        'old_protocol_requests_linear': len([e for e in ledger['requests'] if e['purpose'].startswith(sample['run_id'] + ':')]) * factor,
        'old_protocol_input_linear': old_input, 'old_protocol_output_linear': output,
        'old_protocol_serial_seconds_linear': sample['seconds'] * factor,
        'byte_ratio_input_scenario_not_measured_tokens': byte_ratio_input_scenario,
        'old_protocol_flat_price_scenario_CNY': (old_input * prices['input'] + output * prices['output']) / 1000000,
        'byte_ratio_flat_price_scenario_CNY': (byte_ratio_input_scenario * prices['input'] + output * prices['output']) / 1000000})
totals = {key: sum(p[key] for p in projections) for key in ['old_protocol_requests_linear', 'old_protocol_input_linear',
    'old_protocol_output_linear', 'old_protocol_serial_seconds_linear', 'byte_ratio_input_scenario_not_measured_tokens',
    'old_protocol_flat_price_scenario_CNY', 'byte_ratio_flat_price_scenario_CNY']}
report = {'schema_version': 's4-scale-options-1', 'created_at': now.isoformat(), 'decision_status': 'proposals_not_executed',
    'new_paid_calls': 0, 'limits_changed_by_this_script': False,
    'accounting': {'requests_used': len(ledger['requests']), 'measured_input': sum(e['input_tokens'] for e in known),
        'unknown_input_reservation': sum(e['input_ceiling'] for e in unknown), 'measured_output': sum(e['output_tokens'] for e in known),
        'unknown_output_reservation': sum(e['output_ceiling'] for e in unknown), 'unknown_attempts': len(unknown),
        'remaining_requests': ledger['limits']['requests'] - len(ledger['requests']), 'remaining_input': ledger['limits']['input_tokens'] - used_input,
        'remaining_output': ledger['limits']['output_tokens'] - used_output, 'effective_deadline': deadline.isoformat(),
        'remaining_wall_clock_minutes_at_report': max(0, (deadline - now).total_seconds() / 60)},
    'complete_same_version_L01_samples': samples,
    'offline_model_view_evidence': 'code/docs/acceptance/s4/evidence-validation/summary-model-view-real/measurement.json',
    'offline_byte_reduction_is_not_measured_token_cost_or_latency_reduction': True,
    'option_A': {'scope': 'one complete L01 independent_context_review condition, preferentially job-13 Astra, within the unchanged existing call/token caps',
        'why_Astra_for_bounded_engineering_test': 'lower observed L01 input and wall time in this development pair, not a medical quality preference',
        'estimated_additional_requests_range': [18, 28], 'estimated_additional_input_range': [200000, 330000],
        'estimated_additional_output_range': [10000, 25000], 'estimated_wall_minutes_range': [10, 25],
        'flat_price_scenario_CNY_range': [15.75, 28.665], 'new_caps_requested': False,
        'stop_policy': 'existing atomic reservations and 30-minute per-document / 16-response per-batch bounds; save partial if limits prevent completion',
        'expected_deliverable_if_completed': '3 of 14 conditions; all L01 source blocks plus every current candidate reviewed_unapproved and both neutral cases actually read and judged; 11 conditions remain pending',
        'complete_run_guaranteed': False},
    'option_B': {'scope': 'execute all original 14 conditions; 12 remain pending at this report', 'model_ids_and_medium_unchanged': True,
        'remaining_original_blocks_including_quarantine': sum(inventory[j['document_id']]['original_source_blocks'] for j in matrix['jobs'] if j['status'] == 'pending'),
        'remaining_assigned_blocks': sum(p['pending_assigned_blocks'] for p in projections),
        'per_model_reference_projection': projections, 'reference_totals': totals,
        'minimum_total_caps_implied_by_old_L01_linear_reference_without_safety_margin': {
            'requests': len(ledger['requests']) + math.ceil(totals['old_protocol_requests_linear']),
            'input_tokens': used_input + math.ceil(totals['old_protocol_input_linear']),
            'output_tokens': used_output + math.ceil(totals['old_protocol_output_linear'])},
        'buffered_operational_cap_proposal_not_authorized': {'requests_total_all_attempts': 700, 'input_tokens_total_including_cache': 10000000,
            'output_tokens_total_including_reasoning': 600000, 'experiment_seconds_from_original_start': 18000,
            'document_seconds_maximum': 3600, 'batch_responses': 16, 'request_seconds': 120, 'transient_retries': 2, 'concurrency': 2},
        'time_reference': {'serial_minutes': totals['old_protocol_serial_seconds_linear'] / 60,
            'ideal_two_worker_minutes_without_overlap_losses': totals['old_protocol_serial_seconds_linear'] / 120,
            'long_Sol_MED03_minutes_from_block_linear_reference': samples[0]['seconds'] / 60 * inventory['MED03']['assigned_blocks'] / 409,
            'long_Sol_L07_minutes_from_block_linear_reference': samples[0]['seconds'] / 60 * inventory['L07']['assigned_blocks'] / 409},
        'uncertainty': ['only one small exposed Chinese paper per model; article and format differences may dominate',
            'new dictionary and independent review/case checks have not yet been measured through the real supplier',
            'byte ratio is not a verified token ratio; additional reviews and retries are excluded from linear reference',
            'upper caps allow bounded attempts, never guarantee full extraction or medical accuracy'],
        'approval_required_before_applying_proposed_call_scale': True},
    'stop_now_boundary': {'completed_engineering_conditions': 2, 'pending_matrix_job_ids': [j['job_id'] for j in matrix['jobs'] if j['status'] == 'pending'],
        'unfinished_R09': 'remaining model/strategy and article comparisons; formal model selection',
        'unfinished_R10': 'real independent semantic review and neutral-case verification; medical gold-based validation',
        'unfinished_R11': 'real independent-review findings/updates not yet observed; human medical approval remains pending',
        'unfinished_R12': 'other four papers and broad scope/generalization trials, full manual gold, independent acceptance and numeric thresholds',
        'stage_passed': False, 'S5_started': False},
    'pricing': {'source': pricing['source_url'], 'verified_date': pricing['verified_date'], 'currency': pricing['currency'],
        'assumption_file': 'code/docs/acceptance/s4/pricing-assumptions.json', 'missing_usage_excluded_from_price_estimates': True,
        'cache_and_account_discount_applicability': 'unknown', 'actual_cost': None, 'actual_bill': 'unknown'}}
(OUT / 'experiment-scale-options.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'A_input_estimate': report['option_A']['estimated_additional_input_range'], 'B_reference_extra_input': math.ceil(totals['old_protocol_input_linear']),
    'B_byte_ratio_input_scenario': math.ceil(totals['byte_ratio_input_scenario_not_measured_tokens']),
    'B_extra_flat_price_CNY_scenarios': [totals['byte_ratio_flat_price_scenario_CNY'], totals['old_protocol_flat_price_scenario_CNY']],
    'no_limits_changed': True}))
