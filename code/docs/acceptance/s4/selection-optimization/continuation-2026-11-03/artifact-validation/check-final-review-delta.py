#!/usr/bin/env python3
"""Check only the sealed third-review/document/cleanup delta; no model rerun."""
import csv
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
BASE = HERE.parent
CODE = HERE.parents[5]
spec = importlib.util.spec_from_file_location("s4_checker", CODE / "scripts/check-s4-selection-artifacts.py")
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)
audit = checker.ContinuationAudit(BASE, "final", True, "completed-experiment")
read = audit.read_json
require = audit.require
expect = audit.expect
manifest = read(BASE / "final-delivery-delta-manifest.json")
baseline_path = audit.path(manifest["base_independent_validation"])
baseline = read(baseline_path)
audit.register = read(BASE / "experiment-register.json")
audit.target_cohort = audit.register["cohort_id"]
audit.report = read(BASE / "report.json", mutable=True)
audit.all_terminal = True
expect("delta_scope", "baseline remains a successful full independent check", (baseline["status"], baseline["check_counts"]), ("passed", {"passed": 1096, "warning": 4}))
expect("delta_scope", "manifest has 12 explicit changed and 7 new paths", (len(manifest["allowed_changed_formal_paths"]), len(manifest["new_formal_evidence_and_script_paths"])), (12, 7))
allowed = {audit.path(p) for p in manifest["allowed_changed_formal_paths"]}
for key in ("allowed_changed_formal_paths", "new_formal_evidence_and_script_paths", "new_live_baseline_backups"):
    for path, sha in manifest[key].items():
        audit.file_hash(path, sha, "delta_manifest")
unexpected = []
unchanged = 0
for item in baseline["input_file_fingerprints"]:
    path = audit.path(item["path"])
    raw = audit.read_bytes(path)
    actual = checker.hash_bytes(raw) if raw is not None else None
    if actual != item["sha256_after_checks"] and path not in allowed:
        unexpected.append(item["path"])
    elif actual == item["sha256_after_checks"]:
        unchanged += 1
require("delta_scope", "no undeclared changes to any previously checked file (hash only)", not unexpected, unexpected)
review = read(BASE / "final-formal-review-round3.json")
old_index = read(BASE / "before-final-review/review-index.json")
index = read(CODE / "docs/acceptance/s4/review-index.json", mutable=True)
expect("review_counter", "exactly the third review was appended, prior two unchanged", index["history"], [*old_index["history"], review["review"]])
expect("review_counter", "same task window closes at 3 of 3", (old_index["formal_astra_reviews_used"], index["formal_astra_reviews_used"], index["limit"], index["formal_review_window_closed"]), (2, 3, 3, True))
expect("review_counter", "review seals actual baseline result", review["independent_result_sha256"], checker.hash_bytes(baseline_path.read_bytes()))
require("review_counter", "sealed review is concise and keeps medical/S5 pending", len(review["review"]["text"]) <= 200 and review["review"]["decision"] == "continue" and review["review"]["medical_acceptance_passed"] is False and review["review"]["S5_started"] is False)

def changes(a, b, path=()):
    if isinstance(a, dict) and isinstance(b, dict):
        for key in a.keys() | b.keys():
            if key not in a or key not in b:
                yield path + (key,), a.get(key), b.get(key)
            else:
                yield from changes(a[key], b[key], path + (key,))
    elif isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        for pos, (left, right) in enumerate(zip(a, b)):
            yield from changes(left, right, path + (pos,))
    elif a != b:
        yield path, a, b

