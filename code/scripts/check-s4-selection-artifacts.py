#!/usr/bin/env python3
"""Independently cross-check the S4 selection delivery, without APIs or mutations.

Only this script's timestamped artifact-validation output is written. Running jobs,
inflight requests and an unrendered final report are pending, never successful
results. This is an engineering artifact check, not an Astra or medical review.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import csv
from datetime import datetime, timezone
import hashlib
import html
import io
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit
import xml.etree.ElementTree as ET
import zipfile


CODE = Path(__file__).resolve().parents[1]
PROJECT = CODE.parent
DEFAULT_BASE = CODE / "docs/acceptance/s4/selection-optimization"
AI_DATA = CODE / "evaluation/reference-drafts/2026-11-03-l01-l05"
CAPS = {"requests": 300, "input_tokens_including_cache": 6_000_000, "output_tokens_including_reasoning": 400_000}
JOB_IDS = {f"{document}-{condition}" for document in ("L01", "L05") for condition in ("B0", "F", "R", "FR")}
TERMINAL = {"engineering_incomplete", "selected_input_finished_quality_pending"}
ALIASES = {"L01-R": "L01-F", "L01-FR": "L01-F", "L05-FR": "L05-F"}
SUPPLIER_EXACT_PAIRS = {("gpt-6-luna", "igpt-6-luna"), ("igpt-6-luna", "gpt-6-luna")}
CONTINUATION_CAPS = {"requests":271,"input_tokens":5_720_497,"output_tokens":377_383}
REGISTER_ACCT = {
    "requests": "requests", "provider_reported_input_tokens": "known_input",
    "missing_usage_input_reservation": "reserved_input", "provider_reported_output_tokens_including_reasoning": "known_output",
    "missing_usage_output_reservation": "reserved_output", "provider_reported_cache_read_tokens_included_in_input": "cache_read",
    "provider_reported_reasoning_tokens_included_in_output": "reasoning", "usage_missing_requests": "unknown_usage",
}
REPORT_ACCT = {
    "requests": "requests", "provider_input_tokens_including_cache": "known_input",
    "unknown_input_reservation": "reserved_input", "provider_output_tokens_including_reasoning": "known_output",
    "unknown_output_reservation": "reserved_output", "unknown_usage_requests": "unknown_usage", "inflight_requests": "inflight",
}


def hash_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def js_json(value) -> bytes:
    """Match these integer-only JSON.stringify manifests, preserving key order."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def numbers(entries):
    present = lambda e, key: key in e and e[key] is not None
    return {
        "requests": len(entries),
        "known_input": sum(e.get("input_tokens") or 0 for e in entries),
        "known_output": sum(e.get("output_tokens") or 0 for e in entries),
        "reserved_input": sum(e["input_ceiling"] for e in entries if not present(e, "input_tokens")),
        "reserved_output": sum(e["output_ceiling"] for e in entries if not present(e, "output_tokens")),
        "cache_read": sum(e.get("cache_read_tokens") or 0 for e in entries),
        "cache_write": sum(e.get("cache_write_tokens") or 0 for e in entries),
        "reasoning": sum(e.get("reasoning_tokens") or 0 for e in entries),
        "unknown_usage": sum(e.get("usage_status") != "provider_reported" for e in entries),
        "inflight": sum(not e.get("finished_at") for e in entries),
    }


def exact_response_name_status(requested, returned, confirmation):
    """No normalization: aliases are accepted only through the recorded exact pair."""
    if not isinstance(returned,str):
        return "unknown"
    if returned == requested:
        return "exact_name_match_not_independent_weight_verification"
    pairs={(p.get("requested_model"),p.get("response_model")) for p in confirmation.get("exact_pairs",[])}
    if (requested,returned) in pairs and pairs==SUPPLIER_EXACT_PAIRS:
        return "exact_supplier_alias_confirmed_via_user_not_independent_weight_verification"
    return "unapproved_response_name"


def carried_budget(prior, entries, new_metadata_requests=0):
    current=numbers(entries)
    return {
        "prior_combined_requests":prior["prior_combined_requests"],
        "continuation_inference_requests":current["requests"],
        "continuation_metadata_http_requests":new_metadata_requests,
        "joint_combined_requests":prior["prior_combined_requests"]+current["requests"]+new_metadata_requests,
        "joint_known_input":prior["prior_known_input_tokens"]+current["known_input"],
        "joint_unknown_input_reservation":prior["prior_unknown_input_reservation"]+current["reserved_input"],
        "joint_conservative_input":prior["prior_conservative_input_tokens"]+current["known_input"]+current["reserved_input"],
        "joint_known_output":prior["prior_known_output_tokens"]+current["known_output"],
        "joint_unknown_output_reservation":prior["prior_unknown_output_reservation"]+current["reserved_output"],
        "joint_conservative_output":prior["prior_conservative_output_tokens"]+current["known_output"]+current["reserved_output"],
        "prior_133_requests_are_outside_selection_authorization_scope":True,
    }


def covered(segment, records):
    intervals = sorted((s["start"], s["end"]) for record in records for s in record.get("quote_span", {}).get("segments", [])
                       if s["block_id"] == segment["block_id"] and s["text_version"] == segment["text_version"])
    end = segment["start"]
    for left, right in intervals:
        if left > end:
            break
        end = max(end, right)
        if end >= segment["end"]:
            return True
    return False


def literal_overlap(a,b):
    return a["block_id"]==b["block_id"] and a["text_version"]==b["text_version"] and max(a["start"],b["start"])<min(a["end"],b["end"])


def node_test_counts(log, label):
    """Node emits TAP '#' or spec-reporter 'ℹ' summaries depending on the runner."""
    return re.findall(r"(?:^|\n)\s*(?:#|ℹ)\s*"+re.escape(label)+r"\s+(\d+)\b",log)


def nested_segments(value):
    if isinstance(value, dict):
        if all(key in value for key in ("block_id", "text_version", "start", "end", "exact_quote")):
            yield value
        for child in value.values():
            yield from nested_segments(child)
    elif isinstance(value, list):
        for child in value:
            yield from nested_segments(child)


class LocalLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key in ("href", "src") and value:
                self.links.append(value)


