#!/usr/bin/env python3
"""Prepare a small current engineering review packet without incrementing review counters."""
from pathlib import Path
from datetime import datetime, timezone
import difflib
import hashlib
import json

CODE = Path(__file__).resolve().parents[1]
OUT = CODE / 'docs/acceptance/s4'
BEFORE = OUT / 'before-engineering-start/code'
review = json.loads((OUT / 'review-index.json').read_text())
assert review['formal_astra_reviews_used'] == 2
files = ['package.json', 'packages/contracts/src/index.ts', 'packages/agent/src/index.ts']
diffs = []
for name in files:
    diffs.extend(difflib.unified_diff((BEFORE / name).read_text().splitlines(True), (CODE / name).read_text().splitlines(True),
        fromfile='before-S4/' + name, tofile='current/' + name))
(OUT / 'core-existing-API.diff').write_text(''.join(diffs))
new_core = ['packages/contracts/src/extraction-evidence.ts'] + [f'packages/agent/src/{name}.ts' for name in [
    'article-scope', 'extraction-budget', 'extraction-pi', 'extraction-store', 'extraction-protocol', 'extraction-tools',
    'extraction-summary', 'extraction-run', 'evidence-validation', 'scope-matching', 'reconciliation', 'summary-model-view']]
source_manifest = {name: {'sha256': hashlib.sha256((CODE / name).read_bytes()).hexdigest(),
    'lines': len((CODE / name).read_text().splitlines())} for name in new_core + files}
packet = {'schema_version': 's4-core-review-materials-1', 'prepared_at': datetime.now(timezone.utc).isoformat(),
    'review_state': 'progress_handoff_prepared_no_round_3_requested_user_experiment_scope_pending',
    'formal_reviews_used': 2, 'formal_reviews_limit': 3, 'formal_review_counter_changed': False,
    'current_source_hash_scope': 'current engineering files at preparation time; NEVER attributed to old real model runs',
    'current_source_manifest': source_manifest, 'existing_export_and_script_diff': 'code/docs/acceptance/s4/core-existing-API.diff',
    'interfaces': [
        {'entry': 'runExtractionDocument(options)', 'behavior': 'real Pi source batches -> validated pending 28-field candidates -> SQLite versions/events -> all-candidate single-paper summary; source reading/completion/quarantine and summary completion separate'},
        {'entry': 'ExtractionTools.definitions / invoke', 'behavior': 'closed model batch_lines with host identity; all medical indices use one stable batch line table; trusted full submission entry retained; exact repeated text requires occurrence'},
        {'entry': 'ExtractionSummaryTools.definitions / invoke', 'behavior': 'lossless source-fragment dictionary; whole-document line indices for actually re-read updates; all current versions reviewed_unapproved in independent strategy; neutral cases must be actually read and judged'},
        {'entry': 'packSummaryModelContext / unpackSummaryModelContext', 'behavior': 'pure reversible JSON dictionary; no candidate/fact/context/location truncation; literal marker collisions escaped'},
        {'entry': 'validateEvidenceSubmission / matchEvidenceScope / reconcileEvidence', 'behavior': 'exact source/version/read checks and limited explicit rules; unapproved model semantics remain separate; all-new terms open without catalog; real strict requires approved mapping; manual versions protected'},
        {'entry': 'ExtractionStore', 'behavior': 'new S4-only SQLite tables; short transactions, CAS, candidate/event atomicity, immutable versions, human edits/approval preserved with pending proposals'},
        {'entry': 'ExtractionBudget', 'behavior': 'one shared atomic budget object, all physical attempts counted; unknown usage reserves; cache input/reasoning output counted once; request/doc/global hard stop cancels only owned streams; original start and initial ledger limits retained'}],
    'current_caps': {'physical_requests': 400, 'input_tokens': 2000000, 'output_tokens': 400000,
        'effective_wall_seconds_from_original_start': 14400, 'request_seconds': 120, 'document_seconds': 1800, 'batch_responses': 16,
        'paid_API_waiting_for_user_scope_choice': True},
    'checks': {'prior_current_full_regression': 'code/docs/acceptance/s4/runtime-validation/pre-summary-model-view-and-neutral-case-review/summary.json',
        'prior_full_regression_count': 169, 'prior_full_regression_not_claimed_for_later_summary_changes': True,
        'current_affected_extraction_suite_log': 'code/docs/acceptance/s4/runtime-validation/summary-current-extraction.txt',
        'current_affected_extraction_suite_count': 118, 'current_summary_focused_count_is_subset': 7,
        'current_summary_focused_log': 'code/docs/acceptance/s4/runtime-validation/summary-view-cases-focused-tests.txt',
        'current_typecheck_log': 'code/docs/acceptance/s4/runtime-validation/summary-view-cases-typecheck.txt',
        'current_checks_do_not_rerun_or_stack_prior_other_71_tests': True,
        'dictionary_pure_checks': 'code/docs/acceptance/s4/evidence-validation/summary-model-view-acceptance.json',
        'dictionary_real_source_roundtrip': 'code/docs/acceptance/s4/evidence-validation/summary-model-view-real/measurement.json',
        'current_history_integrity': 'code/docs/acceptance/s4/protected-history-verification.json'},
    'real_evidence': {'readable_report': 'code/docs/acceptance/s4/index.html', 'matrix': 'code/docs/acceptance/s4/matrix-progress.json',
        'completed_same_source_version_conditions': ['job-01 revision-6', 'job-06 revision-2'],
        'source_version_proof': 'each run source-provenance.json references one immutable shared source snapshot',
        'pending_conditions': 12, 'new_dictionary_case_review_not_yet_paid_tested': True,
        'scale_options': 'code/docs/acceptance/s4/experiment-scale-options.json'},
    'material_risks': ['medical gold/catalog and S3 source fidelity remain pending; no formal accuracy or model choice',
        'original parse associations, table cells, cross-column order and candidate eligibility remain uncertain; acquisition-parameter example explicitly neutral audit case',
        'new summary packet has reversible offline evidence, but real supplier throughput/review behavior still unmeasured; remaining matrix exceeds original input reserve'],
    'stage_passed': False, 'medical_quality_approved': False, 'S5_started': False}
(OUT / 'core-review-materials.json').write_text(json.dumps(packet, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'prepared': True, 'formal_review_counter_unchanged': 2, 'current_core_files': len(source_manifest)}))