json_deltas = {}
for filename in ("当前版本.json", "开发计划.json", "current-handoff.json", "report.json"):
    path = checker.PROJECT / "方案/子任务T1" / filename if filename in {"当前版本.json", "开发计划.json"} else CODE / "docs/acceptance/s4/current-handoff.json" if filename == "current-handoff.json" else BASE / filename
    old = read(BASE / "before-final-review" / filename)
    new = read(path, mutable=True)
    errors = []
    found = list(changes(old, new))
    for location, before, after in found:
        valid = False
        if "formal_review_progress" in location:
            valid = location[-1] == "formal_astra_reviews_used" and (before, after) == (2, 3) or location[-1] == "formal_review_window_closed" and (before, after) == (None, True) or location[-1] == "history" and after == [*before, review["review"]]
            valid = valid and (filename == "current-handoff.json" or location[0] == "S4_engineering")
        elif location[-1] == "final_formal_review_record":
            valid = before is None and after in {"final-formal-review-round3.json", "code/docs/acceptance/s4/selection-optimization/continuation-2026-11-03/final-formal-review-round3.json"}
        elif filename == "开发计划.json" and location[0] == "tasks":
            valid = location[-1] == "engineering_progress" and old["tasks"][location[1]]["stage"] == "S4" and after == before.replace("正式审查2/3", "正式审查3/3")
        elif filename == "current-handoff.json":
            valid = location == ("prepared_at",) and after == review["review"]["recorded_at"] or location == ("S4_final_formal_review_still_reserved",) and (before, after) == (True, False) or location == ("temporary_notes_cleanup_record",) and before is None and after.endswith("/temporary-notes-cleanup.json")
        elif filename == "report.json":
            valid = location == ("formal_review_count", "used") and (before, after) == (2, 3) or location == ("formal_review_count", "final_reserved") and (before, after) == (True, False)
        if not valid:
            errors.append("/".join(map(str, location)))
    require("delta_json", filename + " only review/cleanup metadata changed", not errors, errors)
    json_deltas[filename] = ["/".join(map(str, p)) for p, _, _ in found]

proof = read(BASE / "final-review-sync-preservation.json")
old_proof = read(BASE / "plan-sync-before-final-review.json")
current_proof = read(BASE / "plan-sync-preservation.json", mutable=True)
expect("plan_chain", "old 2/3 receipt remains byte-identical", proof["initial2of3_receipt_sha256"], checker.hash_bytes((BASE / "plan-sync-before-final-review.json").read_bytes()))
expect("plan_chain", "original plan receipt is the one used by the full check", proof["initial2of3_receipt_sha256"], next(f["sha256_at_read"] for f in baseline["input_file_fingerprints"] if f["path"].endswith("/plan-sync-preservation.json")))
expect("plan_chain", "2/3 becomes 3/3 without erasing original paragraph history", (old_proof["formal_review_used"], current_proof["formal_review_used"], [d["appended_paragraphs"] for d in old_proof["DOCX_preservation"]], [d["appended_paragraphs"] for d in current_proof["DOCX_preservation"]]), (2, 3, [9, 9], [10, 10]))
for item in proof["changes"]:
    if "before_sha256" in item:
        audit.file_hash(BASE / "before-final-review" / Path(item["file"]).name, item["before_sha256"], "review_CAS")
    audit.file_hash(item["file"], item["after_sha256"], "review_CAS", mutable=True)
    if item["file"].endswith(".docx"):
        before = (BASE / "before-final-review" / Path(item["file"]).name).read_bytes()
        after = audit.path(item["file"]).read_bytes()
        with zipfile.ZipFile(io.BytesIO(before)) as a, zipfile.ZipFile(io.BytesIO(after)) as b:
            expect("review_DOCX", Path(item["file"]).name + " ZIP members/order intact", a.namelist(), b.namelist())
            require("review_DOCX", Path(item["file"]).name + " other ZIP bytes unchanged", all(a.read(name) == b.read(name) for name in a.namelist() if name != "word/document.xml"))
            old, new = a.read("word/document.xml"), b.read("word/document.xml")
            pos = old.rfind(b"<w:sectPr"); delta = len(new) - len(old)
            require("review_DOCX", Path(item["file"]).name + " live XML preserved by single paragraph insertion", pos >= 0 and delta > 0 and new[:pos] + new[pos + delta:] == old and len(ET.fromstring(b'<r xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' + new[pos:pos + delta] + b'</r>')) == 1)
audit.plan_sync()  # Only aggregate DOCX/JSON/CSV preservation and current pointers.
for filename in ("开发阶段与验收.csv", "开发任务清单.csv"):
    old = list(csv.reader(io.StringIO((BASE / "before-final-review" / filename).read_text("utf-8-sig"))))
    new = list(csv.reader(io.StringIO((checker.PROJECT / "方案/子任务T1" / filename).read_text("utf-8-sig"))))
    stage, progress = old[0].index("阶段"), old[0].index("工程进度")
    require("review_CSV", filename + " only S4 progress review counter text changed", len(old) == len(new) and old[0] == new[0] and all(len(a) == len(b) and all(x == y or a[stage] == "S4" and col == progress and y == x.replace("正式审查2/3", "正式审查3/3") for col, (x, y) in enumerate(zip(a, b))) for a, b in zip(old[1:], new[1:])))

