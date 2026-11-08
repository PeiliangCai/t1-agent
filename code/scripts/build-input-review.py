"""Build one self-contained, source-bound static PDF layout review pack. No model/API calls."""
from hashlib import sha256
from pathlib import Path
import json
import re
import shutil

CODE = Path(__file__).resolve().parents[1]
ROOT = CODE/'docs/acceptance/pdf-structure-review-2026-11-07'
PUBLIC = CODE/'apps/pi-web/public/input-review'
ASSETS = PUBLIC/'assets'


def digest(value):
    return sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def read(path):
    return json.loads(path.read_text())


def source_path(path):
    value = Path(path)
    if str(value).startswith('code/'):
        value = Path(str(value)[5:])
    actual = (CODE/value).resolve()
    if not actual.is_relative_to(CODE):
        raise ValueError('review source must remain inside code/')
    return actual


def copy_asset(path, expected=None):
    actual = source_path(path); data = actual.read_bytes(); hash_ = sha256(data).hexdigest()
    if expected and hash_ != expected:
        raise ValueError('review asset hash changed: '+str(path))
    name = hash_[:20]+actual.suffix.lower()
    destination = ASSETS/name
    if destination.exists():
        if sha256(destination.read_bytes()).hexdigest() != hash_:
            raise ValueError('review asset name collision')
    else:
        shutil.copyfile(actual, destination)
    return 'assets/'+name, hash_


class Sources:
    def __init__(self):
        self.documents = {}; self.pages = {}; self.pdfs = {}

    def document(self, source_id):
        if source_id not in self.documents:
            path = ROOT/'derived'/source_id/'parser-result.json'
            payload = read(path); document = payload.get('document', payload)
            pdf = source_path(document['source']['file_reference'])
            if sha256(pdf.read_bytes()).hexdigest() != document['file_sha256']:
                raise ValueError('source PDF changed')
            self.documents[source_id] = (document, sha256(path.read_bytes()).hexdigest())
            self.pdfs[source_id] = copy_asset(pdf, document['file_sha256'])[0]
        return self.documents[source_id]

    def page(self, source_id, number):
        import pypdfium2 as pdfium
        document, _ = self.document(source_id)
        key = (source_id, number)
        if key not in self.pages:
            pdf = pdfium.PdfDocument(source_path(document['source']['file_reference'])); page = pdf[number-1]
            try:
                bitmap = page.render(scale=2)
                try:
                    import io
                    stream = io.BytesIO(); bitmap.to_pil().save(stream, format='PNG'); data = stream.getvalue()
                    hash_ = sha256(data).hexdigest(); name = hash_[:20]+'.png'; target = ASSETS/name
                    if not target.exists():
                        with target.open('xb') as out:
                            out.write(data)
                    elif sha256(target.read_bytes()).hexdigest() != hash_:
                        raise ValueError('rendered source-page hash collision')
                    self.pages[key] = {'physical_page': number, 'image': 'assets/'+name, 'sha256': hash_}
                finally:
                    bitmap.close()
            finally:
                page.close(); pdf.close()
        return self.pages[key]

    def bind(self, source_id, pages):
        document, ir_sha = self.document(source_id)
        return {'source_id': source_id, 'source_label': source_id+' · '+Path(document['source']['file_reference']).name,
                'pdf_sha256': document['file_sha256'], 'pdf': self.pdfs[source_id],
                'pages': [self.page(source_id, number) for number in sorted(set(pages))], 'source_ir_sha256': ir_sha}


