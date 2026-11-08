#!/usr/bin/env python3
"""Read-only project inventory; writes reports only beside this script.

Run: python3 code/docs/acceptance/reference-answer-inventory-2026-11-04/build_inventory.py
Uses only the Python standard library. Does not execute project scripts, import
application code, open a browser, call APIs, extract archives to disk, or read
environment / credential files. Re-running replaces only this report's outputs.
"""
from __future__ import annotations

import argparse
import bisect
import collections
import csv
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile
import time
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timezone


OUT = Path(__file__).resolve().parent
DEFAULT_ROOT = OUT.parents[3]
TEXT_LIMIT = 48 * 1024 * 1024
NESTED_ARCHIVE_LIMIT = 96 * 1024 * 1024
ARCHIVE_READ_BUDGET = 256 * 1024 * 1024
ARCHIVE_MAX_DEPTH = 3
ARCHIVE_MAX_ENTRIES = 25000
SKIP_DIR_NAMES = {
    '.git', '.aws', '.codex', '.agents', 'node_modules', '.venv', 'venv',
    '__pycache__', '.next', '.cache', 'third_party', '.pytest_cache',
}
SECRET_NAMES = {
    '.npmrc', '.pypirc', '.netrc', 'credentials', 'credentials.json',
    'secrets.json', 'secrets.yaml', 'secrets.yml', 'id_rsa', 'id_ed25519',
    'auth.json', 'accounts.json',
}
TEXT_EXTENSIONS = {
    '.json', '.jsonl', '.md', '.txt', '.csv', '.ts', '.tsx', '.js', '.jsx',
    '.mjs', '.cjs', '.py', '.sh', '.html', '.css', '.log', '.diff', '.patch',
    '.yml', '.yaml', '.toml', '.sql', '.xml', '.rst',
}
PATTERN_SPECS = [
    ('reference_answer_zh', r'参考答案|参考草稿|参考工作簿|AI参考(?:资料|表|Excel|草稿)'),
    ('complete_gold_zh', r'完整(?:人工)?金标|金标准|全文金标|零金标|独立金标'),
    ('full_annotation_zh', r'人工全文标注|全文独立标注|完整(?:独立)?人工标注|独立(?:人工)?标注|人工标注指南|医学专家.{0,20}标注'),
    ('human_gold', r'human[_ -]?gold|complete[_ -]?human[_ -]?gold|human_reference_status'),
    ('gold_contract', r'gold_units|gold_unit_id|full_text_read|independent_of_predictions|full_gold_required|full_reference_answers_required'),
    ('legacy_gold', r'legacy[_ -]?gold|旧完整答案|旧金标工具|完整答案准备'),
    ('ai_reference', r'ai[_-]reference|reference-drafts|raw-workbook\.json|source-anchor-index\.json|import-ai-reference|posthoc-(?:ai-reference|unresolved-reference|source-layer|comparison-contract)'),
    ('annotation_paths', r'expert-handoff|annotation-ui|annotation-offline|prepare-annotation|package-annotation|verify-annotation|render-annotation|t1/annotation|apps/web/src/(?:App|domain|EvidenceEditor|PrintPreview)'),
    ('annotation_workbench', r'离线标注工作台|全文标注工作台|S2.{0,8}标注(?:工作台|页面)|独立全文参考'),
    ('evaluation_gold_schema', r'GoldUnitSchema|GoldEvidenceUnit|unmatched_gold_units|gold_in_scope|no_complete_human_gold|independent_full_text_annotation_incomplete'),
    ('english_reference_context', r'(?:human|medical|verbatim|full[-_ ]text)[ _/-]+(?:full[-_ ]text[ _-]+)?gold\b|\bgold[ _-]+(?:unit|annotation|set|prerequisite|based|quality)\b|\b(?:cancelled|full|no|not|never|zero|out[-_ ]of[-_ ]scope)[ _-]+gold\b|\bS2[^\n]{0,15}\bgold\b|\bword-for-word[ _-]+gold\b|\bduplicate[^\n]{0,30}\bgold\b|\breference[ _-]+answers?\b'),
    ('annotation_preparation_context', r'人工标注(?:工具|材料|模板)|full_text_annotation|human_annotation|independent_annotation|annotation_guide'),
]
PATTERNS = [(key, re.compile(pattern, re.I)) for key, pattern in PATTERN_SPECS]
# Literal gates avoid repeatedly regex-scanning large embedded base64/medical text
# with patterns that cannot possibly match. Every expression has a required gate.
PATTERN_GATES = {
    'reference_answer_zh': ['参考答案', '参考草稿', '参考工作簿', 'ai参考'],
    'complete_gold_zh': ['金标', '金标准'],
    'full_annotation_zh': ['标注'],
    'human_gold': ['gold', 'human_reference_status'],
    'gold_contract': ['gold_', 'full_text_read', 'independent_of_predictions', 'full_reference_answers_required'],
    'legacy_gold': ['gold', '旧完整答案', '旧金标工具', '完整答案准备'],
    'ai_reference': ['reference', 'raw-workbook', 'source-anchor', 'import-ai', 'posthoc'],
    'annotation_paths': ['annotation', 'expert-handoff', 'apps/web/src'],
    'annotation_workbench': ['标注', '独立全文参考'],
    'evaluation_gold_schema': ['gold', 'independent_full_text'],
    'english_reference_context': ['gold', 'reference'],
    'annotation_preparation_context': ['人工标注', 'annotation'],
}
CREDENTIAL_MARKER = re.compile(
    r'api[_-]?key|authorization|\bbearer\b|password|passwd|access[_-]?token|'
    r'refresh[_-]?token|secret[_-]?key|private[_-]?key|\bsk-[a-z0-9]{12,}|\bAKIA[A-Z0-9]{12,}', re.I)