class Audit:
    def __init__(self, base: Path, phase: str, require_plan: bool, delivery_mode: str):
        self.base = base.resolve()
        self.phase = phase
        self.require_plan = require_plan
        self.delivery_mode = delivery_mode
        self.is_continuation = False
        self.current_revision_changes = []
        self.checks = []
        self.files = {}
        self.cache = {}
        self.mutable = set()
        self.docs = {}
        self.masks = {}
        self.results = {}
        self.groups = defaultdict(list)
        self.counts = {}
        self.register = {}
        self.report = {}
        self.all_terminal = False

    def path(self, value, relative_to=None):
        path = Path(value)
        if path.is_absolute():
            return path.resolve()
        if str(path).startswith("code/") or str(path).startswith("方案/"):
            return (PROJECT / path).resolve()
        return ((relative_to or CODE) / path).resolve()

    def label(self, path):
        try:
            return str(Path(path).resolve().relative_to(PROJECT))
        except ValueError:
            return str(path)

    def note(self, group, name, status, detail=None, scope="artifact"):
        item = {"group": group, "check": name, "status": status, "scope":scope}
        if detail is not None:
            item["detail"] = detail
        self.checks.append(item)

    def live_status(self):
        stopped = self.delivery_mode=="stopped-handoff" and self.counts.get("inflight",1)==0
        ready = stopped or (self.all_terminal and self.counts.get("inflight",1)==0 and (self.base/"outputs-freeze.json").exists())
        return "failed" if self.phase=="final" and ready else "pending"

    def expect(self, group, name, actual, expected, live=False):
        if actual == expected:
            self.note(group, name, "passed")
        else:
            self.note(group, name, self.live_status() if live else "failed",
                      {"actual": actual, "expected": expected})

    def require(self, group, name, condition, detail=None, live=False):
        self.note(group, name, "passed" if condition else (self.live_status() if live else "failed"), detail if not condition else None)

    def read_bytes(self, path, pending_if_missing=False, mutable=False):
        path = self.path(path)
        if mutable:
            self.mutable.add(path)
        if path in self.cache:
            return self.cache[path]
        try:
            value = path.read_bytes()
        except (OSError, ValueError) as error:
            self.note("accessible_files", self.label(path), "pending" if pending_if_missing else "failed", type(error).__name__)
            return None
        self.files[path] = {"path": self.label(path), "sha256_at_read": hash_bytes(value), "bytes": len(value)}
        self.cache[path] = value
        return value

    def read_json(self, path, pending_if_missing=False, mutable=False):
        raw = self.read_bytes(path, pending_if_missing, mutable)
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except (UnicodeError, ValueError) as error:
            self.note("parse", self.label(path), "pending" if mutable else "failed", type(error).__name__)
            return None

    def file_hash(self, path, expected, group="source_preservation", mutable=False):
        value = self.read_bytes(path, mutable=mutable)
        if value is not None:
            actual=hash_bytes(value)
            if group=="current_vs_frozen_sources" and actual!=expected and self.delivery_mode=="stopped-handoff":
                change={"path":str(self.path(path).relative_to(CODE)),"experiment_sha256":expected,"current_delivery_sha256":actual}
                self.current_revision_changes.append(change)
                self.note("runtime_versions","delivery revision differs from preserved paid-run revision","warning",change)
            else:
                self.expect(group, self.label(self.path(path)) + " SHA256", actual, expected)

    def compare_accounting(self, label, actual, entries, mapping, live=False):
        if actual is None:
            self.note("ledger", label, "pending" if live else "failed", "accounting not yet recorded")
            return
        expected = numbers(entries)
        differences = {key: {"actual": actual.get(key), "expected": expected[target]}
                       for key, target in mapping.items() if actual.get(key) != expected[target]}
        self.require("ledger", label, not differences, differences, live)

    def expected_result_run_id(self,job,representative_id):
        return self.register["batch_id"]+":"+representative_id

    def physical_requests_for_job(self,job):
        return self.groups[job["job_id"]]

    def literal_comparison_records(self,result):
        return [v["record"] for v in result.get("records",[])]

    def authorization(self):
        auth_path = self.base / "authorization.json"
        auth = self.read_json(auth_path)
        self.register = self.read_json(self.base / "experiment-register.json", mutable=True) or {}
        self.report = self.read_json(self.base / "report.json", pending_if_missing=True, mutable=True) or {}
        if not auth or not self.register:
            return
        reg = self.register
        self.expect("authorization", "model", (auth.get("provider"), auth.get("model_id"), auth.get("reasoning_effort"), auth.get("api")),
                    ("agicto", "gpt-6-luna", "medium", "openai-responses"))
        self.expect("authorization", "explicit hard caps", auth.get("shared_hard_caps"), CAPS)
        self.expect("authorization", "registered authorization hash", reg.get("authorization_sha256"), hash_bytes(self.cache[auth_path]))
        self.expect("authorization", "registered model", (reg.get("model_id"), reg.get("reasoning_effort")), ("gpt-6-luna", "medium"))
        limits = reg.get("shared_limits", {})
        self.expect("authorization", "registered shared caps", (limits.get("requests"), limits.get("input_tokens"), limits.get("output_tokens")), (300, 6_000_000, 400_000))
        expected_auth = {"id": auth.get("authorization_id"), "source": reg.get("authorization"), "recorded_at": auth.get("recorded_at")}
        self.expect("authorization", "registered explicit budget authorization", reg.get("budget_authorization"), expected_auth)
        self.expect("authorization", "exact logical conditions", set(auth.get("logical_conditions", [])), {"B0", "F", "R", "FR"})
        profile = reg.get("common_model_view", {}).get("profile", {})
        self.expect("authorization", "common model profile", (profile.get("model_id"), profile.get("reasoning_effort"), profile.get("api")), ("gpt-6-luna", "medium", "openai-responses"))
        for key in ("AI_reference_in_model_or_rules", "association_enhancement_in_main_experiment", "stage_passed", "medical_quality_approved", "S5_started"):
            self.expect("approval_boundary", "register " + key, reg.get(key), False)
        if self.report:
            self.expect("authorization", "report model", (self.report.get("model_id"), self.report.get("reasoning_effort")), ("gpt-6-luna", "medium"))
            self.expect("authorization", "report hard caps", self.report.get("hard_authorization"), CAPS)
            for key in ("stage_passed", "medical_quality_approved", "S5_started", "pathology_real_paper_feature_extraction_validated"):
                self.expect("approval_boundary", "report " + key, self.report.get(key), False)
            self.expect("approval_boundary", "report no medical strategy winner/default replacement", self.report.get("no_claim_of_best_medical_strategy_or_default_replacement"), True)
            self.expect("reuse", "reuse is not an independent retest", self.report.get("equivalent_condition_reuse_is_not_independent_retest"), True)
        review = self.read_json(CODE / "docs/acceptance/s4/review-index.json")
        if review and self.report:
            self.expect("approval_boundary", "formal review count unchanged by checker", self.report.get("formal_review_count", {}).get("used"), review.get("formal_astra_reviews_used"), live=True)
        self.note("limitations", "engineering validation only", "warning", "This checker performs no medical or formal Astra review; it cannot prove model quality or statistical superiority.")

    def source_integrity(self):
        reg = self.register
        snapshot = reg.get("source_snapshot", {})
        directory = self.path(snapshot.get("directory", "."))
        manifest = self.read_json(directory / "manifest.json")
        if manifest:
            self.expect("runtime_versions", "source snapshot manifest", manifest, {"digest": snapshot.get("digest"), "hashes": snapshot.get("hashes")})
        self.expect("runtime_versions", "source snapshot digest", hash_bytes(js_json(snapshot.get("hashes", {}))), snapshot.get("digest"))
        for path, expected in snapshot.get("hashes", {}).items():
            self.file_hash(directory / path, expected, "runtime_versions")
            self.file_hash(CODE / path, expected, "current_vs_frozen_sources")
        for source in reg.get("sources", []):
            name = source["document_id"]
            self.file_hash(source["original_pdf_path"], source["original_pdf_sha256"])
            self.file_hash(source["source_IR_path"], source["source_IR_sha256"])
            parsed = self.read_json(source["source_IR_path"])
            if not parsed or not parsed.get("document"):
                continue
            doc = parsed["document"]
            self.docs[name] = doc
            self.expect("source_preservation", name + " original binding", (doc.get("document_id"), doc.get("file_sha256"), doc.get("text_version"), len(doc.get("blocks", []))),
                        (name, source["original_pdf_sha256"], source["text_version"], source["source_blocks"]))
            self.expect("source_preservation", name + " true Unicode offset contract", (doc.get("offset_unit"), doc.get("offset_interval")), ("unicode_code_point", "[start,end)"))
        history = self.read_json(self.base / "historical-ledger-preservation-before.json")
        if history:
            self.file_hash(history["historical_ledger_path"], history["sha256"], "historical_ledger")
            old = self.read_json(history["historical_ledger_path"])
            if old:
                self.expect("historical_ledger", "old 133 requests retained", (history.get("requests"), len(old.get("requests", [])), reg.get("old_s4_requests_preserved")), (133, 133, 133))
            reported = self.report.get("historical_ledger", {})
            if reported:
                self.expect("historical_ledger", "report old ledger hash and request count", (reported.get("before_sha256"), reported.get("after_sha256"), reported.get("unchanged"), reported.get("historical_requests")), (history["sha256"], history["sha256"], True, 133))
        ai = self.read_json(AI_DATA / "preservation.json")
        if ai:
            wb = ai["workbook"]
            self.file_hash(wb["file"], wb["sha256_before"], "AI_reference")
            self.expect("AI_reference", "original Excel before/after unchanged", wb["sha256_before"], wb["sha256_after"])
            self.expect("AI_reference", "no Excel formula evaluation", (wb.get("formulas_evaluated"), wb.get("hyperlinks_followed")), (False, False))
        self.check_ai_status()

    def check_ai_status(self):
        drafts = self.read_json(AI_DATA / "reference-drafts.json")
        anchors = self.read_json(AI_DATA / "source-anchor-index.json")
        if not drafts or not anchors:
            return
        self.anchors = anchors
        self.drafts = drafts
        for label, obj in [("draft", drafts), ("anchor index", anchors)] + [(entry["reference_id"], entry) for entry in drafts.get("entries", [])]:
            prov = obj.get("provenance", {})
            self.expect("AI_reference", label + " is AI only", (prov.get("origin"), prov.get("human_verified"), prov.get("not_gold"), prov.get("quality_evaluation_eligible")), ("external_ai_user_supplied", False, True, False))
        self.expect("AI_reference", "reference count and paper distribution", dict(Counter(e["document_id"] for e in drafts["entries"])), {"L01": 25, "L05": 31})
        reliable = sum(r["literal_coverage"]["row_eligible_for_fully_located_literal_comparison"] for r in anchors["records"])
        self.expect("AI_reference", "19 located and 37 unresolved rows are separate", (reliable, len(anchors["records"])-reliable), (19, 37))
        self.expect("AI_reference", "unresolved rows not forced into zero scores", anchors.get("unresolved_rows_separate_from_fully_located_literal_rows"), True)
        self.expect("AI_reference", "no invented human annotator or reviewer", any(e.get("human_annotator_raw") or e.get("human_reviewer_raw") for e in drafts["entries"]), False)

    def masks_and_reuse(self):
        reg = self.register
        jobs = reg.get("jobs", [])
        self.expect("reuse", "8 logical job identities", {j["job_id"] for j in jobs}, JOB_IDS)
        self.expect("reuse", "8 jobs are distinct", len(jobs), 8)
        physical = [j for j in jobs if j.get("independent_model_run")]
        self.expect("reuse", "5 planned independent source input slots, not 5 completed experiments", len(physical), 5)
        self.expect("reuse", "registered 8 logical / 5 unique", (reg.get("planned_logical_conditions"), reg.get("unique_source_inputs")), (8, 5))
        self.expect("reuse", "3 aliases have correct representatives", {j["job_id"]: j["representative_job_id"] for j in jobs if j.get("representative_job_id")}, ALIASES)
        fingerprints = defaultdict(list)
        for job in jobs:
            job_id = job["job_id"]
            mask = self.read_json(self.base / "selection-masks" / (job_id + ".json"))
            batches = self.read_json(self.base / "selection-masks" / (job_id + "-batch-plan.json"))
            doc = self.docs.get(job["document_id"])
            if not mask or batches is None or not doc:
                continue
            self.masks[job_id] = mask
            original = {k:v for k,v in mask.items() if k != "digest"}
            self.expect("mask_bindings", job_id + " mask self digest", hash_bytes(js_json(original)), mask.get("digest"))
            self.expect("mask_bindings", job_id + " registered mask digest", job.get("source_selection_sha256"), mask.get("digest"))
            self.expect("mask_bindings", job_id + " original source binding", (mask.get("document_id"), mask.get("file_sha256"), mask.get("text_version")), (doc["document_id"], doc["file_sha256"], doc["text_version"]))
            block_by_id = {b["block_id"]:b for b in doc["blocks"]}
            errors = []
            for entry in mask["entries"]:
                index = entry["document_line_index"]
                if not 0 <= index < len(doc["blocks"]):
                    errors.append(entry["block_id"] + ":bad_index")
                    continue
                block = doc["blocks"][index]
                if (block["block_id"] != entry["block_id"] or hash_bytes(block["text"].encode()) != entry["text_sha256"] or
                        len(block["text"]) != entry["code_points"] or block["page"] != entry["physical_page"]):
                    errors.append(entry["block_id"])
            self.require("mask_bindings", job_id + " every original source line is auditable", not errors and len(mask["entries"]) == len(doc["blocks"]), errors)
            self.expect("mask_bindings", job_id + " all source IDs retained in audit", {e["block_id"] for e in mask["entries"]}, set(block_by_id))
            counts = {state:sum(e["state"] == state for e in mask["entries"]) for state in ("kept", "deferred", "excluded")}
            points = {state:sum(e["code_points"] for e in mask["entries"] if e["state"] == state) for state in counts}
            self.expect("mask_bindings", job_id + " counts", (mask.get("counts"), job.get("counts")), (counts, counts))
            self.expect("mask_bindings", job_id + " code points", (mask.get("code_points"), job.get("code_points")), (points, points))
            for state in counts:
                expected = [e["block_id"] for e in mask["entries"] if e["state"] == state and e["article_eligible"]]
                self.expect("mask_bindings", job_id + " " + state + " IDs", mask.get(state + "_block_ids"), expected)
            assigned = [b for batch in batches for b in batch["assigned_block_ids"]]
            self.require("mask_bindings", job_id + " each kept block assigned exactly once", len(assigned) == len(set(assigned)) and set(assigned) == set(mask["kept_block_ids"]))
            self.require("mask_bindings", job_id + " context uses valid retained source lines", all(b in block_by_id and b in set(mask["kept_block_ids"]) for batch in batches for b in batch["context_block_ids"]))
            source = next(s for s in reg["sources"] if s["document_id"] == job["document_id"])
            historical_fingerprint = {"commonModelView": reg["common_model_view"], "source_ir_sha256": source["source_IR_sha256"],
                                      "kept_block_ids": mask["kept_block_ids"], "batches": batches,
                                      "authorized_document_line_indices": [e["document_line_index"] for e in mask["entries"] if e["article_eligible"]],
                                      "initially_omitted_document_line_indices": [e["document_line_index"] for e in mask["entries"] if e["article_eligible"] and e["state"] != "kept"]}
            computed = hash_bytes(js_json(historical_fingerprint))
            self.expect("reuse", job_id + " historical source-mask/neutral-contract fingerprint only", computed, job.get("model_visible_source_input_sha256"))
            fingerprints[computed].append(job_id)
            for key in ("original_source_changed", "medical_rules_approved", "full_document_coverage_implied"):
                self.expect("approval_boundary", job_id + " mask " + key, mask.get(key), False)
        self.expect("reuse", "recomputed 5 source-mask/contract groups", len(fingerprints), 5)
        by_id = {j["job_id"]:j for j in jobs}
        for alias_id, representative_id in ALIASES.items():
            alias, representative = by_id.get(alias_id, {}), by_id.get(representative_id, {})
            self.expect("reuse", alias_id + " not independently run", alias.get("independent_model_run"), False)
            self.expect("reuse", alias_id + " fingerprint equals representative", alias.get("model_visible_source_input_sha256"), representative.get("model_visible_source_input_sha256"))
            if alias.get("result_path"):
                self.expect("reuse", alias_id + " references exact same real result path", alias["result_path"], representative.get("result_path"))
                self.expect("reuse", alias_id + " not independently measured", alias.get("independently_measured"), False)
                self.require("reuse", alias_id + " has no invented independent accounting or latency", not alias.get("accounting") and alias.get("total_seconds") is None)
            else:
                self.note("experiment_completion", alias_id + " awaits representative result", "pending",scope="experiment")
        self.all_terminal = len(physical) == 5 and all(j.get("status") in TERMINAL and j.get("result_path") for j in physical)
        if not self.all_terminal:
            self.note("experiment_completion", "all 5 real paper outputs are terminal", "pending", {j["job_id"]:j.get("status") for j in physical},scope="experiment")
        else:
            self.note("experiment_completion", "all 5 real paper outputs are terminal", "passed",scope="experiment")
        self.note("reuse_limitations", "opaque run_id prevents full-payload equivalence claim", "warning",
                  "The historical model_visible_source_input_sha256 verifies source mask and neutral contract only. Run IDs contain condition suffixes; aliases reuse F once, are not independent R/FR results, and do not prove byte-identical requests or strict blinding.")
        identity = self.read_json(self.base / "identity-equivalence-limitation.json", pending_if_missing=True, mutable=True)
        if identity is not None:
            self.identity = identity
            self.note("reuse_limitations", "explicit equivalence limitation is separately accessible", "passed")
            self.expect("reuse_limitations", "5 real / 8 logical and frozen implementation retained",(identity.get("actual_paper_runs_planned"),identity.get("logical_conditions"),identity.get("frozen_implementation_retained")),(5,8,True))
            self.require("reuse_limitations", "full payload and independent alias behavior explicitly unestablished",
                         all(any(term in str(value).lower() for value in identity.get("equivalence_not_established",[])) for term in ("byte-identical","independent r/fr","statistically")))

    def call_ledger(self):
        runtime = self.path(self.register["runtime_directory"])
        ledger = self.read_json(runtime / "call-ledger.json", pending_if_missing=True, mutable=True)
        if not ledger:
            return
        self.ledger = ledger
        entries = ledger.get("requests", [])
        self.counts = numbers(entries)
        metadata=self.read_json(self.base/"model-catalog-readonly.json",pending_if_missing=True) if (self.base/"model-catalog-readonly.json").exists() else None
        metadata_count=metadata.get("physical_http_requests",0) if metadata else 0
        self.counts["inference_ledger_requests"]=len(entries)
        self.counts["metadata_http_requests"]=metadata_count
        self.counts["combined_requests_against_300_cap"]=len(entries)+metadata_count
        if metadata:
            self.expect("ledger","read-only metadata GET has no inference token claim",(metadata.get("method"),metadata.get("inference_requests"),metadata.get("model_alias_relationship_established")),("GET",0,False))
            self.expect("ledger","metadata physical request counts conservatively toward cap",metadata.get("counts_toward_combined_request_ceiling_conservatively"),True)
        self.expect("ledger", "new ledger explicit limits", ledger.get("limits"), self.register.get("shared_limits"))
        self.expect("ledger", "new ledger authorization", ledger.get("authorization"), self.register.get("budget_authorization"))
        self.expect("ledger", "unique physical request IDs", len({e["id"] for e in entries}), len(entries))
        self.require("ledger", "actual plus unknown reservation stays within 300/6M/400k", self.counts["combined_requests_against_300_cap"] <= 300 and self.counts["known_input"] + self.counts["reserved_input"] <= 6_000_000 and self.counts["known_output"] + self.counts["reserved_output"] <= 400_000, self.counts)
        allowed = {j["job_id"] for j in self.register["jobs"] if j["independent_model_run"]} | {"synthetic-probe"}
        errors, inflight_missing, supplier_differences = [], [], []
        for entry in entries:
            prefix = self.register["batch_id"] + ":"
            rest = entry.get("purpose", "")[len(prefix):] if entry.get("purpose", "").startswith(prefix) else ""
            group = rest.split(":", 1)[0]
            self.groups[group].append(entry)
            if group not in allowed:
                errors.append({"id":entry["id"], "reason":"unknown_or_alias_request_group", "purpose":entry.get("purpose")})
            if entry.get("model_id") != "gpt-6-luna":
                errors.append({"id":entry["id"], "reason":"unauthorized_model"})
            if entry.get("provider_response_model") and entry["provider_response_model"] != entry.get("model_id"):
                supplier_differences.append({key:entry.get(key) for key in (
                    "id","purpose","attempt","started_at","finished_at","model_id","requested_reasoning_effort",
                    "provider_response_model","provider_response_id","payload_sha256","response_stream_sha256","usage_status","status")})
            effort = entry.get("requested_reasoning_effort")
            if effort != "medium":
                (inflight_missing if not entry.get("finished_at") and effort is None else errors).append({"id":entry["id"], "reason":"missing_or_nonmedium_reasoning", "value":effort})
            for key in ("input_ceiling", "output_ceiling"):
                if not isinstance(entry.get(key), int) or entry[key] <= 0:
                    errors.append({"id":entry["id"], "reason":"invalid_conservative_ceiling", "field":key})
            if entry.get("input_ceiling", 0) < max(entry.get("payload_bytes", 0)+512, 32768) or entry.get("output_ceiling", 0) > 8192:
                errors.append({"id":entry["id"], "reason":"reservation_policy_not_conservative_or_output_ceiling_exceeds_profile"})
            if entry.get("requested_max_output_tokens", 8192) > 8192 or entry.get("configured_deadline_ms", 120000) > 120000:
                errors.append({"id":entry["id"], "reason":"request_operation_limit_exceeded"})
            if entry.get("usage_status") == "provider_reported":
                if entry.get("input_tokens") is None or entry.get("output_tokens") is None:
                    errors.append({"id":entry["id"], "reason":"reported_usage_missing_actual_tokens"})
            for key, parent in (("cache_read_tokens", "input_tokens"), ("reasoning_tokens", "output_tokens")):
                if entry.get(parent) is not None and entry.get(key, 0) > entry[parent]:
                    errors.append({"id":entry["id"], "reason":"cache_or_reasoning_doublecount_risk", "field":key})
            raw_usage = entry.get("provider_usage", {})
            for key in ("input_tokens", "output_tokens"):
                if key in raw_usage and key in entry and raw_usage[key] != entry[key]:
                    errors.append({"id":entry["id"], "reason":"raw_provider_usage_mismatch", "field":key})
        self.require("ledger", "all physical requests authorized and classified, failures included", not errors, errors)
        self.supplier_differences = supplier_differences
        if supplier_differences:
            self.note("supplier_model_identity", "returned model name differs: real identity unverified, comparison blocked", "pending",
                      {"ledger":self.label(runtime/"call-ledger.json"),"automatic_prefix_normalization_forbidden":True,
                       "comparative_conclusions_blocked":True,"requests":supplier_differences},scope="experiment")
        else:
            self.note("supplier_model_identity", "returned labels match requested authorized model where supplied", "passed")
        if inflight_missing:
            self.note("ledger", "inflight payload metadata not yet persisted", "pending", inflight_missing)
        if self.counts["inflight"]:
            self.note("experiment_completion", "no inflight physical requests", "pending", self.counts["inflight"])
        else:
            self.note("experiment_completion", "no inflight physical requests", "passed")
        if (runtime / "active-owner.lock").exists():
            self.note("experiment_completion", "paid run owner lock has been released", "pending")
        else:
            self.note("experiment_completion", "paid run owner lock has been released", "passed")
        self.compare_accounting("register total accounting", self.register.get("accounting"), entries, REGISTER_ACCT, live=True)
        totals = self.register.get("budget_totals", {})
        expected = {"requests":self.counts["requests"], "input_tokens":self.counts["known_input"]+self.counts["reserved_input"],
                    "output_tokens":self.counts["known_output"]+self.counts["reserved_output"], "conservative_missing_usage_requests":self.counts["unknown_usage"]}
        self.expect("ledger", "register conservative totals include all unknown usage", {k:totals.get(k) for k in expected}, expected, live=True)
        if self.report:
            self.compare_accounting("report counts every new physical request and unknown reservation", self.report.get("all_new_requests_including_probe_failure_retry"), entries, REPORT_ACCT, live=True)
            combined=self.counts["combined_requests_against_300_cap"]
            self.expect("ledger", "historical plus new physical count includes metadata and excludes aliases", self.report.get("historical_plus_new_physical_requests"), 133+combined, live=True)
            if metadata:
                expected_scope={"inference_ledger_requests":len(entries),"metadata_http_requests":metadata_count,
                                "combined_authorized_physical_requests_used":combined,"remaining_authorized_requests":300-combined}
                self.expect("ledger","report explicitly distinguishes inference/metadata/combined request scope",{k:self.report.get(k) for k in expected_scope},expected_scope,live=True)
                self.expect("ledger","metadata GET does not invent inference tokens",self.report.get("metadata_GET_has_no_inference_token_usage"),True,live=True)
            price = round(self.counts["known_input"] / 1_000_000 * .63 + self.counts["known_output"] / 1_000_000 * 3.15, 6)
            self.expect("ledger", "price is measured known usage scenario only", self.report.get("public_price_scenario_rmb_for_measured_usage_only"), price, live=True)
            self.expect("ledger", "actual supplier bill remains unknown", self.report.get("actual_bill"), None)
        probe = self.register.get("probe", {})
        self.compare_accounting("synthetic probe is separately counted", probe.get("accounting"), self.groups["synthetic-probe"], REGISTER_ACCT, live=True)
        self.expect("approval_boundary", "synthetic probe is not medical validation", (probe.get("fixture"), probe.get("medical_validation")), (True, False))

    def run_artifacts(self):
        report_rows = {r["job_id"]:r for r in self.report.get("rows", [])}
        if self.report:
            self.expect("report_consistency", "report contains all 8 logical rows", set(report_rows), JOB_IDS, live=True)
            self.expect("report_consistency", "materialized run artifacts are counted without creating 8 independent samples", self.report.get("actual_main_paper_runs"), sum(bool(j.get("result_path")) and j["independent_model_run"] for j in self.register["jobs"]), live=True)
            finished=sum(j.get("status")=="selected_input_finished_quality_pending" and j["independent_model_run"] for j in self.register["jobs"])
            if self.delivery_mode=="stopped-handoff":
                self.expect("report_consistency","finished conditions are counted separately from recovered run artifacts",self.report.get("complete_main_paper_conditions"),finished,live=True)
                self.expect("report_consistency","stopped handoff does not claim completed optimization",self.report.get("comparison_completed"),False,live=True)
            self.counts["materialized_paper_run_artifacts"]=sum(bool(j.get("result_path")) and j["independent_model_run"] for j in self.register["jobs"])
            self.counts["successfully_finished_selected_input_conditions"]=finished
        for job in self.register["jobs"]:
            job_id = job["job_id"]
            row = report_rows.get(job_id)
            mask = self.masks.get(job_id)
            if row and mask:
                self.expect("report_consistency", job_id + " status", row.get("status"), job.get("status"), live=True)
                self.expect("report_consistency", job_id + " reuse declarations", (row.get("independent_measurement"),row.get("reused_from")), (job["independent_model_run"],job.get("representative_job_id")))
                self.expect("report_consistency", job_id + " source selection statistics", (row.get("selected_blocks"), row.get("selection_counts"), row.get("selected_characters")), (len(mask["kept_block_ids"]),mask["counts"],mask["code_points"]["kept"]))
                if self.is_continuation:
                    source_chars=sum(entry["code_points"] for entry in mask["entries"])
                    self.expect("report_consistency", job_id + " character reduction is calculated only from source code points",
                                row.get("input_character_reduction_percent"),(source_chars-mask["code_points"]["kept"])/source_chars*100)
                else:
                    self.expect("report_consistency", job_id + " character reduction is not measured token/latency saving", row.get("character_reduction_is_not_measured_token_or_latency_reduction"), True)
                if not job["independent_model_run"]:
                    self.expect("reuse", job_id + " report no independent accounting or latency", (row.get("accounting"), row.get("total_seconds")), (None,None))
            if not job.get("result_path"):
                self.note("experiment_completion", job_id + " terminal result not yet registered", "pending",scope="experiment")
                continue
            result = self.read_json(job["result_path"], pending_if_missing=True)
            if not result:
                continue
            self.results[job_id] = result
            doc = self.docs[job["document_id"]]
            representative = job.get("representative_job_id") or job_id
            self.expect("run_identity", job_id + " actual result identifies real representative only", (result.get("run_id"),result.get("document_id"),result.get("model_id"),result.get("reasoning_effort")),
                        (self.expected_result_run_id(job,representative),job["document_id"],"gpt-6-luna","medium"))
            if row:
                self.expect("report_consistency", job_id + " report copies actual result, including incompleteness", (row.get("coverage"),row.get("candidate_count"),row.get("error")), (result.get("coverage"),result.get("candidate_count"),result.get("error")), live=True)
                self.expect("report_consistency", job_id + " result path",row.get("result_path"),job.get("result_path"),live=True)
                if job["independent_model_run"]:
                    self.expect("report_consistency", job_id + " independent accounting and latency",(row.get("accounting"),row.get("total_seconds")),(job.get("accounting"),result.get("total_seconds")),live=True)
            coverage = result.get("coverage", {})
            for key in ("source_fidelity_human_verified","medical_recall_proven_by_coverage"):
                self.expect("approval_boundary",job_id+" coverage "+key,coverage.get(key),False)
            blocks = {b["block_id"]:b for b in doc["blocks"]}
            completed = set(coverage.get("completed_source_block_ids", []))
            assigned = set(mask["kept_block_ids"]) if mask else set()
            self.expect("coverage", job_id + " explicit completion counter", coverage.get("explicitly_completed_source_blocks"), len(completed))
            self.require("coverage", job_id + " unselected blocks are never explicitly completed by reread alone", completed <= assigned)
            self.expect("coverage", job_id + " selected input processing completeness", coverage.get("selected_source_block_processing_complete"), assigned <= completed)
            self.expect("coverage", job_id + " all-source completeness is distinct from selected input", coverage.get("source_block_processing_complete"), set(blocks) <= completed)
            if coverage.get("full_document_extraction_completed"):
                self.require("coverage", job_id + " full-document claim needs all source blocks and summary", bool(coverage.get("source_block_processing_complete")) and bool(coverage.get("whole_document_summary_complete")))
            finished = not result.get("error") and coverage.get("selected_source_block_processing_complete") and coverage.get("whole_document_summary_complete")
            if job["independent_model_run"]:
                actual_requests=self.physical_requests_for_job(job)
                if self.delivery_mode=="stopped-handoff":
                    self.require("run_status_consistency",job_id+" interrupted run is not claimed selected-input success",job.get("status")=="selected_input_finished_quality_pending" if finished else job.get("status")!="selected_input_finished_quality_pending")
                else:
                    self.expect("run_status_consistency", job_id + " terminal status does not promote incomplete run to success", job.get("status"), "selected_input_finished_quality_pending" if finished else "engineering_incomplete")
                self.compare_accounting(job_id + " selected real attempt request accounting", job.get("accounting"),actual_requests,REGISTER_ACCT)
                directory = self.path(job.get("directory", Path(job["result_path"]).parent))
                accounting_path=directory/"request-accounting.json"
                recovery=result.get("recovery_only_no_new_inference") is True
                saved = self.read_json(accounting_path,pending_if_missing=True) if accounting_path.exists() or not recovery else None
                if saved:
                    self.expect("ledger", job_id + " immutable per-run physical IDs", [e["id"] for e in saved.get("requests", [])], [e["id"] for e in actual_requests])
                    self.compare_accounting(job_id + " immutable per-run accounting", saved.get("accounting"),actual_requests,REGISTER_ACCT)
                elif recovery:
                    self.compare_accounting(job_id+" recovery embeds actual ledger accounting without inventing normal completion",result.get("request_accounting"),actual_requests,REGISTER_ACCT)
                provenance = self.read_json(directory / "source-provenance.json")
                if provenance:
                    source = next(s for s in self.register["sources"] if s["document_id"] == job["document_id"])
                    self.expect("runtime_versions", job_id + " actual run uses registered source snapshot", provenance.get("source_snapshot"), self.register.get("source_snapshot"))
                    meta=provenance.get("source_meta",{})
                    mask_claim=provenance.get("source_selection_sha256",provenance.get("prior_source_mask_sha256"))
                    if mask_claim is None and self.is_continuation and provenance.get("configuration_identical_to_initial") is True:
                        actual_selection=self.read_json(directory/"source-selection.json")
                        mask_claim=actual_selection.get("digest") if actual_selection else None
                    actual=(provenance.get("file_sha256",meta.get("original_pdf_sha256")),provenance.get("parser_result_sha256",meta.get("source_IR_sha256")),mask_claim)
                    self.expect("runtime_versions", job_id + " actual PDF/IR/input-mask binding",actual,(source["original_pdf_sha256"],source["source_IR_sha256"],job["source_selection_sha256"]))
                actual_mask = self.read_json(directory / "source-selection.json")
                self.expect("runtime_versions", job_id + " actual run mask matches frozen mask", actual_mask, mask)
                actual_plan = self.read_json(directory / "batch-plan.json")
                planned = self.read_json(self.base / "selection-masks" / (job_id+"-batch-plan.json"))
                self.expect("runtime_versions", job_id + " actual batches match frozen batches", actual_plan, planned)
                if coverage.get("whole_document_summary_complete"):
                    summary_artifact=self.read_json(directory/"whole-document-summary.json",pending_if_missing=True)
                    if summary_artifact:
                        self.expect("report_consistency",job_id+" summary is backed by actual summary artifact",summary_artifact.get("summary"),result.get("summary"))
                limits = result.get("operation_limits", {})
                if recovery and not limits:
                    self.note("authorization",job_id+" normal terminal operation-limits artifact unavailable after interruption","warning",
                              "Frozen runner/registered options declare 1800s/16/request120s; recovery does not invent a normal terminal limits measurement.")
                    view=self.register.get("common_model_view",{})
                    self.expect("authorization",job_id+" preserved configured paper limits",(view.get("document_timeout_ms"),view.get("batch_max_responses"),self.register.get("shared_limits",{}).get("request_seconds")),(1_800_000,16,120))
                else:
                    self.expect("authorization", job_id + " effective paper 1800s/16 responses/request120s", (limits.get("document_timeout_ms"),limits.get("batch_max_responses"),limits.get("request_seconds")), (1_800_000,16,120))
            for key in ("medical_quality_approved", "human_gold_complete", "formal_model_selected"):
                self.expect("approval_boundary", job_id + " " + key, result.get(key), False)
            records = [v["record"] for v in result.get("records", [])]
            self.expect("candidate_sources", job_id + " latest candidate count", result.get("candidate_count"), len(records))
            errors, checked = [], 0
            for record in records:
                if record.get("document_id") != job["document_id"] or record.get("source_version", {}).get("file_sha256") != doc["file_sha256"]:
                    errors.append(record.get("record_id", "unknown")+":wrong_document_or_PDF")
                for segment in nested_segments(record):
                    block = blocks.get(segment["block_id"])
                    if not block or segment["text_version"] != doc["text_version"] or not 0 <= segment["start"] < segment["end"] <= len(block["text"]) or block["text"][segment["start"]:segment["end"]] != segment["exact_quote"]:
                        errors.append(record.get("record_id", "unknown")+":invalid_unicode_source_span")
                    elif "physical_page" in segment and segment["physical_page"] != block["page"]:
                        errors.append(record.get("record_id", "unknown")+":invalid_physical_page")
                    checked += 1
                span = record.get("quote_span", {})
                if len(span.get("segments", [])) > 1 and span.get("contiguous_source_quote"):
                    errors.append(record.get("record_id", "unknown")+":multifragment_claimed_contiguous")
            self.require("candidate_sources", job_id + " all evidence slices roundtrip to original source", not errors, {"checked_intervals":checked,"errors":errors})
            self.counts.setdefault("validated_candidate_source_intervals", 0)
            self.counts["validated_candidate_source_intervals"] += checked if job["independent_model_run"] else 0

    def review_exports(self):
        export=self.read_json(self.base/"candidates-with-original-evidence.json",pending_if_missing=True,mutable=True)
        if export is not None:
            rows=export.get("rows",[])
            expected={(job_id,version["record"]["record_id"],version["version"]):version["record"]
                      for job_id,result in self.results.items() for version in result.get("records",[])}
            actual={(r["job_id"],r["record_id"],r["version"]):r for r in rows}
            self.expect("review_exports","candidate export identities include actual aliases without new measurements",set(actual),set(expected),live=True)
            self.expect("review_exports","candidate export has no duplicate logical identity",len(actual),len(rows),live=True)
            differences=[]
            for key,record in expected.items():
                row=actual.get(key)
                if row and (row.get("original_record")!=record or row.get("quote_segments")!=record.get("quote_span",{}).get("segments") or row.get("medical_approval") is not False):
                    differences.append(key)
            self.require("review_exports","candidate export preserves exact original records and source segments",not differences,differences,live=True)
        raw=self.read_bytes(self.base/"source-selection-audit.csv",pending_if_missing=True,mutable=True)
        if raw is not None:
            rows=list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))))
            expected={(job_id,e["block_id"]):e for job_id,mask in self.masks.items() for e in mask["entries"]}
            actual={(r["job_id"],r["block_id"]):r for r in rows}
            self.expect("review_exports","every source line and condition appears once in selection CSV",(set(actual),len(rows)),(set(expected),len(expected)),live=True)
            differences=[]
            documents={job["job_id"]:self.docs[job["document_id"]] for job in self.register["jobs"] if job["document_id"] in self.docs}
            for key,entry in expected.items():
                row=actual.get(key)
                if row is None:
                    continue
                original=documents[key[0]]["blocks"][entry["document_line_index"]]["text"]
                if (row.get("exact_original_source_line")!=original or row.get("text_sha256")!=entry["text_sha256"] or
                        row.get("state")!=entry["state"] or row.get("document_line_index")!=str(entry["document_line_index"])):
                    differences.append(key)
            self.require("review_exports","CSV source text, state and source-index binding are unchanged",not differences,differences,live=True)

    def frozen_posthoc(self):
        if self.delivery_mode=="stopped-handoff" and not (self.base/"outputs-freeze.json").exists() and not (self.base/"posthoc-ai-reference-review.json").exists():
            self.note("posthoc","stopped experiment has no final optimization freeze or AI comparison","deferred",
                      "No five-condition comparison or medical score is inferred from a stopped handoff.",scope="experiment")
            return
        freeze = self.read_json(self.base / "outputs-freeze.json", pending_if_missing=True, mutable=True)
        posthoc = self.read_json(self.base / "posthoc-ai-reference-review.json", pending_if_missing=True, mutable=True)
        if not freeze or not posthoc:
            self.note("posthoc", "posthoc comparison waits for all real outputs and explicit freeze", "pending")
            return
        self.require("posthoc", "freeze was not made while paper outputs were pending", self.all_terminal)
        self.expect("posthoc", "freeze uses actual implementation revision", freeze.get("source_snapshot"), self.register["source_snapshot"]["digest"])
        for path, expected in freeze.get("artifacts", {}).items():
            self.file_hash(path, expected, "outputs_freeze")
        physical_results = {self.label(self.path(j["result_path"])) for j in self.register["jobs"] if j["independent_model_run"] and j.get("result_path")}
        frozen_results = {self.label(self.path(path)) for path in freeze.get("artifacts", {})}
        self.require("posthoc", "all 5 actual outputs are included in freeze", physical_results <= frozen_results and len(physical_results)==5)
        self.expect("posthoc", "comparison ties to exact freeze object", posthoc.get("outputs_freeze"), freeze)
        for path, field in [(AI_DATA / "reference-drafts.json","AI_reference_sha256"),(AI_DATA / "source-anchor-index.json","anchor_index_sha256")]:
            raw = self.read_bytes(path)
            if raw:
                self.expect("posthoc", field, posthoc.get(field), hash_bytes(raw))
        for key in ("not_precision_recall_f1_or_medical_scoring", "unlisted_model_candidates_are_not_false_positives", "unresolved_locations_are_not_forced_into_a_recall_denominator", "whole_line_output_overlap_is_not_same_feature_assertion"):
            self.expect("posthoc", key, posthoc.get(key), True)
        anchors = {r["reference_id"]:r for r in getattr(self,"anchors",{}).get("records",[])}
        jobs = {j["job_id"]:j for j in self.register["jobs"]}
        comparisons = posthoc.get("comparisons", [])
        expected_pairs = {(job_id,ref_id) for job_id,j in jobs.items() for ref_id,r in anchors.items() if j["document_id"]==r["document_id"]}
        self.expect("posthoc", "all logical-reference pairs, without pretending independent trials", {(c["job_id"],c["reference_id"]) for c in comparisons}, expected_pairs)
        self.expect("posthoc", "no duplicate logical-reference comparisons", len(comparisons),len(expected_pairs))
        errors = []
        for comparison in comparisons:
            job_id, ref_id = comparison["job_id"],comparison["reference_id"]
            anchor = anchors.get(ref_id)
            result = self.results.get(job_id)
            if not anchor or not result or job_id not in self.masks:
                errors.append((job_id,ref_id,"missing_actual_reference_or_result"));continue
            reliable = anchor["literal_coverage"]["row_eligible_for_fully_located_literal_comparison"]
            if comparison.get("AI_reference_only_not_gold") is not True or comparison.get("semantic_equivalence_or_medical_correctness_established") is not False or comparison.get("row_fully_located_for_literal_comparison") != reliable:
                errors.append((job_id,ref_id,"incorrect_AI_or_row_eligibility_status"))
            if not reliable and (comparison.get("all_source_units_in_selected_input") is not None or comparison.get("all_source_units_have_literal_output_interval_coverage") is not None):
                errors.append((job_id,ref_id,"unresolved_row_forced_to_zero_or_boolean"))
            kept = set(self.masks[job_id]["kept_block_ids"])
            completed = set(result.get("coverage",{}).get("completed_source_block_ids",[]))
            records = self.literal_comparison_records(result)
            actual_units = comparison.get("units",[])
            if len(actual_units)!=len(anchor["units"]):
                errors.append((job_id,ref_id,"unit_count_differs"));continue
            for actual, original in zip(actual_units,anchor["units"]):
                good = original["usable_for_literal_block_retention"]
                segments = original["unique_source_segments"]
                expected = (all(s["block_id"] in kept for s in segments),all(s["block_id"] in completed for s in segments),all(covered(s,records) for s in segments)) if good and segments else (None,None,None)
                fields = ("all_required_blocks_retained","all_required_blocks_explicitly_completed","output_literal_source_intervals_covered")
                if tuple(actual.get(k) for k in fields)!=expected or actual.get("reliable_unique_location")!=good or actual.get("unique_source_segments")!=segments:
                    errors.append((job_id,ref_id,"unit_not_tied_to_real_source_or_output_intervals"))
                if actual.get("ambiguity_not_resolved_by_choosing_first") is not True:
                    errors.append((job_id,ref_id,"ambiguous_source_selected_without_adjudication"))
        self.require("posthoc", "AI reference remains source-only with unresolved values null", not errors, errors)
        self.counts["posthoc_logical_reference_pairs"] = len(comparisons)

    def stopped_handoff(self):
        if self.delivery_mode!="stopped-handoff":
            return
        for key in ("paid_inference_stopped","no_automatic_resume","requested_model_identity_unverified"):
            self.expect("stopped_handoff","report "+key,self.report.get(key),True,live=True)
        self.expect("stopped_handoff","register disallows automatic paid resume",self.register.get("no_automatic_resume"),True,live=True)
        if hasattr(self,"ledger"):
            self.require("stopped_handoff","ledger has an explicit model-identity stop reason","identity" in str(self.ledger.get("halted","")).lower(),live=True)
        terminal=self.read_json(self.base/"model-identity-pause-terminal.json",pending_if_missing=True)
        recovery=self.read_json(self.base/"interrupted-recovery.json",pending_if_missing=True)
        if terminal:
            snapshot_ledger=None
            for original,item in terminal.get("before_termination_snapshots",{}).items():
                self.file_hash(item["snapshot"],item["sha256"],"stopped_handoff_preservation")
                if original.endswith("call-ledger.json"):
                    snapshot_ledger=self.read_json(item["snapshot"])
                elif original.endswith((".sqlite",".sqlite-wal")):
                    self.file_hash(original,item["sha256"],"stopped_handoff_preservation")
            if snapshot_ledger and hasattr(self,"ledger"):
                before=snapshot_ledger["requests"];after=self.ledger["requests"]
                self.expect("stopped_handoff","no extra inference request after process stop",[r["id"] for r in after],[r["id"] for r in before])
                allowed_ids=set(terminal.get("terminated_inflight_request_ids",[]))
                errors=[]
                for old,new in zip(before,after):
                    changed={k for k in set(old)|set(new) if old.get(k)!=new.get(k)}
                    allowed={"finished_at","usage_status","error_code","manual_terminal_accounting"} if old["id"] in allowed_ids else set()
                    if changed-allowed:
                        errors.append({"request":old["id"],"unexpected_changed_fields":sorted(changed-allowed)})
                    if old["id"] in allowed_ids and ("input_tokens" in new or "output_tokens" in new or new.get("usage_status")!="missing_usage_conservative_reservation" or
                                                    old["input_ceiling"]!=new["input_ceiling"] or old["output_ceiling"]!=new["output_ceiling"]):
                        errors.append({"request":old["id"],"unknown_usage_was_not_preserved":True})
                self.require("stopped_handoff","only explicit terminal bookkeeping changes; original unknown reservation intact",not errors,errors)
                self.expect("stopped_handoff","pause receipt physical inference count",terminal.get("requests"),len(after))
        if recovery:
            self.file_hash(recovery["recovery_result"],recovery["recovery_result_sha256"],"stopped_handoff_preservation")
            restored=self.read_json(recovery["recovery_result"])
            if restored:
                actual=(restored.get("candidate_count"),restored.get("candidate_versions"),restored.get("coverage",{}).get("explicitly_completed_source_blocks"),restored.get("coverage",{}).get("whole_document_summary_complete"))
                self.expect("stopped_handoff","recovery counts and interrupted summary match actual preserved artifact",actual,(recovery.get("candidate_count"),recovery.get("versions"),recovery.get("completed_emitted_source_blocks"),recovery.get("summary_completed")))
                self.expect("stopped_handoff","recovery is diagnostic old-revision output, not verified model success",(restored.get("recovery_only_no_new_inference"),restored.get("model_identity_verified"),restored.get("only_diagnostic_data_not_a_verified_Luna_condition")),(True,False,True))
                self.expect("runtime_versions","recovered data retains original actual-run code revision",restored.get("source_snapshot_digest"),self.register["source_snapshot"]["digest"])
            self.expect("stopped_handoff","new source guard cannot relabel old paid snapshot",recovery.get("new_source_guard_tests_cannot_relabel_this_old_snapshot"),True)
        probe=self.register.get("probe",{})
        self.expect("stopped_handoff","probe protocol success is not an authorized identity pass",
                    (probe.get("protocol_tool_chain_success"),probe.get("model_identity_verified"),probe.get("not_authorized_identity_pass"),probe.get("success")),(True,False,True,False))
        resume=self.read_json(self.base/"no-auto-resume.json",pending_if_missing=True)
        if resume:
            expected={"inference_ledger_requests":self.counts["inference_ledger_requests"],"read_only_metadata_http_requests":self.counts["metadata_http_requests"],
                      "combined_authorized_physical_requests_used":self.counts["combined_requests_against_300_cap"],"combined_remaining_requests":300-self.counts["combined_requests_against_300_cap"],
                      "known_input_tokens_including_cache":self.counts["known_input"],"unknown_input_reservation":self.counts["reserved_input"],
                      "remaining_input_after_known_and_reservation":6_000_000-self.counts["known_input"]-self.counts["reserved_input"],
                      "known_output_tokens_including_reasoning":self.counts["known_output"],"unknown_output_reservation":self.counts["reserved_output"],
                      "remaining_output_after_known_and_reservation":400_000-self.counts["known_output"]-self.counts["reserved_output"]}
            self.expect("stopped_handoff","no-resume receipt has exact known/unknown/remaining scope",{k:resume.get(k) for k in expected},expected)
            self.expect("stopped_handoff","future registration carries consumed/reserved budget without resetting original wall clock",
                        (resume.get("original_experiment_started_at"),resume.get("original_wall_clock_limit_seconds"),resume.get("waiting_does_not_reset_wall_clock"),
                         resume.get("conservative_input_used"),resume.get("conservative_output_used"),resume.get("new_directory_or_registration_must_carry_forward_all_consumed_and_reserved_budget")),
                        (getattr(self,"ledger",{}).get("experiment_started_at"),7200,True,self.counts["known_input"]+self.counts["reserved_input"],self.counts["known_output"]+self.counts["reserved_output"],True))
        # Current guard is a new delivery revision, independently fingerprinted by its own tests.
        witnesses=[]
        changed={r["path"]:r["current_delivery_sha256"] for r in self.current_revision_changes}
        validation_dir=self.base/"runtime-validation"
        for receipt_path in sorted(validation_dir.glob("*.result.json")):
            if not any(word in receipt_path.name.lower() for word in ("identity","guard")):
                continue
            receipt=self.read_json(receipt_path)
            if not receipt or receipt.get("exit_code")!=0:
                continue
            name=receipt_path.name.removesuffix(".result.json")
            before_path=validation_dir/(name+".sources-before.json");after_path=validation_dir/(name+".sources-after.json")
            if not before_path.exists() or not after_path.exists():
                continue
            before,after=self.read_json(before_path),self.read_json(after_path)
            def file_map(sample):
                values=dict(sample.get("hashes",{}))
                values.update({f["path"]:f["sha256"] for f in sample.get("files",[])})
                values.update({f["path"]:f["sha256"] for f in sample.get("scripts",[])})
                return values
            a,b=file_map(before),file_map(after)
            if a!=b:
                self.note("guard_revision",name+" code changed during verification","failed");continue
            self.read_bytes(receipt["log"])
            covered_changes={path for path,value in changed.items() if b.get(path)==value}
            witnesses.append({"receipt":self.label(receipt_path),"current_changed_files_covered":sorted(covered_changes)})
        covered_changes={path for witness in witnesses for path in witness["current_changed_files_covered"]}
        guard_dir=self.base/"model-identity-guard"
        summary=self.read_json(guard_dir/"guard-validation-summary.json",pending_if_missing=True)
        if summary:
            self.guard_summary=summary
            self.expect("guard_revision","guard revision has explicit separate validation schema",summary.get("schema_version"),"s4-response-model-guard-validation-1")
            self.expect("guard_revision","guard retains original paid-run digest and cannot relabel it",
                        (summary.get("paid_source_snapshot_digest"),summary.get("paid_results_relabelled_to_new_code")),(self.register["source_snapshot"]["digest"],False))
            self.expect("guard_revision","guard tests are local and do not verify supplier model identity",
                        (summary.get("real_supplier_validation"),summary.get("no_new_paid_requests"),summary.get("model_alias_mapping_approved")),(False,True,False))
            before=self.read_json(guard_dir/"validation-source-before.json")
            after=self.read_json(guard_dir/"validation-source-after.json")
            hashes=summary.get("source_hashes",{})
            if before and after:
                self.expect("guard_revision","modified files identical before/after all new guard checks",before.get("files"),after.get("files"))
                for path,expected in after.get("files",{}).items():
                    self.file_hash(path,expected,"guard_revision")
                    self.expect("guard_revision",path+" belongs to new guard snapshot",hashes.get(path),expected)
            snapshot=self.path(summary["new_source_snapshot"])
            manifest=self.read_json(snapshot/"manifest.json")
            if manifest:
                self.expect("guard_revision","new guard source manifest",manifest,{"digest":summary["new_source_digest"],"hashes":hashes})
            self.expect("guard_revision","new guard source digest (sorted Python JSON)",hash_bytes(json.dumps(hashes,sort_keys=True).encode()),summary.get("new_source_digest"))
            for path,expected in hashes.items():
                self.file_hash(path,expected,"guard_revision")
                self.file_hash(snapshot/path,expected,"guard_revision")
            for name in ("focused_tests","extraction_suite","typecheck"):
                receipt=summary.get(name,{})
                self.expect("guard_revision",name+" actual exit code",receipt.get("exit_code"),0)
                raw=self.read_bytes(receipt.get("log",""))
                if raw and name!="typecheck":
                    log=raw.decode("utf-8",errors="replace")
                    for label,key in (("pass","passed"),("fail","failed")):
                        found=node_test_counts(log,label)
                        self.require("guard_revision",name+" raw Node summary "+label+" matches receipt",bool(found) and int(found[-1])==receipt.get(key),{"observed":found[-1] if found else None,"receipt":receipt.get(key)})
                elif name=="typecheck":
                    self.expect("guard_revision","new guard typecheck passed",receipt.get("passed"),True)
            self.expect("guard_revision","focused 5 are a subset of full 144, not additive",
                        (summary.get("focused_tests",{}).get("passed"),summary.get("focused_tests",{}).get("subset_of_full_extraction_suite"),summary.get("extraction_suite",{}).get("passed")),(5,True,144))
            exact={path for path,value in changed.items() if hashes.get(path)==value and after and after.get("files",{}).get(path)==value}
            witnesses.append({"receipt":self.label(guard_dir/"guard-validation-summary.json"),"current_changed_files_covered":sorted(exact)})
            covered_changes.update(exact)
        if witnesses and set(changed)<=covered_changes:
            self.note("guard_revision","new guard tests fingerprint current delivery revision separately from old inference","passed")
        else:
            self.note("guard_revision","new guard revision verification still required","pending",{"changed_files":changed,"covered":sorted(covered_changes),"witnesses":witnesses})
        self.counts["current_guard_revision_test_witnesses"]=witnesses

    def validation_versions(self):
        base = self.base / "runtime-validation"
        source_hashes = self.register.get("source_snapshot",{}).get("hashes",{})
        checked = []
        for summary_name in ("budget-validation-summary.json","post-freeze-validation-summary.json"):
            summary = self.read_json(base / summary_name, pending_if_missing=True)
            if not summary:
                continue
            runs = summary.get("validation_runs",summary.get("suite_results",summary.get("runs",[])))
            if isinstance(runs,dict):
                runs = list(runs.values())
            for run in runs:
                if not isinstance(run,dict) or "name" not in run:
                    continue
                name = run["name"]
                receipt = self.read_json(base / (name+".result.json"))
                if not receipt:
                    continue
                self.expect("test_evidence", name + " recorded exit code", receipt.get("exit_code"),0)
                raw = self.read_bytes(receipt["log"])
                if raw:
                    log = raw.decode("utf-8",errors="replace")
                    for label in ("tests","pass","fail","cancelled","skipped","todo"):
                        matches = node_test_counts(log,label)
                        expected = receipt.get("test_summary",{}).get(label)
                        if expected is not None and matches:
                            self.expect("test_evidence", name + " raw Node summary " +label,int(matches[-1]),expected)
                before_path, after_path = base/(name+".sources-before.json"),base/(name+".sources-after.json")
                if not before_path.exists() or not after_path.exists():
                    self.note("test_evidence", name + " exact historical code revision not fingerprinted", "warning", "Receipt/log retained; this run alone is not proof of equality to the final frozen version.")
                    continue
                before, after = self.read_json(before_path),self.read_json(after_path)
                if not before or not after:
                    continue
                maps = []
                for sample in (before,after):
                    maps.append(sample.get("hashes") or {f["path"]:f["sha256"] for f in sample.get("files",[])})
                self.expect("test_evidence", name + " before and after source file maps", maps[0],maps[1])
                before_digest = before.get("digest",before.get("aggregate_sha256"))
                after_digest = after.get("digest",after.get("aggregate_sha256"))
                self.expect("test_evidence", name + " receipts bind historical before/after revision", (receipt.get("source_sha256_before"),receipt.get("source_sha256_after")), (before_digest,after_digest))
                differences = {path:{"historical":value,"frozen":source_hashes[path]} for path,value in maps[0].items() if path in source_hashes and value!=source_hashes[path]}
                self.require("runtime_versions", name + " overlapping production code matches actual frozen experiment", not differences,differences)
                checked.append({"name":name,"historical_source_digest":before_digest,"production_files_crosschecked":len(set(maps[0])&set(source_hashes))})
            for item in summary.get("raw_logs_including_initial_failures",[]):
                self.file_hash(item["path"],item["sha256"],"test_evidence")
        self.counts["versioned_validation_runs"] = checked

    def local_references(self):
        path = self.base / "report.html"
        raw = self.read_bytes(path,pending_if_missing=True,mutable=True)
        if not raw:
            return
        if getattr(self,"supplier_differences",[]):
            self.require("supplier_model_identity","readable report discloses mismatched returned model label",b"igpt-6-luna" in raw,
                         "Initial report may predate the finding; a final report must disclose it.",live=True)
        parser = LocalLinks();parser.feed(raw.decode("utf-8"));parser.close()
        errors, external = [], []
        for link in parser.links:
            value = urlsplit(link)
            if value.scheme or value.netloc:
                external.append(link);continue
            if not value.path:
                continue
            target = (path.parent/unquote(value.path)).resolve()
            if not target.exists() or not target.is_file():
                errors.append(link)
            else:
                root_live = target.parent == self.base and target.name in {"report.json","report.html","source-selection-audit.csv","candidates-with-original-evidence.json","experiment-register.json","posthoc-ai-reference-review.json","outputs-freeze.json"}
                self.read_bytes(target, mutable=target in self.mutable or root_live)
        self.require("accessible_files", "all local report hyperlinks exist",not errors,errors,live=True)
        self.note("accessible_files", "external hyperlinks not fetched", "warning" if external else "passed",external if external else None)
        if self.report.get("AI_reference_posthoc_review"):
            self.read_bytes(self.base/self.report["AI_reference_posthoc_review"],pending_if_missing=True,mutable=True)

    def plan_sync(self):
        path = self.base/"plan-sync-preservation.json"
        if not path.exists():
            self.note("plan_sync", "DOCX/plan incremental preservation evidence", "pending" if self.require_plan else "deferred", "Run again with --require-plan-sync after the lead finishes plan synchronization.")
            return
        proof = self.read_json(path,mutable=True)
        if not proof:
            return
        for key in ("stage_passed","S5_started"):
            self.expect("plan_sync", key,proof.get(key),False)
        before_dir = self.base/"before-plan-sync"
        for item in proof.get("DOCX_preservation",[]):
            current = self.path(item["file"])
            before = before_dir/current.name
            self.file_hash(before,item["before_sha256"],"plan_sync")
            self.file_hash(current,item["after_sha256"],"plan_sync",mutable=True)
            before_raw,after_raw = self.read_bytes(before),self.read_bytes(current,mutable=True)
            if before_raw is None or after_raw is None:
                continue
            try:
                with zipfile.ZipFile(io.BytesIO(before_raw)) as a,zipfile.ZipFile(io.BytesIO(after_raw)) as b:
                    self.expect("plan_sync", current.name+" ZIP member names/order",a.namelist(),b.namelist())
                    altered = [name for name in a.namelist() if name!="word/document.xml" and a.read(name)!=b.read(name)]
                    self.require("plan_sync",current.name+" all other ZIP member contents unchanged",not altered,altered)
                    old,new = a.read("word/document.xml"),b.read("word/document.xml")
                    point = old.rfind(b"<w:sectPr")
                    if point<0:point=old.rfind(b"</w:body>")
                    delta = len(new)-len(old)
                    valid = point>=0 and delta>0 and new[:point]+new[point+delta:]==old
                    self.require("plan_sync",current.name+" original document.xml bytes preserved after one insertion",valid)
                    if valid:
                        ns="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                        fragment=ET.fromstring(b'<root xmlns:w="'+ns.encode()+b'">'+new[point:point+delta]+b'</root>')
                        self.expect("plan_sync",current.name+" appended paragraph count",len(fragment.findall("{"+ns+"}p")),item.get("appended_paragraphs"))
            except (OSError,ValueError,KeyError,zipfile.BadZipFile,ET.ParseError) as error:
                self.note("plan_sync",current.name+" archive/XML validation","failed",type(error).__name__)
        self.expect("plan_sync","2 requested DOCX preservation proofs",len(proof.get("DOCX_preservation",[])),2)
        for item in proof.get("JSON_updates",[]):
            current=self.path(item["file"]);before=before_dir/current.name
            self.file_hash(before,item["before_sha256"],"plan_sync")
            self.file_hash(current,item["after_sha256"],"plan_sync",mutable=True)
            old,new=self.read_json(before),self.read_json(current,mutable=True)
            if old and new:
                keys=("S2_preparation","S3_engineering","S3_continuation_history","stage_acceptances","quality_thresholds_frozen")
                self.expect("plan_sync",current.name+" S2/S3/gates not changed",{k:old.get(k) for k in keys},{k:new.get(k) for k in keys})
        for item in proof.get("CSV_updates",[]):
            current=self.path(item["file"]);before=before_dir/current.name
            self.file_hash(before,item["before_sha256"],"plan_sync")
            self.file_hash(current,item["after_sha256"],"plan_sync",mutable=True)
            old_raw,new_raw=self.read_bytes(before),self.read_bytes(current,mutable=True)
            if old_raw is None or new_raw is None:continue
            old=list(csv.reader(io.StringIO(old_raw.decode("utf-8-sig"))));new=list(csv.reader(io.StringIO(new_raw.decode("utf-8-sig"))))
            same_shape=len(old)==len(new) and old[0]==new[0] and all(len(a)==len(b) for a,b in zip(old,new))
            self.require("plan_sync",current.name+" CSV structure/header/order retained",same_shape)
            differences=[]
            if same_shape:
                stage=old[0].index("阶段");progress=old[0].index("工程进度")
                for row_no,(a,b) in enumerate(zip(old[1:],new[1:]),start=2):
                    for col,(x,y) in enumerate(zip(a,b)):
                        if x!=y and not (a[stage]=="S4" and col==progress):differences.append({"row":row_no,"column":old[0][col]})
            self.require("plan_sync",current.name+" only S4 progress cells changed",not differences,differences)
        if self.is_continuation:
            self.continuation_plan_handoff(proof,before_dir)
            return
        handoff=self.read_json(CODE/"docs/acceptance/s4/current-handoff.json",mutable=True)
        if handoff:
            selection=handoff.get("selection_optimization",{})
            self.expect("plan_sync","current handoff preserves stopped/pending gates",
                        (handoff.get("stage_passed"),handoff.get("S5_started"),handoff.get("no_automatic_resume"),handoff.get("no_paid_process_running_after_delivery")),(False,False,True,True))
            self.expect("plan_sync","current handoff request/accounting scope matches final report",selection.get("actual_accounting"),self.report.get("all_new_requests_including_probe_failure_retry"))
            self.expect("plan_sync","current handoff includes metadata and remaining combined requests",
                        (selection.get("combined_physical_requests"),selection.get("metadata_http_requests"),selection.get("remaining_requests")),
                        (self.counts.get("combined_requests_against_300_cap"),self.counts.get("metadata_http_requests"),300-self.counts.get("combined_requests_against_300_cap",0)))
            for key in ("record","readable_report","authorization","resume_constraints"):
                if selection.get(key):self.read_bytes(selection[key])
            files=handoff.get("files",{})
            current_manifest=self.read_json(files.get("current_engineering_source_manifest",""))
            paid_manifest=self.read_json(files.get("paid_selection_source_manifest",""))
            if current_manifest:
                self.expect("plan_sync","handoff current-source pointer names new guard revision",current_manifest.get("digest"),getattr(self,"guard_summary",{}).get("new_source_digest"))
            if paid_manifest:
                self.expect("plan_sync","handoff paid-source pointer names actual old inference revision",paid_manifest.get("digest"),self.register["source_snapshot"]["digest"])
            prior_handoff=self.read_json(before_dir/"current-handoff.json")
            if prior_handoff:
                self.expect("plan_sync","historical pre-selection source pointer retained",files.get("historical_pre_selection_engineering_source_manifest"),prior_handoff.get("files",{}).get("current_engineering_source_manifest"))
            for key,value in files.items():
                target=self.path(value)
                self.require("accessible_files","current handoff reference "+key,target.exists())
                if target.is_file():self.read_bytes(target,mutable=target in self.mutable)
        navigation=self.read_json(self.base/"legacy-index-navigation-preservation.json",pending_if_missing=True)
        if navigation:
            old_path=self.base/"before-legacy-index-navigation.html";new_path=self.path(navigation["file"])
            self.file_hash(old_path,navigation["before_sha256"],"legacy_navigation")
            self.file_hash(new_path,navigation["after_sha256"],"legacy_navigation",mutable=True)
            old,new=self.read_bytes(old_path),self.read_bytes(new_path,mutable=True)
            if old is not None and new is not None:
                common=0
                while common<min(len(old),len(new)) and old[common]==new[common]:common+=1
                delta=len(new)-len(old)
                self.require("legacy_navigation","old index bytes retained after one banner insertion",delta>0 and new[:common]+new[common+delta:]==old)
                parser=LocalLinks();parser.feed(new.decode("utf-8"));parser.close()
                for link in ("selection-optimization/report.html","selection-optimization/no-auto-resume.json"):
                    self.require("legacy_navigation","stopped handoff entry "+link,link in parser.links and (new_path.parent/link).is_file())

    def finish(self):
        for path,evidence in list(self.files.items()):
            try:
                after=hash_bytes(path.read_bytes())
            except OSError:
                after=None
            evidence["sha256_after_checks"]=after
            evidence["unchanged_during_check"]=after==evidence["sha256_at_read"]
            if not evidence["unchanged_during_check"]:
                self.note("consistent_read_snapshot",self.label(path),"pending" if path in self.mutable else "failed","File changed while the read-only checker ran; no final consistency claim can be made.")
        counts=Counter(c["status"] for c in self.checks)
        status="failed" if counts["failed"] else ("pending" if counts["pending"] or self.phase!="final" else "passed")
        if self.phase!="final":
            self.note("delivery_boundary","in-progress validation cannot be final delivery approval","pending")
            counts=Counter(c["status"] for c in self.checks)
        artifact_counts=Counter(c["status"] for c in self.checks if c.get("scope")!="experiment")
        consistency="failed" if artifact_counts["failed"] else ("pending" if artifact_counts["pending"] or self.phase!="final" else "passed")
        return {"schema_version":"s4-selection-artifact-validation-1","checked_at":datetime.now(timezone.utc).isoformat(),
                "phase":self.phase,"status":status,"final_artifact_checks_passed":status=="passed" and self.phase=="final",
                "delivery_mode":self.delivery_mode,"delivery_consistency_status":consistency,
                "stopped_handoff_artifact_checks_passed":self.delivery_mode=="stopped-handoff" and consistency=="passed",
                "experiment_completion_status":"blocked_pending" if not self.all_terminal or getattr(self,"supplier_differences",[]) else "terminal_outputs_still_not_medical_approval",
                "stage_passed":False,"medical_quality_approved":False,"formal_reviews_added":0,"api_calls":0,
                "writes_limited_to":"selection-optimization/artifact-validation/",
                "model_payload_byte_equivalence_proven":False,"strict_blinding_proven":False,
                "supplier_response_model_differences":getattr(self,"supplier_differences",[]),
                "comparative_conclusions_blocked_by_unverified_model_identity":bool(getattr(self,"supplier_differences",[])),
                "aliases_are_not_independent_retests":True,"DOCX_evidence_required":self.require_plan,
                "check_counts":dict(counts),"actual_ledger_recomputed":self.counts,
                "artifact_consistency_check_counts":dict(artifact_counts),"current_delivery_revision_changes":self.current_revision_changes,
                "checks":self.checks,"input_file_fingerprints":list(self.files.values()),
                "checker":{"path":str(Path(__file__).resolve()),"sha256":hash_bytes(Path(__file__).read_bytes()),"python":sys.version.split()[0]}}