FIGURES = [
    ('L07', '6', 'L07-P09-F6', '图6：底部脚注与上下示意图',
     '图6是分期/再分期判据示意图，并非MRI扫描图。本轮补齐底部被裁断的位图脚注，保留左侧原图注；不据此批准医学配图用途。',
     ['底部带星号的MRI脚注是否完整可见，没有被裁断？', '上下STAGING、RESTAGING两块及左侧图6图注是否都保留、没有串图？']),
    ('L07', '2', 'L07-P04-F2', '图2：四面板与双栏图注',
     '本轮补齐原位图右侧和底部的小幅裁边。上轮已保留的双栏图注原文不改写；图中示意部分与扫描图的医学关系仍待专业核验。',
     ['上排A/B和下排C/D四个面板与字母是否齐全，右侧和底部有没有裁掉内容？', '图2左右两栏图注是否都保留，且按先左栏、后右栏的来源顺序对照正确？']),
    ('L07', '3', 'L07-P06-F3', '图3：图例、A-D与跨栏图注',
     '本轮补齐位图底部的小幅裁边。左侧图例、中间定位图、右侧A-D均须对照原页；这里只核对版面与原文出处。',
     ['左侧图例、中间定位示意和右侧A-D四幅是否都在，底部是否完整？', '左栏末尾pos-与右栏开头teriorly及后续图注是否顺序正确、连字符原样保留？']),
    ('L07', '4', 'L07-P07-F4-CONTROL', '图4：四幅图与出版社标志',
     '工程核对后无需裁图修改：保留原有正确整图及页脚标志误配防护。四幅图的病例或医学含义不在本次初筛中批准。',
     ['图4左侧图注是否对应右侧四幅大图，而不是页脚Springer小标志？', '四幅图是否都保留，且没有把页脚或相邻正文混进整图？']),
    ('L07', '5', 'L07-P08-F5-CONTROL', '图5：上下A/B示意图',
     '工程核对后无需裁图修改：保留已有上下A/B整图恢复结果。只核对示意图与原图注，不认定它是患者扫描图。',
     ['上下A/B、图内文字与右上小图是否都完整保留？', '左侧图5图注是否对应此幅上下示意图，没有串到图4或图6？']),
    ('L05', '4', 'L05-P08-F4', '图4：A-I九联图及三组图注',
     '工程核对后无需裁图修改：九个面板与原图注均保留。只核对A-C、D-F、G-I的原文字面分组，不要求判断AIS/MIA/IAC诊断是否正确。',
     ['3×3九个面板A-I及各标号是否齐全，没有裁掉右边或底部？', '图注A-C、D-F、G-I三组原文是否完整，并与原页各组字母对应？']),
    ('L01', '1', 'L01-P02-F1', '图1：三CT面板、Note与图名',
     '工程核对后无需裁图修改：保留（a）（b）（c）三面板、两行明确Note及图1标题。病例与图型的医学含义仍不等于获得批准。',
     ['（a）（b）（c）三个面板、箭头与字母是否都在整图中？', '图下两行“注”与图1标题是否无遗漏、顺序与原页一致？']),
]


def figure_cases(sources):
    result = []
    for source_id, number, case_id, title, explanation, questions in FIGURES:
        document, _ = sources.document(source_id)
        current_path = ROOT/'figures'/source_id/'figure-assets/catalog.json'
        current = read(current_path)
        if any(current[key] != document[key] for key in ['document_id', 'file_sha256', 'text_version']):
            raise ValueError('new figure catalog does not bind current review source')
        old = read(CODE/'docs/acceptance/pdf-input-quality-2026-11-07/derived'/source_id/'figure-assets/catalog.json')
        if old['file_sha256'] != document['file_sha256']:
            raise ValueError('before figure is not from the same PDF')
        figure = next(f for f in current['figures'] if f['figure_number'] == number)
        previous = next(f for f in old['figures'] if f['figure_number'] == number)
        region, before = figure['regions'][0], previous['regions'][0]
        after_image, after_sha = copy_asset(region['path'], region['sha256']); before_image, before_sha = copy_asset(before['path'], before['sha256'])
        fragments = []
        for s in figure['caption_segments']:
            block = next(b for b in document['blocks'] if b['block_id'] == s['block_id'])
            if block['text'][s['start']:s['end']] != s['exact_quote']:
                raise ValueError('caption is not the exact bound source')
            fragments.append({'physical_page': s['physical_page'], 'text': s['exact_quote'], 'source_segment': s})
        changed = before_sha != after_sha
        item = {'case_id': case_id, 'kind': 'figure', 'title': title, 'explanation': explanation,
                **sources.bind(source_id, [region['physical_page']]),
                'case_version': 'PDF结构核验版1 · '+sha256(current_path.read_bytes()).hexdigest()[:12],
                'artifact_sha256': digest({'catalog_sha256': sha256(current_path.read_bytes()).hexdigest(),
                    'source_ir_sha256': sources.document(source_id)[1], 'figure_id': figure['figure_id'], 'after_png_sha256': after_sha,
                    'before_png_sha256': before_sha, 'before_caption_segments': previous['caption_segments']}),
                'after_note': '修后：补齐原PDF完整位图边界；点击图像可放大。' if changed else '核对后无需裁图修改：本轮保留既有整图，PNG指纹相同。',
                'before_note': '修前：同一PDF的此前裁图，供查看裁边变化。' if changed else '此前裁图与当前PNG相同；不将回归保留算作新增修复。',
                'after': {'sections': [{'type': 'image', 'title': '当前整图（点击放大）', 'image': after_image},
                    {'type': 'fragments', 'layout': 'caption-lines', 'title': '原图注 / Note原文片段', 'fragments': fragments, 'note': '依原文行紧凑展示，保留原字符、换行及各行出处；中文核验问题不是原文翻译。'}]},
                'before': {'sections': [{'type': 'image', 'title': '此前整图（点击放大）', 'image': before_image},
                    {'type': 'fragments', 'layout': 'caption-lines', 'title': '此前图注原文片段', 'fragments': [{'physical_page': s['physical_page'], 'text': s['exact_quote'], 'source_segment': s} for s in previous['caption_segments']]}]},
                'questions': [{'question_id': 'q'+str(i+1), 'text': question} for i, question in enumerate(questions)]}
        result.append(item)
    return result


