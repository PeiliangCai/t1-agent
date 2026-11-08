"""Recover committed diagnostics after the owned runner was terminated; never resume inference."""
import datetime as dt
import hashlib
import json
import shutil
import sqlite3
import tempfile
from collections import Counter
from pathlib import Path

CODE = Path(__file__).resolve().parents[1]
OUT = CODE / 'docs/acceptance/s4/selection-optimization'
register_path = OUT / 'experiment-register.json'
registry = json.loads(register_path.read_text())
terminal = json.loads((OUT / 'model-identity-pause-terminal.json').read_text())
runtime = Path(registry['runtime_directory'])
ledger = json.loads((runtime / 'call-ledger.json').read_text())
if ledger['halted'] != 'model_identity_unverified_manual_stop' or any(not r.get('finished_at') for r in ledger['requests']):
    raise ValueError('Owned runner must be stopped and every attempt terminally accounted before recovery')
for pid in terminal['terminated_owned_pids']:
    if Path(f'/proc/{pid}/cmdline').exists() and b'run-s4-selection.ts' in Path(f'/proc/{pid}/cmdline').read_bytes():
        raise ValueError('Runner is still active')
snap = OUT / 'model-identity-incident/before-termination'
with tempfile.TemporaryDirectory(prefix='s4-recovery-', dir=CODE / 'runtime-data') as temporary:
    working = Path(temporary) / 's4-selection.sqlite'
    for suffix in ['', '-wal']:
        if (snap / ('s4-selection.sqlite' + suffix)).exists():
            shutil.copy2(snap / ('s4-selection.sqlite' + suffix), Path(str(working) + suffix))
    db = sqlite3.connect('file:' + str(working) + '?mode=ro', uri=True)
    run_id = next(j['run_id'] for j in registry['jobs'] if j['job_id'] == 'L01-B0')
    stored = db.execute('SELECT input_json,state,metadata_json FROM s4_runs WHERE id=?', (run_id,)).fetchone()
    input_data, prior_state, metadata = json.loads(stored[0]), stored[1], json.loads(stored[2])
    versions = [json.loads(v[0]) for v in db.execute('SELECT envelope_json FROM s4_versions WHERE run_id=? ORDER BY record_id,version', (run_id,))]
    current = {}
    for version in versions:
        if version['status'] != 'proposed':
            current[version['record']['record_id']] = version
    records = list(current.values())
    events = [json.loads(v[0]) for v in db.execute('SELECT payload_json FROM s4_events WHERE run_id=? ORDER BY seq', (run_id,))]
    batches = [json.loads(v[0]) for v in db.execute('SELECT payload_json FROM s4_batches WHERE run_id=? ORDER BY batch_id', (run_id,))]
    db.close()
selection = json.loads((OUT / 'selection-masks/L01-B0.json').read_text())
source = next(s for s in registry['sources'] if s['document_id'] == 'L01')
document = json.loads(Path(source['source_IR_path']).read_text())['document']
completed = set(b for batch in batches if batch['status'] == 'completed' and batch['explicit_completion_received'] for b in batch['assigned_block_ids'])
read_ids = set(b for batch in batches for b in batch['read_block_ids'])
requests = [r for r in ledger['requests'] if r['purpose'].startswith(run_id + ':')]
accounting = {'requests': len(requests), 'provider_reported_input_tokens': sum(r.get('input_tokens', 0) for r in requests),
    'provider_reported_output_tokens_including_reasoning': sum(r.get('output_tokens', 0) for r in requests),
    'missing_usage_input_reservation': sum(r['input_ceiling'] for r in requests if 'input_tokens' not in r),
    'missing_usage_output_reservation': sum(r['output_ceiling'] for r in requests if 'output_tokens' not in r),
    'provider_reported_cache_read_tokens_included_in_input': sum(r.get('cache_read_tokens', 0) for r in requests),
    'provider_reported_reasoning_tokens_included_in_output': sum(r.get('reasoning_tokens', 0) for r in requests),
    'usage_missing_requests': sum(r['usage_status'] != 'provider_reported' for r in requests)}
job = next(j for j in registry['jobs'] if j['job_id'] == 'L01-B0')
elapsed = (dt.datetime.fromisoformat(terminal['recorded_at']) - dt.datetime.fromisoformat(job['started_at'].replace('Z', '+00:00'))).total_seconds()
coverage = {'physical_pages': len(document['pages']), 'parser_status': document['parser']['status'],
    'all_source_blocks': len(document['blocks']), 'assigned_source_blocks': len(selection['kept_block_ids']),
    'dispatched_source_blocks': len(selection['kept_block_ids']), 'source_blocks_read': len(read_ids),
    'explicitly_completed_source_blocks': len(completed), 'completed_source_block_ids': sorted(completed),
    'selected_source_block_processing_complete': set(selection['kept_block_ids']) <= completed,
    'source_block_processing_complete': set(selection['kept_block_ids']) <= completed,
    'unprocessed_source_block_ids': [e['block_id'] for e in selection['entries'] if e['block_id'] not in completed],
    'failed_source_block_ids': [], 'quarantined_source_block_ids': [], 'deferred_source_block_ids': [],
    'excluded_input_copy_source_block_ids': [], 'summary_reread_source_block_ids': None,
    'summary_reread_status': 'unknown_from_interrupted_in_memory_session_not_inferred',
    'whole_document_summary_complete': False, 'full_document_extraction_completed': False,
    'source_fidelity_human_verified': False, 'medical_recall_proven_by_coverage': False}
