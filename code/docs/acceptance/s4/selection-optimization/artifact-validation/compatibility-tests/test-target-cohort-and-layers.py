#!/usr/bin/env python3
"""Offline regression fixtures for the changed cohort and interval contracts.

Uses synthetic records only; no model requests, reference workbook or live run
artifacts are read. The target checker is imported without bytecode writes.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
CODE = HERE.parents[5]
CHECKER = CODE / "scripts/check-s4-selection-artifacts.py"
spec = importlib.util.spec_from_file_location("s4_artifact_checker", CHECKER)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


def segment(start, end, version="text-v1"):
    return {"block_id": "same-block", "text_version": version,
            "start": start, "end": end, "exact_quote": "synthetic"}


class TargetContractTests(unittest.TestCase):
    def test_complete_pilot_is_excluded_from_main_attempt_selection(self):
        audit = checker.ContinuationAudit(HERE, "final", False, "completed-experiment")
        audit.target_cohort = "reliability-v2-main"
        batch = "synthetic-batch"
        pilot_job = {"job_id": "L01-F", "independent_model_run": True,
                     "run_id": batch + ":L01-F", "result_path": "pilot-result.json",
                     "status": "selected_input_finished_quality_pending"}
        target_job = {"job_id": "L01-F", "independent_model_run": True,
                      "run_id": batch + ":reliability-v2-main:L01-F",
                      "result_path": "target-result.json", "status": "engineering_incomplete"}
        alias = {"job_id": "L01-R", "independent_model_run": False,
                 "run_id": target_job["run_id"], "result_path": target_job["result_path"]}
        audit.pilot_registers = {"pilot1": {"batch_id": batch, "jobs": [pilot_job],
                                           "source_snapshot": {"digest": "pilot-revision"}}}
        audit.register = {"batch_id": batch, "jobs": [target_job, alias],
                          "source_snapshot": {"digest": "target-revision"}}
        audit.build_attempt_catalog()
        self.assertEqual(len(audit.attempt_catalog), 2)
        self.assertEqual(len(audit.attempts_by_job["L01-F"]), 1)
        self.assertEqual(audit.attempts_by_job["L01-F"][0]["snapshot"]["status"],
                         "engineering_incomplete")
        self.assertFalse(audit.attempt_catalog[pilot_job["run_id"]]["eligible_for_main_comparison"])
        self.assertTrue(audit.attempt_catalog[target_job["run_id"]]["eligible_for_main_comparison"])
        self.assertEqual(audit.attempt_catalog[target_job["run_id"]]["source_snapshot"]["digest"],
                         "target-revision")
        self.assertNotIn("L01-R", audit.attempts_by_job)
        self.assertFalse([c for c in audit.checks if c["status"] != "passed"])

    def test_exact_primary_context_and_readback_remain_separate(self):
        target = segment(2, 8)
        records = [{"record_id": "primary-with-gap", "quote_span": {"segments": [segment(2, 4), segment(5, 8)]},
                    "context": {"fragments": [segment(2, 8)]}},
                   {"record_id": "wrong-text-version", "quote_span": {"segments": [segment(2, 8, "old-version")]},
                    "context": {"fragments": []}}]
        self.assertFalse(checker.covered(target, records))
        self.assertFalse(checker.literal_overlap(target, segment(2, 8, "old-version")))
        self.assertFalse(checker.literal_overlap(segment(2, 4), segment(4, 8)))
        self.assertTrue(checker.covered(target, [{"quote_span": {"segments": [segment(2, 4), segment(4, 8)]}}]))
        expected_layers = {
            "initial_selected_input_retains_all_anchored_lines": True,
            "primary_quote_exact_source_interval_union_covers_all": False,
            "one_primary_record_covers_all_segments": [],
            "primary_quote_interval_overlapping_record_ids": ["primary-with-gap"],
            "context_exact_source_interval_union_covers_all": True,
            "context_only_without_full_primary_quote": True,
            "all_anchored_lines_explicitly_reread_in_summary": True,
            "same_block_overlap_is_location_hint_only_not_extracted_description": True,
            "context_or_readback_is_not_primary_feature_extraction": True,
            "semantic_or_medical_correctness_established": False,
        }
        reliable = {"unit_id": "unit-1", "unique_source_segments": [target],
                    "reliable_unique_location": True, "all_required_blocks_retained": True,
                    "evidence_layers": expected_layers}
        unresolved = {"unit_id": "unresolved-1", "unique_source_segments": [],
                      "reliable_unique_location": False,
                      "evidence_layers": {**expected_layers,
                          "initial_selected_input_retains_all_anchored_lines": None,
                          "primary_quote_exact_source_interval_union_covers_all": None,
                          "primary_quote_interval_overlapping_record_ids": [],
                          "context_exact_source_interval_union_covers_all": None,
                          "context_only_without_full_primary_quote": None,
                          "all_anchored_lines_explicitly_reread_in_summary": None}}
        row_review = {"initial_input_retains_all_units": True,
                      "primary_quote_intervals_cover_all_units": False,
                      "all_units_in_context_but_not_fully_in_primary_quotes": True,
                      "not_a_claim_that_the_reference_description_was_medically_extracted": True}
        comparisons = [{"job_id": "L01-F", "reference_id": "located", "units": [reliable],
                        "engineering_selected_input_and_summary_complete": True,
                        "literal_overlap_is_not_condition_completion_or_medical_quality": True,
                        "row_fully_located_for_literal_comparison": True,
                        "three_layer_row_review": row_review},
                       {"job_id": "L01-F", "reference_id": "unresolved", "units": [unresolved],
                        "engineering_selected_input_and_summary_complete": True,
                        "literal_overlap_is_not_condition_completion_or_medical_quality": True,
                        "row_fully_located_for_literal_comparison": False,
                        "three_layer_row_review": {**row_review, "initial_input_retains_all_units": None,
                            "primary_quote_intervals_cover_all_units": None,
                            "all_units_in_context_but_not_fully_in_primary_quotes": None}}]
        summary = {"L01-F": {"reliably_located_rows": 1, "unresolved_rows": 1,
                             "initial_input_retains_all_units_rows": 1,
                             "primary_quote_interval_union_covers_all_units_rows": 0,
                             "context_without_full_primary_quote_rows": 1,
                             "engineering_selected_input_and_summary_complete": True}}
        with tempfile.TemporaryDirectory(prefix="synthetic-layers-", dir=HERE) as directory:
            audit = checker.ContinuationAudit(Path(directory), "final", False, "completed-experiment")
            audit.target_cohort = "reliability-v2-main"
            audit.register = {"pilot_cohorts": []}
            audit.attempt_catalog = {}
            audit.results = {"L01-F": {"records": [{"status": "active", "record": {**r, "review_status": "pending", "evidence_validation": {"quote_located": True}}} for r in records],
                                       "coverage": {"summary_reread_source_block_ids": ["same-block"],
                                                    "selected_source_block_processing_complete": True,
                                                    "whole_document_summary_complete": True}}}
            fixtures = {
                "posthoc-ai-reference-review.json": {"comparisons": comparisons, "three_layer_summaries": summary},
                "posthoc-source-layer-summary.json": {"not_medical_precision_recall_or_f1": True, "rows": summary},
                "outputs-freeze.json": {"artifacts": {}, "all_failed_and_selected_attempt_artifacts_included": True,
                                        "archived_pilot_artifacts_included": True},
            }
            for name, data in fixtures.items():
                (audit.base / name).write_text(json.dumps(data), encoding="utf-8")
            # The old posthoc checks have their own fixtures. Exercise only the
            # newly added layer recomputation without loading AI reference rows.
            with patch.object(checker.Audit, "frozen_posthoc", lambda self: None), patch.object(audit, "validate_comparison_contract", lambda value: None):
                audit.frozen_posthoc()
            self.assertTrue(audit.checks)
            self.assertFalse([c for c in audit.checks if c["status"] != "passed"])
            # A same-block overlap falsely promoted to complete extraction must
            # be rejected by the independent interval recomputation.
            tampered = deepcopy(fixtures["posthoc-ai-reference-review.json"])
            tampered["comparisons"][0]["units"][0]["evidence_layers"]["primary_quote_exact_source_interval_union_covers_all"] = True
            (audit.base / "posthoc-ai-reference-review.json").write_text(json.dumps(tampered), encoding="utf-8")
            audit.cache.clear()
            audit.checks.clear()
            with patch.object(checker.Audit, "frozen_posthoc", lambda self: None), patch.object(audit, "validate_comparison_contract", lambda value: None):
                audit.frozen_posthoc()
            self.assertTrue(any(c["group"] == "posthoc_exact_layers" and c["status"] == "failed" for c in audit.checks))

    def test_qualification_does_not_fill_gaps_from_history_or_ineligible_versions(self):
        audit = checker.ContinuationAudit(HERE, "final", False, "completed-experiment")
        audit.target_cohort = "reliability-v2-main"
        current = {"record_id": "current-pending", "review_status": "needs_context",
                   "evidence_validation": {"quote_located": True},
                   "quote_span": {"segments": [segment(2, 4), segment(5, 8)]}}
        rejected = {**deepcopy(current), "record_id": "rejected", "review_status": "rejected",
                    "quote_span": {"segments": [segment(2, 8)]}}
        unlocated = {**deepcopy(current), "record_id": "unlocated",
                     "evidence_validation": {"quote_located": False}, "quote_span": {"segments": [segment(2, 8)]}}
        proposal = {**deepcopy(current), "record_id": "proposed", "quote_span": {"segments": [segment(2, 8)]}}
        old = {**deepcopy(current), "quote_span": {"segments": [segment(2, 8)]}}
        result = {"records": [{"status": "active", "version": 2, "record": current},
                              {"status": "active", "version": 1, "record": rejected},
                              {"status": "active", "version": 1, "record": unlocated},
                              {"status": "proposed", "version": 1, "record": proposal}],
                  "versions": [{"status": "active", "version": 1, "record": old}]}
        eligible = audit.literal_comparison_records(result)
        self.assertEqual(eligible, [current])
        self.assertFalse(checker.covered(segment(2, 8), eligible))
        self.assertTrue(checker.covered(segment(2, 8), [old]))


if __name__ == "__main__":
    started = datetime.now(timezone.utc)
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(TargetContractTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    output = HERE / (started.strftime("%Y%m%dT%H%M%S.%fZ") + "-target-contract")
    output.mkdir(exist_ok=False)
    receipt = {"schema_version": "s4-checker-target-contract-fixtures-1", "started_at": started.isoformat(),
               "tests_run": result.testsRun, "failed": len(result.failures), "errors": len(result.errors),
               "passed": result.wasSuccessful(), "external_requests": 0, "live_run_results_read": False,
               "ai_reference_rows_read": False, "source": str(CHECKER),
               "source_sha256": hashlib.sha256(CHECKER.read_bytes()).hexdigest(),
               "fixture_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    (output / "result.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"receipt": str(output / "result.json"), **receipt}, ensure_ascii=False))
    sys.exit(0 if result.wasSuccessful() else 1)