def shared_case(case, sources):
    """The parser owner supplies exact text/cells; no HTML, translation or inferred values are accepted."""
    source_id = case['source_id']; document, ir_sha = sources.document(source_id)
    if case['source_pdf_sha256'] != document['file_sha256'] or case['parser_result_sha256'] != ir_sha or case['text_version'] != document['text_version']:
        raise ValueError('table/continuation PDF binding mismatch')
    if sha256(source_path(case['parser_result']).read_bytes()).hexdigest() != ir_sha:
        raise ValueError('case parser artifact changed')
    pages = case.get('physical_pages') or [case['physical_page']]
    kind = 'table' if 'table' in case['kind'] else 'continuation'
    blocks = {b['block_id']: b for b in document['blocks']}
    def original_fragments(segments, label=''):
        result = []
        for s in segments:
            block = blocks[s['block_id']]
            if s['text_version'] != document['text_version'] or not 0 <= s['start'] < s['end'] <= len(block['text']):
                raise ValueError('case source span drift')
            text = block['text'][s['start']:s['end']]
            if s.get('exact_quote', text) != text:
                raise ValueError('case quoted text drift')
            if result and result[-1]['physical_page'] == block['page']:
                result[-1]['text'] += '\n'+text
            else:
                result.append({'physical_page': block['page'], 'text': text, 'label': label})
        return result
    def sections(value, label):
        result = []
        grid = value.get('grid') or (value if 'cells' in value else None)
        if grid:
            if label == '当前':
                if grid['source_pdf_sha256'] != document['file_sha256'] or grid['text_version'] != document['text_version']:
                    raise ValueError('source table grid drift')
                bound = next(t['source_grid'] for t in document['structure']['tables'] if t.get('source_grid', {}).get('grid_id') == grid['grid_id'])
                presentation = {key: value for key, value in grid.items() if key != 'index_interval'}
                presentation['cells'] = [{key: value for key, value in cell.items() if key not in ['text', 'column_header', 'row_header']}
                                         for cell in grid['cells']]
                if bound != presentation:
                    raise ValueError('readable table is not the bound current source grid')
                for cell in grid['cells']:
                    original_fragments(cell.get('source_segments', []))
                    literal = '\n'.join(blocks[s['block_id']]['text'][s['start']:s['end']] for s in cell['source_segments'])
                    if cell['text'] != literal:
                        raise ValueError('readable cell text is not the exact source spans')
                if grid.get('caption_status') == 'geometry_checked_numbered_title' and grid.get('caption_segments'):
                    result.append({'type': 'fragments', 'title': '表题原文', 'fragments': original_fragments(grid['caption_segments'])})
            result.append({'type': 'table', 'title': label+'可读表格', 'grid': grid})
            if label == '当前' and grid.get('footnote_segments'):
                result.append({'type': 'fragments', 'title': '表脚注原文', 'fragments': original_fragments(grid['footnote_segments'])})
        fragments = value.get('fragments') or value.get('ordered_fragments')
        parts = value.get('ordered_parts') or value.get('parts')
        if parts:
            fragments = []
            for i, part in enumerate(parts):
                fragments.extend(original_fragments(part['segments'], '第'+str(i+1)+'部分'))
        if fragments:
            result.append({'type': 'fragments', 'title': '当前续接顺序（原文片段仍分开）' if label == '当前' else '此前独立片段（未确立续接关系）', 'fragments': fragments,
                           'note': value.get('note', '按1→2展示当前阅读关系；保留各片段原文及原页位置，不去掉原连字符，不冒充单一连续原文。' if label == '当前' else '此前只保存独立原文片段；本栏不表示已经建立续接关系。')})
        if value.get('text'):
            result.append({'type': 'text', 'title': label+'文字', 'text': value['text']})
        if value.get('image'):
            result.append({'type': 'image', 'title': label+'对照图', 'image': copy_asset(value['image'])[0]})
        if not result:
            raise ValueError('case lacks a readable table or original fragments: '+case['case_id'])
        return result
    after = sections(case['after'], '当前'); before = sections(case['before'], '此前')
    artifact_sha = digest({'owner_case': case, 'bound_parser_sha256': ir_sha})
    title = case['title']; explanation = case.get('explanation') or case.get('problem', '')
    if kind == 'table':
        table_number = re.search(r'Table([0-9]+)', case['case_id'])[1]
        logical_levels = case['after'].get('grid', case['after']).get('logical_header_rows', 1)
        title = source_id+' · p'+str(pages[0])+' 表'+table_number+'：行列和'+('多级表头' if logical_levels > 1 else '表头')
    if kind == 'continuation':
        parts = case['after']['ordered_parts']; first = parts[0]['text']; last = parts[0]['text'].splitlines()[-1][-18:]; following = parts[1]['text'].splitlines()[0][:18]
        figure = re.match(r'^Fig\.\s*([1-9][0-9]*)\b', first)
        pending = case['after']['status'] == 'needs_user_review'
        object_name = 'Fig'+figure[1]+'图注' if figure else '参考文献' if pending else '正文'
        page_label = '→'.join(str(p) for p in pages)
        title = source_id+' · p'+page_label+' '+object_name+'续接'
        explanation = ('此条参考文献续接仍需你判断，当前只展示候选关系。' if pending else '当前已按原页恢复阅读关系，仍请对照判断是否接错。')+' 边界为“'+last+'” → “'+following+'”。保留原字符、连字符及独立出处，不涉及医学结论判断。'
    questions = case['questions']
    if case['case_id'] == 'L05-p6-Table3':
        # This review case has a single logical header. Use its three concrete
        # questions instead of the inherited generic multi-level-header prompts.
        questions = questions[-3:]
    return {'case_id': case['case_id'], 'kind': kind, 'title': title, 'explanation': explanation,
            **sources.bind(source_id, pages), 'artifact_sha256': digest({'owner_artifact_sha256': artifact_sha, 'source_ir_sha256': sources.document(source_id)[1], 'after': after}),
            'case_version': case.get('case_version', 'PDF结构核验版1 · '+artifact_sha[:12]),
            'after_note': case.get('after_note', '该候选续接仍待你判断；不自动认定成立。' if case['after'].get('status') == 'needs_user_review' else '当前解析结果；请按原页逐项核对，未作医学或产品批准。'),
            'before_note': case.get('before_note', '此前排版/顺序结果，仅供查看变化，不作原文依据。'),
            'after': {'sections': after}, 'before': {'sections': before},
            'questions': [{'question_id': q.get('question_id', 'q'+str(i+1)), 'text': q['text'], **({'hint': q['hint']} if q.get('hint') else {})}
                          if isinstance(q, dict) else {'question_id': 'q'+str(i+1), 'text': q} for i, q in enumerate(questions)]}