result = {'schema_version': 's4-extraction-interrupted-recovery-1', 'run_id': run_id, 'document_id': 'L01',
    'model_id': 'gpt-6-luna', 'reasoning_effort': 'medium', 'source_selection_condition': 'B0', 'state': 'interrupted',
    'prior_committed_database_state': prior_state, 'recovery_only_no_new_inference': True,
    'source_snapshot_digest': registry['source_snapshot']['digest'], 'model_identity_verified': False,
    'provider_response_model_distribution': dict(Counter(r.get('provider_response_model', 'missing') for r in requests)),
    'candidate_count': len(records), 'candidate_versions': len(versions), 'records': records, 'versions': versions,
    'events': events, 'batches': batches, 'coverage': coverage, 'summary': '',
    'total_seconds': elapsed, 'timing_scope': 'interrupted_elapsed_time_including_manual_stop_not_comparable_completed_run_latency',
    'error': {'type': 'InterruptedRecovery', 'code': 'model_identity_unverified_manual_stop'},
    'medical_quality_approved': False, 'human_gold_complete': False, 'formal_model_selected': False,
    'only_diagnostic_data_not_a_verified_Luna_condition': True, 'request_accounting': accounting,
    'actual_cost': None, 'cost_status': 'unknown_gateway_billing', 'metadata': metadata}
target = runtime / 'L01-B0/interrupted-result.json'
if target.exists():
    raise ValueError('Recovery result already exists; do not overwrite the original recovery artifact')
target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
(runtime / 'L01-B0/request-accounting-interrupted.json').write_text(json.dumps({'accounting': accounting, 'requests': requests}, ensure_ascii=False, indent=2) + '\n')
job.update({'status': 'interrupted_model_identity_unverified', 'state': 'interrupted', 'result_path': str(target),
    'recovered_artifact': True, 'independently_measured': True, 'candidate_count': len(records), 'coverage': coverage,
    'total_seconds': elapsed, 'accounting': accounting, 'error': result['error'], 'finished_at': terminal['recorded_at'],
    'only_diagnostic_data_not_a_verified_Luna_condition': True})
for item in registry['jobs']:
    if item is not job:
        item['status'] = 'not_run_model_identity_blocked'
        item['independently_measured'] = False
registry.update({'status': 'paid_stopped_model_identity_unverified', 'full_comparison_completed': False,
    'no_automatic_resume': True, 'further_inference_requires_explicit_user_identity_decision': True,
    'probe_engineering_chain_passed_but_identity_unverified': True,
    'probe': {**registry['probe'], 'original_status_before_identity_discovery': registry['probe']['status'],
              'status': 'engineering_protocol_passed_identity_unverified_not_model_validated', 'identity_verified': False},
    'accounting': {'requests': len(ledger['requests']), 'provider_reported_input_tokens': sum(r.get('input_tokens', 0) for r in ledger['requests']),
                   'provider_reported_output_tokens_including_reasoning': sum(r.get('output_tokens', 0) for r in ledger['requests']),
                   'missing_usage_input_reservation': sum(r['input_ceiling'] for r in ledger['requests'] if 'input_tokens' not in r),
                   'missing_usage_output_reservation': sum(r['output_ceiling'] for r in ledger['requests'] if 'output_tokens' not in r)}})
register_path.write_text(json.dumps(registry, ensure_ascii=False, indent=2) + '\n')
lock = runtime / 'active-owner.lock'
if lock.exists():
    lock.rename(runtime / 'active-owner.terminated.lock')
receipt = {'recorded_at': dt.datetime.now(dt.timezone.utc).isoformat(), 'recovery_result': str(target),
    'recovery_result_sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'candidate_count': len(records),
    'versions': len(versions), 'completed_emitted_source_blocks': len(completed), 'summary_completed': False,
    'source_snapshot': registry['source_snapshot']['digest'], 'original_SQLite_not_rewritten': True,
    'only_working_copy_of_pre_termination_DB_WAL_read': True, 'no_automatic_resume': True,
    'no_paid_inference': True, 'new_source_guard_tests_cannot_relabel_this_old_snapshot': True}
(OUT / 'interrupted-recovery.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(receipt, ensure_ascii=False))
