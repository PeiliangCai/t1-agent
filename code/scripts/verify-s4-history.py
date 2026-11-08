#!/usr/bin/env python3
"""Check protected pre-S4 evidence and permitted current-plan progress edits."""
from pathlib import Path
from datetime import datetime, timezone
import csv
import hashlib
import json
import zipfile
import xml.etree.ElementTree as ET

CODE = Path(__file__).resolve().parents[1]
ROOT = CODE.parent
OUT = CODE / 'docs/acceptance/s4'
BEFORE = OUT / 'before-engineering-start'
authority = json.loads((OUT / 'engineering-start-authorization.json').read_text())
allowed_protected_change = {'方案/子任务T1/验收清单.csv'}
changed = []
missing = []
for name, expected in authority['protected_inputs_sha256'].items():
    path = ROOT / name
    if not path.is_file(): missing.append(name)
    elif hashlib.sha256(path.read_bytes()).hexdigest() != expected: changed.append(name)
assert not missing, missing
assert set(changed) <= allowed_protected_change, changed

csv_checks = {}
for name in ['开发阶段与验收.csv', '开发任务清单.csv', '验收清单.csv']:
    before = list(csv.DictReader((BEFORE / '方案/子任务T1' / name).open(encoding='utf-8-sig')))
    after = list(csv.DictReader((ROOT / '方案/子任务T1' / name).open(encoding='utf-8-sig')))
    assert len(before) == len(after)
    allowed = {'状态', '工程开工例外', '工程进度'}
    differences = []
    for left, right in zip(before, after):
        assert set(left) == set(right)
        fields = [k for k in left if left[k] != right[k]]
        assert set(fields) <= allowed, (name, fields)
        if fields: differences.append({'id': next(iter(left.values())), 'changed_fields': fields})
    csv_checks[name] = {'requirements_and_thresholds_unchanged': True, 'progress_changes': differences}

machine_checks = {}
for name in ['当前版本.json', '开发计划.json']:
    before = json.loads((BEFORE / '方案/子任务T1' / name).read_text())
    after = json.loads((ROOT / '方案/子任务T1' / name).read_text())
    preserved_keys = ['S3_engineering', 'S2_preparation', 'human_stage_approval', 'S3_continuation_history']
    for key in preserved_keys: assert before.get(key) == after.get(key), (name, key)
    assert after['S4_engineering']['stage_passed'] is False
    assert after['S4_engineering']['formal_model_selected'] is False
    assert after['S4_engineering']['numeric_thresholds_frozen'] is False
    machine_checks[name] = {'preserved_historical_objects': preserved_keys, 'S4_medical_stage_not_passed': True}

docx_checks = {}
namespace = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
for name in ['T1开发执行说明.docx', 'T1智能体开发计划.docx']:
    with zipfile.ZipFile(BEFORE / '方案/子任务T1' / name) as left, zipfile.ZipFile(ROOT / '方案/子任务T1' / name) as right:
        assert left.namelist() == right.namelist()
        for member in left.namelist():
            if member != 'word/document.xml': assert left.read(member) == right.read(member), (name, member)
        old = [ET.tostring(p) for p in ET.fromstring(left.read('word/document.xml')).findall('.//w:p', namespace)]
        new = [ET.tostring(p) for p in ET.fromstring(right.read('word/document.xml')).findall('.//w:p', namespace)]
        assert new[:len(old)] == old, name
        docx_checks[name] = {'original_paragraphs': len(old), 'current_paragraphs': len(new),
                            'original_paragraph_XML_and_order_preserved': True, 'all_other_zip_members_preserved': True}

report = {'recorded_at': datetime.now(timezone.utc).isoformat(), 'passed': True,
    'protected_file_count': len(authority['protected_inputs_sha256']), 'protected_unchanged_count': len(authority['protected_inputs_sha256']) - len(changed),
    'permitted_current_status_file_changes': changed, 'missing': missing,
    'current_csv_checks': csv_checks, 'machine_history_checks': machine_checks, 'docx_checks': docx_checks,
    'medical_quality_approval': False, 'S5_started': False}
(OUT / 'protected-history-verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'passed': True, 'protected_files': report['protected_file_count'], 'permitted_current_status_changes': len(changed)}))