def main():
    ASSETS.mkdir(parents=True, exist_ok=True); sources = Sources()
    shared = read(ROOT/'review-cases-tables-continuations.json')
    cases = figure_cases(sources)+[shared_case(c, sources) for c in shared['cases']]
    if len({c['case_id'] for c in cases}) != len(cases):
        raise ValueError('duplicate review case ID')
    for c in cases:
        assert c['questions'] and len({q['question_id'] for q in c['questions']}) == len(c['questions'])
    pack = {'schema_version': 'pdf-input-review-pack-1', 'pack_id': 'pdf-structure-review-2026-11-07-v1',
            'scope': 'PDF解析、原页与图文定位的非医学初筛；非LLM新抽取结果或批准证据。',
            'human_approved': False, 'medical_quality_approved': False, 'product_export_approved': False,
            'cases': cases}
    pack['pack_sha256'] = digest(pack)
    target = PUBLIC/'data.json'; temporary = target.with_suffix('.json.tmp'); temporary.write_text(json.dumps(pack, ensure_ascii=False, indent=2)+'\n'); temporary.replace(target)
    print(json.dumps({'page': str((PUBLIC/'index.html').relative_to(CODE)), 'cases': len(cases),
        'questions': sum(len(c['questions']) for c in cases), 'kinds': sorted({c['kind'] for c in cases}),
        'pack_sha256': pack['pack_sha256'], 'rendered_source_pages': len(sources.pages), 'paid_calls': 0}, ensure_ascii=False))


if __name__ == '__main__':
    main()