class ContinuationAudit(Audit):
    """The same experiment, with an exact user-relayed alias and remaining caps."""
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        self.is_continuation=True
        self.prior_base=self.base.parent
        self.unapproved_response_names=[]
        self.confirmed_alias_requests=[]
        self.target_cohort=None
        self.pilot_registers={}

    def read_json(self,path,pending_if_missing=False,mutable=False):
        actual=self.path(path)
        # These two unchanged historical records are explicitly shared by the continuation.
        if actual.parent==self.base and actual.name in {"historical-ledger-preservation-before.json","identity-equivalence-limitation.json"} and not actual.exists():
            actual=self.prior_base/actual.name
        return super().read_json(actual,pending_if_missing,mutable)

    def file_hash(self,path,expected,group="source_preservation",mutable=False):
        if group=="current_vs_frozen_sources" and self.target_cohort and self.path(path)==CODE/"package.json":
            raw=self.read_bytes(path,mutable=mutable)
            if raw is not None and hash_bytes(raw)!=expected and (self.base/"concurrent-package-script-drift.json").exists():
                self.check_package_script_drift(raw,expected)
                return
        return super().file_hash(path,expected,group,mutable)

    def check_package_script_drift(self,current_raw,expected_sha):
        evidence=self.read_json(self.base/"concurrent-package-script-drift.json") or {}
        snapshot=self.register["source_snapshot"]
        frozen_raw=self.read_bytes(self.path(snapshot["directory"])/"package.json")
        copied_raw=self.read_bytes(self.base/"concurrent-package-scripts-current.json")
        if frozen_raw is None:return
        old,new=json.loads(frozen_raw),json.loads(current_raw)
        allowed={"predev:web":"tsx scripts/prepare-annotation-pdfs.ts",
                 "prebuild:web":"tsx scripts/prepare-annotation-pdfs.ts",
                 "prepare:annotation-pdfs":"tsx scripts/prepare-annotation-pdfs.ts",
                 "test:annotation":"tsx --test tests/annotation-ui/*.test.ts"}
        expected_changes={key:{"before":None,"after":value} for key,value in allowed.items()}
        actual_changes={key:{"before":old.get("scripts",{}).get(key),"after":new.get("scripts",{}).get(key)}
                        for key in old.get("scripts",{}).keys()|new.get("scripts",{}).keys()
                        if old.get("scripts",{}).get(key)!=new.get("scripts",{}).get(key)}
        self.expect("source_drift","only four explicitly disclosed new annotation scripts differ",actual_changes,expected_changes)
        self.expect("source_drift","all package JSON values outside scripts remain equal",
                    {k:v for k,v in new.items() if k!="scripts"},{k:v for k,v in old.items() if k!="scripts"})
        self.expect("source_drift","the four scripts are additions, with no pre-existing entries",set(old.get("scripts",{}))&set(allowed),set())
        self.expect("source_drift","concurrent package copy preserves exact observed bytes",copied_raw,current_raw)
        mismatches=[]
        for name,expected in snapshot["hashes"].items():
            raw=self.read_bytes(CODE/name)
            actual=hash_bytes(raw) if raw is not None else None
            if actual!=expected:mismatches.append({"file":name,"expected_sha256":expected,"current_sha256":actual})
        self.expect("source_drift","entire frozen manifest has exactly the disclosed package mismatch",mismatches,
                    [{"file":"package.json","expected_sha256":expected_sha,"current_sha256":hash_bytes(current_raw)}])
        self.expect("source_drift","disclosure is bound to exact source, counts and observed difference",
                    (evidence.get("schema_version"),evidence.get("frozen_source_snapshot"),evidence.get("frozen_manifest_total_files"),evidence.get("matching_current_files"),evidence.get("mismatches"),evidence.get("changed_script_entries")),
                    ("s4-concurrent-package-script-drift-1",snapshot["digest"],len(snapshot["hashes"]),len(snapshot["hashes"])-1,mismatches,actual_changes))
        self.expect("source_drift","original snapshot is retained and full workspace equality is not claimed",
                    (evidence.get("snapshot_rewritten"),evidence.get("concurrent_changes_reverted"),self.report.get("current_workspace_equals_entire_paid_snapshot")),(False,False,False))
        driver_raw=self.read_bytes(self.path(snapshot["directory"])/"scripts/run-s4-selection-reliability.ts")
        if driver_raw:
            driver=driver_raw.decode()
            self.require("source_drift","frozen driver loads config before owner lock and invokes document runner directly",
                         driver.index("config = loadModelConfig()")<driver.index("const lockPath =") and "await runExtractionDocument({" in driver and all(key not in driver for key in allowed))
        self.read_bytes(self.base/"concurrent-package-scripts.diff")
        change={"path":"package.json","experiment_sha256":expected_sha,"current_delivery_sha256":hash_bytes(current_raw),
                "strict_hash_equality_passed":False,"precise_changes":actual_changes,"independent_weight_or_unrecorded_environment_verification":False}
        self.current_revision_changes.append(change)
        self.package_drift=change
        self.note("current_vs_frozen_sources","package.json SHA256 equality FAILED; exact annotation-script drift retained","warning",change)

    def literal_comparison_records(self,result):
        if not self.target_cohort:return super().literal_comparison_records(result)
        return [v["record"] for v in result.get("records",[]) if v.get("status")=="active"
                and v["record"].get("review_status")!="rejected" and v["record"].get("evidence_validation",{}).get("quote_located") is True]

    def authorization(self):
        self.register=self.read_json(self.base/"experiment-register.json",mutable=True) or {}
        self.report=self.read_json(self.base/"report.json",pending_if_missing=True,mutable=True) or {}
        self.confirmation=self.read_json(self.base/"supplier-alias-confirmation.json") or {}
        self.carry=self.read_json(self.base/"budget-carry-forward.json") or {}
        self.prior_register=self.read_json(self.prior_base/"experiment-register.json") or {}
        if not self.register or not self.confirmation or not self.carry:return
        reg,confirmation,carry=self.register,self.confirmation,self.carry
        self.target_cohort=reg.get("cohort_id")
        self.pilot_registers={}
        for pilot in reg.get("pilot_cohorts",[]):
            self.file_hash(pilot["registry_path"],pilot["registry_sha256"],"cohort_history")
            history=self.read_json(pilot["registry_path"])
            if history:self.pilot_registers[pilot["cohort_id"]]=history
            self.expect("cohort_history",pilot["cohort_id"]+" excluded from main comparison",pilot.get("excluded_from_main_comparison"),True)
        self.expect("authorization","continuation schema",reg.get("schema_version"),"s4-selection-continuation-1")
        self.expect("authorization","exact alias confirmation schema",confirmation.get("schema_version"),"s4-supplier-exact-alias-confirmation-1")
        self.expect("authorization","supplier statement is user-relayed, without independent contact/weights claim",
                    (confirmation.get("source_kind"),confirmation.get("supplier_contacted_by_this_agent"),confirmation.get("independent_supplier_contact_or_weight_identity_verification_claimed")),
                    ("supplier_statement_relayed_by_user_in_main_session",False,False))
        self.expect("authorization","verbatim user confirmation preserved",confirmation.get("user_verbatim"),'官方回复：“是一个模型，这个是部署资源地区加的标识。”')
        pairs={(p.get("requested_model"),p.get("response_model")) for p in confirmation.get("exact_pairs",[])}
        self.expect("authorization","only the two confirmed exact name pairs",pairs,SUPPLIER_EXACT_PAIRS)
        for key,expected in (("wildcard_or_prefix_stripping_allowed",False),("other_names_must_halt",True),("original_response_model_values_must_be_preserved",True),("original_call_token_caps_unchanged",True)):
            self.expect("authorization","alias confirmation "+key,confirmation.get(key),expected)
        self.expect("authorization","outgoing requested model/effort remains authorized",(reg.get("requested_model_id"),reg.get("reasoning_effort")),("gpt-6-luna","medium"))
        policy=reg.get("response_model_alias_policy",{})
        self.expect("authorization","runtime allowlist is the single outgoing gpt-to-igpt exact pair",policy.get("exact_pairs"),[{"requested_model":"gpt-6-luna","response_model":"igpt-6-luna"}])
        self.expect("authorization","runtime alias policy tied to user confirmation",(policy.get("policy_id"),policy.get("source"),policy.get("recorded_at")),
                    (confirmation.get("confirmation_id"),str((self.base/"supplier-alias-confirmation.json").relative_to(PROJECT)),confirmation.get("recorded_at")))
        self.expect("budget_carry","carry-forward schema",carry.get("schema_version"),"s4-selection-budget-carry-forward-1")
        original_auth=self.read_json(carry["original_authorization"])
        if original_auth:
            self.expect("authorization","original user model and joint hard caps remain authoritative",
                        (original_auth.get("model_id"),original_auth.get("reasoning_effort"),original_auth.get("shared_hard_caps")),("gpt-6-luna","medium",CAPS))
            self.file_hash(carry["original_authorization"],self.prior_register.get("authorization_sha256"),"authorization")
        self.expect("budget_carry","old 133 requests remain separate historical scope",carry.get("historical_pre_selection_requests"),133)
        self.expect("budget_carry","same joint authorized caps",carry.get("joint_authorized_caps"),{"requests":300,"input_tokens":6_000_000,"output_tokens":400_000})
        self.expect("budget_carry","prior consumption remains explicit and conservative",
                    (carry.get("prior_selection_inference_requests"),carry.get("prior_metadata_http_requests"),carry.get("prior_combined_requests"),carry.get("prior_conservative_input_tokens"),carry.get("prior_conservative_output_tokens")),(28,1,29,279503,22617))
        self.expect("budget_carry","remaining caps, not a fresh full allowance",carry.get("continuation_caps"),CONTINUATION_CAPS)
        self.expect("budget_carry","caps add back to original joint allowance",
                    (carry["prior_combined_requests"]+carry["continuation_caps"]["requests"],carry["prior_conservative_input_tokens"]+carry["continuation_caps"]["input_tokens"],carry["prior_conservative_output_tokens"]+carry["continuation_caps"]["output_tokens"]),(300,6_000_000,400_000))
        self.expect("budget_carry","register embeds exact carry record",reg.get("budget_carry_forward"),carry)
        self.file_hash(carry["prior_ledger_path"],carry["prior_ledger_sha256"],"budget_carry")
        self.file_hash(self.prior_base/"experiment-register.json",carry["prior_registry_sha256"],"budget_carry")
        self.file_hash(self.prior_base/"model-catalog-readonly.json",carry["prior_model_metadata_sha256"],"budget_carry")
        prior=self.read_json(carry["prior_ledger_path"])
        self.prior_ledger=prior or {}
        if prior:
            values=numbers(prior["requests"])
            self.expect("budget_carry","old known usage and unknown reservation were not erased",
                        (values["requests"],values["known_input"],values["reserved_input"],values["known_output"],values["reserved_output"],values["unknown_usage"]),(28,157909,121594,14425,8192,1))
            self.expect("budget_carry","old start/window/halted record preserved",(prior.get("experiment_started_at"),prior.get("limits",{}).get("seconds"),prior.get("halted")),(carry["prior_wall_clock"]["started_at"],7200,"model_identity_unverified_manual_stop"))
        limits=reg.get("shared_limits",{})
        self.expect("budget_carry","new ledger caps equal only the remainder",{k:limits.get(k) for k in CONTINUATION_CAPS},CONTINUATION_CAPS)
        window=carry.get("continuation_operation_window",{})
        self.require("budget_carry","new local protection window is at most 10800s, without new user budget claim",
                     0<limits.get("seconds",0)<=window.get("max_seconds",0)<=10800 and window.get("user_added_budget_claimed") is False and window.get("separate_local_protection_window_starts_at_first_continuation_inference") is True)
        self.expect("authorization","configured request/document/session protections unchanged",(limits.get("request_seconds"),limits.get("document_seconds"),limits.get("batch_responses"),limits.get("response_output_tokens")),(120,1800,16,8192))
        self.expect("authorization","all five start fresh; old interrupted records stay historical",
                    (reg.get("restarted_from_beginning"),reg.get("prior_interrupted_results_are_historical"),carry.get("old_interrupted_candidates_remain_historical")),(True,True,True))
        self.expect("runtime_versions","original paid implementation snapshot remains separately identified",reg.get("original_paid_snapshot"),self.prior_register.get("source_snapshot"))
        self.expect("source_preservation","continuation original PDF/IR register is unchanged",reg.get("sources"),self.prior_register.get("sources"))
        prior_view=self.prior_register.get("common_model_view",{})
        host_fields={"host_instrumentation_snapshot","maximum_execution_concurrency","host_batch_protocol","medical_instruction_sha256","tool_schema_sha256"}
        view={k:v for k,v in reg.get("common_model_view",{}).items() if k not in host_fields}
        self.expect("runtime_versions","neutral source/contract/model/batch view unchanged",view,prior_view)
        frozen=reg.get("source_snapshot",{}).get("hashes",{})
        original=reg.get("original_paid_snapshot",{}).get("hashes",{})
        if self.target_cohort:
            self.reliability_protocol_controls()
        else:
            invariant_files=["packages/agent/src/source-selection.ts","packages/agent/src/extraction-run.ts","packages/agent/src/extraction-tools.ts","packages/agent/src/extraction-summary.ts","packages/agent/src/extraction-protocol.ts"]
            for path in invariant_files:
                self.expect("runtime_versions",path+" same as original frozen extraction rules/contracts",frozen.get(path),original.get(path))
        self.expect("authorization","two parallel physical runs are declared as host instrumentation",(reg.get("execution_concurrency"),reg.get("common_model_view",{}).get("maximum_execution_concurrency")),(2,2))
        for key in ("AI_reference_in_prompt_or_rule_tuning","association_enhancement","stage_passed","medical_quality_approved","S5_started"):
            self.expect("approval_boundary","continuation register "+key,reg.get(key),False)
        self.expect("reuse_limitations","source mask equivalence is not complete request identity or independent retest",reg.get("source_mask_equivalence_only_not_identical_full_requests_or_independent_retest"),True)
        if self.report:
            for key in ("stage_passed","medical_quality_approved","S5_started"):
                self.expect("approval_boundary","continuation report "+key,self.report.get(key),False)
            self.expect("approval_boundary","no medical strategy winner/default replacement",self.report.get("no_claim_of_best_medical_strategy_or_default_replacement"),True)
            review=self.read_json(CODE/"docs/acceptance/s4/review-index.json")
            if review:self.expect("approval_boundary","same S4 formal review counter",self.report.get("formal_review_count",{}).get("used"),review.get("formal_astra_reviews_used"),live=True)
        self.note("limitations","confirmed alias source boundary","warning","Exact name equivalence is accepted from the user's relayed supplier statement; the checker did not contact the supplier or independently verify model weights.")

    def reliability_protocol_controls(self):
        controls=self.read_json(self.base/"reliability-v2-control-manifest.json")
        tools=self.read_json(self.base/"reliability-v2-tool-schema-control.json")
        revision=self.read_json(self.base/"reliability-v2-authorization.json")
        self.revision_authorization=revision or {}
        if not controls or not tools or not revision:return
        self.expect("protocol_controls","predefined main comparison cohort",self.target_cohort,"reliability-v2-main")
        self.expect("protocol_controls","register embeds exact medical instruction controls",self.register.get("reliability_controls"),controls)
        self.expect("protocol_controls","system/batch/summary instruction literal hashes unchanged",controls.get("medical_instruction_literal_sha256"),controls.get("pilot1_medical_instruction_literal_sha256"))
        self.expect("protocol_controls","model/scope/timeout/retry constraints",
                    (controls.get("model_id"),controls.get("reasoning_effort"),controls.get("batch_options"),controls.get("document_seconds"),controls.get("request_seconds"),controls.get("batch_max_responses"),controls.get("max_output_tokens"),controls.get("max_transient_retries")),
                    ("gpt-6-luna","medium",{"maxCodePoints":8500,"maxBlocks":128,"contextBlocks":6},1800,120,16,8192,2))
        self.expect("protocol_controls","scope hash (sorted Python JSON control format)",hash_bytes(json.dumps(self.register["common_model_view"]["scope"],sort_keys=True).encode()),controls.get("scope_sha256"))
        for path,digest in controls.get("unchanged_source_selection_scope_batch_medical_evidence_contract_files",{}).items():
            self.expect("protocol_controls",path+" unchanged control",self.register["source_snapshot"]["hashes"].get(path),digest)
            self.expect("protocol_controls",path+" original control",self.register["original_paid_snapshot"]["hashes"].get(path),digest)
        old_tools={t["name"]:t for t in tools.get("old",[])};new_tools={t["name"]:t for t in tools.get("new",[])}
        changed=sorted(name for name in set(old_tools)|set(new_tools) if old_tools.get(name)!=new_tools.get(name))
        self.expect("protocol_controls","only diagnostic tool schema/help changed",changed,["report_context_issue"])
        self.expect("protocol_controls","new diagnostic schema uses optional host-bound line_indices",
                    (new_tools.get("report_context_issue",{}).get("parameters",{}).get("required"),set(new_tools.get("report_context_issue",{}).get("parameters",{}).get("properties",{}))),(["reason"],{"reason","line_indices"}))
        for kind in ("old","new"):
            self.expect("protocol_controls",kind+" effective tool schema hash",hash_bytes(js_json(tools[kind])),tools.get(kind+"_tool_schema_sha256"))
        self.expect("protocol_controls","effective batch protocol",(controls.get("host_batch_protocol"),tools.get("batch_protocol"),self.register["common_model_view"].get("host_batch_protocol")),("s4-unified-batch-lines-6",)*3)
        self.expect("protocol_controls","register reports real new tool schema, not whole-request equality",self.register["common_model_view"].get("tool_schema_sha256"),tools["new_tool_schema_sha256"])
        self.expect("protocol_controls","reliability changes are not claimed as medical filter improvement",controls.get("reliability_changes_not_medical_rule_or_filter_improvement"),True)
        pilot=next(iter(self.pilot_registers.values()),None)
        if pilot:
            roots=[self.path(pilot["source_snapshot"]["directory"]),self.path(self.register["source_snapshot"]["directory"])]
            token_pattern=re.compile(r"'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`",re.S)
            literal_fingerprints={}
            for label,marker in (("batch","promptExtractionSession(created,"),("summary","promptExtractionSession(summarySession,")):
                values=[]
                for root in roots:
                    raw=self.read_bytes(root/"packages/agent/src/extraction-run.ts")
                    if raw is None:break
                    text=raw.decode();start=text.index(marker)+len(marker);end=text.index(", budget, signal",start)
                    values.append(token_pattern.findall(text[start:end]))
                if len(values)==2:
                    self.expect("protocol_controls",label+" actual frozen instruction literal tokens unchanged",values[0],values[1])
                    literal_fingerprints[label]=[hash_bytes(js_json(v)) for v in values]
            system=[]
            for root in roots:
                raw=self.read_bytes(root/"packages/agent/src/extraction-pi.ts")
                if raw is None:break
                match=re.search(r"export const EXTRACTION_SYSTEM_RULES = (`(?:\\.|[^`\\])*`)",raw.decode(),re.S)
                system.append(match.group(1) if match else None)
            if len(system)==2:self.require("protocol_controls","actual frozen system instruction literal unchanged",system[0] is not None and system[0]==system[1])
            self.counts["independent_medical_instruction_literal_source_fingerprints"]=literal_fingerprints
        self.expect("cohort_history","revision decision retains every pilot attempt and original operation start",
                    (revision.get("allpilot1_attempts_retained_not_main_cohort"),revision.get("same_ledger_and10800second_start_retained")),(True,True))

    def source_integrity(self):
        original=self.register
        self.register={**original,"old_s4_requests_preserved":133}
        try:super().source_integrity()
        finally:self.register=original
        for cohort,history in self.pilot_registers.items():
            snapshot=history["source_snapshot"];directory=self.path(snapshot["directory"])
            self.expect("cohort_history",cohort+" archived source digest",hash_bytes(js_json(snapshot["hashes"])),snapshot["digest"])
            for path,expected in snapshot["hashes"].items():self.file_hash(directory/path,expected,"cohort_history")

    def masks_and_reuse(self):
        original=self.register
        jobs=[{**job,"model_visible_source_input_sha256":job.get("source_mask_and_task_contract_sha256")} for job in original["jobs"]]
        self.register={**original,"jobs":jobs,"common_model_view":self.prior_register["common_model_view"]}
        try:super().masks_and_reuse()
        finally:self.register=original
        for job in original["jobs"]:
            self.expect("reuse",job["job_id"]+" original logical identity retained",job.get("old_job_id"),job["job_id"])
            if self.target_cohort:self.expect("cohort_selection",job["job_id"]+" belongs only to target main protocol",job.get("cohort_id"),self.target_cohort)
            for suffix in (".json","-batch-plan.json"):
                path=Path("selection-masks")/(job["job_id"]+suffix)
                a,b=self.read_bytes(self.prior_base/path),self.read_bytes(self.base/path)
                if a is not None and b is not None:self.expect("mask_bindings",str(path)+" byte-identical to original frozen input",hash_bytes(b),hash_bytes(a))

    def build_attempt_catalog(self):
        self.attempt_catalog={}
        self.attempts_by_job=defaultdict(list)
        self.attempts_by_cohort=defaultdict(list)
        self.requests_by_attempt=defaultdict(list)
        self.cohort_request_groups=defaultdict(list)
        errors=[]
        cohorts=[*self.pilot_registers.items(),(self.target_cohort,self.register)]
        for cohort,registry in cohorts:
          for job in registry.get("jobs",[]):
            if not job.get("independent_model_run"):continue
            snapshots=[*job.get("attempts",job.get("attempt_history",[])),job]
            seen=set()
            for snapshot in snapshots:
                run=snapshot.get("run_id")
                if not run or run in seen:continue
                seen.add(run)
                attempt=snapshot.get("attempt_id") or (job.get("selected_attempt_id") if snapshot is job else None) or "initial"
                namespace=(cohort+":") if cohort and registry is self.register else ""
                expected=registry["batch_id"]+":"+namespace+("" if attempt=="initial" else attempt+":")+job["job_id"]
                if run!=expected:errors.append({"job":job["job_id"],"run_id":run,"expected":expected})
                if run in self.attempt_catalog:errors.append({"run_id":run,"error":"duplicate_attempt_identity"})
                record={"job_id":job["job_id"],"cohort_id":cohort,"source_snapshot":registry.get("source_snapshot",{}),"attempt_id":attempt,"run_id":run,"snapshot":snapshot,
                        "eligible_for_main_comparison":registry is self.register,
                        "selected":snapshot.get("result_path")==job.get("result_path") and run==job.get("run_id")}
                self.attempt_catalog[run]=record;self.attempts_by_cohort[cohort].append(record)
                if registry is self.register:self.attempts_by_job[job["job_id"]].append(record)
        self.require("attempt_lineage","all declared document attempts have separate fresh run identities",not errors,errors)

    def expected_result_run_id(self,job,representative_id):
        representative=next(j for j in self.register["jobs"] if j["job_id"]==representative_id)
        return representative.get("run_id",self.register["batch_id"]+":"+representative_id)

    def physical_requests_for_job(self,job):
        return self.requests_by_attempt.get(job.get("run_id"),[])

    def call_ledger(self):
        runtime=self.path(self.register["runtime_directory"])
        ledger=self.read_json(runtime/"call-ledger.json",pending_if_missing=True,mutable=True)
        if not ledger:return
        self.ledger=ledger
        self.build_attempt_catalog()
        entries=ledger.get("requests",[])
        self.counts=numbers(entries)
        self.expect("ledger","new ledger remainder limits",ledger.get("limits"),self.register.get("shared_limits"))
        self.expect("ledger","new ledger authorization ties to carry record",ledger.get("authorization"),self.register.get("budget_authorization"))
        self.expect("ledger","new ledger literal alias policy is frozen",ledger.get("response_model_alias_policy"),self.register.get("response_model_alias_policy"))
        self.expect("ledger","distinct new physical request IDs",len({e["id"] for e in entries}),len(entries))
        old_ids={e["id"] for e in self.prior_ledger.get("requests",[])}
        self.require("ledger","new directory does not reuse or overwrite old physical requests",not old_ids&{e["id"] for e in entries})
        extra_metadata=0
        metadata_path=self.base/"model-catalog-readonly.json"
        if metadata_path.exists():
            metadata=self.read_json(metadata_path) or {}
            extra_metadata=metadata.get("physical_http_requests",0)
        self.joint=carried_budget(self.carry,entries,extra_metadata)
        self.joint["joint_unknown_usage_requests"]=numbers(self.prior_ledger.get("requests",[]))["unknown_usage"]+self.counts["unknown_usage"]
        self.counts["joint_with_prior_consumption"]=self.joint
        caps=self.register["shared_limits"]
        self.require("ledger","new physical calls and conservative tokens stay within remainder",
                     len(entries)+extra_metadata<=caps["requests"] and self.counts["known_input"]+self.counts["reserved_input"]<=caps["input_tokens"] and self.counts["known_output"]+self.counts["reserved_output"]<=caps["output_tokens"],self.joint)
        self.require("ledger","old plus new actual/reserved totals stay within original joint cap",
                     self.joint["joint_combined_requests"]<=300 and self.joint["joint_conservative_input"]<=6_000_000 and self.joint["joint_conservative_output"]<=400_000,self.joint)
        errors=[]
        policy=self.register["response_model_alias_policy"]
        physical={j["job_id"] for j in self.register["jobs"] if j["independent_model_run"]}
        response_counts=Counter()
        for entry in entries:
            matches=[run for run in self.attempt_catalog if entry.get("purpose","").startswith(run+":")]
            run=max(matches,key=len) if matches else None
            group=self.attempt_catalog[run]["job_id"] if run else "unregistered"
            self.groups[group].append(entry)
            if run:
                self.requests_by_attempt[run].append(entry)
                self.cohort_request_groups[self.attempt_catalog[run]["cohort_id"]].append(entry)
            if not run or group not in physical:
                errors.append({"id":entry["id"],"error":"unregistered_or_alias_physical_request"})
            if entry.get("model_id")!="gpt-6-luna" or entry.get("requested_reasoning_effort") not in ("medium",None):
                errors.append({"id":entry["id"],"error":"unauthorized_outgoing_model_or_reasoning"})
            if entry.get("finished_at") and entry.get("requested_reasoning_effort")!="medium":
                errors.append({"id":entry["id"],"error":"finished_request_missing_medium_metadata"})
            if entry.get("input_ceiling",0)<max(32768,entry.get("payload_bytes",0)+512) or not 0<entry.get("output_ceiling",0)<=8192:
                errors.append({"id":entry["id"],"error":"nonconservative_request_reservation"})
            if entry.get("requested_max_output_tokens",8192)>8192 or entry.get("configured_deadline_ms",120000)>120000:
                errors.append({"id":entry["id"],"error":"per_request_operation_limit_exceeded"})
            if entry.get("usage_status")=="provider_reported" and (entry.get("input_tokens") is None or entry.get("output_tokens") is None):
                errors.append({"id":entry["id"],"error":"reported_usage_without_actual_tokens"})
            for key in ("input_tokens","output_tokens"):
                if key in entry.get("provider_usage",{}) and entry.get(key)!=entry["provider_usage"][key]:
                    errors.append({"id":entry["id"],"error":"raw_provider_usage_mismatch","field":key})
            for child,parent in (("cache_read_tokens","input_tokens"),("reasoning_tokens","output_tokens")):
                if entry.get(parent) is not None and entry.get(child,0)>entry[parent]:errors.append({"id":entry["id"],"error":"cache_or_reasoning_not_subset"})
            observations=entry.get("response_model_observations",[])
            expected_status="unknown";first_explicit=None;has_explicit=False
            if entry.get("response_model_identity_evidence_scope")!="provider_reported_name_only_not_weight_identity_or_HTTP_body_replay":
                errors.append({"id":entry["id"],"error":"response_name_evidence_scope_missing_or_overstated"})
            for observation in observations:
                observed=observation.get("actual_model")
                state=exact_response_name_status(entry.get("model_id"),observed,self.confirmation)
                literal="unknown" if state=="unknown" else "mismatch" if state=="unapproved_response_name" else "confirmed_alias" if state.startswith("exact_supplier_alias") else "matched"
                response_counts[literal]+=1
                if observation.get("status")!=literal or observation.get("expected_model")!=entry["model_id"] or observation.get("source")!="provider_stream_event.response.model":
                    errors.append({"id":entry["id"],"error":"observation_status_does_not_match_literal_raw_name"})
                if isinstance(observed,str) and not has_explicit:first_explicit=observed;has_explicit=True
                if literal=="confirmed_alias":
                    if (observation.get("alias_policy_id"),observation.get("alias_confirmation_source"))!=(policy["policy_id"],policy["source"]):
                        errors.append({"id":entry["id"],"error":"alias_observation_missing_user_confirmation_provenance"})
                    self.confirmed_alias_requests.append({"request_id":entry["id"],"raw_response_model":observed,"policy_id":policy["policy_id"],"source":policy["source"]})
                if literal=="mismatch":
                    self.unapproved_response_names.append({"request_id":entry["id"],"raw_response_model":observed})
                if expected_status!="mismatch" and literal!="unknown" and not (expected_status=="confirmed_alias" and literal=="matched"):expected_status=literal
            if entry.get("response_model_identity_status","unknown")!=expected_status:
                errors.append({"id":entry["id"],"error":"sticky_response_model_observation_state_incorrect"})
            if has_explicit and entry.get("provider_response_model")!=first_explicit:
                errors.append({"id":entry["id"],"error":"first_raw_model_name_overwritten_or_normalized"})
            if not has_explicit and entry.get("provider_response_model") is not None:
                errors.append({"id":entry["id"],"error":"raw_model_name_without_original_observation_provenance"})
        self.require("ledger","every physical request authorized, source-labelled, and conservatively counted",not errors,errors)
        self.require("supplier_model_identity","only exact user-confirmed aliases, no unrelated returned names",not self.unapproved_response_names,self.unapproved_response_names)
        self.counts["response_model_observation_status_counts"]=dict(response_counts)
        aliases_by_request={}
        for observation in self.confirmed_alias_requests:
            item=aliases_by_request.setdefault(observation["request_id"],{**observation,"matching_observation_count":0})
            item["matching_observation_count"]+=1
        self.confirmed_alias_requests=list(aliases_by_request.values())
        self.counts["confirmed_alias_physical_requests"]=len(self.confirmed_alias_requests)
        self.counts["confirmed_alias_observations"]=sum(r["matching_observation_count"] for r in self.confirmed_alias_requests)
        self.supplier_differences=[]  # Approved raw aliases are retained separately; they are no longer an unresolved mismatch.
        accounting_map={**REGISTER_ACCT,"provider_reported_cache_write_tokens_included_in_input":"cache_write"}
        self.compare_accounting("continuation register accounting excludes prior usage",self.register.get("accounting"),entries,accounting_map,live=True)
        if self.target_cohort:
            self.compare_accounting("target cohort accounting excludes all pilot1 attempts",self.register.get("target_cohort_accounting"),self.cohort_request_groups[self.target_cohort],accounting_map,live=True)
            for descriptor in self.register.get("pilot_cohorts",[]):
                self.file_hash(descriptor["ledger_at_end_path"],descriptor["ledger_at_end_sha256"],"cohort_history")
                snapshot=self.read_json(descriptor["ledger_at_end_path"])
                if not snapshot:continue
                prefix=snapshot["requests"]
                self.expect("cohort_history",descriptor["cohort_id"]+" every settled request unchanged before target append",entries[:len(prefix)],prefix)
                self.expect("budget_carry",descriptor["cohort_id"]+" same operation clock, no target reset",ledger.get("experiment_started_at"),snapshot.get("experiment_started_at"))
                self.compare_accounting(descriptor["cohort_id"]+" historical accounting remains independently bound",self.pilot_registers[descriptor["cohort_id"]].get("accounting"),self.cohort_request_groups[descriptor["cohort_id"]],accounting_map)
                at_start=carried_budget(self.carry,prefix)
                revision=self.revision_authorization
                self.expect("budget_carry","repair cohort started from jointly consumed old+pilot budget",
                            (revision.get("joint_requests_used"),revision.get("joint_conservative_input_used"),revision.get("joint_conservative_output_used")),
                            (at_start["joint_combined_requests"],at_start["joint_conservative_input"],at_start["joint_conservative_output"]))
                self.expect("budget_carry","repair-cohort remainder is not a new allocation",revision.get("remaining_joint_budget"),
                            {"requests":300-at_start["joint_combined_requests"],"input_tokens":6_000_000-at_start["joint_conservative_input"],"output_tokens":400_000-at_start["joint_conservative_output"]})
                later=[e["id"] for e in entries[len(prefix):] if not any(e["id"]==t["id"] for t in self.cohort_request_groups[self.target_cohort])]
                self.require("cohort_selection","no new pilot requests after target cohort starts",not later,later)
        expected={"requests":len(entries),"input_tokens":self.counts["known_input"]+self.counts["reserved_input"],"output_tokens":self.counts["known_output"]+self.counts["reserved_output"],"conservative_missing_usage_requests":self.counts["unknown_usage"]}
        self.expect("ledger","continuation register conservative local totals",{k:self.register.get("budget_totals",{}).get(k) for k in expected},expected,live=True)
        combined=self.register.get("combined_budget_totals",{})
        self.expect("ledger","continuation register joint totals carry old known and unknown usage",
                    (combined.get("requests"),combined.get("conservative_input_tokens"),combined.get("conservative_output_tokens"),combined.get("prior_ledger_unchanged")),
                    (self.joint["joint_combined_requests"],self.joint["joint_conservative_input"],self.joint["joint_conservative_output"],True),live=True)
        if entries:
            parse=lambda value:datetime.fromisoformat(value.replace("Z","+00:00"))
            start=parse(ledger["experiment_started_at"]);first=parse(entries[0]["started_at"])
            self.require("budget_carry","new local window starts at first continuation request",0<=(first-start).total_seconds()<=1)
            self.require("budget_carry","new physical requests start inside the declared local window",all(0<=(parse(e["started_at"])-start).total_seconds()<=caps["seconds"]+0.001 for e in entries))
        if self.counts["inflight"]:self.note("experiment_completion","no inflight continuation requests","pending",self.counts["inflight"])
        else:self.note("experiment_completion","no inflight continuation requests","passed")
        self.note("experiment_completion","continuation owner lock released","pending" if (runtime/"active-owner.lock").exists() else "passed")
        if self.report:
            # The report must expose the register's complete accounting, not silently mix old/new scopes.
            reported=self.report.get("joint_accounting",self.report.get("combined_budget_totals",self.report.get("joint_budget_totals")))
            if reported is None:
                self.note("ledger","report joint accounting schema awaits explicit binding","pending")
            else:
                self.expect("ledger","report combined physical/conservative totals",
                            (reported.get("requests"),reported.get("conservative_input_tokens"),reported.get("conservative_output_tokens")),
                            (self.joint["joint_combined_requests"],self.joint["joint_conservative_input"],self.joint["joint_conservative_output"]),live=True)
                if "joint_accounting" in self.report:
                    expected={"provider_input_tokens_including_cache":self.joint["joint_known_input"],"provider_output_tokens_including_reasoning":self.joint["joint_known_output"],
                              "unknown_input_reservation":self.joint["joint_unknown_input_reservation"],"unknown_output_reservation":self.joint["joint_unknown_output_reservation"],
                              "unknown_usage_requests":self.joint["joint_unknown_usage_requests"],"remaining_requests":300-self.joint["joint_combined_requests"]}
                    self.expect("ledger","report joint known/unknown/remaining scope",{k:reported.get(k) for k in expected},expected,live=True)
                    self.expect("ledger","report old 133 stays outside current joint authorization",self.report.get("historical_plus_current_joint_physical_requests"),133+self.joint["joint_combined_requests"],live=True)
            self.compare_accounting("report entire continuation ledger includes pilots and target",self.report.get("continuation_accounting"),entries,REPORT_ACCT,live=True)
            if self.target_cohort:
                target_entries=self.cohort_request_groups[self.target_cohort]
                self.compare_accounting("report main cohort excludes all pilot usage",self.report.get("target_cohort_accounting"),target_entries,REPORT_ACCT,live=True)
                self.expect("cohort_selection","report main cohort/source is the predefined repaired protocol",(self.report.get("target_cohort_id"),self.report.get("target_source_snapshot")),(self.target_cohort,self.register["source_snapshot"]),live=True)
                self.expect("response_identity","report raw returned-name distribution is target-only",
                            self.report.get("response_name_distribution"),dict(Counter(e.get("provider_response_model","not_yet_reported") for e in target_entries)),live=True)
                self.expect("response_identity","report raw identity status distribution is target-only",
                            self.report.get("response_identity_status_distribution"),dict(Counter(e.get("response_model_identity_status","unknown") for e in target_entries)),live=True)
                exported=self.read_json(self.base/"per-request-accounting.json",pending_if_missing=True,mutable=True)
                if exported:
                    exported_rows=exported.get("requests",[]);by_id={e["id"]:e for e in exported_rows};target_ids={e["id"] for e in target_entries};differences=[]
                    self.expect("ledger_export","every continuation physical request exported exactly once",(set(by_id),len(exported_rows)),({e["id"] for e in entries},len(entries)),live=True)
                    for entry in entries:
                        row=by_id.get(entry["id"],{})
                        cohort=self.target_cohort if entry["id"] in target_ids else "pilot1"
                        seconds=(datetime.fromisoformat(entry["finished_at"].replace("Z","+00:00"))-datetime.fromisoformat(entry["started_at"].replace("Z","+00:00"))).total_seconds() if entry.get("finished_at") else None
                        if any(row.get(k)!=v for k,v in entry.items()) or row.get("request_cohort")!=cohort or row.get("observed_request_seconds")!=seconds or row.get("single_environment_observation_not_causal_filter_effect") is not True:
                            differences.append(entry["id"])
                    self.require("ledger_export","export preserves all original names/observations/usage and actual cohort",not differences,differences,live=True)
        self.concurrency_timeline()

    def concurrency_timeline(self):
        errors=[];overall_peak=0;peaks={};cohort_times={}
        for cohort,registry in [*self.pilot_registers.items(),(self.target_cohort,self.register)]:
          active=set();started=set();finished=set();peak=0
          physical={j["job_id"] for j in registry["jobs"] if j["independent_model_run"]}
          times=[]
          for event in registry.get("actual_concurrency_timeline",[]):
            job=event.get("job_id")
            attempt=event.get("attempt_id","initial")
            run=event.get("run_id") or next((r for r,a in self.attempt_catalog.items() if a["cohort_id"]==cohort and a["job_id"]==job and a["attempt_id"]==attempt),None)
            if job not in physical:errors.append({"event":event,"error":"alias_or_unregistered_concurrent_run"})
            if run not in self.attempt_catalog:errors.append({"event":event,"error":"unregistered_concurrency_attempt"})
            if event.get("event")=="started":
                if run in started:errors.append({"run_id":run,"error":"same_document_attempt_started_twice"})
                started.add(run);active.add(run)
            elif event.get("event")=="finished":
                if run not in active:errors.append({"run_id":run,"error":"finish_without_active_start"})
                active.discard(run);finished.add(run)
            else:errors.append({"job":job,"error":"unknown_concurrency_event"})
            active_jobs={self.attempt_catalog[r]["job_id"] for r in active if r in self.attempt_catalog}
            if set(event.get("active_job_ids",[]))!=active_jobs or event.get("active_count")!=len(active) or len(active)>2 or len(active_jobs)!=len(active):
                errors.append({"job":job,"error":"concurrency_trace_or_limit_inconsistent"})
            peak=max(peak,len(active))
            if event.get("at"):times.append(event["at"])
          expected={a["run_id"] for a in self.attempts_by_cohort[cohort]}
          if registry is not self.register or self.all_terminal:self.expect("concurrency",str(cohort)+" all declared attempts finish without active runs",(started,finished,active),(expected,expected,set()))
          peaks[str(cohort)]=peak;overall_peak=max(overall_peak,peak)
          if times:cohort_times[cohort]=(min(times),max(times))
        self.require("concurrency","actual trace replays within 2 independent jobs",not errors,errors)
        self.counts["actual_peak_concurrency"]=overall_peak
        self.counts["actual_peak_concurrency_by_protocol_cohort"]=peaks
        if self.target_cohort in cohort_times:
            for cohort in self.pilot_registers:
                if cohort in cohort_times:self.require("concurrency",cohort+" owner ended before target protocol began",cohort_times[cohort][1]<=cohort_times[self.target_cohort][0])
        self.note("limitations","concurrent resource measurements are not isolated samples","warning","Two active document sessions share the Node process; latency/resource comparisons and source-mask aliases are not independent stochastic or isolated CPU/RSS trials.")

    def run_artifacts(self):
        super().run_artifacts()
        mapping={**REGISTER_ACCT,"provider_reported_cache_write_tokens_included_in_input":"cache_write"}
        incomplete=[];attempt_count=0
        for job in self.register["jobs"]:
            if not job["independent_model_run"]:continue
            attempts=self.attempts_by_job.get(job["job_id"],[])
            first_complete=None;failed_entries=[]
            for attempt in attempts:
                snapshot=attempt["snapshot"]
                path=snapshot.get("result_path")
                if not path:
                    self.note("attempt_lineage",attempt["run_id"]+" result not materialized","pending");continue
                actual=self.read_json(path,pending_if_missing=True)
                if not actual:continue
                attempt_count+=1
                entries=self.requests_by_attempt[attempt["run_id"]]
                self.compare_accounting(attempt["run_id"]+" all physical calls including failures/unknown",snapshot.get("accounting"),entries,mapping)
                registered_ids=snapshot.get("request_ids",snapshot.get("requests_ids"))
                if registered_ids is not None:
                    self.expect("attempt_lineage",attempt["run_id"]+" registered request IDs",registered_ids,[e["id"] for e in entries])
                if snapshot.get("result_sha256"):self.file_hash(path,snapshot["result_sha256"],"attempt_lineage")
                if snapshot.get("orchestration_script_sha256"):
                    driver=snapshot.get("orchestration_driver_snapshot")
                    self.require("runtime_versions",attempt["run_id"]+" retry driver snapshot is separately identified",bool(driver))
                    if driver:self.file_hash(driver,snapshot["orchestration_script_sha256"],"runtime_versions")
                    provenance=self.read_json(self.path(snapshot.get("directory",Path(path).parent))/"source-provenance.json")
                    if provenance:
                        self.expect("runtime_versions",attempt["run_id"]+" retry driver did not relabel core source or reset the window",
                                    (provenance.get("orchestration_script_sha256"),provenance.get("source_snapshot"),provenance.get("original_operation_window_not_reset")),
                                    (snapshot["orchestration_script_sha256"],self.register["source_snapshot"],True))
                coverage=actual.get("coverage",{})
                complete=not actual.get("error") and coverage.get("selected_source_block_processing_complete") and coverage.get("whole_document_summary_complete")
                if complete and first_complete is None:first_complete=attempt
                if not complete:
                    incomplete.append({"job_id":job["job_id"],"attempt_id":attempt["attempt_id"],"run_id":attempt["run_id"],"result_path":path,"error":actual.get("error")})
                    failed_entries.extend(entries)
                self.expect("attempt_lineage",attempt["run_id"]+" real result identity",actual.get("run_id"),attempt["run_id"])
                self.expect("attempt_lineage",attempt["run_id"]+" status reflects selected-source and summary completeness",snapshot.get("status"),"selected_input_finished_quality_pending" if complete else "engineering_incomplete")
                if not attempt["selected"]:
                    doc=self.docs[job["document_id"]];blocks={b["block_id"]:b for b in doc["blocks"]}
                    errors=[];checked=0
                    for version in actual.get("records",[]):
                        for segment in nested_segments(version["record"]):
                            block=blocks.get(segment["block_id"])
                            if not block or segment["text_version"]!=doc["text_version"] or block["text"][segment["start"]:segment["end"]]!=segment["exact_quote"]:
                                errors.append(version["record"]["record_id"])
                            checked+=1
                    self.require("attempt_lineage",attempt["run_id"]+" failed-attempt source evidence remains independently accessible",not errors,{"checked":checked,"errors":errors})
            if len(attempts)>1:
                self.expect("attempt_selection",job["job_id"]+" predeclared retry selection policy",job.get("selected_attempt_policy",job.get("selection_policy")),"first_complete_engineering_attempt_not_quality_or_speed")
                self.compare_accounting(job["job_id"]+" total cost includes every necessary attempt",job.get("all_attempts_accounting"),self.groups[job["job_id"]],mapping)
                self.compare_accounting(job["job_id"]+" failed attempts remain in cost/unknown reservations",job.get("failed_attempts_accounting"),failed_entries,mapping)
            if first_complete:
                self.expect("attempt_selection",job["job_id"]+" selects first complete result, never fastest/highest quality",job.get("result_path"),first_complete["snapshot"].get("result_path"))
                if len(attempts)>1:self.expect("attempt_selection",job["job_id"]+" selected attempt ID",job.get("selected_attempt_id"),first_complete["attempt_id"])
                self.expect("attempt_selection",job["job_id"]+" no extra document retry after first complete attempt",attempts[-1]["run_id"],first_complete["run_id"])
        self.counts["materialized_real_document_attempts"]=attempt_count
        self.counts["failed_document_attempts_retained"]=incomplete
        if self.target_cohort:
            complete_count=sum(not result.get("error") and bool(result.get("coverage",{}).get("selected_source_block_processing_complete")) and bool(result.get("coverage",{}).get("whole_document_summary_complete"))
                               for job in self.register["jobs"] if job["independent_model_run"] and (result:=self.results.get(job["job_id"])))
            self.expect("report_consistency","main report completion uses only all five actual target source/summary chains",
                        (self.report.get("complete_selected_input_chains"),self.report.get("comparison_completed"),self.report.get("actual_document_attempts")),
                        (complete_count,complete_count==5,attempt_count),live=True)
            self.validate_historical_pilots(mapping)
            for job in self.register["jobs"]:
                if job["independent_model_run"] and job.get("result_path"):
                    self.validate_internal_recovery(job,self.results.get(job["job_id"],{}))
            self.validate_phase_recovery_reports()
            self.validate_real_completion()
        if incomplete:self.note("limitations","failure cause is not inferred from missing usage or configured deadline","warning","Unknown usage remains conservatively reserved. An unclassified SDK failure is not relabelled as a 120-second timeout without explicit deadline evidence.")

    def validate_historical_pilots(self,mapping):
        summaries=[]
        for descriptor in self.register.get("pilot_cohorts",[]):
            cohort=descriptor["cohort_id"];complete_count=0;count=0
            for attempt in self.attempts_by_cohort[cohort]:
                snapshot=attempt["snapshot"];path=snapshot.get("result_path")
                if not path:
                    self.note("cohort_history",attempt["run_id"]+" historical result missing","failed");continue
                actual=self.read_json(path)
                if not actual:continue
                count+=1
                entries=self.requests_by_attempt[attempt["run_id"]]
                self.compare_accounting(attempt["run_id"]+" historical cost/unknown usage retained",snapshot.get("accounting"),entries,mapping)
                coverage=actual.get("coverage",{})
                complete=not actual.get("error") and coverage.get("selected_source_block_processing_complete") and coverage.get("whole_document_summary_complete")
                complete_count+=bool(complete)
                self.expect("cohort_history",attempt["run_id"]+" original status not relabelled",snapshot.get("status"),"selected_input_finished_quality_pending" if complete else "engineering_incomplete")
                self.expect("cohort_history",attempt["run_id"]+" original identity preserved",actual.get("run_id"),attempt["run_id"])
                self.expect("cohort_history",attempt["run_id"]+" cannot enter main comparison",attempt["eligible_for_main_comparison"],False)
                directory=self.path(snapshot.get("directory",Path(path).parent))
                provenance=self.read_json(directory/"source-provenance.json")
                if provenance:self.expect("cohort_history",attempt["run_id"]+" source epoch remains historical",provenance.get("source_snapshot"),attempt["source_snapshot"])
                accounting=self.read_json(directory/"request-accounting.json")
                if accounting:self.expect("cohort_history",attempt["run_id"]+" complete historical request IDs",[e["id"] for e in accounting.get("requests",[])],[e["id"] for e in entries])
                doc=self.docs[snapshot["document_id"]];blocks={b["block_id"]:b for b in doc["blocks"]};errors=[]
                for version in actual.get("records",[]):
                    for segment in nested_segments(version["record"]):
                        b=blocks.get(segment["block_id"])
                        if not b or segment["text_version"]!=doc["text_version"] or b["text"][segment["start"]:segment["end"]]!=segment["exact_quote"]:
                            errors.append(version["record"]["record_id"])
                self.require("cohort_history",attempt["run_id"]+" historical candidate source slices still roundtrip",not errors,errors)
            self.expect("cohort_history",cohort+" complete-condition count stays historical",complete_count,descriptor.get("complete_unique_conditions"))
            summaries.append({"cohort_id":cohort,"document_attempts":count,"complete_conditions":complete_count,"included_in_main_comparison":False})
        self.counts["historical_pilot_cohorts_retained"]=summaries

    def validate_internal_recovery(self,job,result):
        directory=self.path(job.get("directory",Path(job["result_path"]).parent))
        run=job["run_id"];entries=self.requests_by_attempt[run];by_batch=defaultdict(list);covered_ids=set();errors=[]
        for path in sorted(directory.glob("batch-*-attempt-*.json")):
            if not re.fullmatch(r"batch-\d+-attempt-\d+\.json",path.name):continue
            artifact=self.read_json(path)
            if artifact:by_batch[artifact["batch_id"]].append((path,artifact))
        explicit=set()
        for batch,artifacts in by_batch.items():
            artifacts.sort(key=lambda item:item[1]["attempt"])
            indices=[a["attempt"] for _,a in artifacts]
            if indices!=list(range(len(indices))) or len(indices)>3:errors.append({"batch":batch,"error":"batch_recovery_exceeds_fixed_max2_or_skips_attempt"})
            for index,(path,a) in enumerate(artifacts):
                ids=[e["id"] for e in a.get("request_accounting",[])]
                expected=[e["id"] for e in entries if e["purpose"]==run+":"+batch and e["attempt"]==a["attempt"]]
                if ids!=expected:errors.append({"path":str(path),"error":"batch_attempt_request_scope_mismatch"})
                covered_ids.update(ids)
                completed=a.get("status")=="completed"
                if completed:
                    if not a.get("explicit_completion_received") or a.get("result",{}).get("error") or index!=len(artifacts)-1:
                        errors.append({"batch":batch,"error":"completion_without_explicit_success_or_retry_after_completion"})
                    explicit.update(a.get("assigned_block_ids",[]))
                elif index<len(artifacts)-1 and not a.get("result",{}).get("transient_error"):
                    errors.append({"batch":batch,"error":"nontransient_batch_was_retried"})
        summaries=result.get("summary_attempts",[])
        indices=[a["attempt"] for a in summaries]
        if indices!=list(range(len(indices))) or len(indices)>3:errors.append({"error":"summary_recovery_exceeds_fixed_max2_or_skips_attempt"})
        previous_versions=-1
        for index,summary in enumerate(summaries):
            a=self.read_json(summary["path"])
            if not a:continue
            expected=[e["id"] for e in entries if e["purpose"]==run+":whole-document-summary" and e["attempt"]==summary["attempt"]]
            ids=[e["id"] for e in a.get("request_accounting",[])]
            if ids!=expected or summary.get("request_ids")!=expected:errors.append({"summary_attempt":index,"error":"summary_attempt_request_ids_mismatch"})
            covered_ids.update(ids)
            if index<len(summaries)-1 and (summary.get("status")=="completed" or not a.get("result",{}).get("transient_error")):
                errors.append({"summary_attempt":index,"error":"summary_retry_after_success_or_nontransient_failure"})
            versions=summary.get("candidate_versions_after_attempt",-1)
            if versions<previous_versions:errors.append({"summary_attempt":index,"error":"summary_recovery_erased_candidate_versions"})
            previous_versions=versions
        if result.get("coverage",{}).get("whole_document_summary_complete") and (not summaries or summaries[-1].get("status")!="completed"):
            errors.append({"error":"summary_completion_claim_without_terminal_successful_attempt"})
        expected_completed=set(result.get("coverage",{}).get("completed_source_block_ids",[]))
        if expected_completed!=explicit:errors.append({"error":"explicit_source_completion_does_not_match_completed_batch_attempts"})
        if covered_ids!={e["id"] for e in entries}:errors.append({"error":"some_physical_requests_not_preserved_in_batch_or_summary_attempt_artifacts"})
        self.require("internal_recovery",job["job_id"]+" finite transient recovery preserves all requests and explicit completion",not errors,errors)
        self.counts.setdefault("internal_summary_attempt_counts",{})[job["job_id"]]=len(summaries)

    def validate_phase_recovery_reports(self):
        evidence=self.read_json(self.base/"recovery-evidence.json",pending_if_missing=True,mutable=True)
        if not evidence:return
        self.expect("recovery_report","recovery evidence schema",evidence.get("schema_version"),"s4-actual-recovery-version-evidence-1")
        self.expect("recovery_report","reconciliation counts are engineering evidence only",evidence.get("counts_describe_engineering_not_medical_deduplication_quality"),True)
        actual_rows=evidence.get("rows",[]);rows={r["job_id"]:r for r in actual_rows}
        physical={j["job_id"] for j in self.register["jobs"] if j["independent_model_run"] and j.get("result_path")}
        self.expect("recovery_report","only target independent runs have recovery rows",(set(rows),len(actual_rows)),(physical,len(physical)),live=True)
        report_rows={r["job_id"]:r for r in self.report.get("rows",[])}
        mapping={**REPORT_ACCT,"provider_cache_read_tokens_included_in_input":"cache_read",
                 "provider_cache_write_tokens_included_in_input":"cache_write","provider_reasoning_tokens_included_in_output":"reasoning"}
        for job in self.register["jobs"]:
            job_id=job["job_id"];report_row=report_rows.get(job_id,{})
            if not job["independent_model_run"]:
                self.expect("recovery_report",job_id+" alias has no independent phase accounting",report_row.get("phase_accounting"),None)
                continue
            if job_id not in rows:continue
            row=rows[job_id];result=self.results.get(job_id,{})
            directory=self.path(job.get("directory",Path(job["result_path"]).parent))
            run=job["run_id"];entries=self.requests_by_attempt[run]
            batch=[e for e in entries if re.fullmatch(re.escape(run)+r":batch-\d+",e.get("purpose",""))]
            summary=[e for e in entries if e.get("purpose")==run+":whole-document-summary"]
            self.expect("phase_accounting",job_id+" batch and summary partition physical requests exactly once",
                        ({e["id"] for e in batch}&{e["id"] for e in summary},{e["id"] for e in batch+summary}),
                        (set(),{e["id"] for e in entries}))
            failed_ids=set()
            for pattern in ("batch-*-attempt-*.json","whole-document-summary-attempt-*.json"):
                for path in directory.glob(pattern):
                    if not re.fullmatch(r"(?:batch-\d+|whole-document-summary)-attempt-\d+\.json",path.name):continue
                    attempt=self.read_json(path)
                    if attempt and attempt.get("result",{}).get("error"):
                        failed_ids.update(e["id"] for e in attempt.get("request_accounting",[]))
            phases=row.get("phase_accounting") or {}
            for name,selected in (("batch_extraction_including_retries",batch),
                                  ("summary_including_readback_and_retries",summary),
                                  ("failed_attempt_requests_overlay",[e for e in entries if e["id"] in failed_ids]),
                                  ("retry_attempt_requests_overlay",[e for e in entries if e.get("attempt",0)>0])):
                self.compare_accounting(job_id+" "+name,phases.get(name),selected,mapping,live=True)
            self.expect("phase_accounting",job_id+" failure/retry costs are overlays; readback-only tokens unknown",
                        (phases.get("recovery_overlays_are_already_in_stage_totals_do_not_add_again"),phases.get("readback_only_tokens_not_separately_identifiable_from_whole_request_usage")),(True,True))
            self.expect("phase_accounting",job_id+" report and recovery evidence share physical stage accounting",report_row.get("phase_accounting"),phases,live=True)
            events=result.get("events",[])
            expected_batches=[]
            for event in events:
                if event.get("type")!="batch":continue
                detail=event["detail"]
                expected_batches.append({"batch_id":detail.get("batch_id"),"attempt":detail.get("attempt"),
                    "status":detail.get("status"),"candidate_count_so_far":detail.get("candidate_count_so_far"),
                    "read_source_blocks":len(detail.get("read_block_ids",[])),
                    "explicit_completion_received":detail.get("explicit_completion_received"),"error":detail.get("result",{}).get("error")})
            self.expect("recovery_report",job_id+" batch candidate snapshots preserve actual event history",row.get("batch_attempts"),expected_batches)
            self.expect("recovery_report",job_id+" summary attempts and immutable/final candidate counts match actual version history",
                        (row.get("cohort_id"),row.get("summary_attempts"),row.get("final_active_candidates"),row.get("immutable_candidate_versions"),row.get("active_human_versions_in_actual_run")),
                        (self.target_cohort,result.get("summary_attempts",[]),result.get("candidate_count"),result.get("candidate_versions"),sum(v.get("actor")=="human" for v in result.get("records",[]))))
            self.expect("recovery_report",job_id+" reconciliation actions count actual host events only",row.get("reconciliation_action_counts"),
                        dict(Counter(e["detail"].get("action","unknown") for e in events if e.get("type")=="reconciliation")))
            self.expect("recovery_report",job_id+" human protections are local tests without medical approval",
                        (row.get("failed_attempt_candidates_remain_in_version_history"),row.get("human_revision_protection_tested_locally_not_medical_approval")),(True,True))

    def validate_real_completion(self):
        completion=self.read_json(self.base/"real-run-completion.json",pending_if_missing=True)
        if not completion:return
        self.expect("real_completion","owner terminal receipt and zero inflight",
                    (completion.get("schema_version"),completion.get("exit_code"),completion.get("owner_lock_absent"),completion.get("inflight_requests"),completion.get("all5_selected_input_and_summary_complete"),completion.get("no_more_inference_for_this_registered_experiment")),
                    ("s4-main-reliability-run-completion-1",0,True,0,True,True))
        self.require("real_completion","actual owner lock is absent",not (self.path(self.register["runtime_directory"])/"active-owner.lock").exists())
        self.expect("real_completion","actual ledger is terminal",self.counts.get("inflight"),0)
        for path_key,sha_key in (("ledger_path","ledger_sha256"),("stdout_path","stdout_sha256"),("outputs_freeze_path","outputs_freeze_sha256")):
            self.file_hash(completion[path_key],completion[sha_key],"real_completion")
        for path,expected in completion.get("database_artifacts",{}).items():self.file_hash(path,expected,"real_completion")
        self.expect("real_completion","terminal accounting is the same independently checked report scope",completion.get("joint_accounting"),self.report.get("joint_accounting"))
        self.expect("real_completion","full-source mismatch is explicitly retained in terminal receipt",
                    (completion.get("all_frozen_workspace_file_hashes_still_match"),completion.get("frozen_source_files"),completion.get("matching_current_files"),completion.get("failed_all_source_assertion_not_an_API_call")),
                    (not hasattr(self,"package_drift"),len(self.register["source_snapshot"]["hashes"]),len(self.register["source_snapshot"]["hashes"])-int(hasattr(self,"package_drift")),True))

    def validation_versions(self):
        filename="offline-validation-reliability-v2.json" if self.target_cohort else "offline-validation.json"
        offline=self.read_json(self.base/filename,pending_if_missing=True)
        if not offline:return
        self.expect("test_evidence","continuation validation schema",offline.get("schema_version"),"s4-reliability-v2-validation-1" if self.target_cohort else "s4-alias-continuation-validation-1")
        self.expect("runtime_versions","offline validation bound to actual continuation/cohort snapshot",offline.get("source_snapshot"),self.register.get("source_snapshot"))
        for name in ("extraction","focused" if self.target_cohort else "focused_alias","typecheck"):
            receipt=offline.get(name,{})
            self.expect("test_evidence",name+" exit code",receipt.get("exit_code"),0)
            raw=self.read_bytes(receipt.get("log",""))
            if raw and name!="typecheck":
                log=raw.decode("utf-8",errors="replace")
                for label,key in (("pass","passed"),("fail","failed")):
                    values=node_test_counts(log,label)
                    self.require("test_evidence",name+" raw Node "+label+" matches receipt",bool(values) and int(values[-1])==receipt.get(key))
            elif name=="typecheck":self.expect("test_evidence","continuation typecheck passed",receipt.get("passed"),True)
        if self.target_cohort:
            self.expect("test_evidence","6 repair cases are a subset of 154, older suites stay historical",
                        (offline.get("extraction",{}).get("passed"),offline.get("focused",{}).get("passed"),offline.get("focused",{}).get("subset_of154"),offline.get("older148_144_139_not_relabelled")),(154,6,True,True))
            for path,expected in offline.get("source_file_sha256",{}).items():self.file_hash(path,expected,"test_evidence")
        else:
            self.expect("test_evidence","4 alias cases are a subset of 148, not added to previous versions",
                        (offline.get("extraction",{}).get("passed"),offline.get("focused_alias",{}).get("passed"),offline.get("focused_alias",{}).get("is_subset_of148"),offline.get("old148_144_139_not_added")),(148,4,True,True))

    def frozen_posthoc(self):
        super().frozen_posthoc()
        if not self.target_cohort:return
        path=self.base/"posthoc-ai-reference-review.json"
        if not path.exists():return
        posthoc=self.read_json(path,mutable=True)
        if not posthoc:return
        self.validate_comparison_contract(posthoc)
        expected_summaries={};errors=[]
        for row in posthoc.get("comparisons",[]):
            result=self.results.get(row["job_id"],{})
            records=self.literal_comparison_records(result)
            condition_complete=bool(result.get("coverage",{}).get("selected_source_block_processing_complete") and result.get("coverage",{}).get("whole_document_summary_complete"))
            if row.get("engineering_selected_input_and_summary_complete")!=condition_complete or row.get("literal_overlap_is_not_condition_completion_or_medical_quality") is not True:
                errors.append({"job_id":row["job_id"],"reference_id":row["reference_id"],"error":"literal_overlap_promoted_to_condition_completion"})
            contextual=[{"quote_span":{"segments":r.get("context",{}).get("fragments",[])}} for r in records]
            readback=set(result.get("coverage",{}).get("summary_reread_source_block_ids",[]))
            review=[]
            for unit in row.get("units",[]):
                segments=unit.get("unique_source_segments",[])
                reliable=unit.get("reliable_unique_location") and bool(segments)
                primary=all(covered(s,records) for s in segments) if reliable else None
                context=all(covered(s,contextual) for s in segments) if reliable else None
                expected={"initial_selected_input_retains_all_anchored_lines":unit.get("all_required_blocks_retained") if reliable else None,
                          "primary_quote_exact_source_interval_union_covers_all":primary,
                          "one_primary_record_covers_all_segments":[r["record_id"] for r in records if reliable and all(covered(s,[r]) for s in segments)],
                          "primary_quote_interval_overlapping_record_ids":[r["record_id"] for r in records if any(literal_overlap(a,b) for a in segments for b in r.get("quote_span",{}).get("segments",[]))],
                          "context_exact_source_interval_union_covers_all":context,
                          "context_only_without_full_primary_quote":context and not primary if reliable else None,
                          "all_anchored_lines_explicitly_reread_in_summary":all(s["block_id"] in readback for s in segments) if reliable else None,
                          "same_block_overlap_is_location_hint_only_not_extracted_description":True,
                          "context_or_readback_is_not_primary_feature_extraction":True,"semantic_or_medical_correctness_established":False}
                if unit.get("evidence_layers")!=expected:errors.append({"job_id":row["job_id"],"reference_id":row["reference_id"],"unit_id":unit.get("unit_id"),"error":"three_layer_exact_interval_or_readback_mismatch"})
                review.append(expected)
            eligible=row.get("row_fully_located_for_literal_comparison")
            expected_row={"initial_input_retains_all_units":all(u["initial_selected_input_retains_all_anchored_lines"] for u in review) if eligible else None,
                          "primary_quote_intervals_cover_all_units":all(u["primary_quote_exact_source_interval_union_covers_all"] for u in review) if eligible else None,
                          "all_units_in_context_but_not_fully_in_primary_quotes":all(u["context_exact_source_interval_union_covers_all"] for u in review) and not all(u["primary_quote_exact_source_interval_union_covers_all"] for u in review) if eligible else None,
                          "not_a_claim_that_the_reference_description_was_medically_extracted":True}
            if row.get("three_layer_row_review")!=expected_row:errors.append({"job_id":row["job_id"],"reference_id":row["reference_id"],"error":"row_layer_summary_or_unresolved_null_mismatch"})
            summary=expected_summaries.setdefault(row["job_id"],{"reliably_located_rows":0,"unresolved_rows":0,"initial_input_retains_all_units_rows":0,"primary_quote_interval_union_covers_all_units_rows":0,"context_without_full_primary_quote_rows":0,"engineering_selected_input_and_summary_complete":condition_complete})
            if not eligible:summary["unresolved_rows"]+=1
            else:
                summary["reliably_located_rows"]+=1
                summary["initial_input_retains_all_units_rows"]+=int(expected_row["initial_input_retains_all_units"])
                summary["primary_quote_interval_union_covers_all_units_rows"]+=int(expected_row["primary_quote_intervals_cover_all_units"])
                summary["context_without_full_primary_quote_rows"]+=int(expected_row["all_units_in_context_but_not_fully_in_primary_quotes"])
        self.require("posthoc_exact_layers","primary/context/readback are distinct and recomputed from exact source intervals",not errors,errors)
        self.expect("posthoc_exact_layers","posthoc per-job layer counts",posthoc.get("three_layer_summaries"),expected_summaries)
        table=self.read_json(self.base/"posthoc-source-layer-summary.json")
        if table:
            self.expect("posthoc_exact_layers","standalone layer summary is the same nonmedical data",(table.get("not_medical_precision_recall_or_f1"),table.get("rows")),(True,expected_summaries))
        freeze=self.read_json(self.base/"outputs-freeze.json",mutable=True)
        if freeze:
            artifacts={self.path(p) for p in freeze.get("artifacts",{})}
            expected=set()
            for attempt in self.attempt_catalog.values():
                snapshot=attempt["snapshot"]
                if snapshot.get("result_path"):
                    expected.add(self.path(snapshot["result_path"]))
                    directory=self.path(snapshot.get("directory",Path(snapshot["result_path"]).parent))
                    expected.update(p.resolve() for p in directory.rglob("*.json"))
            for pilot in self.register.get("pilot_cohorts",[]):
                expected.update((self.path(pilot["registry_path"]),self.path(pilot["ledger_at_end_path"])))
            self.require("outputs_freeze","all pilot and target failed/selected result artifacts are frozen",expected<=artifacts)
            self.expect("outputs_freeze","freeze explicitly includes all failed and archived pilot artifacts",
                        (freeze.get("all_failed_and_selected_attempt_artifacts_included"),freeze.get("archived_pilot_artifacts_included")),(True,True))

    def validate_comparison_contract(self,posthoc):
        contract=self.read_json(self.base/"posthoc-comparison-contract.json")
        if not contract:return
        self.expect("comparison_versions","terminal literal-comparison contract schema/cohort",
                    (contract.get("schema_version"),contract.get("target_cohort_id")),("s4-terminal-current-version-literal-contract-1",self.target_cohort))
        self.expect("comparison_versions","posthoc points to the current-version qualification contract",posthoc.get("current_version_qualification_contract"),"posthoc-comparison-contract.json")
        self.expect("comparison_versions","qualifying current candidates are explicitly constrained",contract.get("qualification"),
                    ["terminal result.records equals latest persisted non-proposed version per record_id","version.status is exactly active","record.review_status is not rejected","record.evidence_validation.quote_located is true"])
        for key in ("pending_and_needs_context_remain_unapproved_candidates_not_medically_correct_findings",
                    "history_superseded_and_proposed_never_extend_main_quote_or_context_interval_union",
                    "duplicate_or_conflict_links_do_not_create_extra_independent_medical_discoveries","same_interval_repetition_does_not_add_interval_union_coverage"):
            self.expect("comparison_versions",key,contract.get(key),True)
        actual_rows=contract.get("rows",[]);rows={row["job_id"]:row for row in actual_rows}
        self.expect("comparison_versions","one version contract per logical row, aliases remain reuse",(set(rows),len(actual_rows)),(JOB_IDS,8))
        counts={}
        for job in self.register["jobs"]:
            job_id=job["job_id"];result=self.results.get(job_id,{});row=rows.get(job_id,{})
            current=result.get("records",[]);versions=result.get("versions",[]);latest={}
            for version in versions:
                if version.get("status")=="proposed":continue
                key=version["record"]["record_id"]
                if key not in latest or latest[key]["version"]<version["version"]:latest[key]=version
            current_by_id={v["record"]["record_id"]:v for v in current}
            self.expect("comparison_versions",job_id+" terminal records are exactly the latest non-proposed persisted versions",
                        (current_by_id,len(current)),(latest,len(latest)))
            eligible=[v for v in current if v.get("status")=="active" and v["record"].get("review_status")!="rejected" and v["record"].get("evidence_validation",{}).get("quote_located") is True]
            eligible_keys={(v["record"]["record_id"],v["version"]) for v in eligible}
            expected=[{"record_id":v["record"]["record_id"],"version":v["version"],"status":v.get("status"),"review_status":v["record"]["review_status"]} for v in eligible]
            excluded=[]
            for version in versions:
                key=version["record"]["record_id"]
                if (key,version["version"]) in eligible_keys:continue
                reason="proposed_not_effective" if version.get("status")=="proposed" else "superseded_version" if latest[key]["version"]!=version["version"] else "ineligible_current_version"
                excluded.append({"record_id":key,"version":version["version"],"status":version.get("status"),"actor":version["actor"],"review_status":version["record"]["review_status"],"reason":reason,"eligible_for_main_quote_union":False})
            self.expect("comparison_versions",job_id+" only eligible active current versions contribute quote/context union",row.get("eligible_current_versions"),expected)
            self.expect("comparison_versions",job_id+" historical/proposed/ineligible versions remain audit-only",row.get("history_proposals_and_ineligible_current_audit_only"),excluded)
            self.expect("comparison_versions",job_id+" comparison uses actual selected terminal artifact",row.get("original_result_path"),job.get("result_path"))
            if job.get("result_path"):self.file_hash(job["result_path"],row.get("original_result_sha256"),"comparison_versions")
            counts[job_id]={"current_versions":len(current),"eligible_current_versions":len(eligible),"historical_proposed_ineligible_audit_only":len(excluded)}
        self.counts["terminal_current_candidate_qualification"]=counts

    def continuation_plan_handoff(self,proof,before_dir):
        handoff=self.read_json(CODE/"docs/acceptance/s4/current-handoff.json",mutable=True)
        if not handoff:return
        self.expect("plan_sync","continuation handoff keeps medical/stage gates pending",(handoff.get("stage_passed"),handoff.get("S5_started")),(False,False))
        pointer=handoff.get("files",{}).get("current_engineering_source_manifest")
        if pointer:
            manifest=self.read_json(pointer)
            if manifest:self.expect("plan_sync","current source pointer names actual continuation revision",manifest.get("digest"),self.register["source_snapshot"]["digest"])
        self.expect("plan_sync","plan sync formal review counter matches current S4",proof.get("formal_review_used"),self.read_json(CODE/"docs/acceptance/s4/review-index.json").get("formal_astra_reviews_used"))

    def finish(self):
        result=super().finish()
        result["supplier_alias_confirmation_source"]="supplier_statement_relayed_by_user_in_main_session"
        result["supplier_confirmed_exact_alias_requests"]=self.confirmed_alias_requests
        result["unapproved_returned_model_names"]=self.unapproved_response_names
        result["independent_model_weight_identity_verified"]=False
        result["comparative_conclusions_blocked_by_unverified_model_identity"]=bool(self.unapproved_response_names)
        result["joint_with_prior_selection_consumption"]=getattr(self,"joint",None)
        result["all_current_workspace_source_hashes_equal_paid_snapshot"]=not bool(self.current_revision_changes)
        result["precisely_disclosed_package_script_drift"]=getattr(self,"package_drift",None)
        if self.unapproved_response_names:result["experiment_completion_status"]="blocked_unapproved_response_name"
        elif not self.all_terminal:result["experiment_completion_status"]="pending_real_unique_runs"
        elif any(j["independent_model_run"] and j.get("status")!="selected_input_finished_quality_pending" for j in self.register.get("jobs",[])):
            result["experiment_completion_status"]="real_outputs_terminal_some_selected_input_chains_incomplete"
        else:result["experiment_completion_status"]="all_five_selected_input_chains_finished_medical_quality_pending"
        return result