DIRECT_ROOTS = {
    'code/evaluation/annotations': 'direct_annotation_materials',
    'code/evaluation/reference-drafts': 'ai_reference_drafts',
    'code/dist/annotation-offline': 'offline_annotation_distribution',
    'code/docs/acceptance/s2/annotation-ui': 'annotation_qa_history',
    'code/docs/acceptance/pi-web-frontend-2026-11-04/annotation': 'retirement_records_archives',
    'code/docs/acceptance/s4/input-selection/ai-reference': 'ai_reference_derivatives',
}
SHARED_ENGINE_ROOTS = [
    'code/evaluation/src', 'code/evaluation/contracts', 'code/evaluation/rules',
    'code/evaluation/fixtures/scoring', 'code/evaluation/reports/fixtures',
    'code/evaluation/reports/real', 'code/tests/evaluation',
]
SHARED_SOURCE_ROOTS = [
    'code/evaluation/catalog', 'code/evaluation/manifests', 'code/evaluation/corpus',
]
SHARED_SCRIPTS = {
    'code/scripts/prepare-s2-materials.py', 'code/scripts/start-s2.py',
    'code/scripts/clarify-s2-u02.py', 'code/scripts/check-s2.py',
    'code/scripts/export-evaluation-contracts.ts', 'code/scripts/evaluate-quality.ts',
}
AI_SCRIPTS = {'code/scripts/import-ai-reference.py', 'code/scripts/test-import-ai-reference.py'}
POSTHOC_PREFIX = 'code/docs/acceptance/s4/selection-optimization/continuation-2026-11-03/'
POSTHOC_FILES = {
    POSTHOC_PREFIX + name for name in [
        'posthoc-ai-reference-review.json', 'posthoc-unresolved-reference-rows.json',
        'posthoc-source-layer-summary.json', 'posthoc-comparison-contract.json',
        'outputs-freeze.json',
    ]
}
EXPLICIT_FILES = {
    'code/dist/T1-S2-离线标注工作台.zip': 'offline_annotation_distribution',
    '方案/历史归档.zip': 'historical_archive_containers',
    'research/调研原始资料.zip': 'historical_archive_containers',
    'code/scripts/verify-pi-web-browser.mjs': 'shared_browser_verification',
    'code/package.json': 'related_shared_application_code',
}
SUPPORT_ROOTS = ['code/.tools/annotation-browser', 'code/.tools/qa-tmp']
KEY_FILES = {
    'code/README.md', '方案/子任务T1/当前版本.json', '方案/子任务T1/开发计划.json',
    '方案/子任务T1/质量与性能验收契约.json',
    'code/docs/acceptance/pi-web-frontend-2026-11-04/annotation/retirement-manifest.json',
    'code/evaluation/reference-drafts/2026-11-03-l01-l05/summary.json',
    'code/scripts/verify-pi-web-browser.mjs',
}
CATEGORY_LABELS = {
    'direct_annotation_materials': '专项人工标注指南、模板与专家交接材料（旧要求留档）',
    'ai_reference_drafts': '用户提供AI参考工作簿的七份转换产物（非医生金标准）',
    'ai_reference_import_tools': 'AI参考导入与本地校验脚本（保留，未运行）',
    'ai_reference_derivatives': 'AI参考导入报告、冻结后对照与来源分层报告',
    'offline_annotation_distribution': '旧离线工作台发布物、说明、许可和论文复制件',
    'annotation_qa_history': '旧工作台工程验收、合成测试答案、打印件和历史源码快照',
    'retirement_records_archives': '退役记录、历史备份和实际归档容器',
    'shared_evaluation_engine': '共用评测接口、计分/准备逻辑、测试及合成计分报告',
    'shared_source_materials': '共用医学目录、来源/分组清单及五篇PDF原件',
    'current_policy_documents': '当前方案、README及取消/退役规则说明',
    'historical_records_references': '历史阶段证据、before快照和运行/来源快照内的相关引用',
    'related_shared_application_code': '仍在仓库中的共用代码/配置/契约内的相关字段或引用',
    'related_preparation_scripts': '仍在仓库中的其它准备/记录/材料生成脚本内的相关引用',
    'historical_archive_containers': '方案历史与调研原始档案容器（逐成员筛选）',
    'shared_browser_verification': '当前新前端复用的浏览器验证脚本',
    'research_reference_mentions': '调研资料中的相关提及（不等于项目答案）',
    'other_related_documents': '其它项目文件中的明确相关提及',
}
FILE_FIELDS = [
    'path', 'category', 'category_zh', 'role', 'current_status', 'size_bytes',
    'file_kind', 'matched_terms', 'evidence_locator', 'evidence_snippet',
    'match_count', 'scan_method', 'notes', 'archive_parent', 'source_sha256',
]
ARCHIVE_FIELDS = [
    'path', 'archive_parent', 'container_format', 'member_name', 'depth', 'member_type',
    'size_bytes', 'compressed_bytes', 'related', 'category', 'role', 'current_status',
    'matched_terms', 'evidence_locator', 'evidence_snippet', 'match_count', 'scan_method',
    'notes', 'member_sha256',
]


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def under(path, prefix):
    return path == prefix or path.startswith(prefix + '/')


def sensitive_name(name):
    low = name.lower()
    return low.startswith('.env') or low in SECRET_NAMES or low.endswith(('.pem', '.key', '.p12', '.pfx'))