old_html = (BASE / "before-final-review/report.html").read_text()
new_html = (BASE / "report.html").read_text()
review_tag = r'<p id="s4-sealed-final-review">.*?</p>\n?'
require("navigation", "report HTML only appends the sealed review footer", len(re.findall(review_tag, new_html, re.S)) == 1 and re.sub(review_tag, "", new_html, flags=re.S) == old_html and review["review"]["text"] in new_html)
old_index_html = (BASE / "before-final-review/index.html").read_text()
new_index_html = (CODE / "docs/acceptance/s4/index.html").read_text()
nav_tag = r'<!-- selection-optimization-current-continuation-navigation --><aside\b.*?</aside>'
require("navigation", "legacy index historical body preserved outside current aside", len(re.findall(nav_tag, new_index_html, re.S)) == 1 and re.sub(nav_tag, "", old_index_html, flags=re.S) == re.sub(nav_tag, "", new_index_html, flags=re.S))
audit.local_references()
cleanup = read(BASE / "temporary-notes-cleanup.json")
expected_removed = {"runtime-data/agent-notes/ROOT_READ_FIRST_S4.txt", "runtime-data/agent-notes/t1-s4-selection-active.json"}
expect("cleanup", "only the two authorized temporary notes are removed", {n["path"] for n in cleanup["notes"]}, expected_removed)
require("cleanup", "both notes actually absent and other recorded notes survive", all(not (CODE / path).exists() for path in expected_removed) and all((CODE / path).exists() for path in cleanup["other_note_files_before"]))
expect("cleanup", "saved handoff SHA precedes authorized cleanup", cleanup["handoff_sha256_at_cleanup"], checker.hash_bytes((CODE / "docs/acceptance/s4/current-handoff.json").read_bytes()))
observation = read(BASE / "concurrent-workspace-observation-manifest.json")
expect("source_observation", "observed manifest contains exactly the paid 36 paths", set(observation["current_hashes"]), set(audit.register["source_snapshot"]["hashes"]))
drifts = []
for path, sha in observation["current_hashes"].items():
    audit.file_hash(CODE / path, sha, "source_observation")
    if sha != audit.register["source_snapshot"]["hashes"][path]:
        drifts.append(path)
expect("source_observation", "full source equality remains false with only the disclosed package drift", (drifts, observation["different_from_paid_snapshot"], observation["whole_workspace_equality_assertion"]), (["package.json"], ["package.json"], "failed"))
audit.file_hash(BASE / "outputs-freeze.json", manifest["model_output_freeze_sha256_unchanged"], "immutable_outputs")
audit.file_hash(Path(audit.register["runtime_directory"]) / "call-ledger.json", manifest["ledger_sha256_unchanged"], "immutable_outputs")
result = checker.Audit.finish(audit)
result.update({"schema_version": "s4-final-review-delta-validation-1", "scope": "review3/plan/handoff/navigation/cleanup plus unchanged hashes;no model-result or posthoc algorithm rerun", "baseline_full_validation": str(baseline_path), "baseline_check_counts": baseline["check_counts"], "previously_checked_files_hash_unchanged": unchanged, "JSON_changed_paths": json_deltas, "formal_reviews_used": 3, "formal_review_limit": 3, "all_current_workspace_source_hashes_equal_paid_snapshot": False, "experiment_completion_status": baseline["experiment_completion_status"], "known_limitations_carried_from_baseline": [c for c in baseline["checks"] if c["status"] == "warning"], "app_tests_rerun": False, "source": {"path": str(Path(__file__).resolve()), "sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}})
out = HERE / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ") + "-final-review-delta")
out.mkdir(exist_ok=False)
(out / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
(out / "report.html").write_text(checker.render(result))
(out / "invocation.json").write_text(json.dumps({"command": [sys.executable, "-B", str(Path(__file__).resolve())], "exit_code": 0 if result["status"] == "passed" else 1, "API_calls": 0, "full_experiment_check_rerun": False}, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"status": result["status"], "check_counts": result["check_counts"], "result": str(out / "result.json"), "API_calls": 0}, ensure_ascii=False))
sys.exit(0 if result["status"] == "passed" else 1)