def render(result):
    esc=lambda x:html.escape(str(x),quote=True)
    rows=[]
    for check in result["checks"]:
        detail=json.dumps(check.get("detail"),ensure_ascii=False,indent=2,default=lambda v:sorted(v) if isinstance(v,set) else str(v)) if "detail" in check else ""
        rows.append(f"<tr><td>{esc(check['status'])}</td><td>{esc(check['group'])}</td><td>{esc(check['check'])}<pre>{esc(detail)}</pre></td></tr>")
    return f"""<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>S4交付一致性检查</title>
<style>body{{font:15px/1.6 system-ui;max-width:1450px;margin:24px auto;padding:0 18px}}table{{border-collapse:collapse;width:100%}}td,th{{border:1px solid #bcc8d2;padding:8px;text-align:left;vertical-align:top}}pre{{white-space:pre-wrap;overflow-wrap:anywhere}}.notice{{padding:16px;background:#fff0c9}}</style>
<h1>S4交付一致性检查</h1><p class="notice">状态：{esc(result['status'])}；检查阶段：{esc(result['phase'])}；交付口径：{esc(result['delivery_mode'])}。交接产物一致性：{esc(result['delivery_consistency_status'])}；实验完成：{esc(result['experiment_completion_status'])}。这是工程产物一致性校验，医学质量仍待复核，S4未验收。本检查未调用API、未增加正式审查、未修改lead报告。</p>
<p>检查计数：{esc(result['check_counts'])}。进行中的请求、未完结实验和初始报告统计滞后记pending，不提前视为成功。复用只证明源mask与中性契约等价；opaque run_id不同，未证明完整请求逐字相同或严格盲化，R/FR别名不算独立测试。</p>
<pre>{esc(json.dumps(result['actual_ledger_recomputed'],ensure_ascii=False,indent=2))}</pre><table><tr><th>状态</th><th>类别</th><th>检查及分歧</th></tr>{''.join(rows)}</table></html>"""


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base",type=Path,default=DEFAULT_BASE)
    parser.add_argument("--phase",choices=("in-progress","final"),default="in-progress")
    parser.add_argument("--require-plan-sync",action="store_true")
    parser.add_argument("--delivery-mode",choices=("completed-experiment","stopped-handoff"),default="completed-experiment")
    args=parser.parse_args(argv)
    register_path=args.base/"experiment-register.json"
    try:
        schema=json.loads(register_path.read_text(encoding="utf-8")).get("schema_version")
    except (OSError,ValueError):
        schema=None
    audit_type=ContinuationAudit if schema=="s4-selection-continuation-1" else Audit
    audit=audit_type(args.base,args.phase,args.require_plan_sync,args.delivery_mode)
    for method in (audit.authorization,audit.source_integrity,audit.masks_and_reuse,audit.call_ledger,audit.run_artifacts,audit.review_exports,audit.frozen_posthoc,audit.stopped_handoff,audit.validation_versions,audit.local_references,audit.plan_sync):
        try:
            method()
        except (KeyError,TypeError,ValueError,OSError) as error:
            audit.note("checker_execution",method.__name__,"failed",{"exception":type(error).__name__,"message":str(error)[:500]})
        if method==audit.authorization and not audit.register:
            audit.note("consistent_read_snapshot","registry unavailable; dependent checks await readable register","pending")
            break
    result=audit.finish()
    out=args.base.resolve()/"artifact-validation"/(datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")+"-"+args.phase)
    out.mkdir(parents=True,exist_ok=False)
    (out/"result.json").write_text(json.dumps(result,ensure_ascii=False,indent=2,default=lambda v:sorted(v) if isinstance(v,set) else str(v))+"\n",encoding="utf-8")
    (out/"report.html").write_text(render(result),encoding="utf-8")
    (out.parent/"latest.json").write_text(json.dumps({"result":str(out/"result.json"),"report":str(out/"report.html"),"status":result["status"],"phase":args.phase},ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"status":result["status"],"phase":args.phase,"check_counts":result["check_counts"],"result":str(out/"result.json"),"report":str(out/"report.html"),"all_terminal":audit.all_terminal,"no_API_calls":True},ensure_ascii=False))
    if result["status"]=="failed":
        return 1
    if args.phase=="final" and result["status"]=="pending":
        return 0 if args.delivery_mode=="stopped-handoff" and result["delivery_consistency_status"]=="passed" else 2
    return 0


if __name__=="__main__":
    raise SystemExit(main())