def digest_file(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def safe_snippet(text):
    compact = re.sub(r'\s+', ' ', text).strip()
    if CREDENTIAL_MARKER.search(compact):
        return '[片段含凭证相关字段名，内容不复制；仅保留匹配词与定位]'
    return compact[:190]


def walk_files(root, excluded_output):
    """Metadata only; never follow file or directory symlinks."""
    result, excluded, errors = {}, collections.Counter(), []
    for current, dirs, files in os.walk(root, followlinks=False):
        base = Path(current)
        kept = []
        for name in sorted(dirs):
            p = base / name
            rel = p.relative_to(root).as_posix()
            if p == excluded_output or name in SKIP_DIR_NAMES or rel == 'code/.tools':
                excluded[rel] += 1
            elif p.is_symlink():
                excluded['symlink_directory_not_followed'] += 1
            else:
                kept.append(name)
        dirs[:] = kept
        for name in sorted(files):
            p = base / name
            rel = p.relative_to(root).as_posix()
            if sensitive_name(name):
                excluded['sensitive_file_names_not_read'] += 1
                continue
            try:
                st = p.lstat()
                item = {'size_bytes': st.st_size, 'mtime_ns': st.st_mtime_ns,
                        'mode': stat.S_IFMT(st.st_mode),
                        'file_kind': 'symlink' if stat.S_ISLNK(st.st_mode) else 'regular'}
                if rel in KEY_FILES and item['file_kind'] == 'regular':
                    item['sha256'] = digest_file(p)
                result[rel] = item
            except OSError as exc:
                errors.append({'path': rel, 'error': type(exc).__name__})
    return dict(sorted(result.items())), dict(excluded), errors


def support_snapshot(root):
    result, errors = {}, []
    for prefix in SUPPORT_ROOTS:
        start = root / prefix
        if not start.exists():
            continue
        for current, dirs, files in os.walk(start, followlinks=False):
            base = Path(current)
            for name in list(dirs):
                p = base / name
                if p.is_symlink():
                    files.append(name)
                    dirs.remove(name)
            for name in sorted(files):
                if sensitive_name(name):
                    continue
                p = base / name
                try:
                    st = p.lstat()
                    result[p.relative_to(root).as_posix()] = {
                        'size_bytes': st.st_size, 'mtime_ns': st.st_mtime_ns,
                        'file_kind': 'symlink' if stat.S_ISLNK(st.st_mode) else 'regular',
                    }
                except OSError as exc:
                    errors.append({'path': p.relative_to(root).as_posix(), 'error': type(exc).__name__})
    return dict(sorted(result.items())), errors


def compare_snapshots(before, after):
    return {
        'added': sorted(set(after) - set(before)),
        'removed': sorted(set(before) - set(after)),
        'changed': sorted(p for p in set(before) & set(after) if before[p] != after[p]),
    }


def has_changes(delta):
    return any(delta.values())


def extract_office(data, suffix):
    units = []
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        if suffix == '.docx':
            names = sorted(n for n in z.namelist() if re.fullmatch(
                r'word/(?:document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml', n))
            for name in names:
                info = z.getinfo(name)
                if info.file_size > TEXT_LIMIT:
                    raise ValueError('office_xml_size_limit')
                tree = ET.fromstring(z.read(info))
                paragraphs = [e for e in tree.iter() if e.tag.endswith('}p')]
                for number, p in enumerate(paragraphs, 1):
                    text = ''.join(e.text or '' for e in p.iter() if e.tag.endswith('}t'))
                    if text:
                        units.append((f'{name}:paragraph:{number}', text))
        else:
            shared = []
            if 'xl/sharedStrings.xml' in z.namelist():
                if z.getinfo('xl/sharedStrings.xml').file_size > TEXT_LIMIT:
                    raise ValueError('office_shared_strings_size_limit')
                tree = ET.fromstring(z.read('xl/sharedStrings.xml'))
                shared = [''.join(e.text or '' for e in si.iter() if e.tag.endswith('}t')) for si in tree]
            for name in sorted(n for n in z.namelist() if re.fullmatch(r'xl/worksheets/sheet\d+\.xml', n)):
                if z.getinfo(name).file_size > TEXT_LIMIT:
                    raise ValueError('office_sheet_size_limit')
                tree = ET.fromstring(z.read(name))
                for c in (e for e in tree.iter() if e.tag.endswith('}c')):
                    cell_type = c.attrib.get('t')
                    value = next((e.text or '' for e in c if e.tag.endswith('}v')), '')
                    if cell_type == 's' and value.isdigit() and int(value) < len(shared):
                        value = shared[int(value)]
                    elif cell_type == 'inlineStr':
                        value = ''.join(e.text or '' for e in c.iter() if e.tag.endswith('}t'))
                    # Formula expressions and external relationships are not evaluated.
                    if value:
                        units.append((f'{name}!{c.attrib.get("r", "?")}', value))
    return units


def match_units(units, plain_text=False):
    terms, evidences, total = set(), [], 0
    for locator, value in units:
        offsets = [m.start() for m in re.finditer('\n', value)] if plain_text else []
        folded = value.casefold()
        for key, pattern in PATTERNS:
            if not any(gate in folded for gate in PATTERN_GATES[key]):
                continue
            matches = list(pattern.finditer(value))
            if not matches:
                continue
            terms.add(key)
            total += len(matches)
            for match in matches[:1]:
                loc = f'line:{bisect.bisect_left(offsets, match.start()) + 1}' if plain_text else locator
                snippet = safe_snippet(value[max(0, match.start() - 45):match.end() + 115])
                if len(evidences) < 4 and (loc, snippet) not in evidences:
                    evidences.append((loc, snippet))
    return {
        'matched_terms': ';'.join(sorted(terms)),
        'evidence_locator': ' | '.join(x[0] for x in evidences),
        'evidence_snippet': ' | '.join(x[1] for x in evidences),
        'match_count': total,
    }


def scan_bytes(data, name):
    suffix = Path(name).suffix.lower()
    if suffix in {'.docx', '.xlsx'}:
        try:
            result = match_units(extract_office(data, suffix))
            result['scan_method'] = 'office_xml_text_no_formula_evaluation'
            return result
        except (ValueError, zipfile.BadZipFile, ET.ParseError, KeyError) as exc:
            return {'scan_method': 'office_xml_read_error', 'error': type(exc).__name__}
    if suffix == '.pdf':
        return {'scan_method': 'pdf_metadata_and_directory_role_only'}
    if suffix not in TEXT_EXTENSIONS and Path(name).name not in {'LICENSE', 'README', 'Makefile'}:
        return {'scan_method': 'binary_metadata_or_unsupported_text_type'}
    if len(data) > TEXT_LIMIT:
        return {'scan_method': 'text_size_limit_not_read'}
    try:
        value = data.decode('utf-8-sig')
    except UnicodeDecodeError:
        try:
            value = data.decode('gb18030')
        except UnicodeDecodeError:
            return {'scan_method': 'undecodable_text_not_read'}
    if '\x00' in value:
        return {'scan_method': 'binary_nul_not_read'}
    result = match_units([('', value)], plain_text=True)
    result['scan_method'] = 'utf8_or_gb18030_text'
    return result


def empty_evidence(method='metadata_and_directory_role'):
    return {'matched_terms': '', 'evidence_locator': '', 'evidence_snippet': '',
            'match_count': 0, 'scan_method': method}


def category_for(path, evidence):
    for prefix, category in DIRECT_ROOTS.items():
        if under(path, prefix):
            return category
    if path in AI_SCRIPTS:
        return 'ai_reference_import_tools'
    if path in POSTHOC_FILES:
        return 'ai_reference_derivatives'
    if path in EXPLICIT_FILES:
        return EXPLICIT_FILES[path]
    if path in SHARED_SCRIPTS or any(under(path, p) for p in SHARED_ENGINE_ROOTS):
        return 'shared_evaluation_engine'
    if any(under(path, p) for p in SHARED_SOURCE_ROOTS):
        return 'shared_source_materials'
    if not evidence.get('matched_terms'):
        return None
    if path == 'code/README.md' or path.startswith('方案/'):
        return 'current_policy_documents'
    if path.startswith(('code/docs/acceptance/', 'code/runtime-data/')):
        return 'historical_records_references'
    if path.startswith('code/scripts/'):
        return 'related_preparation_scripts'
    if path.startswith(('code/apps/', 'code/packages/', 'code/tests/', 'code/services/', 'code/evaluation/')):
        return 'related_shared_application_code'
    if path.startswith('research/'):
        return 'research_reference_mentions'
    return 'other_related_documents'


def role_and_status(path, category):
    name, suffix = Path(path).name, Path(path).suffix.lower()
    if category == 'direct_annotation_materials':
        status = '历史专项材料保留；完整答案准备要求已取消；未宣称人工完成'
        if '参考答案_待复核.xlsx' in name:
            return '用户提供的其它AI抽取参考工作簿；56条草稿；不是医生已审核金标准', status
        if suffix == '.pdf':
            return '专家材料中的原论文复制件；共用语料原件另在evaluation/corpus', status
        if suffix == '.zip':
            return '专家交接ZIP（实际11成员，未含后来新增的AI参考工作簿）', status
        if '空白' in name or '/templates/' in path:
            return '空白标注/逐页核对/争议/裁定模板；不是已经制作的完整答案', status
        if suffix == '.docx':
            return '旧独立全文标注指南或医学专家任务说明', status
        if suffix == '.py':
            return '旧专家交接材料生成脚本；本次只读盘点，未执行', status
        return '专项指南版本、人员待办、材料保全或包装元数据', status
    if category == 'ai_reference_drafts':
        roles = {
            'raw-workbook.json': '工作簿单元格与原始声明转存；不代表人工核准',
            'reference-drafts.json': '56条外部AI参考草稿及来源映射；禁止当作医学gold',
            'source-anchor-index.json': '参考草稿到既有来源区间的锚点索引',
            'pdf-page-texts.json': 'L01/L05页级PDF文字辅助核对；不是医学答案',
            'issues.json': '字面对齐、重复引文和争议问题清单',
            'summary.json': '草稿数量、字面对齐与人工待复核状态汇总',
            'preservation.json': '导入输入哈希、未调用模型/网络、未改原件的保全记录',
        }
        return roles.get(name, 'AI参考转换产物'), '保留供溯源；not_gold=true，human_verified=false，不能用于正式质量计分'
    if category == 'ai_reference_import_tools':
        return 'AI工作簿只读导入/来源保全或其本地校验脚本；未运行', '源码保留；不作为本次必须准备答案的任务；旧人标要求文字仅属历史'
    if category == 'ai_reference_derivatives':
        return '冻结输出后的AI参考字面/来源区间对照、未定位行分层或导入报告', '历史研究证据；不产生医生金标准或医学precision/recall/F1'
    if category == 'offline_annotation_distribution':
        if suffix == '.pdf':
            role = '旧离线包中的原论文复制件；不是参考答案'
        elif '/licenses/' in path:
            role = '旧离线包依赖/字体许可附属文件；不是医学答案'
        elif suffix == '.html':
            role = '仍存在的旧离线标注工具HTML发布成品；活动入口已退役'
        elif suffix == '.zip':
            role = '旧离线工作台完整ZIP（25发布文件；没有TS源码）'
        else:
            role = '旧离线包使用说明、哈希或发布清单'
        return role, '旧发布物保留；已从当前应用退役；本次未删除/重建'
    if category == 'annotation_qa_history':
        if '/before-' in path:
            role = '旧工作台开发时的源码/配置/审查输入历史快照'
        elif suffix in {'.pdf', '.png'}:
            role = '合成测试的打印件或界面截图；不是医生参考答案'
        elif any(x in name for x in ['backup', 'export', 'fixture', 'roundtrip']):
            role = '旧工作台合成/演示测试答案、备份、导出或回环验证产物'
        else:
            role = '旧工作台工程验收、日志、资源准备或正式审查记录'
        return role, '历史QA证据封存；整目录纳入；不能升级医学批准'
    if category == 'retirement_records_archives':
        return ('实际退役归档容器；源码/测试只存在于对应tar成员，另表逐项列出'
                if archive_format(name) else '旧准备工具退役、合成备份或来源/资源保全记录'), '退役事实/历史留档；并非当前活动准备入口'
    if category == 'shared_evaluation_engine':
        if '/fixtures/' in path:
            role = '合成计分fixture或其报告；不能作真实医学答案'
        elif '/reports/real/' in path:
            role = '真实评测输入未具备条件时的阻塞/未评估报告'
        elif '/scripts/' in path:
            role = '共用S2材料准备、状态检查、契约导出或质量计分脚本'
        elif '/tests/' in path:
            role = '共用评测计分/契约工程测试'
        else:
            role = '共用评测契约、金标字段、计分器或草案规则'
        return role, '共用保留；可能含旧完整gold约束；不据此判定应整体删除'
    if category == 'shared_source_materials':
        return ('五篇原始开发语料PDF之一；专项包内另有复制件' if suffix == '.pdf'
                else '共用医学目录、适用关系、文献来源、分组/暴露或划分清单'), '共用基础资料保留；不是已制作参考答案'
    if category == 'current_policy_documents':
        return '当前方案/工程说明中的参考答案、取消要求、退役或可选研究规则', '以当前有效规则为准：完整参考答案要求已取消；真实输出逐条人工审核仍保留'
    if category == 'historical_records_references':
        if '/source-snapshots/' in path or '/before-' in path:
            role = '旧源码/方案/报告的历史before或source快照内的相关引用'
        else:
            role = '阶段/运行/验收报告中关于旧gold、标注准备、AI参考或取消要求的相关引用'
        return role, '历史或变更记录；仅引用不等于实际医生答案；不改写旧事实'
    if category == 'shared_browser_verification':
        return '当前pi-web浏览器验证脚本，明确复用annotation-browser和qa-tmp', '当前通用QA仍在使用；支持工具另表，不属于医学答案'
    if category == 'historical_archive_containers':
        return '历史方案/调研资料归档；ZIP成员另表标相关或未命中', '档案保留；不声称整个档案均有关或均应删除'
    if category == 'related_preparation_scripts':
        return '共用阶段准备、交付报告或历史状态记录脚本中的明确相关引用', '现存脚本；本次未执行；与其它工程工作共用'
    if category == 'related_shared_application_code':
        if path == 'code/package.json':
            return '共用应用配置/评测入口：test:evaluation、eval:quality、eval:export-contracts直接调用现存评测代码', '当前保留的共用入口；不是完整参考答案准备页面'
        return '共用应用代码/契约/测试中的旧gold、AI参考或退役状态相关字段', '现存共用代码；不等于仍有完整答案准备页面'
    if category == 'research_reference_mentions':
        return '调研资料中的明确参考答案/金标/标注相关提及', '调研材料；不等于本项目已生成答案'
    return '项目文件中的明确参考答案准备相关提及', '仅记录引用及定位；未变更现有文件'


def archive_format(name):
    low = name.lower()
    if low.endswith('.zip'):
        return 'zip'
    if low.endswith(('.tar.gz', '.tgz', '.tar')):
        return 'tar'
    return None


class Inventory:
    def __init__(self, root):
        self.root = root
        self.rows = {}
        self.details = {}
        self.archive_rows = []
        self.archive_stats = []
        self.problems = []
        self.budget_used = 0
        self.archive_entries_seen = 0

    def scan_file(self, rel, metadata):
        path = self.root / rel
        evidence = empty_evidence()
        if metadata['file_kind'] == 'symlink':
            evidence['scan_method'] = 'symlink_not_followed'
        elif archive_format(rel):
            evidence['scan_method'] = 'archive_member_inventory_separate_csv'
        elif metadata['size_bytes'] > TEXT_LIMIT:
            evidence['scan_method'] = 'size_limit_metadata_only'
        elif Path(rel).suffix.lower() in TEXT_EXTENSIONS | {'.docx', '.xlsx'} or Path(rel).name in {'LICENSE', 'README', 'Makefile'}:
            try:
                evidence.update(scan_bytes(path.read_bytes(), rel))
            except OSError as exc:
                self.problems.append({'path': rel, 'error': type(exc).__name__})
                evidence['scan_method'] = 'source_read_error'
        elif Path(rel).suffix.lower() == '.pdf':
            evidence['scan_method'] = 'pdf_metadata_and_directory_role_only'
        path_match = [key for key, pattern in PATTERNS if pattern.search(rel)]
        if path_match:
            existing = set(filter(None, evidence['matched_terms'].split(';')))
            evidence['matched_terms'] = ';'.join(sorted(existing | {'path:' + k for k in path_match}))
            if not evidence['evidence_locator']:
                evidence['evidence_locator'] = 'path'
                evidence['evidence_snippet'] = rel
        if rel == 'code/package.json' and metadata['file_kind'] == 'regular':
            command_lines = [(number, line.strip()) for number, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1)
                             if re.search(r'"(?:test:evaluation|eval:quality|eval:export-contracts)"\s*:', line)]
            evidence.update(matched_terms='explicit_evaluation_entrypoints',
                evidence_locator=' | '.join(f'line:{number}' for number, _ in command_lines),
                evidence_snippet=' | '.join(safe_snippet(line) for _, line in command_lines),
                match_count=len(command_lines), scan_method='explicit_evaluation_command_reference_chain')
        category = category_for(rel, evidence)
        self.details[rel] = evidence
        self.rows.pop(rel, None)
        if category:
            role, status = role_and_status(rel, category)
            self.rows[rel] = dict(path=rel, category=category, category_zh=CATEGORY_LABELS[category],
                role=role, current_status=status, size_bytes=metadata['size_bytes'],
                file_kind=metadata['file_kind'], **{k: evidence[k] for k in ['matched_terms',
                'evidence_locator', 'evidence_snippet', 'match_count', 'scan_method']},
                notes=('按明确目录归属/引用链全量纳入；正文无需命中。' if not evidence['match_count'] else '')
                      + ('源文件没有被读取：仅列元数据。' if metadata['file_kind'] == 'symlink' else ''),
                archive_parent='', source_sha256=metadata.get('sha256', ''))

    def scan_archives(self, metadata):
        self.archive_rows, self.archive_stats = [], []
        self.budget_used, self.archive_entries_seen = 0, 0
        for rel in sorted(p for p in metadata if archive_format(p) and metadata[p]['file_kind'] == 'regular'):
            try:
                with (self.root / rel).open('rb') as stream:
                    direct_archive = self.rows.get(rel, {}).get('category') in {
                        'direct_annotation_materials', 'offline_annotation_distribution',
                        'retirement_records_archives',
                    }
                    self.scan_archive(stream, rel, 0, direct_archive)
            except (OSError, tarfile.TarError, zipfile.BadZipFile, ValueError) as exc:
                self.problems.append({'path': rel, 'error': type(exc).__name__, 'operation': 'archive_read'})
        related_parents = {r['path'].split('!/', 1)[0] for r in self.archive_rows if r['related']}
        for parent in related_parents:
            if parent not in self.rows and parent in metadata:
                self.rows[parent] = dict(path=parent, category='historical_archive_containers',
                    category_zh=CATEGORY_LABELS['historical_archive_containers'],
                    role='含明确相关成员的归档容器；逐成员另表', current_status='历史留档',
                    size_bytes=metadata[parent]['size_bytes'], file_kind=metadata[parent]['file_kind'],
                    **empty_evidence('archive_member_inventory_separate_csv'), notes='', archive_parent='', source_sha256='')
        for info in self.archive_stats:
            row = self.rows.get(info['path'])
            if row and row['category'] == 'historical_archive_containers':
                row['notes'] = f"已检查全部{info['file_entries']}文件成员；精确范围相关{info['related_file_entries']}成员。"
                if info['related_file_entries'] == 0:
                    row['role'] = '已检查的候选档案；未检出符合本次精确范围的相关内容'
                    row['current_status'] = '候选档案已检查；相关成员0，不称为有参考答案内容'

    def scan_archive(self, source, parent, depth, inherited_related):
        fmt = archive_format(parent)
        if depth > ARCHIVE_MAX_DEPTH:
            self.problems.append({'path': parent, 'error': 'nested_archive_depth_limit'})
            return
        if fmt == 'zip':
            archive = zipfile.ZipFile(source)
            entries = archive.infolist()
        else:
            archive = tarfile.open(fileobj=source, mode='r:*')
            entries = archive.getmembers()
        summary = {'path': parent, 'format': fmt, 'depth': depth, 'entries': len(entries),
                   'file_entries': 0, 'related_file_entries': 0, 'uncompressed_file_bytes': 0,
                   'related_uncompressed_file_bytes': 0, 'nested_archives': 0, 'read_errors_or_limits': []}
        self.archive_stats.append(summary)
        try:
            for info in entries:
                self.archive_entries_seen += 1
                if self.archive_entries_seen > ARCHIVE_MAX_ENTRIES:
                    summary['read_errors_or_limits'].append('global_archive_entries_limit')
                    break
                name = info.filename if fmt == 'zip' else info.name
                is_dir = info.is_dir() if fmt == 'zip' else info.isdir()
                is_file = (not is_dir) if fmt == 'zip' else info.isfile()
                member_type = 'directory' if is_dir else ('file' if is_file else 'link_or_special')
                size = info.file_size if fmt == 'zip' else info.size
                member_path = parent + '!/' + name
                evidence = empty_evidence('archive_member_metadata')
                data = None
                leaf = PurePosixPath(name).name
                parts = PurePosixPath(name).parts
                excluded_member = sensitive_name(leaf) or any(p in SKIP_DIR_NAMES for p in parts)
                is_nested = bool(archive_format(name))
                read_limit = NESTED_ARCHIVE_LIMIT if is_nested else TEXT_LIMIT
                suffix = Path(name).suffix.lower()
                readable = suffix in TEXT_EXTENSIONS | {'.docx', '.xlsx'} or leaf in {'LICENSE', 'README', 'Makefile'}
                # For direct retired archives, hashes also verify manifest-only paths against real members.
                need_data = is_file and not excluded_member and (readable or is_nested or inherited_related)
                if need_data:
                    if size > read_limit or self.budget_used + size > ARCHIVE_READ_BUDGET:
                        evidence['scan_method'] = 'archive_read_size_or_budget_limit'
                        summary['read_errors_or_limits'].append(name)
                    elif fmt == 'zip' and info.flag_bits & 1:
                        evidence['scan_method'] = 'encrypted_member_not_read'
                        summary['read_errors_or_limits'].append(name)
                    else:
                        try:
                            handle = archive.open(info) if fmt == 'zip' else archive.extractfile(info)
                            with handle:
                                data = handle.read(read_limit + 1)
                            self.budget_used += len(data)
                            if len(data) > read_limit:
                                data = None
                                evidence['scan_method'] = 'actual_member_size_limit'
                            elif readable:
                                evidence.update(scan_bytes(data, name))
                            elif suffix == '.pdf':
                                evidence['scan_method'] = 'pdf_metadata_and_directory_role_only'
                        except (OSError, RuntimeError, zipfile.BadZipFile, tarfile.TarError) as exc:
                            evidence['scan_method'] = 'archive_member_read_error'
                            summary['read_errors_or_limits'].append(name + ':' + type(exc).__name__)
                if excluded_member:
                    evidence['scan_method'] = 'sensitive_or_dependency_member_not_read'
                path_terms = [key for key, pattern in PATTERNS if pattern.search(name)]
                if path_terms:
                    evidence['matched_terms'] = ';'.join(sorted(set(filter(None,
                        evidence['matched_terms'].split(';'))) | {'path:' + k for k in path_terms}))
                related = bool(inherited_related or evidence['matched_terms'])
                archive_context = parent.split('!/', 1)[0]
                if 'retired-' in archive_context or '/annotation/' in archive_context:
                    category = 'retired_application_archive_member'
                    role = ('已撤下旧源码/脚本/测试的真实归档成员'
                            if suffix in {'.ts', '.tsx', '.py', '.mjs', '.css', '.json', '.html'} and '/pdfjs/' not in name
                            else '退役工具随附资源/原论文复制件/构建成品')
                elif '离线标注工作台' in archive_context:
                    category, role = 'offline_distribution_archive_member', '旧离线发布包成员；无TS源码'
                elif 'expert-handoff' in archive_context:
                    category, role = 'expert_handoff_archive_member', '旧专家交接包成员；不是已完成医生金标准'
                else:
                    category = 'historical_related_archive_member' if related else 'nonmatching_archive_member'
                    role = '历史方案/调研相关文字或脚本' if related else '归档成员已列名；未命中本次精确条件，不声称是项目答案'
                row = dict(path=member_path, archive_parent=parent, container_format=fmt,
                    member_name=name, depth=depth, member_type=member_type, size_bytes=size,
                    compressed_bytes=info.compress_size if fmt == 'zip' else '', related=related,
                    category=category, role=role, current_status='历史归档成员；不作为独立实际文件计数',
                    **{k: evidence[k] for k in ['matched_terms', 'evidence_locator', 'evidence_snippet',
                    'match_count', 'scan_method']}, notes='Office内部XML只用于提取可读文字，不拆成用户文件。'
                        if suffix in {'.docx', '.xlsx'} else '',
                    member_sha256=hashlib.sha256(data).hexdigest() if data is not None else '')
                self.archive_rows.append(row)
                if is_file:
                    summary['file_entries'] += 1
                    summary['uncompressed_file_bytes'] += size
                    if related:
                        summary['related_file_entries'] += 1
                        summary['related_uncompressed_file_bytes'] += size
                if is_nested and data is not None and depth < ARCHIVE_MAX_DEPTH:
                    summary['nested_archives'] += 1
                    try:
                        self.scan_archive(io.BytesIO(data), member_path, depth + 1, related)
                    except (OSError, ValueError, zipfile.BadZipFile, tarfile.TarError) as exc:
                        self.problems.append({'path': member_path, 'error': type(exc).__name__, 'operation': 'nested_archive_read'})
        finally:
            archive.close()


