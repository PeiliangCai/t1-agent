#!/usr/bin/env python3
"""Verify immutable history, source PDFs, stage gates and the S3 manifest."""
from datetime import datetime, timezone
from hashlib import sha256
import ast
import csv
from io import StringIO
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
import zipfile

CODE = Path(__file__).resolve().parents[1]
PROJECT = CODE.parent
PLAN = PROJECT / '方案/子任务T1'
OUT = CODE / 'docs/acceptance/s3'


def digest(path):
    result = sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            result.update(chunk)
    return result.hexdigest()


def read(path):
    return json.loads(path.read_text())


def verify():
    auth = read(OUT / 'engineering-start-authorization.json')
    original = OUT / 'before-engineering-start/方案/子任务T1'
    current, plan = read(PLAN / '当前版本.json'), read(PLAN / '开发计划.json')
    previous_current, previous_plan = read(original / '当前版本.json'), read(original / '开发计划.json')
    protected = {path: digest(PROJECT / path) == expected for path, expected in auth['protected_inputs_sha256'].items()}
    assert all(protected.values()), 'Historical acceptance or protected quality input changed'
    assert current['execution_guide']['confirmed_decisions'] == previous_current['execution_guide']['confirmed_decisions']
    assert current['S2_preparation']['status'] == plan['S2_preparation']['status'] == 'in_progress'
    assert current['S2_preparation']['stage_passed'] is False
    assert current['S2_preparation']['formal_review_progress'] == previous_current['S2_preparation']['formal_review_progress']
    assert current['S2_preparation']['formal_review_progress']['formal_astra_reviews_used'] == 2
    for state in [current['S3_engineering'], plan['S3_engineering']]:
        assert state['status'] == 'engineering_in_progress' and state['stage_passed'] is False
        assert state['formal_review_progress']['formal_astra_reviews_used'] == 3
        assert state['formal_parser_selected'] is False
    assert current['execution_guide']['source_scope_sha256'] == digest(PLAN / 'T1智能体开发计划.docx')
    stages = {s['id']: s for s in plan['progression']['stages']}
    for previous in previous_plan['progression']['stages']:
        current_stage = stages[previous['id']]
        for key in ['dependencies', 'work', 'deliverables', 'gate', 'fail_action']:
            assert current_stage[key] == previous[key], (previous['id'], key)
    assert stages['S2']['status'] == 'in_progress'
    assert stages['S3']['status'] == 'engineering_in_progress'
    assert stages['S4']['status'] == stages['S5']['status'] == 'not_started'
    tasks = {t['id']: t for t in plan['tasks']}
    assert all(tasks[t['id']]['dependencies'] == t['dependencies'] for t in previous_plan['tasks'])
    for name, identity in [('开发阶段与验收.csv', '阶段'), ('开发任务清单.csv', '编号')]:
        before = list(csv.DictReader(StringIO((original / name).read_text(encoding='utf-8-sig'))))
        after = {r[identity]: r for r in csv.DictReader(StringIO((PLAN / name).read_text(encoding='utf-8-sig')))}
        for row in before:
            for key, value in row.items():
                if key != '状态':
                    assert after[row[identity]][key] == value, (name, row[identity], key)
    source = read(CODE / 'evaluation/manifests/source-register.json')
    downloads = read(CODE / 'docs/acceptance/s2/downloads.json')
    pdfs = []
    for source_id in ['MED03', 'L07', 'L05', 'L01', 'L02']:
        item = next(s for s in source['sources'] if s['source_id'] == source_id)
        download = next(s for s in downloads['sources'] if s['source_id'] == source_id)
        actual = digest(CODE / item['access']['local_path'])
        assert actual == item['access']['sha256'] == download['sha256']
        assert not item['exposure']['independent_acceptance_eligible']
        pdfs.append({'source_id': source_id, 'path': item['access']['local_path'], 'sha256': actual, 'original_unchanged': True})
    ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    docx = []
    for name in ['T1开发执行说明.docx', 'T1智能体开发计划.docx']:
        with zipfile.ZipFile(original / name) as a, zipfile.ZipFile(PLAN / name) as b:
            assert a.namelist() == b.namelist()
            assert all(a.read(n) == b.read(n) for n in a.namelist() if n != 'word/document.xml')
            paragraphs = lambda z: [ET.tostring(p) for p in ET.fromstring(z.read('word/document.xml')).findall('.//w:p', ns)]
            old, new = paragraphs(a), paragraphs(b)
            assert new[:len(old)] == old
            docx.append({'file': name, 'old_paragraph_count': len(old), 'current_paragraph_count': len(new),
                         'old_paragraph_xml_preserved': True, 'other_zip_member_bytes_and_order_preserved': True})
    old_guide_version = read(OUT / 'before-u02-clarification/code/evaluation/annotations/guide-version.json')
    assert digest(CODE / old_guide_version['file']) == old_guide_version['sha256']
    guide = read(CODE / 'evaluation/annotations/guide-version.json')
    assert digest(CODE / guide['file']) == guide['sha256']
    assert guide['status'] == 'pending_user_and_medical_confirmation'
    with zipfile.ZipFile(CODE / old_guide_version['file']) as a, zipfile.ZipFile(CODE / guide['file']) as b:
        assert all(a.read(n) == b.read(n) for n in a.namelist() if n != 'word/document.xml')
        old = [ET.tostring(p) for p in ET.fromstring(a.read('word/document.xml')).findall('.//w:p', ns)]
        new = [ET.tostring(p) for p in ET.fromstring(b.read('word/document.xml')).findall('.//w:p', ns)]
        assert new[:len(old)] == old
    # Syntax checking new orchestration/docs scripts needs no model or server.
    parsed = []
    for path in sorted((CODE / 'scripts').glob('*s3*.py')):
        ast.parse(path.read_text(), filename=str(path)); parsed.append(str(path.relative_to(CODE)))
    manifest = read(OUT / 'version-manifest.json')
    manifest_checks = {path: digest(PROJECT / path) == expected for path, expected in manifest['files_sha256'].items()}
    assert all(manifest_checks.values()), 'S3 manifest differs from current files'
    return {'recorded_at': datetime.now(timezone.utc).isoformat(), 'all_integrity_checks_passed': True,
            'protected_historical_file_count': len(protected), 'protected_historical_files_unchanged': True,
            'E01_to_E09_unchanged': True, 'original_stage_gates_and_dependencies_unchanged': True,
            'numeric_quality_contract_unchanged': True, 'S2_status': 'in_progress', 'S2_reviews_used': 2,
            'S3_status': 'engineering_in_progress', 'S3_stage_passed': False, 'S3_reviews_used': 3,
            'S4_S5_started': False, 'formal_parser_selected': False, 'original_pdfs': pdfs,
            'docx_preservation': docx, 'old_v01_annotation_guide_unchanged': True, 'new_v02_guide_append_only': True,
            'new_python_orchestration_scripts_syntax_checked': parsed,
            'manifest_file_count': len(manifest_checks), 'all_manifest_file_hashes_match': True,
            'version_manifest_sha256': digest(OUT / 'version-manifest.json'),
            'not_an_additional_formal_review': True, 'medical_or_stage_quality_acceptance': False}


if __name__ == '__main__':
    report = verify()
    if '--write' in sys.argv:
        target = OUT / 'final-integrity.json'
        assert not target.exists(), 'Existing integrity evidence is immutable; choose a separate recheck record'
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'all_integrity_checks_passed': True, 'historical_files_unchanged': report['protected_historical_file_count'],
                      'manifest_files_verified': report['manifest_file_count'], 'S3_stage_passed': False}, ensure_ascii=False))
