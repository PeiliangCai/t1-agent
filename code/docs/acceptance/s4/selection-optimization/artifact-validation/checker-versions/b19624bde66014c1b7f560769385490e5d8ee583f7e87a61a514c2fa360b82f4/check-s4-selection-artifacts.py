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
        "reasoning": sum(e.get("reasoning_tokens") or 0 for e in entries),
        "unknown_usage": sum(e.get("usage_status") != "provider_reported" for e in entries),
        "inflight": sum(not e.get("finished_at") for e in entries),
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
                        (self.register["batch_id"]+":"+representative,job["document_id"],"gpt-6-luna","medium"))
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
                if self.delivery_mode=="stopped-handoff":
                    self.require("run_status_consistency",job_id+" interrupted run is not claimed selected-input success",job.get("status")=="selected_input_finished_quality_pending" if finished else job.get("status")!="selected_input_finished_quality_pending")
                else:
                    self.expect("run_status_consistency", job_id + " terminal status does not promote incomplete run to success", job.get("status"), "selected_input_finished_quality_pending" if finished else "engineering_incomplete")
                self.compare_accounting(job_id + " actual physical request accounting", job.get("accounting"), self.groups[job_id], REGISTER_ACCT)
                directory = self.path(job.get("directory", Path(job["result_path"]).parent))
                accounting_path=directory/"request-accounting.json"
                recovery=result.get("recovery_only_no_new_inference") is True
                saved = self.read_json(accounting_path,pending_if_missing=True) if accounting_path.exists() or not recovery else None
                if saved:
                    self.expect("ledger", job_id + " immutable per-run physical IDs", [e["id"] for e in saved.get("requests", [])], [e["id"] for e in self.groups[job_id]])
                    self.compare_accounting(job_id + " immutable per-run accounting", saved.get("accounting"), self.groups[job_id], REGISTER_ACCT)
                elif recovery:
                    self.compare_accounting(job_id+" recovery embeds actual ledger accounting without inventing normal completion",result.get("request_accounting"),self.groups[job_id],REGISTER_ACCT)
                provenance = self.read_json(directory / "source-provenance.json")
                if provenance:
                    source = next(s for s in self.register["sources"] if s["document_id"] == job["document_id"])
                    self.expect("runtime_versions", job_id + " actual run uses registered source snapshot", provenance.get("source_snapshot"), self.register.get("source_snapshot"))
                    self.expect("runtime_versions", job_id + " actual PDF/IR/input-mask binding", (provenance.get("file_sha256"),provenance.get("parser_result_sha256"),provenance.get("source_selection_sha256")), (source["original_pdf_sha256"],source["source_IR_sha256"],job["source_selection_sha256"]))
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
            records = [v["record"] for v in result.get("records",[])]
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
    audit=Audit(args.base,args.phase,args.require_plan_sync,args.delivery_mode)
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