def write_json(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def csv_value(value):
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if value is None:
        return ''
    if isinstance(value, str) and value[:1] in {'=', '+', '-', '@', '\t', '\r'}:
        return "'" + value
    return value


def write_csv(name, fields, rows):
    with (OUT / name).open('w', encoding='utf-8-sig', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=fields, extrasaction='ignore')
        writer.writeheader()
        for row in rows:
            writer.writerow({key: csv_value(row.get(key, '')) for key in fields})


def directory_stats(root, prefix, metadata, selected_paths):
    items = [(p, m) for p, m in metadata.items() if under(p, prefix)]
    return {'path': prefix, 'exists': (root / prefix).exists(), 'file_entries': len(items),
            'regular_file_count': sum(m['file_kind'] == 'regular' for _, m in items),
            'symlink_count': sum(m['file_kind'] == 'symlink' for _, m in items),
            'size_bytes_lstat': sum(m['size_bytes'] for _, m in items),
            'selected_file_entries': sum(p in selected_paths for p, _ in items)}


def read_json_optional(root, rel):
    try:
        return json.loads((root / rel).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def missing_paths(root, inv):
    manifest_rel = 'code/docs/acceptance/pi-web-frontend-2026-11-04/annotation/retirement-manifest.json'
    manifest = read_json_optional(root, manifest_rel) or {}
    candidates = collections.defaultdict(lambda: {'sources': [], 'actual_archive_members': []})
    for path in manifest.get('removed_active_roots', []):
        candidates['code/' + path]['sources'].append(manifest_rel + '#removed_active_roots')
    for item in manifest.get('archived_files', []):
        candidates['code/' + item['path']]['sources'].append(manifest_rel + '#archived_files')
    for member in inv.archive_rows:
        if member['member_type'] == 'file' and 'retired-' in member['archive_parent']:
            rel = 'code/' + member['member_name'].removeprefix('./')
            candidates[rel]['actual_archive_members'].append(member['path'])
    rows = []
    for path, item in sorted(candidates.items()):
        if not (root / path).exists() and not (root / path).is_symlink():
            rows.append(dict(referenced_path=path, exists_at_scan=False,
                status='原路径缺失，真实归档成员已核实' if item['actual_archive_members'] else '原路径缺失；退役根目录/manifest引用',
                **item))
    return rows


def validate_retirement(root, inv):
    base = 'code/docs/acceptance/pi-web-frontend-2026-11-04/annotation/'
    manifest = read_json_optional(root, base + 'retirement-manifest.json') or {}
    actual = {r['member_name']: r for r in inv.archive_rows
              if r['archive_parent'] == base + 'retired-unreleased-annotation-migration.tar.gz' and r['member_type'] == 'file'}
    expected = {r['path']: r for r in manifest.get('archived_files', [])}
    mismatches = []
    for path, info in expected.items():
        found = actual.get(path)
        if not found or found['size_bytes'] != info['bytes'] or found['member_sha256'] != info['sha256']:
            mismatches.append(path)
    vite = read_json_optional(root, base + 'legacy-source-sha256.json') or {}
    actual_vite = {r['member_name']: r for r in inv.archive_rows
                   if r['archive_parent'] == base + 'retired-vite-application.tar.gz' and r['member_type'] == 'file'}
    vite_mismatches = [p for p, sha in vite.items() if p not in actual_vite or actual_vite[p]['member_sha256'] != sha]
    archive_integrity = []
    for item in manifest.get('archives', []):
        rel = 'code/' + item['path']
        ok = (root / rel).is_file() and (root / rel).stat().st_size == item['bytes'] and digest_file(root / rel) == item['sha256']
        archive_integrity.append({'path': rel, 'passed': ok})
    return {'migration_manifest_files': len(expected), 'migration_actual_files': len(actual),
            'migration_missing_or_hash_mismatches': mismatches,
            'migration_unlisted_members': sorted(set(actual) - set(expected)),
            'vite_expected_files': len(vite), 'vite_actual_files': len(actual_vite),
            'vite_missing_or_hash_mismatches': vite_mismatches,
            'archive_container_integrity': archive_integrity}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    args = parser.parse_args()
    root = args.root.resolve()
    if not (root / 'AGENTS.md').is_file() or not (root / 'code').is_dir():
        raise SystemExit('Expected project root containing AGENTS.md and code/.')
    started = utc_now()
    monotonic = time.monotonic()
    before, exclusions, walk_errors = walk_files(root, OUT)
    support_before, support_errors = support_snapshot(root)
    inv = Inventory(root)
    for rel, metadata in before.items():
        inv.scan_file(rel, metadata)
    inv.scan_archives(before)
    concurrency = []
    prior = before
    final = before
    stable = False
    # Re-read content whenever size/mtime/type/key hash changes, even if name stays unchanged.
    for attempt in range(1, 4):
        current, exclusions, errors = walk_files(root, OUT)
        walk_errors.extend(errors)
        delta = compare_snapshots(prior, current)
        concurrency.append({'pass': attempt, 'observed_at': utc_now(), **delta})
        final = current
        if not has_changes(delta):
            stable = True
            break
        for rel in delta['removed']:
            inv.rows.pop(rel, None)
            inv.details.pop(rel, None)
        for rel in delta['added'] + delta['changed']:
            inv.scan_file(rel, current[rel])
        if any(archive_format(rel) for key in delta for rel in delta[key]):
            inv.scan_archives(current)
        prior = current
    support_after, support_after_errors = support_snapshot(root)
    support_errors.extend(support_after_errors)
    support_delta = compare_snapshots(support_before, support_after)
    scan_finished = utc_now()
    rows = [inv.rows[p] for p in sorted(inv.rows)]
    member_rows = sorted(inv.archive_rows, key=lambda r: r['path'])
    support_rows = []
    for path, metadata in support_after.items():
        prefix = next(p for p in SUPPORT_ROOTS if under(path, p))
        support_rows.append(dict(path=path, category='shared_regenerable_browser_support',
            category_zh='当前新前端复用的可再生通用浏览器QA工具/缓存',
            role='Playwright/Chromium/系统库/字体/缓存；不是医学参考答案',
            current_status='verify-pi-web-browser.mjs:10-13当前复用；正文未扫描',
            size_bytes=metadata['size_bytes'], file_kind=metadata['file_kind'],
            matched_terms='explicit_support_root', evidence_locator='code/scripts/verify-pi-web-browser.mjs:10-13',
            evidence_snippet='PLAYWRIGHT_BROWSERS_PATH; LD_LIBRARY_PATH; TMPDIR; playwright/index.mjs',
            match_count=0, scan_method='metadata_only_no_dependency_content_read',
            notes='所属工具目录：' + prefix + '；符号链接不跟随，size_bytes使用lstat链接自身长度。',
            archive_parent='', source_sha256=''))
    missing = missing_paths(root, inv)
    category_counts = collections.Counter(r['category'] for r in rows)
    category_bytes = collections.Counter()
    for r in rows:
        category_bytes[r['category']] += r['size_bytes']
    key_roots = list(DIRECT_ROOTS) + SHARED_ENGINE_ROOTS + SHARED_SOURCE_ROOTS + SUPPORT_ROOTS
    directories = [directory_stats(root, prefix, support_after if prefix in SUPPORT_ROOTS else final,
                                    set(support_after) if prefix in SUPPORT_ROOTS else set(inv.rows))
                   for prefix in key_roots]
    ai = read_json_optional(root, 'code/evaluation/reference-drafts/2026-11-03-l01-l05/summary.json') or {}
    limitations = [
        '只读扫描本项目管理文件；排除.git/.aws/.codex/.agents、任意node_modules/.venv/venv/第三方、code/.tools其它工具、code/third_party、.next生成目录及自身报告目录。',
        '所有.env*、凭证/私钥常见文件名均不读内容；证据片段遇凭证字段名时整体隐藏；未复制答案全文。',
        'code/.tools/annotation-browser与qa-tmp仅列元数据；第三方正文不读。符号链接不跟随，字节数按lstat，避免重复计目标。',
        'PDF只按明确目录、原件/复制件与归档上下文列出，未OCR或解析全文；本次没有安装/调用PDF正文提取器。截图未OCR；SQLite及其它二进制不检索内部内容。',
        'DOCX提取正文/页眉页脚/脚注尾注/批注可读XML，XLSX提取单元格/共享字符串，不运行公式、不跟随外链；Office内部ZIP条目不作为独立用户文件。',
        '项目ZIP/TAR归档在内存读取，保留完整父路径与成员名；普通Office文件不当外层归档。最大递归深度3、成员数25000、单文本48MiB、嵌套归档96MiB、总读取256MiB；遇限额写明。',
        'CSV实际文件与归档成员分表；成员解压大小、原件复制件和同ZIP重复归档不能相加当独立内容量。',
        '精确关键字、专项目录全量纳入与已核引用链组合；未按泛化gold或annotation词扫描第三方/配色/通用库。未命中档案成员仍列清单但related=false。',
        '历史人标/完整gold待办与最新取消政策分别表述。真实模型输出逐条人工审核/医生补充不自动视作旧答案准备。',
        '本次只新增本目录脚本与报告，没有删除/修改现有应用、方案、README、旧证据或他人文件；没有模型API、依赖下载、浏览器或应用测试。',
    ]
    summary = {
        'schema_version': 'reference-answer-file-inventory-1',
        'project_root': str(root), 'report_directory': str(OUT),
        'scan_started_at_utc': started, 'scan_finished_at_utc': scan_finished,
        'elapsed_seconds': round(time.monotonic() - monotonic, 3),
        'effective_user_request': '全部列出与参考答案生成/准备/转换/历史引用相关的现存内容；只盘点，不删除。',
        'formal_review': {'new_rounds': 0, 'original_s2_used': 3, 'original_s2_limit': 3, 'original_s2_frozen': True},
        'physical_files': {'listed': len(rows), 'size_bytes_lstat': sum(r['size_bytes'] for r in rows),
                           'support_listed_separately': len(support_rows),
                           'support_size_bytes_lstat': sum(r['size_bytes'] for r in support_rows)},
        'categories': [{'category': key, 'label_zh': CATEGORY_LABELS[key],
                        'file_count': category_counts[key], 'size_bytes_lstat': category_bytes[key]}
                       for key in CATEGORY_LABELS if category_counts[key]],
        'directories': directories, 'archives': inv.archive_stats,
        'archive_member_totals': {
            'all_entries': len(member_rows),
            'file_entries': sum(r['member_type'] == 'file' for r in member_rows),
            'related_file_entries': sum(r['related'] and r['member_type'] == 'file' for r in member_rows),
            'zip_entries': sum(r['container_format'] == 'zip' for r in member_rows),
            'tar_entries': sum(r['container_format'] == 'tar' for r in member_rows),
            'nested_archive_count': sum(s['depth'] > 0 for s in inv.archive_stats),
            'office_internal_members_not_counted': True,
        },
        'ai_reference_status': {key: ai.get(key) for key in [
            'provenance', 'record_count', 'records_by_document', 'nonempty_human_annotator_fields',
            'nonempty_human_reviewer_fields', 'fully_located_literal_comparison_rows',
            'unresolved_rows_separate_not_scored_as_zero']},
        'missing_original_paths_separate_from_existing_files': missing,
        'concurrent_workspace': {'source_metadata_passes': concurrency,
                                 'source_stable_at_final_pass': stable,
                                 'support_changes_between_passes': support_delta,
                                 'changed_files_re_read': True,
                                 'key_file_hashes_before': {p: before.get(p) for p in sorted(KEY_FILES)},
                                 'key_file_hashes_after': {p: final.get(p) for p in sorted(KEY_FILES)}},
        'scan_boundary': {'enumerated_managed_file_entries': len(final),
                          'excluded_directories_and_sensitive_name_counts': exclusions,
                          'patterns': dict(PATTERN_SPECS), 'direct_roots': DIRECT_ROOTS,
                          'shared_engine_roots': SHARED_ENGINE_ROOTS,
                          'shared_source_roots': SHARED_SOURCE_ROOTS,
                          'explicit_reference_chain_files': sorted(POSTHOC_FILES),
                          'archive_bytes_read': inv.budget_used,
                          'limits_and_interpretation': limitations},
        'unread_or_failed': inv.problems + walk_errors + support_errors,
        'writer_script_sha256': digest_file(Path(__file__)),
        'reports': {
            'actual_files': 'files.csv', 'zip_members': 'zip-members.csv', 'tar_members': 'tar-members.csv',
            'all_archive_members': 'archive-members.csv', 'support_files': 'support-tool-files.csv',
            'summary': 'summary.json', 'chinese_index': '索引.txt',
            'validation': 'report-validation.json', 'source_metadata_before': 'scan-before.json',
            'source_metadata_after': 'scan-after.json',
        },
    }
    write_csv('files.csv', FILE_FIELDS, rows)
    write_csv('support-tool-files.csv', FILE_FIELDS, support_rows)
    write_csv('archive-members.csv', ARCHIVE_FIELDS, member_rows)
    write_csv('zip-members.csv', ARCHIVE_FIELDS, [r for r in member_rows if r['container_format'] == 'zip'])
    write_csv('tar-members.csv', ARCHIVE_FIELDS, [r for r in member_rows if r['container_format'] == 'tar'])
    write_json('scan-before.json', {'observed_at_utc': started, 'managed_files': before, 'support_files': support_before})
    write_json('scan-after.json', {'observed_at_utc': scan_finished, 'managed_files': final, 'support_files': support_after})
    write_json('summary.json', summary)
    lines = [
        '参考答案相关内容逐文件盘点（只盘点、不删除）',
        f'扫描时间（UTC）：{started} 至 {scan_finished}',
        f'项目：{root}',
        '',
        '有效状态：完整人工参考答案/逐篇完整金标不再是必需交付或开发前置条件；旧准备UI已退役。',
        '真实抽取输出的逐条人工审核、证据出处与医生补充来源要求仍保留。历史材料的pending不恢复旧要求。',
        f'本表列出现存相关文件及候选档案：{len(rows)}；支持工具另表：{len(support_rows)}。',
        f'已检查的全部归档成员：{len(member_rows)}；其中精确范围相关文件成员：{sum(r["related"] and r["member_type"] == "file" for r in member_rows)}。',
        '所有CSV为UTF-8 BOM，可用Excel直接打开。每个现存文件在files.csv只列一行，ZIP/TAR成员另表。',
        '',
        '打开顺序：',
        '1. files.csv：逐文件路径、分类、用途、状态、大小、命中词、定位和短证据。',
        '2. zip-members.csv / tar-members.csv：每个实际归档成员（related列区分相关/未命中）；archive-members.csv为合表。',
        '3. support-tool-files.csv：Playwright/Chromium/系统库/缓存的逐文件元数据，不是医学答案。',
        '4. summary.json：分类/目录/归档准确数量、旧路径缺失清单、扫描边界和并发变化。',
        '5. report-validation.json：实际执行的完整性校验；scan-before/after.json保留两次来源元数据。',
        '复现命令：python3 ' + str(Path(__file__).relative_to(root)),
        '', '分类数量：',
    ]
    lines.extend(f"- {CATEGORY_LABELS[k]}：{category_counts[k]}文件，{category_bytes[k]}字节" for k in CATEGORY_LABELS if category_counts[k])
    lines.extend(['', '关键区别：',
        '- code/evaluation/annotations整目录26文件为旧专项准备材料，包含空白表、待复核AI表、指南、交接脚本/包及复制PDF；不等于医生已完成答案。',
        '- AI草稿七文件共56条（L01 25、L05 31），非空人工标注者/复核者均为0，human_verified=false、not_gold=true。',
        '- 专家ZIP实际11成员，未含后来放入展开材料目录的AI参考工作簿；ZIP与目录内容不能视作完全相同。',
        '- code/dist/annotation-offline仍有25发布文件，旧ZIP也有25成员；retirement目录legacy ZIP是旧离线包副本，均没有TS源码。',
        '- TS源码、旧专用脚本和tests不在活动原路径；真实存于两个tar归档（Vite 28、未发布迁移233文件），另表可查。',
        '- annotation-ui完整历史目录的备份/导出/打印PDF/截图属于工程合成测试材料，不能认作医生答案。',
        '- evaluation/corpus下五篇PDF是共用原件；离线包、专家包、退役归档内是复制件；目录/来源清单和共用评测引擎也不是全应删除。',
        '- 当前verify-pi-web-browser.mjs:10-13仍复用annotation-browser与qa-tmp；这些依赖属于通用QA。',
        '- 当前方案/README的取消和退役说明也列出；旧before/source-snapshots按历史引用列，原文件缺失不代表归档已消失。',
        '', '归档：'])
    lines.extend(f"- {a['path']}：{a['file_entries']}文件成员，其中相关{a['related_file_entries']}；展开字节{a['uncompressed_file_bytes']}" for a in inv.archive_stats)
    lines.extend(['', '扫描限制与计数解释：'] + ['- ' + x for x in limitations])
    lines.extend(['', f'最终来源列表/size/mtime/关键hash稳定：{stable}；扫描错误或限制另见JSON。',
                  '原S2正式审查3/3封存；本盘点新增正式审查0轮。',
                  '本次未删除任何现有文件。'])
    (OUT / '索引.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8-sig')
    # Focused report verification against the actual metadata and archive listings.
    csv_rows = list(csv.DictReader((OUT / 'files.csv').open(encoding='utf-8-sig', newline='')))
    root_checks = []
    for prefix in DIRECT_ROOTS:
        expected = {p for p in final if under(p, prefix)}
        listed = {r['path'] for r in rows if under(r['path'], prefix)}
        root_checks.append({'path': prefix, 'expected': len(expected), 'listed': len(listed),
                            'missing': sorted(expected - listed), 'unexpected': sorted(listed - expected),
                            'passed': expected == listed})
    retirement = validate_retirement(root, inv)
    validations = {
        'schema_version': 'inventory-report-validation-1', 'validated_at_utc': utc_now(),
        'checks': {
            'csv_rows_match_selected_count': len(csv_rows) == len(rows),
            'csv_actual_paths_unique': len({r['path'] for r in csv_rows}) == len(csv_rows),
            'all_actual_rows_exist_in_final_snapshot': all(r['path'] in final for r in rows),
            'actual_sizes_match_final_snapshot': all(r['size_bytes'] == final[r['path']]['size_bytes'] for r in rows),
            'no_support_paths_mixed_into_actual_files': all(not any(under(r['path'], p) for p in SUPPORT_ROOTS) for r in rows),
            'no_sensitive_filename_in_report': all(not sensitive_name(Path(r['path']).name) for r in rows + support_rows),
            'all_direct_roots_complete': all(r['passed'] for r in root_checks),
            'source_final_snapshot_stable': stable,
            'support_snapshot_stable': not has_changes(support_delta),
            'all_archive_rows_unique_by_parent_and_name': len({r['path'] for r in member_rows}) == len(member_rows),
            'zip_csv_matches_zip_members': len(list(csv.DictReader((OUT / 'zip-members.csv').open(encoding='utf-8-sig')))) == sum(r['container_format'] == 'zip' for r in member_rows),
            'tar_csv_matches_tar_members': len(list(csv.DictReader((OUT / 'tar-members.csv').open(encoding='utf-8-sig')))) == sum(r['container_format'] == 'tar' for r in member_rows),
            'retired_migration_manifest_matches_real_archive': not retirement['migration_missing_or_hash_mismatches'] and not retirement['migration_unlisted_members'],
            'retired_vite_source_hashes_match_real_archive': not retirement['vite_missing_or_hash_mismatches'],
            'retirement_container_hashes_match_manifest': all(x['passed'] for x in retirement['archive_container_integrity']),
            'no_scan_exceptions': not summary['unread_or_failed'],
            'no_archive_size_depth_or_encryption_limits_hit': not any(a['read_errors_or_limits'] for a in inv.archive_stats),
            'all_csv_utf8_bom': all((OUT / n).read_bytes().startswith(b'\xef\xbb\xbf') for n in ['files.csv', 'support-tool-files.csv', 'archive-members.csv', 'zip-members.csv', 'tar-members.csv']),
        },
        'direct_root_checks': root_checks, 'retirement_archive_validation': retirement,
        'counts': summary['physical_files'], 'archive_member_totals': summary['archive_member_totals'],
        'exceptions': summary['unread_or_failed'],
        'not_run': ['application/model/API tests', 'browser', 'dependency install', 'PDF/OCR internal text scanning',
                    'SQLite content queries', 'medical/human approval'],
    }
    validations['all_report_checks_passed'] = all(validations['checks'].values())
    write_json('report-validation.json', validations)
    print(json.dumps({'report_directory': str(OUT), 'files': len(rows), 'support_files': len(support_rows),
                      'archive_members': len(member_rows), 'categories': dict(category_counts),
                      'all_report_checks_passed': validations['all_report_checks_passed'],
                      'failed_checks': [k for k, v in validations['checks'].items() if not v]}, ensure_ascii=False))


if __name__ == '__main__':
    main()
