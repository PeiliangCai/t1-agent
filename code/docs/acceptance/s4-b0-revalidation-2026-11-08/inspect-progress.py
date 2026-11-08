"""One read-only observation; never controls a process, budget or model request."""
import datetime
import hashlib
import json
from pathlib import Path
import sqlite3

BASE = Path(__file__).resolve().parent
CODE = BASE.parents[2]
auth = json.loads((BASE / 'authorization.json').read_text())
owner = CODE / 'runtime-data/s4-budget-owners' / hashlib.sha256(auth['authorization_id'].encode()).hexdigest()
ledger = json.loads((owner / 'call-ledger.json').read_text())
requests = ledger['requests']
now = datetime.datetime.now(datetime.timezone.utc)
first = ledger['experiment_started_at']
deadline = datetime.datetime.fromisoformat(first.replace('Z', '+00:00')) + datetime.timedelta(seconds=auth['limits']['seconds']) if first else None
value = {
    'observed_at': now.isoformat(), 'authorization_id': auth['authorization_id'],
    'first_request_at': first, 'approved_deadline_at': deadline.isoformat() if deadline else None,
    'requests_started': len(requests),
    'known_input_tokens': sum(r.get('input_tokens', 0) for r in requests),
    'known_output_tokens': sum(r.get('output_tokens', 0) for r in requests),
    'input_with_open_or_missing_usage_reservations': sum(r.get('input_tokens', r['input_ceiling']) for r in requests),
    'output_with_open_or_missing_usage_reservations': sum(r.get('output_tokens', r['output_ceiling']) for r in requests),
    'open_or_missing_usage_requests': sum(r['usage_status'] != 'provider_reported' for r in requests),
    'ledger_halted': ledger['halted'], 'last_purpose': requests[-1]['purpose'] if requests else None,
    'last_request_started_at': requests[-1]['started_at'] if requests else None,
    'last_request_finished_at': requests[-1].get('finished_at') if requests else None,
    'last_request_identity_status': requests[-1].get('response_model_identity_status') if requests else None,
}
db = BASE / 'prepared/execution/evidence.sqlite'
connection = sqlite3.connect('file:' + str(db) + '?mode=ro', uri=True)
value['runs'] = [{'id': r[0], 'state': r[1]} for r in connection.execute('SELECT id,state FROM s4_runs')]
value['candidate_id_count_so_far'] = connection.execute('SELECT COUNT(DISTINCT record_id) FROM s4_versions').fetchone()[0]
batches = [json.loads(r[0]) for r in connection.execute('SELECT payload_json FROM s4_batches')]
value['completed_batches'] = sum(b.get('status') == 'completed' for b in batches)
value['failed_batches_so_far'] = sum(b.get('status') == 'failed' for b in batches)
connection.close()
with (BASE / 'progress-observations.jsonl').open('a') as stream:
    stream.write(json.dumps(value, ensure_ascii=False) + '\n')
print(json.dumps(value, ensure_ascii=False))
