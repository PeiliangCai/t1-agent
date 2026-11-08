#!/usr/bin/env python3
"""Build the readable comparison from immutable measurements and AI observations."""
from datetime import datetime, timezone, timedelta
from hashlib import sha256
from html import escape
from pathlib import Path
import csv
import json
import os
import sys

CODE = Path(__file__).resolve().parents[1]
OUT = CODE / 'docs/acceptance/s3/comparison-2026-11-02'
sys.path.insert(0, str(CODE / 'services/pdf-parser'))
from adapter import resolve_segments

CANDIDATES = ['docling-standard-cpu', 'mineru-basic-onnx-cpu']
IDS = ['MED03', 'L07', 'L05', 'L01', 'L02']
NAMES = {CANDIDATES[0]: 'Docling 完整 CPU + 共用原文锚点', CANDIDATES[1]: 'MinerU basic ONNX CPU + 共用原文锚点'}


def read(path):
    return json.loads(path.read_text())


def write(name, value):
    path = OUT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def rel(path):
    return str(path.relative_to(CODE))


def main():
    recorded = datetime.now(timezone(timedelta(hours=8))).isoformat()
    docs = {(c, s): read(OUT / 'runs/guarded-v4/reuse' / c / (s + '.json'))['document'] for c in CANDIDATES for s in IDS}
    # These observations were made by actually opening original/overlay/grid
    # images with view_image. This script records them; it is not a visual model.
    definitions = [
        ('L01', 1, '中文通栏摘要转双栏正文、日期及阅读顺序', [
            (CANDIDATES[0], 'definite_error', '#/texts/4', '摘要中日期原页为2018年12月—2023年3月，native文本丢失连接线。原文锚点与native文本分开保存，匹配时忽略连接线不能证明native逐字忠实。'),
            (CANDIDATES[1], 'correct_sample', '#/pages/0/blocks/5', '所核日期连接线保留；摘要及左右栏正文区域存在。'),
            ('both', 'unverified_scope', None, '页内主要正文先左后右；文章编号等元数据插入正文顺序的差异仍需下游区分，未逐字符核全文。')]),
        ('L01', 2, '中文表格多级表头、数值、三联CT图注及正文框', [
            (CANDIDATES[0], 'correct_sample', '#/tables/0', '表1核对有效组31/29/2/63.06±7.10/11/15/5、无效组19/17/2/65.05±8.23/13/5/1与原页对应，8列结构保留。'),
            (CANDIDATES[1], 'definite_error', '#/pages/1/blocks/17', '同表native HTML为7列；性别头变为“女 男”，病理头合并；有效组末部11/5丢失15，无效组末部15/1错配且13未留在正确格。原始HTML已确认同错，非项目HTML解析引入。'),
            ('both', 'unverified_scope', None, '正文框与表区叠框可回到原页。CT多面板图像均保留，但MinerU拆图及(a)(b)(c)关联不等于共享图注归组已验证。')]),
        ('L01', 3, '跨物理页结果续接、中文CT特征表', [
            (CANDIDATES[0], 'correct_sample', '#/tables/1', '表2抽查CT值38.90±5.12与36.94±6.22、血管征6/25与10/9及P=0.014，行列对齐。'),
            (CANDIDATES[1], 'correct_sample', '#/pages/2/blocks/2', '相同抽查格与18×5网格保留，未发现这些抽查格的差异。'),
            ('both', 'unverified_scope', None, 'p2正文“见表2”至p3表2是可追溯上下文；项目未将其推断为跨页同一表，也未形成医学适用关系。')]),
        ('MED03', 2, '英文双栏左栏末句到右栏首句的真实续接', [
            (CANDIDATES[0], 'correct_sample_after_adapter_fix', '#/texts/20', 'native本身含两个provenance/charspan区域；原页neoadjuvant→右栏chemotherapy and colectomy连续。旧适配按整页y排序误成partial；按native各charspan分别映射后保留23个精确源片段与两栏边界。1128/1128为匹配记账，不是字符准确率。'),
            (CANDIDATES[1], 'correct_sample', '#/pages/1/blocks/5', '左栏末段与右栏首段分别为native顺序18/19（blocks/5、blocks/6），图像抽查续接顺序对应。')]),
        ('MED03', 4, '旋转英文大表、重复数字与单元格定位', [
            (CANDIDATES[0], 'definite_structure_difference', '#/tables/0', '原表转正后应Panelist为行、A1至Tot为列；Docling输出18×18以Tot为首行、Panelist为末行，呈转置/逆序方向。抽查Tot74/72及Mean74.07、Std4.85保留，但不按自然方向读成已验证语义表。'),
            (CANDIDATES[1], 'definite_error', '#/pages/3/blocks/2', '输出20×18，主要Panelist行方向更接近转正原表，抽查74/72、74.07/4.85保留；表题被切碎塞入第0行，缺少独立caption关系。重复短分值只能整表范围定位，不能唯一指定格内出处。')]),
        ('L05', 5, '英文表2与两面板Fig.2的独立区域', [
            (CANDIDATES[0], 'definite_missing_relationship', '#/tables/1', '表2及Fig.2区域像素/文字均存在，表2有独立caption文字但native table未关联；Fig.2主图未连caption。'),
            (CANDIDATES[1], 'correct_region_sample', '#/pages/4/blocks/4', '表2区域与caption关联保留；Fig.2拆为上下两图，共享caption仅挂上图，不能视作整组图注完整。'),
            ('both', 'unverified_scope', None, '网格完整性与全部数值未逐格核验；该页用来比较表/图分区和caption归属。')]),
        ('L05', 6, '英文表3、下方nomogram和行标签', [
            (CANDIDATES[0], 'definite_error', '#/tables/2', '原页上部Table3与下方独立nomogram被同一native大表框包住；Fig.3图注错挂表3，当前类型保护明确conflict/rejected。抽查Bronchial inflation N155/55、Y56/66，Bubble sign N126/61、Y85/60保留，但额外空列与12.78±4.71拆格等仍有结构问题。'),
            (CANDIDATES[1], 'definite_error', '#/pages/5/blocks/3', '表区、nomogram及各自caption分开较好；但Bubble sign表头标签上移到前一因素的Y56/66行，N/Y与多行单元格关联错位。不能由区域框正确推定单元格正确。')]),
        ('L07', 2, '英文图形摘要、关键词与两栏正文', [
            (CANDIDATES[0], 'definite_error', '#/pictures/2', '图形摘要区域及部分内部PDF文本被native保留；Keywords行被误作picture caption，当前类型保护conflict/rejected。'),
            (CANDIDATES[1], 'definite_error', '#/pages/1/blocks/3', '图形摘要区域图像保留，但内部文本未作为普通native文本展开；同样把Keywords误挂caption，当前明确拒绝。'),
            ('both', 'unverified_scope', None, 'PDF图像可见不等于图内全部字已抽出；两个正文栏区域存在，医学图示内容未审核。')]),
        ('L07', 3, '英文长图注、MRI双面板及两栏正文', [
            (CANDIDATES[0], 'correct_region_sample', '#/pictures/4', 'Fig.1左侧长caption与右侧A/B双MRI区域关联保留，叠框贴合所核区域；正文先左后右。'),
            (CANDIDATES[1], 'correct_region_sample', '#/pages/2/blocks/2', '同一Fig.1双面板及长图注关系保留，正文区域/左右栏顺序抽查可用。'),
            ('both', 'unverified_scope', None, '箭头所指医学结构、每句语义和跨页分期条目不在此次AI工程核验范围。')]),
        ('L02', 2, '中文MRI参数上标、三个表和ROC图注', [
            (CANDIDATES[0], 'correct_sample', '#/tables/2', '表1抽查0.54±0.13/0.37±0.06；表3保留7列，Ve行0.751、0.056、<0.001、0.641～0.861、0.745、0.645分别在对应格。图1与ROC区域关联存在。'),
            (CANDIDATES[1], 'definite_error', '#/pages/1/blocks/16', '表1同一抽查值保留；表3从原7列合并为5列，“标准误P”和“95%CI灵敏度”混列，0.641变为前格尾0.与后格641；这不是来源层能补回的native表格正确性。'),
            ('both', 'unverified_scope', None, 'Ktrans/Kep/Ve的上下标在plain native表头中被平面化；原页及原文底座另存，未据此批准医学词表/适用关系。')])]
    focus = []
    evidence_dir = OUT / 'page-review/focused-evidence'
    evidence_dir.mkdir(exist_ok=True)
    for source_id, page, reason, observations in definitions:
        prefix = f'{source_id}-p{page:02}'
        original = OUT / 'page-review/v1' / (prefix + '-original.png')
        assert original.exists()
        record = {'source_id': source_id, 'physical_page': page, 'selection_reason': reason,
                  'reviewer': 'GPT-6.1-Sol AI engineering inspection', 'actual_view_image_used': True,
                  'human_review': False, 'medical_review': False, 'full_page_verbatim_gold': False,
                  'original_image': rel(original), 'observations': [], 'candidate_evidence': {}}
        for candidate, status, ref, detail in observations:
            entry = {'candidate_id': candidate, 'classification': status, 'native_ref': ref, 'detail': detail}
            if candidate in CANDIDATES and ref:
                doc = docs[candidate, source_id]
                unit = next(u for u in doc['structure']['units'] if u['native_ref'] == ref)
                entry.update({'unit_id': unit['unit_id'], 'native_text_sample': unit['native_text'][:1500],
                              'provenance': unit['provenance'], 'source_segments': unit['source_segments']})
                relation = next((t for t in doc['structure']['tables'] + doc['structure']['pictures'] if t['native_ref'] == ref), None)
                if relation:
                    entry['native_relationship_retained_with_project_guard'] = {k: v for k, v in relation.items() if k not in ['cells', 'native_html']}
                    if 'cells' in relation:
                        units = {u['unit_id']: u for u in doc['structure']['units']}
                        entry['native_grid_cells'] = [{**cell, 'native_text': units[cell['unit_id']]['native_text'],
                            'mapping': units[cell['unit_id']]['mapping'], 'source_segments': units[cell['unit_id']]['source_segments'],
                            'geometry_precision': list(dict.fromkeys(p['precision'] for p in units[cell['unit_id']]['provenance']))} for cell in relation['cells']]
                if unit['source_segments']:
                    reference = {'document_id': doc['document_id'], 'text_version': doc['text_version'], 'segments': unit['source_segments'], 'joiner': '\n'}
                    location = resolve_segments(doc, **reference)
                    location['quote_authority'] = 'individual_source_segments_only_display_composite_is_not_contiguous_source'
                    file = evidence_dir / (prefix + '-' + candidate + '-location.json')
                    file.write_text(json.dumps(location, ensure_ascii=False, indent=2) + '\n')
                    entry['source_location_evidence'] = rel(file)
            record['observations'].append(entry)
        for candidate in CANDIDATES:
            record['candidate_evidence'][candidate] = {'IR': rel(OUT / 'runs/guarded-v4/reuse' / candidate / (source_id + '.json')),
                'IR_text_version': docs[candidate, source_id]['text_version'],
                'overlay': rel(OUT / 'page-review/v1' / (prefix + '-' + candidate + '-order.png')),
                'native_grid_images': [rel(p) for p in sorted((OUT / 'page-review/v1').glob(prefix + '-' + candidate + '-table*-grid.png'))],
                'image_revision_note': 'v1 renders use guarded-v3; final v4 changes guard/config identity only, native content/boxes unchanged'}
        focus.append(record)
    write('page-review/focused-findings.json', {'recorded_at': recorded, 'page_count': len(focus), 'pages': focus,
        'scope': '10 focused AI engineering checks, not human gold/medical approval or full-word fidelity',
        'actually_viewed_original_pages': [f"{r['source_id']}:{r['physical_page']}" for r in focus]})
    survey = read(OUT / 'page-review/pi-executor-survey/survey-summary.json')
    expected = {(s, p) for s, doc in [(s, docs[CANDIDATES[0], s]) for s in IDS] for p in range(1, len(doc['pages']) + 1)}
    focused_set = {(r['source_id'], r['physical_page']) for r in focus}
    survey_set = {(r['document_id'], r['physical_page']) for r in survey['coverage']}
    assert not focused_set & survey_set and focused_set | survey_set == expected and len(expected) == 41
    write('page-review/all-pages-review.json', {'recorded_at': recorded, 'physical_pages': 41, 'actual_AI_viewed_pages': 41,
        'focused_pages': 10, 'additional_survey_pages': 31, 'disjoint_complete_page_set_checked': True,
        'focused_findings': 'focused-findings.json', 'additional_findings': 'pi-executor-survey/page-findings.json',
        'native_completeness_not_inferred_from_shared_source_blocks': True, 'human_medical_approval': False,
        'full_word_or_cell_gold': False, 'unreviewed_scope': ['all word/code-point fidelity', 'all table cells/spans',
        'all multipanel/cross-page grouping', 'medical classification/applicability', 'article-region exclusion']})
    measurements = []
    for name in ['benchmark-152649.json', 'benchmark-153842.json']:
        for row in read(OUT / name)['results']:
            m, nm = row['metrics'], row['metrics']['native_metrics']
            final = read(OUT / 'runs/guarded-v4' / row['mode'] / row['candidate_id'] / (row['source_id'] + '.json'))['document']
            measurements.append({'candidate_id': row['candidate_id'], 'mode': row['mode'], 'source_id': row['source_id'],
                'pages': row['physical_pages'], 'file_bytes': row['file_bytes'], 'file_sha256': row['file_sha256'],
                'native_seconds': m['native_seconds'], 'source_anchor_seconds_original_run': m['source_anchor_seconds'],
                'mapping_seconds_original_run': m['mapping_seconds'], 'adapter_wall_seconds_original_run': row['adapter_wall_seconds'],
                'native_cpu_user_seconds': nm['cpu_user_seconds'], 'native_cpu_system_seconds': nm['cpu_system_seconds'],
                'host_cpu_user_seconds': row['host_cpu_user_seconds'], 'host_cpu_system_seconds': row['host_cpu_system_seconds'],
                'sampled_process_tree_peak_rss_bytes': row['sampled_process_tree_peak_rss_bytes'],
                'native_ru_maxrss_lifetime_bytes': nm['peak_rss_bytes_process_lifetime'],
                'host_ru_maxrss_lifetime_bytes': row['host_peak_rss_bytes_process_lifetime'],
                'rss_sampling_ms': row['rss_sample_interval_ms'], 'native_first_call': nm['first_call_in_process'],
                'model_instance_reused': nm['model_instance_reused'], 'document_result_cache_used': row['document_result_cache_used'],
                'status_original_run': row['status'], 'original_result': row['output'], 'native_log': row['native_log'],
                'final_IR': rel(OUT / 'runs/guarded-v4' / row['mode'] / row['candidate_id'] / (row['source_id'] + '.json')),
                'final_IR_text_version': final['text_version'], 'mapping_seconds_final_derivation': final['metrics']['mapping_seconds'],
                'source_anchor_seconds_final_derivation': final['metrics']['source_anchor_seconds'],
                'final_derivation_is_end_to_end_native_run': False,
                'native_pages': len(final['coverage']['native_pages']), 'unmapped_or_partial_units': len(final['coverage']['unmapped_unit_ids']),
                'ambiguous_units': len(final['coverage']['ambiguous_unit_ids']),
                'quality_accuracy_from_counts': None, 'native_exceptions': len(final['coverage']['native_errors']),
                'original_unchanged': row['original_unchanged']})
    write('comparison-data.json', {'recorded_at': recorded, 'records': measurements,
        'cold_definition': 'Fresh host/native processes; model files and OS caches available; no download time',
        'reuse_definition': 'One model process, each original PDF reparsed; first MED03 includes initial model load; no document-result cache',
        'rss_definition': '50ms sampled host+recursive native child RSS; peak per PDF; includes shared mappings counted per process; ru_maxrss separately process lifetime',
        'final_IR_derivation': 'Reused immutable native artifact plus actually rerun source/mapping/guards; never splice old native + new mapping as current measured end-to-end',
        'run_order': IDS, 'cpu_threads': 4, 'single_pdf_at_a_time': True, 'rss_cap_bytes': 8 * 2**30,
        'native_run_count': len(measurements), 'unique_development_pages': 41, 'independent_acceptance_pages': 0,
        'stage_passed': False, 'formal_parser_selected': False, 'human_medical_gold_available': False})
    with (OUT / 'comparison-data.csv').open('w', newline='', encoding='utf-8-sig') as stream:
        writer = csv.DictWriter(stream, fieldnames=list(measurements[0])); writer.writeheader(); writer.writerows(measurements)

    def performance_table():
        lines = ['|资料（物理页/文件MB）|Docling新进程 原生/整条旧适配 秒|MinerU新进程 原生/整条旧适配 秒|Docling复用 原生秒 / RSS GiB|MinerU复用 原生秒 / RSS GiB|',
                 '|---|---:|---:|---:|---:|']
        for source in IDS:
            rows = {(r['candidate_id'], r['mode']): r for r in measurements if r['source_id'] == source}
            dc, mc, dw, mw = [rows[x] for x in [(CANDIDATES[0], 'cold'), (CANDIDATES[1], 'cold'), (CANDIDATES[0], 'reuse'), (CANDIDATES[1], 'reuse')]]
            lines.append(f"|{source}（{dc['pages']}页/{dc['file_bytes']/1e6:.2f}）|{dc['native_seconds']:.2f} / {dc['adapter_wall_seconds_original_run']:.2f}|{mc['native_seconds']:.2f} / {mc['adapter_wall_seconds_original_run']:.2f}|{dw['native_seconds']:.2f} / {dw['sampled_process_tree_peak_rss_bytes']/2**30:.2f}|{mw['native_seconds']:.2f} / {mw['sampled_process_tree_peak_rss_bytes']/2**30:.2f}|")
        return '\n'.join(lines)
    peak = {c: max(r['sampled_process_tree_peak_rss_bytes'] for r in measurements if r['candidate_id'] == c) / 2**30 for c in CANDIDATES}
    text = f'''# S3：无 GPU 的真实解析、定位及候选对照

记录时间：{recorded}。本批目录沿用2026-11-02开工日期；仍属同一个S3任务，正式审查3/3不重置。

**当前服务器无GPU也能完成这批资料的两种本地解析。** 完整Docling 2.145.0 CPU和MinerU 4.1.4 basic/ONNX CPU均实跑5篇、41物理页；各做5次新进程和同一模型进程内5篇连续解析，共20次原生运行。无付费LLM、无PDF外传、未改系统Python或实例规格。所有结果继续标为partial，表示原生结构和全文忠实度尚未验收。

建议优先考虑 **Docling完整CPU布局/表格 + 共用docling-parse原文锚点** 作为首版工程默认候选：抽查中文表格行列和逐格定位更适合当前来源要求，多数资料开销也更小；保留MinerU作为可替换的对照候选。它在部分页面的表/图分区、日期、旋转表方向更好，无法以单篇或计数断言整体更准。**正式解析器尚未选择，需用户结合下列证据共同确定；本报告不批准医学规则或S3质量通过。**

## 如何看这次比较

|维度|Docling完整CPU + 共用原文锚点|MinerU basic ONNX CPU + 共用原文锚点|
|---|---|---|
|原生文字/结构实际保留|正文、orig/text、表格cell、标题/图注、原生顺序/层级及多区域charspan保留；存在注释混正文、日期连线丢失、图注错挂和旋转表方向问题|正文、inline spans、原生HTML网格、标题/图注、图像和原生顺序保留；存在中文表头/数值错格、图组拆散、旋转表题入格和跨文章顺序交织|
|来源定位能否还原|共同原文字行底座；native逐格bbox可缩小单元匹配范围，逐段源引用可还原；不等于native表格逐格正确|同一底座可提供原页字行；公开middle JSON的HTML格没有独立格bbox，只有整表区域，重复短数字可能无法唯一定位|
|正文与引用关系|native可能去连字符、改空白；processed native/orig不冒称逐字原文；权威引用为原文blocks的码点segments|同样保留native加工文本和原文底座的区别；不得把底座补回的字记作MinerU原生完整|
|本次CPU配置|4线程、单PDF；OCR=false、表结构开启；无远程服务|4线程/1 inter-op、单PDF；basic+txt+ONNX/CPU；整页OCR未开，但表格管线实际调用本地OCR/公式模型|
|测得最高进程树RSS|{peak[CANDIDATES[0]]:.2f} GiB|{peak[CANDIDATES[1]]:.2f} GiB|
|尚未覆盖|扫描/需OCR混合页完整处理、所有表格/图组/医学语义、全量人工逐字核验|相同；此处未测试官方4.x的Standard/Advanced VLM模式、GPU或云端模式（[full]是安装extra而非层级）|

两路共享原文底座仅使来源可追溯，**不能证明两路native文字同样完整**。3887个原文字行、单位数、图/表个数、映射比例均为工程记账，绝非正确率。5篇都是已曝光开发资料，独立验收资料为0。

## 实际开销

{performance_table()}

新进程不等于操作系统/模型文件冷盘，模型下载不计入；复用只复用模型，不读整份PDF的旧解析缓存，首篇MED03仍含模型加载。两路直接调用本地SDK，每篇重新解析原件。RSS为50ms采样的宿主+递归原生子进程总和；复用进程可能保留模型/缓存，另存ru_maxrss终身峰值，不能把它当本篇独占内存。CPU为进程用户/系统时间，不是耗时百分比；逐篇CPU、文件大小、源锚点/原生/映射分段及失败页见[CSV](comparison-data.csv)和[机器数据](comparison-data.json)。

20次运行均返回全体物理页native结果，无native异常或超8GiB退出；输出partial与未验证图像/结构、未匹配或有歧义来源相符。没有扫描页/OCR完整性的对照承诺。旧实测文件和native耗时不回写；最终guarded-v4 IR是复用原生工件、实际重跑来源映射/保护的派生结果，**不能把旧native时间加新mapping时间称当前端到端实测**。真实TS→CLI桥接另有实际运行记录；报告没有为改文字重跑20次基准。

## 三个可直接核对的原页例子

1. **L01物理第2页，表1。** 原页有效组病理值11/15/5，无效组13/5/1；Docling保留8列和这些抽查值，MinerU原生HTML合成7列，丢/错放15与13，性别头也变成“女 男”。[原页](page-review/v1/L01-p02-original.png)、[Docling网格](page-review/v1/L01-p02-docling-standard-cpu-table0-grid.png)、[MinerU网格](page-review/v1/L01-p02-mineru-basic-onnx-cpu-table0-grid.png)。两者都能给出表区框，但这不使错误网格可用。
2. **L05物理第6页，Table3和下方Fig.3。** Docling把表与nomogram包进同一表框，Fig.3误挂到表；项目明确标conflict/rejected，保留原生错误。MinerU分区/图注较好，但Bubble sign标签移到前一因素的56/66行。 [原页](page-review/v1/L05-p06-original.png)、[Docling叠框](page-review/v1/L05-p06-docling-standard-cpu-order.png)、[MinerU网格](page-review/v1/L05-p06-mineru-basic-onnx-cpu-table2-grid.png)。没有自动纠正医学关系。
3. **MED03物理第2页，左栏末段→右栏首段。** 两候选抽查均保留neoadjuvant→chemotherapy and colectomy的续接。Docling原生有两段charspan/框；修复项目映射按整页y错配的问题后，以23个源segments定位，保留跨栏边界。[原页](page-review/v1/MED03-p02-original.png)、[Docling叠框](page-review/v1/MED03-p02-docling-standard-cpu-order.png)、[MinerU叠框](page-review/v1/MED03-p02-mineru-basic-onnx-cpu-order.png)、[逐段来源](page-review/focused-evidence/MED03-p02-docling-standard-cpu-location.json)。拼接quote只是显式joiner的展示组合，不能当连续原文。

## 41页实际图片核验范围与剩余问题

已用view_image实际查看全部41页：本执行者10页重点正文/顺序/表格/图注对照，另执行者31页版面/内容存在性巡视；集合无重叠且覆盖全部页。原图、两候选native摘要/叠框、每条具体发现分别保存。[10页详细材料](page-review/v1/index.html)、[10页发现及确切引用](page-review/focused-findings.json)、[其余31页巡视](page-review/pi-executor-survey/survey-summary.json)、[全页覆盖索引](page-review/all-pages-review.json)。这属于AI工程核验，**没有人类/医生批准、逐字全文金标或全部单元格金标**；不能宣称100%忠实性。

- L02物理第2页表3：Docling保持7列，MinerU合成5列并将0.641分散到相邻格。MED03物理第4/5页旋转表，两路方向/表题/网格不同，全部格仍待核。
- L07物理第7页：Docling Fig.4图注错挂Springer小logo，真实MRI图无caption。类型保护和新增“长编号图注+远处极小图”几何保护拒绝此链接，但没有猜测改挂。该启发式不能解决所有同类图注/多面板归组。
- MED03物理第1页：Docling把author-information注释与第2页正文混成native单元。L07第4/6/8/9页、L05第8页存在半图注/多面板共享关系缺失；原生工件保留、结构一律不可直接用于医学解释。
- **L02物理第3页下半部“上接第38页”属于另一篇续文/参考文献。** 两路全页保留是覆盖事实，不能将该区域自动当本篇论文证据；MinerU顺序还把它插进本篇右栏参考文献之前。原件未裁剪/修补；文章区域排除尚未实现，后续S4需识别并人工核对。
- MinerU MED03的562个歧义单位全为table_cell，公开输出只给整表区域，516个文字长度≤3、其余也是区域内重复项。Docling逐格几何使该篇0歧义；这是出处精度与粒度差异，**不是两者文字准确率**。歧义格不给“第一个匹配”。[分解证据](ambiguous-anchor-breakdown.json)。

## 工程接入和复现

DocumentIR v1人工样例保持兼容；v2原文字行与v3结构均按候选/代码/配置/原工件SHA生成版本。物理页码、CropBox相对且已应用Rotate/UserUnit的左上角pt坐标、原始几何/转换、Unicode码点[开始,结束)偏移、native处理文本和原文segments分别保存。来源框精度是**整行**，native结构框是区域/格，不冒称字框。

真实Pi链路已可用这5篇PDF：受限的5个工具读取真实DocumentIR/来源，候选选择由调用端显式传入，模型不能选择任意本地路径；工具不把native工件路径当模型能力。真实SDK配本机脚本模型只验证调度/来源约束，**没有调用真实抽取LLM**。真实医学submit明确拒绝medical_candidate_submission_not_implemented，成功工程探针仍partial/候选0。[接入与验证索引](pi-integration/interface-and-validation.json)。HTTP上传/产品UI是S5，此轮未启动。

```bash
# 显式选择候选；改run-id/输出路径，旧工件不覆盖
bash scripts/with-node.sh npm run parse:pdf:structured -- \\
  --candidate-id docling-standard-cpu --run-id local-new-run --document-id L01 \\
  --file-reference evaluation/corpus/development-candidates/L01.pdf \\
  --file-sha256 8f5e38ac6575cd776469506fece887e85acb95bf4df0d61ae489cc88cf0de267 \\
  --output runtime-data/local-new-run/parser-result.json
# 可替换为mineru-basic-onnx-cpu；退出码2表示partial，1表示错误。
bash scripts/with-node.sh npm run verify:s3:pi -- --candidate-id docling-standard-cpu \\
  --parser-result docs/acceptance/s3/comparison-2026-11-02/runs/guarded-v4/reuse/docling-standard-cpu/L01.json
```

需要重新测模型时运行`.venv/bin/python scripts/compare-s3-cpu.py --candidates docling-standard-cpu mineru-basic-onnx-cpu --output-directory docs/acceptance/s3/my-new-unique-cpu-comparison`；输出批次必须不存在，脚本拒绝覆盖旧批次。本次测量时脚本原始版本另存source-snapshots，不重复运行基准。最终回归与失败修复见[检查汇总](checks.json)。

## 版本、来源、许可与资源

Docling锁2.145.0/docling-parse7.24.2，完整标准CPU路径在`.venv`；MinerU固定4.1.4/basic ONNX，独立`.tools/mineru-venv`的116包锁定环境，没有CUDA/torch/full依赖覆盖旧环境。MinerU ONNX包858,220,651字节、固定commit `358310b4f64b95f9fefc372ad899356e4111f376`，下载并校验ready；压缩依赖222,257,914字节。项目解析环境/模型实际占用约4.34GiB，小于6GiB预算，详细最终盘点见[交付记录](engineering-delivery.json)。

官方来源在2026-11-02核验并固定快照：[MinerU发布/源码](https://github.com/opendatalab/MinerU/tree/6d6fc6008869f82f353fd169d903c02998140cbe)、[CPU模式文档](https://opendatalab.github.io/MinerU/usage/tiers/)、[模型来源](https://opendatalab.github.io/MinerU/usage/model_source/)、[PyPI4.1.4](https://pypi.org/project/mineru/4.1.4/)。MinerU源码LICENSE为Apache2并含商业阈值/在线署名条件；ONNX汇总repo无顶层license元数据而声明沿用原模型许可，逐一固定并核验5个原模型仓库的Apache2元数据，未把缺失元数据伪称已获法律批准。[模型许可来源与hash](model-license-verification.json)、[官方原始资料目录](sources/)。Docling本地代码/模型固定来源沿用[此前官方核验](../candidate-source-verification.json)。

## 待共同确定与质量验收

可选方向：A. Docling完整CPU+共用原文锚点为工程默认、MinerU保留对照（本报告建议）；B. 先保留双路显式选择，补查争议网格/图组后再定；C. 指定更重模式或其它资源做下一轮有界工程比较（需另谈资源/许可，不因无GPU默认扩大）。本轮未写入任何正式默认选择。

S2人工阅读全文金标、医学复核、正式分组、标注/计分细则仍pending；S3人类定位忠实度、错误边界处理及正式组件选择/质量验收仍pending。原E01—E09、数值阈值和阶段gate不变；S0/S1已验收保持，S2审查2/3、S3审查3/3保持，S4/S5尚未启动。此次交付解决无GPU可运行、真实工具链接通和可供选择的开发对照，不能替代原质量门槛。
'''
    (OUT / 'README.md').write_text(text)
    # Render a standalone local HTML report using the already installed Markdown
    # package. No site/server/deployment is created.
    from markdown_it import MarkdownIt
    body = MarkdownIt('commonmark').enable('table').render(text)
    style = 'body{max-width:1180px;margin:32px auto;padding:0 22px;font:16px/1.65 system-ui,sans-serif;color:#182233}h1,h2{line-height:1.3}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid #c8d0d8;padding:9px;vertical-align:top}th{background:#eaf0f6}pre{overflow:auto;background:#f2f5f8;padding:16px}a{color:#075b9d}strong{color:#85320c}img{max-width:100%}figure{margin:24px 0}figcaption{font-size:14px;color:#4a5563}'
    figures = ''.join(f'<figure><a href="{name}"><img loading="lazy" src="{name}" alt="{escape(label)}"></a><figcaption>{escape(label)}</figcaption></figure>' for name, label in [
        ('page-review/v1/L01-p02-original.png', '原件L01物理第2页：右栏表1为8列；点击放大。'),
        ('page-review/v1/L01-p02-mineru-basic-onnx-cpu-table0-grid.png', 'MinerU原生网格：7列合并与病理数值错位，仅为错误对照，不可作医学依据。'),
        ('page-review/v1/L05-p06-docling-standard-cpu-order.png', 'Docling原生大表框涵盖下方独立nomogram；错误图注关系已拒绝，原生输出未改写。')])
    (OUT / 'index.html').write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>S3 CPU解析对照</title><style>' + style + '</style><body>' + body + '<h2>原页证据预览</h2>' + figures + '</body></html>')
    print(json.dumps({'report': rel(OUT / 'index.html'), 'measurements': len(measurements), 'focused': len(focus), 'all_AI_pages': len(expected)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
