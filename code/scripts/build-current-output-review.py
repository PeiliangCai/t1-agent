"""Build a source-bound static ordinary-output review pack. Offline; never opens a DB/API.

Reuse the small input-review renderer in a separate directory. Only finalized
current comparison exports are accepted; historical review data is never loaded.
"""
from hashlib import sha256
from pathlib import Path
import argparse
import io
from html import escape
import json
import shutil
import subprocess

CODE = Path(__file__).resolve().parents[1]
DEFAULT_ROOT = CODE / 'docs/acceptance/s0-s4-recheck-2026-11-08'
EXPECTED_PLAN = 'b634daf4d3803f37224e6c4b6ac6d8c8c8410dba13f5b030c2b4166b0f975616'
TEMPLATE = CODE / 'apps/pi-web/public/input-review'
SCHEMA = 'current-output-review-pack-1'
QUESTIONNAIRE = 'current-output-ordinary-screening-2'
PRIMARY_POLICY = 'model-primary-assessment-1'
TERMINAL_EXECUTION_STATUSES = ['finished', 'stopped', 'finished_runs_human_quality_and_selection_pending']
REVIEW_GROUPS = {
    'primary_candidate': '主待核',
    'background_suggestion': '仅背景建议（未人工确认）',
    'delivery_rejected': '交付拒绝的原始记录',
}
LEGACY_PROBLEM_TYPES = ['missing', 'order', 'row_column', 'incomplete_figure', 'wrong_figure', 'other']
PROBLEM_TYPES = ['context_missing', 'source_text_error', 'not_target_visual', 'background_unnecessary', 'background_should_be_main',
    'figure_uncertain', 'figure_incomplete', 'wrong_figure', 'other']
SCOPE = 'current_model_output_ordinary_screening'
FROZEN_RECOVERY = {
    'offline-delivery-recovery/recovered-L07-B0-result.json': '7a9c3ec40c00bec3eb85c27270669b67de8adbd3e73f514341a020f4970cd49b',
    'offline-delivery-recovery/rejected-views.json': '92e30756a59947e1e369b2780ead90191aacdf4696d45bfae1bb68ad6d7b0617',
    'offline-delivery-recovery/recovery-binding.json': '3802c5360d3d1ab8d0cb81c3efaaecef4d5d0df365f0af0bba512445284e8192',
    'automatic-audit/comparison.json': 'db48cf87c107e6fd4aa741af2f389ec74988b0a7b5ea5ae58eb325dcf8cdb540',
}
# Same SHA-256 content check on localhost/HTTPS and ordinary remote HTTP.
# The fallback needs only standard typed arrays; it performs no network call.
SHA256_JS = r"""
  async function digestText(text) {
    const bytes = new TextEncoder().encode(text);
    if (globalThis.crypto?.subtle) {
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
    }
    const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const data = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64), words = new Int32Array(64);
    data.set(bytes); data[bytes.length] = 0x80;
    const dv = new DataView(data.buffer), rotate = (v,n) => (v >>> n) | (v << (32-n));
    dv.setUint32(data.length-8, Math.floor(bytes.length / 0x20000000), false);
    dv.setUint32(data.length-4, (bytes.length * 8) >>> 0, false);
    for (let offset=0; offset<data.length; offset+=64) {
      for (let i=0;i<16;i++) words[i] = dv.getUint32(offset+i*4, false);
      for (let i=16;i<64;i++) {
        const x=words[i-15], y=words[i-2], s0=rotate(x,7)^rotate(x,18)^(x>>>3), s1=rotate(y,17)^rotate(y,19)^(y>>>10);
        words[i] = (words[i-16]+s0+words[i-7]+s1)|0;
      }
      let [a,b,c,d,e,f,g,z] = h;
      for (let i=0;i<64;i++) {
        const t1=(z+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+k[i]+words[i])|0;
        const t2=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))|0;
        z=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
      }
      [a,b,c,d,e,f,g,z].forEach((v,i) => h[i]=(h[i]+v)>>>0);
    }
    return [...h].map(v=>v.toString(16).padStart(8,'0')).join('');
  }
"""


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def digest(value):
    return sha256(canonical(value).encode()).hexdigest()


def inside(path):
    path = Path(path)
    if str(path).startswith('code/'):
        path = Path(str(path)[5:])
    result = (CODE / path).resolve()
    if not result.is_relative_to(CODE):
        raise ValueError('source path outside code/: ' + str(path))
    return result


class Builder:
    def __init__(self, root, plan_hash):
        self.root = root
        self.comparison = root / 'comparison'
        self.audit = self.comparison / 'automatic-audit'
        self.output = root / 'output-review'
        self.expected_plan = plan_hash
        self.sources = {}
        self.assets = {}
        self.pages = {}
        self.pdfs = {}
        self.output_binding = None
        self.output_binding_jobs = {}
        self.terminal_audit = None
        self.page_additional_directed_review_risks = []

    @staticmethod
    def protected_reviews():
        result = {}
        for folder in [CODE / 'apps/pi-web/public/input-review', CODE / 'apps/pi-web/public/output-review',
                DEFAULT_ROOT / 'output-review', DEFAULT_ROOT / 'comparison']:
            inventory = {str(p.relative_to(CODE)): sha256(p.read_bytes()).hexdigest() for p in sorted(folder.rglob('*')) if p.is_file()}
            result[str(folder.relative_to(CODE))] = inventory
        return result

    @staticmethod
    def risk_reasons(source):
        record, entry = source['record'], source['entry']
        reasons = []
        if source.get('rejected_view'):
            reasons.append('交付校验未通过；保留原机械诊断，普通意见不能自动批准导出')
        if entry.get('primary_assessment', {}).get('effective_role') == 'background_suggestion':
            reasons.append('仅背景建议，尚未人工确认；请核对目标外观或病灶直接尺寸是否被过度分流、背景是否需要保留')
        if record['evidence_type'] == 'interpretive_condition':
            reasons.append('条件解释候选；不等于已验收的独立图像特征')
        if record['evidence_type'] == 'association_conclusion':
            reasons.append('关联结论候选；需区分统计关系与视觉描述')
        codes = record['evidence_validation'].get('model_semantic_review', {}).get('issue_codes', [])
        if any('background' in c.lower().replace('-', '_') or 'not_independent_visual' in c.lower().replace('-', '_') for c in codes):
            reasons.append('模型标记为背景或非独立视觉描述（模型意见未批准）')
        if entry['review_status'] == 'needs_context' or record['context']['status'] == 'needs_context':
            reasons.append('记录状态为 needs_context，主体与条件仍待核对')
        if entry['figure_association']['status'] in ['pending', 'not_checked']:
            reasons.append('图文对应尚待核验')
        for risk in source.get('directed_review_risks', []):
            reasons.append(Builder.directed_risk_label(risk))
        return reasons

    @staticmethod
    def directed_risk_label(risk):
        if risk.get('scope_execution_deviation'):
            return risk['reason']
        reason = risk['reason']
        if 'AAH' in reason:
            return '指定核验：同一 AAH 病灶尺寸原句在两种方法下分组不同，请分别核对；单次结果不说明哪种方法更准'
        if 'comet-tail' in reason:
            return '指定核验：彗星尾及形态外观原句在两种方法下分组不同，请核对背景/主待核分组是否合理'
        if 'irregular borders' in reason:
            return '指定核验：原句含边界、信号或形态外观，却被建议为背景；可能需要重新考虑分组'
        if 'Same exact source spans' in reason:
            return '指定核验：同样的来源片段形成两条记录，模型对来源归属的标记不同；可能重复或归属有误，两条均待核'
        if 'Full appearance/' in reason:
            return '指定核验：完整外观句保留了必要条件和否定；文内引用配图内容仍需对照'
        return '指定定向风险仍待核：' + reason

    def attach_page_scope_risks(self, records):
        """User-confirmed C14 scope check; historical votes are never copied."""
        if not self.terminal_audit:
            return
        sources = {(r['job']['job_id'], r['entry']['record_id'], r['entry']['record_version']): r for r in records}
        def spans(values):
            return [{k: f[k] for k in ['block_id', 'text_version', 'start', 'end', 'exact_quote', 'physical_page']} for f in values]
        for anchor in self.terminal_audit.get('historical_feedback_source_anchor_checks', []):
            if anchor.get('historical_case_id') != 'C14-483dd5716867':
                continue
            for overlap in anchor['current_source_span_overlap']:
                key = (overlap['job_id'], overlap['record_id'], overlap['record_version'])
                source = sources.get(key)
                if not source or self.review_group(source) != 'primary_candidate':
                    continue
                if spans(source['entry']['original_fragments']) != spans(anchor['old_original_fragments']) or \
                        any(source['binding'][k] != anchor['source_binding'][k] for k in ['pdf_sha256', 'ir_sha256', 'text_version']):
                    raise ValueError('C14 page scope risk requires exact frozen historical/current source spans')
                risk = {**{k: overlap[k] for k in ['job_id', 'record_id', 'record_version', 'effective_role']},
                    'origin': 'page_level_user_confirmed_scope_execution_check', 'historical_case_id': anchor['historical_case_id'],
                    'historical_original_spans_sha256': digest(anchor['old_original_fragments']),
                    'terminal_audit_sha256': self.output_binding['terminal_audit_sha256'], 'scope_execution_deviation': True,
                    'reason': '你已确认这类纯结论仅作背景；本轮模型仍列为独立描述，这是规则执行偏差。原记录与分组保留，此处不重新决策范围，也不套用旧票。'}
                source.setdefault('directed_review_risks', []).append(risk)
                self.page_additional_directed_review_risks.append(risk)

    def read(self, path, expected=None):
        path = inside(path)
        if self.comparison == DEFAULT_ROOT / 'comparison' and path.is_relative_to(self.comparison):
            expected = expected or FROZEN_RECOVERY.get(str(path.relative_to(self.comparison)))
        raw = self.source_bytes(path, expected)
        return json.loads(raw)

    def source_bytes(self, path, expected=None):
        path = inside(path)
        raw = path.read_bytes()
        actual = sha256(raw).hexdigest()
        if expected and actual != expected:
            raise ValueError('source hash mismatch: ' + str(path))
        key = str(path.relative_to(CODE))
        if key in self.sources and self.sources[key] != actual:
            raise ValueError('source changed during build: ' + str(path))
        self.sources[key] = actual
        return raw

    def frozen_binding(self, plan, execution):
        """New rounds need a closed, byte-bound owner handoff, not a live report."""
        path = self.comparison / 'output-binding.json'
        required = plan.get('config', {}).get('experiment_scope', {}).get('shared_protocol') == PRIMARY_POLICY
        if not path.is_file():
            if required:
                raise ValueError('wait for finalized current output-binding.json')
            return
        binding = self.read(path)
        if binding.get('schema_version') != 'current-output-binding-1' or binding.get('finalized') is not True or \
                binding.get('plan_sha256') != self.expected_plan or binding.get('execution_status') != execution['status'] or \
                execution['status'] not in TERMINAL_EXECUTION_STATUSES:
            raise ValueError('current output binding is not finalized for this plan/execution')
        expected_paths = {'plan_path': self.comparison / 'plan.json',
            'execution_report_path': self.comparison / 'execution/report.json', 'audit_path': self.audit / 'comparison.json'}
        for key, expected in expected_paths.items():
            if not binding.get(key) or inside(binding[key]) != expected:
                raise ValueError('current output binding source path mismatch: ' + key)
        def check(value):
            if isinstance(value, list):
                for item in value:
                    check(item)
            elif isinstance(value, dict):
                for key, item in value.items():
                    if key.endswith('_path') and isinstance(item, str):
                        hash_key = key[:-5] + '_sha256'
                        if hash_key in value:
                            expected = value[hash_key]
                            if not isinstance(expected, str) or len(expected) != 64:
                                raise ValueError('frozen source hash missing: ' + key)
                            self.source_bytes(item, expected)
                    elif isinstance(item, (list, dict)):
                        check(item)
        check(binding)
        for key in ['plan_sha256', 'execution_report_sha256', 'audit_sha256', 'ledger_sha256', 'rejected_views_sha256']:
            if not isinstance(binding.get(key), str) or len(binding[key]) != 64:
                raise ValueError('frozen binding required source hash missing: ' + key)
            if not isinstance(binding.get(key[:-7] + '_path'), str):
                raise ValueError('frozen binding required source path missing: ' + key)
        logical = {j['job_id']: j for p in plan['papers'] for j in p['methods']['jobs']}
        bound_jobs = binding.get('jobs', [])
        if len(bound_jobs) != len(logical) or {j['job_id'] for j in bound_jobs} != set(logical):
            raise ValueError('frozen binding must include all logical jobs exactly once')
        for row in bound_jobs:
            job = logical[row['job_id']]
            if row['independent_model_run'] != job['independent_model_run'] or \
                    (row.get('representative_job_id') or row['job_id']) != (job['representative_job_id'] or job['job_id']):
                raise ValueError('frozen binding representative job mismatch')
        self.output_binding, self.output_binding_jobs = binding, {j['job_id']: j for j in bound_jobs}
        if binding.get('terminal_audit_path'):
            self.terminal_audit = self.read(binding['terminal_audit_path'], binding['terminal_audit_sha256'])

    @staticmethod
    def review_group(source):
        if source.get('rejected_view'):
            return 'delivery_rejected'
        # Legacy issue-code strings never create or alter a role classification.
        return 'background_suggestion' if source['entry'].get('primary_assessment', {}).get('effective_role') == 'background_suggestion' else 'primary_candidate'

    @staticmethod
    def group_counts(records):
        counts = {key: sum(Builder.review_group(r) == key for r in records) for key in REVIEW_GROUPS}
        return {**counts, 'total_current_records': len(records),
            'legal_delivery_records': counts['primary_candidate'] + counts['background_suggestion']}

    @staticmethod
    def validate_delivery_groups(delivery, manifest):
        primary, background = delivery['records'], delivery.get('background_records', [])
        if len({r['record_id'] for r in primary + background}) != len(primary) + len(background):
            raise ValueError('primary/background deliveries overlap or repeat a record')
        if any(r.get('primary_assessment', {}).get('effective_role') == 'background_suggestion' for r in primary) or \
                any(r.get('primary_assessment', {}).get('effective_role') != 'background_suggestion' for r in background):
            raise ValueError('delivery primary/background grouping mismatch')
        if delivery.get('primary_assessment_policy_version') == PRIMARY_POLICY:
            for group, entries in [('primary_candidate', primary), ('background_suggestion', background)]:
                for entry in entries:
                    a = entry.get('primary_assessment', {})
                    if a.get('policy_version') != PRIMARY_POLICY or a.get('effective_role') != group or \
                            a.get('record_version') != entry['record_version'] or a.get('source_record_sha256') != entry['source_record_sha256'] or \
                            a.get('human_approved') is not False or a.get('value') not in [None, 'context_only_suggested',
                                'visual_evidence_suggested', 'mixed_or_needs_context', 'uncertain'] or \
                            group == 'background_suggestion' and a.get('value') != 'context_only_suggested':
                        raise ValueError('current assessment/version/group binding mismatch')
            if manifest.get('primary_candidate_count') != len(primary) or manifest.get('background_suggestion_count') != len(background):
                raise ValueError('candidate export group counts mismatch')
        elif background:
            raise ValueError('background grouping requires explicit current assessment policy')

    def select_records(self, records):
        selected = []
        for job_id in sorted({r['job']['job_id'] for r in records}):
            group = sorted([r for r in records if r['job']['job_id'] == job_id],
                key=lambda r: digest({'seed': self.expected_plan, 'job': job_id, 'record': r['entry']['record_id'],
                    'record_version': r['entry']['record_version'],
                    'version_fingerprint': r['entry']['delivery_fingerprint'] or r['binding']['raw_view_fingerprint']}))
            sample = group[:6]
            selected.extend((r, 'all_current_candidates' if len(group) <= 6 else 'fixed_seed_development_sample') for r in sample)
            remaining = [r for r in group if r not in sample]
            directed = [r for r in remaining if r.get('rejected_view') or r.get('directed_review_risks')]
            # Keep the original base ranking. Missing primary/background strata
            # are covered as disclosed directed cases, never relabeled random.
            covered = {self.review_group(r) for r in sample + directed}
            for role in ['primary_candidate', 'background_suggestion']:
                candidate = next((r for r in remaining if self.review_group(r) == role), None)
                if role not in covered and candidate is not None:
                    directed.append(candidate)
                    covered.add(role)
            risks = [r for r in remaining if r not in directed and self.risk_reasons(r)]
            risks.sort(key=lambda r: 0 if self.review_group(r) == 'background_suggestion' or
                r['record']['evidence_type'] in ['interpretive_condition', 'association_conclusion'] else
                1 if r['entry']['review_status'] == 'needs_context' else 2)
            # Mandatory refused views/group coverage may exceed the usual two;
            # every extra case is separately marked as directed, without reuse.
            directed.extend(risks[:max(0, 2 - len(directed))])
            selected.extend((r, 'directed_risk_not_random_sample') for r in directed)
        return selected

    def asset(self, path, expected):
        path = inside(path)
        raw = path.read_bytes()
        actual = sha256(raw).hexdigest()
        if actual != expected:
            raise ValueError('asset hash mismatch: ' + str(path))
        self.sources[str(path.relative_to(CODE))] = actual
        name = 'assets/' + actual[:24] + path.suffix.lower()
        target = self.output / name
        if target.exists() and target.read_bytes() != raw:
            raise ValueError('asset name collision')
        if not target.exists():
            target.write_bytes(raw)
        self.assets[name] = actual
        return name

    def page(self, paper, number):
        import pypdfium2 as pdfium
        key = (paper['document_id'], number)
        if key not in self.pages:
            pdf = pdfium.PdfDocument(inside(paper['pdf_path']))
            try:
                if not 1 <= number <= len(pdf):
                    raise ValueError('physical page out of range')
                page = pdf[number - 1]
                try:
                    bitmap = page.render(scale=2)
                    try:
                        stream = io.BytesIO()
                        bitmap.to_pil().save(stream, format='PNG')
                        raw = stream.getvalue()
                    finally:
                        bitmap.close()
                finally:
                    page.close()
            finally:
                pdf.close()
            hash_ = sha256(raw).hexdigest()
            name = 'assets/' + hash_[:24] + '.png'
            target = self.output / name
            if target.exists() and target.read_bytes() != raw:
                raise ValueError('rendered page name collision')
            if not target.exists():
                target.write_bytes(raw)
            self.assets[name] = hash_
            self.pages[key] = {'physical_page': number, 'image': name, 'sha256': hash_}
        return self.pages[key]

    @staticmethod
    def fragments(values, document, excluded):
        blocks = {b['block_id']: b for b in document['blocks']}
        result, previous = [], None
        for value in values:
            b = blocks.get(value['block_id'])
            if not b or b['block_id'] in excluded or value['text_version'] != document['text_version'] or \
                    b['page'] != value['physical_page'] or not 0 <= value['start'] < value['end'] <= len(b['text']) or \
                    b['text'][value['start']:value['end']] != value['exact_quote']:
                raise ValueError('literal source span/bibliography boundary mismatch')
            adjacent = previous and (previous['block_id'] == b['block_id'] and previous['end'] == value['start'] or
                blocks[previous['block_id']]['reading_order'] + 1 == b['reading_order'] and
                previous['physical_page'] == value['physical_page'])
            result.append({'text': value['exact_quote'], 'physical_page': value['physical_page'],
                'label': '逐字原文片段', 'break_before': not adjacent})
            previous = value
        return result

    def records(self):
        plan = self.read(self.comparison / 'plan.json', self.expected_plan)
        if plan['schema_version'] != 'two-method-prepared-comparison-1':
            raise ValueError('current two-method plan required')
        execution = self.read(self.comparison / 'execution/report.json')
        if execution['status'] == 'running' or execution['batch_id'] != plan['batch_id']:
            raise ValueError('execution is not finalized for this plan')
        audit = self.read(self.audit / 'comparison.json')
        if audit.get('batch_id', plan['batch_id']) != plan['batch_id'] or audit['execution_status'] != execution['status']:
            raise ValueError('final automatic audit does not match execution')
        self.frozen_binding(plan, execution)
        rows = {r['job_id']: r for r in execution['jobs']}
        recovery_dir = self.comparison / 'offline-delivery-recovery'
        rejected = []
        rejected_path = recovery_dir / 'rejected-views.json'
        if self.output_binding:
            rejected_path = inside(self.output_binding['rejected_views_path'])
            rejected_payload = self.read(rejected_path, self.output_binding['rejected_views_sha256'])
            if rejected_payload.get('schema_version') != 'current-output-rejected-views-1':
                raise ValueError('unknown current rejected-source-view schema')
            rejected = rejected_payload['views']
        elif (recovery_dir / 'recovery-binding.json').is_file():
            recovery = self.read(recovery_dir / 'recovery-binding.json')
            if recovery.get('plan_sha256') != self.expected_plan or recovery['original_execution_report_sha256'] != \
                    self.sources[str((self.comparison / 'execution/report.json').relative_to(CODE))] or not recovery['round_closed']:
                raise ValueError('offline recovery belongs to another plan')
            for row in recovery['effective_jobs']:
                rows[row['job_id']] = row
            rejected_payload = self.read(recovery_dir / 'rejected-views.json')
            if rejected_payload['schema_version'] != 'offline-rejected-output-views-1':
                raise ValueError('unknown rejected-source-view schema')
            rejected = rejected_payload['views']
        audit_rows = {r['job_id']: r for r in audit['rows']}
        audited_outputs = {r['job_id']: r for r in audit['automatic_audits']}
        logical = [j for p in plan['papers'] for j in p['methods']['jobs']]
        if len(logical) != 6 or sum(j['independent_model_run'] for j in logical) != 5 or not set(rows) <= {j['job_id'] for j in logical}:
            raise ValueError('expected six logical/five planned independent input conditions')
        records, jobs = [], []
        for paper in plan['papers']:
            document = self.read(paper['ir_path'], paper['ir_sha256'])['document']
            catalog = self.read(paper['figure_catalog_path'], paper['figure_catalog_sha256'])
            if document['file_sha256'] != paper['pdf_sha256'] or document['text_version'] != paper['text_version'] or \
                    catalog['file_sha256'] != paper['pdf_sha256'] or catalog['text_version'] != paper['text_version']:
                raise ValueError('PDF/IR/catalog identity mismatch')
            # Hash original PDFs before any rendering. Copies retain every source byte.
            self.pdfs[paper['document_id']] = self.asset(paper['pdf_path'], paper['pdf_sha256'])
            for job in paper['methods']['jobs']:
                representative = job['representative_job_id'] or job['job_id']
                measure = audit_rows[job['job_id']]
                actual = rows.get(representative, {})
                actual_audit = audited_outputs.get(representative, {})
                frozen_job = self.output_binding_jobs.get(job['job_id'], {})
                jobs.append({'job_id': job['job_id'], 'representative_job_id': representative,
                    'independent': job['independent_model_run'], 'state': measure.get('state'),
                    'candidate_count': measure.get('candidate_count'), 'task_processing_complete': measure.get('task_processing_complete'),
                    'method_requests': measure.get('method_requests'), 'additional_physical_requests': measure.get('additional_physical_requests'),
                    'result_available': bool(actual.get('result_path')), 'coverage': actual_audit.get('coverage', actual.get('coverage')),
                    'error': actual_audit.get('error', actual.get('error')),
                    'recovered_offline': bool(actual.get('recovered_offline')),
                    'whole_live_delivery_passed': actual_audit.get('whole_live_delivery_passed'),
                    'valid_source_delivery_records': measure.get('valid_source_delivery_records'),
                    'rejected_current_record_count': measure.get('rejected_current_record_count', frozen_job.get('rejected_current_records')),
                    'unstarted_reason': measure.get('unstarted_reason'),
                    'execution_status': 'not_started' if not actual else 'saved_result' if actual.get('result_path') else 'no_saved_result',
                    'started': frozen_job.get('started', bool(actual)), 'frozen_status': frozen_job.get('status'),
                    'primary_candidate_count': measure.get('primary_candidate_count'),
                    'background_suggestion_count': measure.get('background_suggestion_count'),
                    'primary_assessment_policy_version': measure.get('primary_assessment_policy_version'),
                    'parser_status': measure.get('parser_status'), 'image_text_unverified_pages': measure.get('image_text_unverified_pages'),
                    'f_unselected_source_blocks': measure.get('f_unselected_source_blocks'),
                    'shared_bibliography_excluded_source_blocks': measure.get('shared_bibliography_excluded_source_blocks'),
                    'full_source_block_processing_complete': measure.get('full_source_block_processing_complete'),
                    'delivery_validation': actual.get('delivery_validation'),
                    'reuse_is_not_zero_cost': not job['independent_model_run']})
                if not job['independent_model_run']:
                    continue
                row = rows.get(job['job_id'], {})
                if not row.get('result_path'):
                    if row.get('candidate_count'):
                        raise ValueError('job candidates exist without a finalized result')
                    continue
                result = self.read(row['result_path'])
                jobs[-1]['primary_assessment_validation'] = result.get('primary_assessment_validation')
                if self.output_binding:
                    frozen = self.output_binding_jobs[job['job_id']]
                    if not frozen.get('result_path') or inside(frozen['result_path']) != inside(row['result_path']) or \
                            frozen.get('result_sha256') != self.sources[str(inside(row['result_path']).relative_to(CODE))]:
                        raise ValueError('saved result differs from frozen owner binding')
                if result['document_id'] != paper['document_id'] or result['model_id'] != plan['config']['model']['model_id'] or \
                        result['reasoning_effort'] != plan['config']['model']['reasoning_effort'] or result['source_selection_digest'] != job['source_selection_digest']:
                    raise ValueError('result identity differs from current plan')
                export_dir = self.audit / (job['job_id'] + '-candidates')
                exported = self.output_binding_jobs.get(job['job_id'], {}).get('candidate_export')
                if self.output_binding and exported is None:
                    if export_dir.exists():
                        raise ValueError('unbound candidate export exists for frozen job')
                    # A fully rejected result is indexed from its raw source
                    # views below. Do not invent a legal-delivery manifest/hash.
                    manifest = {'mode': 'candidates', 'medical_quality_approved': False, 'record_level_human_confirmation': False,
                        'file_sha256': paper['pdf_sha256'], 'text_version': paper['text_version'], 'record_count': 0, 'assets': []}
                    delivery = {'records': []}
                else:
                    manifest = self.read(export_dir / 'manifest.json')
                    delivery = self.read(export_dir / 'delivery.json')
                self.validate_delivery_groups(delivery, manifest)
                delivered_records = delivery['records'] + delivery.get('background_records', [])
                if manifest['mode'] != 'candidates' or manifest['medical_quality_approved'] or manifest['record_level_human_confirmation'] or \
                        manifest['file_sha256'] != paper['pdf_sha256'] or manifest['text_version'] != paper['text_version'] or \
                        manifest['record_count'] != len(delivered_records):
                    raise ValueError('unapproved current candidate export required')
                if self.output_binding and exported is not None:
                    if inside(exported['directory']) != export_dir or \
                            self.sources[str((export_dir / 'manifest.json').relative_to(CODE))] != exported.get('manifest_sha256') or \
                            self.sources[str((export_dir / 'delivery.json').relative_to(CODE))] != exported.get('delivery_sha256'):
                        raise ValueError('candidate export differs from frozen owner binding')
                    if any(exported.get(key) != expected for key, expected in {'primary_count': len(delivery['records']),
                            'background_count': len(delivery.get('background_records', [])), 'total_count': len(delivered_records)}.items()):
                        raise ValueError('frozen candidate export group counts differ from delivery')
                    for name, entries in [('records', delivery['records']), ('background-records', delivery.get('background_records', []))]:
                        if name == 'background-records' and 'background_records' not in delivery and not (export_dir / (name + '.jsonl')).is_file():
                            continue
                        raw = self.source_bytes(export_dir / (name + '.jsonl'))
                        if [json.loads(line) for line in raw.splitlines() if line.strip()] != entries:
                            raise ValueError('candidate JSONL group differs from delivery: ' + name)
                        self.source_bytes(export_dir / (name + '.csv'))
                for asset in manifest['assets']:
                    self.asset(export_dir / asset['package_path'], asset['sha256'])
                current = {}
                for v in result['versions']:
                    if v['status'] != 'proposed' and v['version'] > current.get(v['record']['record_id'], {}).get('version', -1):
                        current[v['record']['record_id']] = v
                rejected_job = [v for v in rejected if v['job_id'] == job['job_id']]
                if set(current) != {r['record_id'] for r in delivered_records} | {v['record_id'] for v in rejected_job} or \
                        {r['record_id'] for r in delivered_records} & {v['record_id'] for v in rejected_job}:
                    raise ValueError('legal export plus explicit rejected views must partition every current result version')
                excluded = set(job['selection']['excluded_block_ids'])
                for entry in delivered_records:
                    version = current[entry['record_id']]
                    if entry['record_version'] != version['version'] or entry['run_id'] != result['run_id'] or entry.get('human_confirmation') is not None:
                        raise ValueError('candidate current-version/run mismatch')
                    record = version['record']
                    if record['extraction_trace']['run_id'] != result['run_id'] or record['extraction_trace']['fixture'] or \
                            entry['original_fragments'] != record['quote_span']['segments'] or entry['context_fragments'] != record['context']['fragments']:
                        raise ValueError('candidate output literal content differs from saved result')
                    originals = self.fragments(entry['original_fragments'], document, excluded)
                    contexts = self.fragments(entry['context_fragments'], document, excluded)
                    # JS stringify is the runtime fingerprint contract (not Python float formatting).
                    self.verify_fingerprints(entry, record, catalog)
                    aliases = [j['job_id'] for j in paper['methods']['jobs'] if (j['representative_job_id'] or j['job_id']) == job['job_id']]
                    binding = {'plan_sha256': self.expected_plan, 'pdf_path': paper['pdf_path'], 'pdf_sha256': paper['pdf_sha256'],
                        'ir_path': paper['ir_path'], 'ir_sha256': paper['ir_sha256'],
                        'text_version': paper['text_version'], 'figure_catalog_sha256': paper['figure_catalog_sha256'],
                        'job_id': job['job_id'], 'logical_job_ids': aliases, 'run_id': result['run_id'],
                        'result_path': row['result_path'],
                        'result_sha256': self.sources[str(inside(row['result_path']).relative_to(CODE))],
                        'candidate_export_manifest_sha256': self.sources[str((export_dir / 'manifest.json').relative_to(CODE))],
                        'delivery_file_sha256': self.sources[str((export_dir / 'delivery.json').relative_to(CODE))],
                        'record_id': entry['record_id'], 'record_version': entry['record_version'],
                        'source_record_sha256': entry['source_record_sha256'], 'text_fingerprint': entry['text_fingerprint'],
                        'delivery_fingerprint': entry['delivery_fingerprint'], 'artifact_kind': 'unreviewed_offline_delivery_candidate'}
                    if self.output_binding:
                        binding['output_binding_sha256'] = self.sources[str((self.comparison / 'output-binding.json').relative_to(CODE))]
                    if entry.get('primary_assessment'):
                        binding['primary_assessment'] = entry['primary_assessment']
                    records.append({'paper': paper, 'document': document, 'catalog': catalog, 'job': job, 'entry': entry,
                        'record': record, 'originals': originals, 'contexts': contexts, 'binding': binding,
                        'task_processing_complete': result.get('task_processing_complete'),
                        'job_delivery_failed': (result.get('error') or {}).get('code') == 'delivery_visual_statement_policy_failed'})
                for view in rejected_job:
                    version = current[view['record_id']]
                    record = version['record']
                    if version['version'] != view['record_version'] or record != view['record'] or result['run_id'] != view['run_id'] or \
                            self.js_digests([record])[0] != view['source_record_sha256']:
                        raise ValueError('rejected view changed the saved original record/version/run')
                    source_binding = view['source_binding']
                    result_hash = self.sources[str(inside(row['result_path']).relative_to(CODE))]
                    if any(source_binding.get(k) != expected for k, expected in {'pdf_sha256': paper['pdf_sha256'],
                        'ir_sha256': paper['ir_sha256'], 'text_version': paper['text_version'], 'result_sha256': result_hash,
                        'delivery_fingerprint': None}.items()):
                        raise ValueError('rejected source view binding mismatch')
                    originals = self.fragments(record['quote_span']['segments'], document, excluded)
                    contexts = self.fragments(record['context']['fragments'], document, excluded)
                    missing = self.missing_source_fragments(view['issues'], document, required=not bool(self.output_binding))
                    binding = {**source_binding, 'plan_sha256': self.expected_plan, 'job_id': job['job_id'],
                        'logical_job_ids': [j['job_id'] for j in paper['methods']['jobs'] if
                            (j['representative_job_id'] or j['job_id']) == job['job_id']],
                        'run_id': result['run_id'], 'record_id': view['record_id'],
                        'pdf_path': paper['pdf_path'], 'ir_path': paper['ir_path'], 'result_path': row['result_path'],
                        'figure_catalog_sha256': paper['figure_catalog_sha256'],
                        'record_version': view['record_version'], 'source_record_sha256': view['source_record_sha256'],
                        'artifact_kind': 'delivery_rejected_original_source_view', 'delivery_fingerprint': None,
                        'raw_view_fingerprint': digest(view), 'rejected_views_sha256': self.sources[str(rejected_path.relative_to(CODE))]}
                    if self.output_binding:
                        binding['output_binding_sha256'] = self.sources[str((self.comparison / 'output-binding.json').relative_to(CODE))]
                    # Presentation adapter only: this is deliberately NOT a legal
                    # EvidenceDelivery entry or an inferred Figure pairing.
                    entry = {'record_id': view['record_id'], 'record_version': view['record_version'], 'run_id': result['run_id'],
                        'original_fragments': record['quote_span']['segments'], 'context_fragments': record['context']['fragments'],
                        'source_record_sha256': view['source_record_sha256'], 'delivery_fingerprint': None, 'review_status': record['review_status'],
                        'figure_association': {'status': 'not_checked', 'figure_ids': [], 'proposed_figure_ids': [],
                            'reasons': ['交付被拒的原始待核视图，没有合法交付配图；下方图目录仅供原页对照。']}}
                    diagnostics = self.fragments(missing, document, excluded)
                    for fragment, span in zip(diagnostics, missing):
                        fragment['label'] = '缺失定位：' + span['block_id'] + ' [' + str(span['start']) + ',' + str(span['end']) + ')'
                    records.append({'paper': paper, 'document': document, 'catalog': catalog, 'job': job, 'entry': entry,
                        'record': record, 'originals': originals, 'contexts': contexts, 'binding': binding,
                        'task_processing_complete': False, 'job_delivery_failed': True, 'rejected_view': view,
                        'diagnostic_missing_fragments': diagnostics})
        if self.output_binding:
            by_key = {(r['job']['job_id'], r['entry']['record_id'], r['entry']['record_version']): r for r in records}
            seen_risks = set()
            for risk in self.output_binding.get('directed_review_risks', []):
                key = (risk['job_id'], risk['record_id'], risk['record_version'])
                source = by_key.get(key)
                if not source or key in seen_risks or risk.get('effective_role', self.review_group(source)) != self.review_group(source):
                    raise ValueError('directed review risk does not bind one actual current version/group')
                source.setdefault('directed_review_risks', []).append(risk)
                seen_risks.add(key)
            counts = self.group_counts(records)
            expected_counts = {'total_current_records': counts['total_current_records'],
                'primary_candidate_records': counts['primary_candidate'], 'background_suggestions': counts['background_suggestion'],
                'rejected_current_records': counts['delivery_rejected']}
            if any(self.output_binding.get(key) != expected for key, expected in expected_counts.items()):
                raise ValueError('frozen owner population differs from primary/background/rejected index')
            self.attach_page_scope_risks(records)
        job_map = {j['job_id']: j for j in jobs}
        for job in jobs:
            if not job['independent']:
                job['primary_assessment_validation'] = job_map[job['representative_job_id']].get('primary_assessment_validation')
        return plan, execution, audit, jobs, records

    @staticmethod
    def missing_source_fragments(issues, document, required=True):
        blocks = {b['block_id']: b for b in document['blocks']}
        found = {}
        def visit(value, enabled=False):
            if isinstance(value, list):
                for item in value:
                    visit(item, enabled)
            elif isinstance(value, dict):
                if enabled and all(k in value for k in ['block_id', 'text_version', 'start', 'end']):
                    b = blocks.get(value['block_id'])
                    if not b or value['text_version'] != document['text_version'] or not 0 <= value['start'] < value['end'] <= len(b['text']):
                        raise ValueError('missing-context diagnostic source binding mismatch')
                    span = {k: value[k] for k in ['block_id', 'text_version', 'start', 'end']}
                    span.update(exact_quote=b['text'][value['start']:value['end']], physical_page=b['page'])
                    found[(span['block_id'], span['start'], span['end'])] = span
                    return
                for key, item in value.items():
                    visit(item, enabled or key in ['missing_spans', 'missing_source_spans'])
        visit(issues)
        if required and not found:
            raise ValueError('rejected view must include explicit missing-source-span diagnostics')
        return list(found.values())

    @staticmethod
    def js_digests(values):
        command = "const{createHash}=require('node:crypto');let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(s).map(v=>createHash('sha256').update(JSON.stringify(v)).digest('hex')))));"
        return json.loads(subprocess.run([str(CODE / '.tools/node/bin/node'), '-e', command],
            input=json.dumps(values, ensure_ascii=False), text=True, capture_output=True, check=True).stdout)

    @staticmethod
    def verify_fingerprints(entry, record, catalog):
        text = {k: entry[k] for k in ['record_id', 'record_version', 'run_id', 'document_id', 'original_fragments', 'context_fragments', 'source_record_sha256']}
        for key in ['supporting_table_evidence', 'evidence_policy_version', 'source_evidence_unit_version']:
            if key in entry:
                text[key] = entry[key]
        value = {**text, 'text_fingerprint': entry['text_fingerprint'], 'figure_association': entry['figure_association'], 'review_status': entry['review_status']}
        if entry.get('primary_assessment'):
            value['primary_assessment'] = entry['primary_assessment']
        value['figure_content'] = [f for f in catalog['figures'] if f['figure_id'] in entry['figure_association']['proposed_figure_ids']]
        hashes = Builder.js_digests([record, text, value])
        if hashes != [entry['source_record_sha256'], entry['text_fingerprint'], entry['delivery_fingerprint']]:
            raise ValueError('record/text/delivery fingerprint mismatch')

    @staticmethod
    def figure_label(status):
        return {'paired': '已找到明确引用的配图，待人工核验', 'pending': '有待核图参考，尚未确认图文对应',
            'not_checked': '尚未核验配图', 'no_explicit_reference': '没有明确图引用；不表示论文无图，也不单独判为错误'}.get(status, status)

    @staticmethod
    def figure_title(figure):
        number = figure.get('figure_number')
        return 'Figure ' + str(number) if number is not None else '未确认图号的图像区域'

    @staticmethod
    def run_status(job):
        if not job['independent']:
            return '等价复用 ' + job['representative_job_id'] + '（结果与成本只算一次）'
        if job.get('started') is False or job.get('execution_status') == 'not_started':
            return '未启动'
        if job.get('error') or job.get('whole_live_delivery_passed') is False or \
                job.get('state') in ['failed', 'error'] or job.get('frozen_status') in ['failed', 'error']:
            return '失败；保留已保存结果与原诊断'
        if job.get('task_processing_complete') is not True:
            return '未完成；已保存部分结果' if job.get('result_available') else '已启动，未保存结果'
        return '本次范围处理完成；候选仍待核'

    def run_table(self, jobs):
        parts = ['<table class="run-table"><thead><tr><th>条件</th><th>运行情况</th><th>主待核 / 仅背景 / 拒绝</th><th>原始来源限制</th></tr></thead><tbody>']
        for job in jobs:
            values = [job.get('primary_candidate_count'), job.get('background_suggestion_count'), job.get('rejected_current_record_count')]
            counts = ' / '.join('—' if v is None else str(v) for v in values)
            limits = []
            if job.get('parser_status') == 'partial':
                limits.append('原解析保留 partial 标记')
            if job.get('image_text_unverified_pages'):
                limits.append(str(job['image_text_unverified_pages']) + ' 页图中文字未核验')
            if job.get('f_unselected_source_blocks'):
                limits.append('预筛未选入 ' + str(job['f_unselected_source_blocks']) + ' 个来源块')
            parts.append('<tr data-job-id="' + escape(job['job_id'], quote=True) + '"><td>' + escape(job['job_id']) +
                '</td><td>' + escape(self.run_status(job)) + '</td><td>' + escape(counts) + '</td><td>' + escape('；'.join(limits) or '见详细来源记录') + '</td></tr>')
        parts.append('</tbody></table><p class="hint">完成仅指本次所选输入范围的处理与汇总，未选来源不算已处理，也不表示整篇 PDF 的图中文字或医学质量已验收。原解析 partial 标记与本次任务是否完成分别保留。“—”表示没有已冻结计数。复用行不再加入总分母或费用。</p>')
        return ''.join(parts)

    @staticmethod
    def questions(role):
        background = role == 'background_suggestion'
        return [
            {'question_id': 'literal_and_context', 'review_intent': 'literal_source_and_context',
                'text': '原文是否与原页对应，且必要的主体、条件和上下文完整？',
                'hint': '检查原字、跨行/续段、否定、不确定性、数字和单位；不确定可选“无法判断”。'},
            {'question_id': 'target_visual_description',
                'review_intent': 'background_retention_suitability' if background else 'independent_target_suitability',
                'text': '单列为背景建议、不作独立特征结果，是否合理？' if background else '这条是否适合作为独立目标描述？',
                'hint': '背景是否确有必要、与目标是否相关尚未确认。若无需保留或更适合作为主目标，可选“有问题”并备注；不确定可直接选择。' if background else
                    '目标包括具体外观、外观定义或病灶直接尺寸。含具体外观的条件句保留完整条件与否定；纯诊断结论、纯正常解剖范围仅作必要背景。'},
            {'question_id': 'figure_correspondence', 'review_intent': 'figure_correspondence_and_completeness',
                'text': '配图或未配图说明是否合理，图文对应和整图是否完整？',
                'hint': '核对 Figure、面板、病例、成像方式和图注；无明确配图不自动判错，未能确认可选“无法判断”并备注。'}]

    @staticmethod
    def question_problem_types(question):
        if question['question_id'] == 'literal_and_context':
            return ['context_missing', 'source_text_error', 'other']
        if question['question_id'] == 'target_visual_description':
            if question.get('review_intent') == 'confirmed_scope_execution_deviation_visibility':
                return ['other']
            return ['background_unnecessary', 'background_should_be_main', 'other'] if question.get('review_intent') == \
                'background_retention_suitability' else ['not_target_visual', 'other']
        return ['figure_uncertain', 'figure_incomplete', 'wrong_figure', 'other']

    def case(self, source, number, sampling):
        paper, entry, record = source['paper'], source['entry'], source['record']
        role = self.review_group(source)
        risk_reasons = self.risk_reasons(source)
        sections = [{'type': 'fragments', 'title': '模型选出的原文（逐字保留）', 'layout': 'caption-lines', 'fragments': source['originals'],
            'note': '独立片段分框；保留原行、连字符和文内引文标记，不补写成新句。'},
            {'type': 'fragments', 'title': '模型保留的必要语境（单独显示）', 'layout': 'caption-lines', 'fragments': source['contexts'],
             'note': '未附语境' if not source['contexts'] else '这些文字是语境，不并入主原文。'}]
        if entry.get('primary_assessment'):
            assessment = entry['primary_assessment']
            sections.append({'type': 'text', 'title': '本条角色建议（不是人工批准）',
                'text': ('仅背景建议，未人工确认；不计为独立主目标。' if assessment['effective_role'] == 'background_suggestion' else
                    '主待核；视觉建议、混合或不确定均保留待核，不等于医学批准。')})
            model_codes = record['evidence_validation'].get('model_semantic_review', {}).get('issue_codes', [])
            model_reasons = [label for code, label in {'feature_association_list_only': '只列相关特征',
                'staging_criteria_feature_list': '分期标准中的特征列表'}.items() if code in model_codes]
            if model_reasons:
                sections.append({'type': 'text', 'title': '模型给出的分组理由（未批准）',
                    'text': '模型理由：' + '；'.join(model_reasons) + '。这只是模型意见，不是用户结论；请按完整原文自行核对。'})
            sections.append({'type': 'text', 'title': '角色建议的原始字段（可展开）', 'collapsed': True,
                'text': json.dumps(assessment, ensure_ascii=False, indent=2)})
        scope_deviation = next((r for r in source.get('directed_review_risks', []) if r.get('scope_execution_deviation')), None)
        if scope_deviation:
            sections.append({'type': 'text', 'title': '已确认范围的执行偏差', 'text': scope_deviation['reason']})
        pages = {f['physical_page'] for f in entry['original_fragments'] + entry['context_fragments']}
        if source.get('rejected_view'):
            sections.append({'type': 'text', 'title': '交付校验未通过：原始记录仍保留',
                'text': '这条记录未通过机械交付校验。原文与语境保持原版本，普通核验意见不能自动批准其导出。'})
            sections.append({'type': 'text', 'title': '原机械校验诊断（可展开）', 'collapsed': True,
                'text': json.dumps(source['rejected_view']['issues'], ensure_ascii=False, indent=2)})
            if source['diagnostic_missing_fragments']:
                sections.append({'type': 'fragments', 'title': '校验诊断的缺失原文对照（未加入本次候选语境）',
                    'layout': 'caption-lines', 'fragments': source['diagnostic_missing_fragments'],
                    'note': '仅展示审计实际指出的缺失定位，不补入候选、不替换原文。'})
            pages.update(f['physical_page'] for f in source['diagnostic_missing_fragments'])
        association = entry['figure_association']
        proposed = set(association['proposed_figure_ids']) | set(association['figure_ids'])
        sections.append({'type': 'text', 'title': '配图情况', 'text':
            ('程序给出以下图参考，图文对应和整图完整性均待核验。' if proposed else '本条没有明确匹配的 Figure；这不表示论文没有相关图。可在下方图目录或原 PDF 中核对并备注。') +
            '\n程序状态：' + self.figure_label(association['status']) + '\n' + '\n'.join(association['reasons'])})
        for figure in source['catalog']['figures']:
            linked = figure['figure_id'] in proposed
            captions = self.fragments(figure['caption_segments'], source['document'], set(source['job']['selection']['excluded_block_ids']))
            images = []
            for region in figure['regions']:
                images.append({'image': self.asset(region['path'], region['sha256']), 'title': self.figure_title(figure) + ' 原PDF图区域'})
                pages.add(region['physical_page'])
            pages.update(f['physical_page'] for f in figure['caption_segments'])
            sections.append({'type': 'fragments', 'title': self.figure_title(figure) + (' · 本条图注与图区域参考（未批准）' if linked else ' · 论文图目录参考（未配给本条）'),
                'layout': 'caption-lines', 'fragments': captions, 'images': images, 'collapsed': not linked,
                'note': '图注与原文单独保留。未从其他版本继承配图；是否医学图像、配对正确或包含全部面板仍需核验。'})
        for support in entry.get('supporting_table_evidence', []):
            sections.append({'type': 'fragments', 'title': '明确引用表格的支持值 · ' + support['table_id'], 'layout': 'caption-lines',
                'fragments': self.fragments(support['fragments'], source['document'], set(source['job']['selection']['excluded_block_ids'])),
                'note': '表格仅作为主原文明确引用的支持值，不作为独立视觉描述。'})
            pages.update(f['physical_page'] for f in support['fragments'])
        if not pages:
            raise ValueError('candidate has no source page')
        aliases = source['binding']['logical_job_ids']
        label = ' / '.join(aliases) + ('（相同输入共用一次结果）' if len(aliases) > 1 else '')
        case = {'case_id': 'C%02d-' % number + digest(source['binding'])[:12], 'kind': source['job']['condition'],
            'review_group': role, 'review_group_label': REVIEW_GROUPS[role],
            'source_id': paper['document_id'], 'source_label': paper['document_id'] + ' · ' + (source['document']['title'] or paper['document_id']),
            'title': REVIEW_GROUPS[role] + ' · ' + label + ' · 候选 ' + str(number), 'pdf': self.pdfs[paper['document_id']], 'pdf_sha256': paper['pdf_sha256'],
            'artifact_sha256': paper['ir_sha256'], 'source_binding': source['binding'], 'sampling': sampling,
            'directed_risk_reasons': risk_reasons,
            'bound_directed_review_risks': source.get('directed_review_risks', []),
            'initial_page': entry['original_fragments'][0]['physical_page'],
            'pages': [self.page(paper, p) for p in sorted(pages)],
            'explanation': '本轮真实模型输出的未审核候选。' + ('L01-F复用L01-B0同一代表运行，不重复作为独立样本；成本归同一代表运行。' if len(aliases) > 1 else '') +
                ({'fixed_seed_development_sample': ' 本条为固定种子开发抽样，不是正式验收样本。',
                  'directed_risk_not_random_sample': ' 本条为另列的定向风险补样，不能当作随机样本。'}.get(sampling, '')) +
                (' 定向核验关注：' + '；'.join(risk_reasons) + '。原文与语境仍按保存记录展示，未以模型汇总替换。' if risk_reasons else '') +
                (' 同一 ' + source['job']['job_id'] + ' 本轮整体交付失败；可导出/拒绝仅是离线校验分组，不能解释为原运行已交付成功。' if source.get('job_delivery_failed') else '') +
                (' 本组任务范围处理未完整完成，不能由少量候选推断无遗漏。' if source['task_processing_complete'] is not True else ''),
            'after_note': '当前结果版本 ' + str(entry['record_version']) + ' · 原文、语境和图注分框；所有医学/产品批准均未完成。',
            'after': {'sections': sections}, 'before': None,
            'questions': self.questions(role)}
        if scope_deviation:
            case['questions'][1].update(review_intent='confirmed_scope_execution_deviation_visibility',
                text='本轮偏离已确认范围的问题，是否显示清楚？',
                hint='这类纯结论应仅作背景，范围已确认。本轮仍列为独立描述是执行偏差；这里只核对展示，不重新决定范围，也不自动修改原记录。')
        case['case_version'] = digest(case)
        return case

    @staticmethod
    def candidate_anchor(source):
        return 'record-' + digest({'job_id': source['job']['job_id'], 'record_id': source['entry']['record_id'],
            'record_version': source['entry']['record_version']})[:16]

    def comparison_groups(self, records, cases):
        """Adapt explicit frozen audit references; never merge or reclassify."""
        if not self.terminal_audit:
            return []
        sources = {(r['job']['job_id'], r['entry']['record_id'], r['entry']['record_version']): r for r in records}
        selected = {(c['source_binding']['job_id'], c['source_binding']['record_id'], c['source_binding']['record_version']): c['case_id'] for c in cases}
        groups = []
        def add(kind, title, note, keys, require_context_equal=False):
            members = [sources.get(key) for key in keys]
            if any(r is None for r in members):
                raise ValueError('frozen source comparison references a non-current record')
            def spans(r, context=False):
                return [{k: f[k] for k in ['block_id', 'text_version', 'start', 'end', 'exact_quote', 'physical_page']}
                    for f in r['entry']['context_fragments' if context else 'original_fragments']]
            if len({(r['paper']['pdf_sha256'], r['paper']['ir_sha256'], r['paper']['text_version']) for r in members}) != 1 or \
                    any(spans(r) != spans(members[0]) for r in members[1:]) or \
                    require_context_equal and any(spans(r, True) != spans(members[0], True) for r in members[1:]):
                raise ValueError('frozen source comparison is not exact source-span equality')
            groups.append({'comparison_id': 'compare-' + str(len(groups) + 1), 'kind': kind, 'title': title, 'note': note,
                'members': [{'job_id': key[0], 'record_id': key[1], 'record_version': key[2],
                    'review_group': self.review_group(source), 'case_id': selected.get(key),
                    'all_candidate_anchor': self.candidate_anchor(source), 'source_binding': source['binding']}
                    for key, source in zip(keys, members)]})
        for row in self.terminal_audit.get('cross_method_exact_span_role_disagreements', []):
            keys = [(row['left_job'], row['left_record_id'], row['left_version']),
                (row['right_job'], row['right_record_id'], row['right_version'])]
            for prefix, key in zip(['left', 'right'], keys):
                if key not in sources or self.review_group(sources[key]) != row[prefix + '_role']:
                    raise ValueError('frozen cross-method comparison role mismatch')
            add('cross_method_role_disagreement', row['document_id'] + ' · 同一原文的分组不同',
                '相同原文在两种方法下被分到不同组，请分别核对。这里只显示本次各一次运行的差异，不能推断是预筛造成，也不能据此判哪种方法更准。', keys)
        duplicate = self.terminal_audit.get('L07_F_same_source_condition_sentence')
        if duplicate:
            keys = [('L07-F', rid, version) for rid, version in zip(duplicate['records'], duplicate['versions'])]
            add('possible_same_source_duplicate', 'L07-F · 同源条件句的两条记录',
                '两条记录使用相同原文、空语境和同一待核 Fig.2。模型将来源分别标为“引用研究”和“本文作者”；可能重复或来源归属有误。两条均保留，请分别核验，尚未合并。', keys, True)
        return groups

    def write_comparisons(self, records, pack):
        sources = {(r['job']['job_id'], r['entry']['record_id'], r['entry']['record_version']): r for r in records}
        parts = ['<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
            '<title>同源分组差异与可能重复 · 待核</title><link rel="stylesheet" href="review.css"><link rel="icon" href="data:,">',
            '<header class="page-header"><h1>同源分组差异与可能重复（待核）</h1>',
            '<p>完整记录仍为 ' + str(pack['total_current_candidates']) + ' 条，包含主待核与背景建议。这里并排展示冻结审计明确指出的同源记录，每条保留自己的分组、版本和意见入口。</p>',
            '<p>原文逐字展示，未替换为模型汇总。分组均未人工批准，不预填审核意见；同源记录数不等于独立外观数或医学有效描述数。</p>',
            '<p><a href="index.html">返回三选核验页</a> · <a href="all-candidates.html">查看全部记录</a></p></header>',
            '<main class="risk-comparison-main">']
        for group in pack['risk_comparisons']['groups']:
            parts.append('<section class="risk-comparison" data-comparison-id="' + group['comparison_id'] + '"><h2>' + escape(group['title']) +
                '</h2><p class="explanation">' + escape(group['note']) + '</p><div class="risk-grid">')
            for member in group['members']:
                source = sources[(member['job_id'], member['record_id'], member['record_version'])]
                role = REVIEW_GROUPS[member['review_group']]
                parts.append('<article class="risk-member" data-job-id="' + escape(member['job_id'], quote=True) + '" data-record-id="' +
                    escape(member['record_id'], quote=True) + '" data-record-version="' + str(member['record_version']) + '"><h3>' +
                    escape(member['job_id'] + ' · ' + role + ' · 版本 ' + str(member['record_version'])) + '</h3>')
                if member['case_id']:
                    parts.append('<p><a href="index.html#' + member['case_id'] + '">为这一条填写三选与备注</a></p>')
                else:
                    parts.append('<p>未纳入本页简单核验；<a href="all-candidates.html#' + member['all_candidate_anchor'] + '">查看完整原记录与版本</a></p>')
                origin = source['record']['context'].get('source_attribution', {}).get('origin')
                label = {'cited_research': '引用研究', 'study_authors': '本文作者', 'unclear': '未明确'}.get(origin, '尚未核实')
                parts.append('<p>模型标记来源：' + label + '（模型意见，仍待核）</p>')
                for title, fragments, css in [('模型选出的逐字原文', source['originals'], 'comparison-original'),
                        ('保存的语境（单独显示）', source['contexts'], 'comparison-context')]:
                    parts.append('<section class="' + css + '"><h4>' + title + '</h4>')
                    if not fragments:
                        parts.append('<p>未附语境</p>')
                    for f in fragments:
                        parts.append('<p class="fragment-label"><a target="_blank" rel="noopener" href="' + self.pdfs[source['paper']['document_id']] +
                            '#page=' + str(f['physical_page']) + '">原 PDF 第 ' + str(f['physical_page']) + ' 页</a></p><pre class="original-text">' + escape(f['text']) + '</pre>')
                    parts.append('</section>')
                parts.append('<p>配图：' + escape(self.figure_label(source['entry']['figure_association']['status'])) + '</p>')
                parts.append('<details><summary>原记录 ID 与来源绑定</summary><pre class="original-text">' +
                    escape(json.dumps(source['binding'], ensure_ascii=False, indent=2)) + '</pre></details></article>')
            parts.append('</div></section>')
        if not pack['risk_comparisons']['groups']:
            parts.append('<p>本轮没有冻结审计明确列出的同源对照。</p>')
        parts.append('</main></html>')
        (self.output / 'risk-comparisons.html').write_text('\n'.join(parts) + '\n')

    def all_candidates(self, records, cases, pack):
        """One read-only current-output index, with explicit sample membership."""
        chosen = {(c['source_binding']['job_id'], c['source_binding']['record_id']): c for c in cases}
        parts = ['<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
            '<title>本轮全部未审核候选</title><link rel="stylesheet" href="review.css"><link rel="icon" href="data:,">',
            '<header class="page-header"><h1>本轮全部未审核候选</h1><p>共 ' + str(len(records)) + ' 条当前代表运行候选；其中 ' + str(len(cases)) +
            ' 条纳入本次简单核验，其余尚未纳入。这里展示完整未审核输出，不表示全部已核验或医学/产品批准。</p>',
            '<p>总分母包含主待核 ' + str(pack['group_counts']['primary_candidate']) + ' 条、仅背景建议 ' +
            str(pack['group_counts']['background_suggestion']) + ' 条、交付拒绝原始记录 ' + str(pack['group_counts']['delivery_rejected']) +
            ' 条。分组是待核建议，不表示错误减少、医学准确率或业务批准。</p>',
            '<p>L01-F 与 L01-B0 共用同一代表结果和成本，仅列一份。条件解释、仅背景及配图待核候选均如实保留。</p>',
            '<nav aria-label="全部记录分组">' + ' · '.join('<a href="#group-' + key + '">' + escape(label) +
                '（' + str(pack['group_counts'][key]) + '）</a>' for key, label in REVIEW_GROUPS.items()) + '</nav>',
            '<p><a href="index.html">打开本次三选与备注核验页</a> · <a href="../comparison/automatic-audit/comparison.json">查看冻结的自动审计（JSON）</a></p>',
            '<p><a href="risk-comparisons.html">并排查看同源分组差异与可能重复（待核）</a></p>',
            '<p>资料指纹：<code>' + pack['pack_sha256'] + '</code></p></header><main style="max-width:1400px;margin:24px auto;padding:0 20px">',
            '<h2>本轮运行情况</h2>' + self.run_table(pack['logical_jobs'])]
        for job_id in sorted({r['job']['job_id'] for r in records if r.get('job_delivery_failed')}):
            group = [r for r in records if r['job']['job_id'] == job_id]
            refused = sum(bool(r.get('rejected_view')) for r in group)
            parts.append('<p class="explanation">' + escape(job_id) + ' 本轮整体交付失败。' + str(len(group) - refused) +
                ' 条可导出 / ' + str(refused) + ' 条拒绝仅是离线校验分组，不表示原运行交付成功；拒绝记录以原始待核视图保留，普通意见不能自动批准其导出。</p>')
        membership = []
        ordered = sorted(records, key=lambda r: list(REVIEW_GROUPS).index(self.review_group(r)))
        previous_group = None
        for n, source in enumerate(ordered, 1):
            entry = source['entry']
            role = self.review_group(source)
            if role != previous_group:
                parts.append('<h2 id="group-' + role + '">' + REVIEW_GROUPS[role] + ' · ' + str(pack['group_counts'][role]) + ' 条</h2>')
                previous_group = role
            key = (source['job']['job_id'], entry['record_id'])
            case = chosen.get(key)
            label = {'all_current_candidates': '纳入本次核验（当前候选全列）', 'fixed_seed_development_sample': '纳入基础样本',
                'directed_risk_not_random_sample': '纳入定向风险补样'}.get(case['sampling'], '') if case else '未纳入此次简单核验'
            membership.append({'job_id': key[0], 'record_id': key[1], 'record_version': entry['record_version'],
                'delivery_fingerprint': entry['delivery_fingerprint'], 'included_in_simple_review': bool(case),
                'artifact_kind': source['binding'].get('artifact_kind'),
                'review_group': role, 'primary_assessment': entry.get('primary_assessment'), 'source_binding': source['binding'],
                'bound_directed_review_risks': source.get('directed_review_risks', []),
                'raw_view_fingerprint': source['binding'].get('raw_view_fingerprint'),
                'selection': case['sampling'] if case else 'not_in_simple_review', 'directed_risk_reasons': self.risk_reasons(source)})
            parts.append('<details id="' + self.candidate_anchor(source) + '" class="opinion-card" data-review-group="' + role + '" data-job-id="' + escape(key[0], quote=True) +
                '" data-record-id="' + escape(entry['record_id'], quote=True) + '"><summary>' +
                escape(str(n) + ' · ' + key[0] + ' · v' + str(entry['record_version']) + ' · ' + label +
                    ' · ' + REVIEW_GROUPS[role]) + '</summary>')
            if entry.get('primary_assessment'):
                parts.append('<p class="hint">' + ('仅背景建议，未人工确认；不计为独立主目标。' if
                    entry['primary_assessment']['effective_role'] == 'background_suggestion' else '主待核。') +
                    '</p><details><summary>查看角色建议原始字段</summary><pre>' + escape(json.dumps(entry['primary_assessment'], ensure_ascii=False)) + '</pre></details>')
            if source.get('directed_review_risks'):
                parts.append('<p class="explanation">' + escape('；'.join(self.directed_risk_label(r) for r in source['directed_review_risks'])) + '</p>')
            if case:
                parts.append('<p><a href="index.html#' + case['case_id'] + '">对此条填写三选与备注</a></p>')
            else:
                parts.append('<p class="hint">本条未进入此次简单核验样本；未作有效描述或医学错误结论。</p>')
            for title, fragments in [('模型选出的逐字原文', source['originals']), ('保存的必要语境（单独显示）', source['contexts'])]:
                parts.append('<section class="parsed-section"><h3>' + title + '</h3>')
                if not fragments:
                    parts.append('<p>未附语境</p>')
                for i, f in enumerate(fragments, 1):
                    parts.append('<p class="fragment-label">片段 ' + str(i) + ' · <a target="_blank" rel="noopener" href="' +
                        self.pdfs[source['paper']['document_id']] + '#page=' + str(f['physical_page']) + '">原 PDF 第' + str(f['physical_page']) +
                        '页</a></p><pre class="original-text">' + escape(f['text']) + '</pre>')
                parts.append('</section>')
            if source.get('rejected_view'):
                parts.append('<section class="parsed-section"><h3>交付校验未通过</h3><p>保留原记录与原机械诊断；普通意见不能自动批准导出。仅在诊断实际给出缺失定位时列出对照，不补入候选。</p>' +
                    '<details><summary>查看原机械诊断</summary><pre class="original-text">' +
                    escape(json.dumps(source['rejected_view']['issues'], ensure_ascii=False, indent=2)) + '</pre></details>')
                for f in source['diagnostic_missing_fragments']:
                    parts.append('<p class="fragment-label">原PDF第' + str(f['physical_page']) + '页 · ' + escape(f['label']) +
                        '</p><pre class="original-text">' + escape(f['text']) + '</pre>')
                parts.append('</section>')
            assoc = entry['figure_association']
            parts.append('<p>配图状态（未批准）：' + escape(self.figure_label(assoc['status'])) + '；' + escape('；'.join(assoc['reasons'])) + '</p>')
            proposed = set(assoc['proposed_figure_ids']) | set(assoc['figure_ids'])
            if not proposed:
                parts.append('<p>本条未明确匹配 Figure；可按上方原 PDF 页链接核对，未配图不表示无相关图。</p>')
            for f in source['catalog']['figures']:
                if f['figure_id'] not in proposed:
                    continue
                parts.append('<section class="parsed-section"><h3>' + escape(self.figure_title(f)) + ' · 图注与图区域参考（未批准）</h3>')
                for caption in f['caption_segments']:
                    parts.append('<pre class="original-text">' + escape(caption['exact_quote']) + '</pre>')
                for region in f['regions']:
                    image = self.asset(region['path'], region['sha256'])
                    parts.append('<a href="' + image + '" target="_blank" rel="noopener"><img loading="lazy" style="max-width:100%;height:auto" src="' + image + '" alt="原PDF图区域，点击查看完整图片"></a>')
                parts.append('</section>')
            parts.append('<details class="source-details"><summary>版本绑定与待核标记</summary><pre class="original-text">' +
                escape(json.dumps({'source_binding': source['binding'], 'directed_risk_reasons': self.risk_reasons(source)}, ensure_ascii=False, indent=2)) + '</pre></details></details>')
        for role, label in REVIEW_GROUPS.items():
            if not pack['group_counts'][role]:
                parts.append('<h2 id="group-' + role + '">' + label + ' · 0 条</h2><p>本轮没有该组已冻结的记录。</p>')
        parts.append('</main></html>')
        (self.output / 'all-candidates.html').write_text('\n'.join(parts) + '\n')
        return membership

    def build(self):
        if self.output.exists():
            raise ValueError('output-review already exists; preserve existing opinions and create no overwrite')
        # Validate the final reporting state before creating output assets.
        execution = self.read(self.comparison / 'execution/report.json')
        if execution['status'] == 'running' or not (self.audit / 'comparison.json').is_file():
            raise ValueError('wait for finalized execution and automatic-audit')
        protected = self.protected_reviews()
        self.output.mkdir(mode=0o700)
        (self.output / 'assets').mkdir()
        try:
            plan, execution, audit, jobs, records = self.records()
            full_entry = self.audit / 'comparison.json'
            self.sources[str(full_entry.relative_to(CODE))] = sha256(full_entry.read_bytes()).hexdigest()
            total = len(records)
            selected = self.select_records(records)
            all_current = all(method == 'all_current_candidates' for _, method in selected)
            counts = self.group_counts(records)
            if any(r.get('rejected_view') and not any(r is chosen for chosen, _ in selected) for r in records):
                raise ValueError('every delivery-rejected view must be included in directed review, without duplication')
            if any(r.get('directed_review_risks') and not any(r is chosen for chosen, _ in selected) for r in records):
                raise ValueError('every frozen directed risk must be included without changing the base sample')
            selection_by_run = [{'job_id': j['job_id'], 'result_available': j['result_available'],
                'current_candidate_population': sum(r['job']['job_id'] == j['job_id'] for r in records),
                'population_by_group': self.group_counts([r for r in records if r['job']['job_id'] == j['job_id']]),
                'sample_by_group': self.group_counts([r for r, _ in selected if r['job']['job_id'] == j['job_id']]),
                'sample_cases': sum(r['job']['job_id'] == j['job_id'] for r, _ in selected),
                'base_sample_cases': sum(r['job']['job_id'] == j['job_id'] and method != 'directed_risk_not_random_sample' for r, method in selected),
                'directed_risk_cases': sum(r['job']['job_id'] == j['job_id'] and method == 'directed_risk_not_random_sample' for r, method in selected),
                'risk_marked_cases_already_in_base': sum(r['job']['job_id'] == j['job_id'] and method != 'directed_risk_not_random_sample' and bool(self.risk_reasons(r)) for r, method in selected),
                'record_versions': [{'record_id': r['entry']['record_id'], 'record_version': r['entry']['record_version'],
                    'review_group': self.review_group(r),
                    'bound_directed_review_risks': r.get('directed_review_risks', []),
                    'delivery_fingerprint': r['entry']['delivery_fingerprint'], 'selection': method, 'directed_risk_reasons': self.risk_reasons(r)}
                    for r, method in selected if r['job']['job_id'] == j['job_id']]} for j in jobs if j['independent']]
            pack = {'schema_version': SCHEMA, 'questionnaire_version': QUESTIONNAIRE, 'review_scope': SCOPE,
                'pack_id': 'current-output-2026-11-08-' + self.expected_plan[:12], 'plan_sha256': self.expected_plan,
                'execution_report_sha256': self.sources[str((self.comparison / 'execution/report.json').relative_to(CODE))],
                'batch_id': plan['batch_id'], 'model': {'id': plan['config']['model']['model_id'], 'reasoning': plan['config']['model']['reasoning_effort']},
                'execution_status': execution['status'], 'logical_jobs': jobs, 'planned_independent_inputs': 5,
                'actual_independent_runs_with_model_requests': sum(j['independent'] and (j['method_requests'] or 0) > 0 for j in jobs),
                'independent_result_files': sum(j['independent'] and j['result_available'] for j in jobs), 'total_current_candidates': total,
                'group_counts': counts, 'sample_group_counts': self.group_counts([r for r, _ in selected]),
                'population_rule': 'All current versions in primary + background + explicitly rejected raw views; actual representative runs counted once. No role change is a measured error reduction.',
                'output_binding_sha256': self.sources.get(str((self.comparison / 'output-binding.json').relative_to(CODE))),
                'question_semantics_rule': 'Question 2 has distinct main-target and background-retention semantics, bound in each case/opinion. Never pool them into medical accuracy.',
                'bound_directed_review_risks': self.output_binding.get('directed_review_risks', []) if self.output_binding else [],
                'page_additional_directed_review_risks': self.page_additional_directed_review_risks,
                'mechanically_exportable_unreviewed_candidates': sum(not bool(r.get('rejected_view')) for r in records),
                'delivery_rejected_original_views': sum(bool(r.get('rejected_view')) for r in records),
                'selection_by_actual_run': selection_by_run,
                'all_unreviewed_outputs': {'href': 'all-candidates.html',
                    'source_audit_href': '../comparison/automatic-audit/comparison.json', 'source_sha256': self.sources[str(full_entry.relative_to(CODE))], 'candidate_count': total,
                    'included_in_simple_review': len(selected), 'not_in_simple_review': total - len(selected),
                    'scope': 'all_current_unreviewed_outputs_not_a_sample_or_medical_approval'},
                'sampling': 'all_current_candidates' if all_current else 'six_fixed_seed_per_actual_run_plus_disclosed_directed_risks',
                'sampling_seed': self.expected_plan, 'formal_sample_threshold': None, 'actual_human_reviews': 0,
                'sampling_algorithm': {'mode': 'all_current_candidates' if all_current else 'versioned_fixed_seed_then_directed_risk',
                    'rank': 'ascending SHA256 of UTF8 canonical sorted-key JSON(seed,job,record,record_version,version_fingerprint); version_fingerprint is delivery_fingerprint or explicit rejected raw_view_fingerprint, never a fabricated legal-delivery hash',
                    'seed': self.expected_plan, 'base_per_actual_run_limit': 6, 'usual_additional_directed_risks': 2,
                    'directed_risk': 'All frozen explicit risk identities, rejected views and missing primary/background strata are mandatory directed cases; may exceed the usual two. Remaining directed slots prioritize interpretation/context/Figure risks. Base ranking unchanged. Background stays in population; no_explicit_reference alone is not an error.',
                    'formal_quality_threshold': None},
                'human_approved': False, 'medical_quality_approved': False, 'product_export_approved': False,
                'cases': [self.case(r, n, method) for n, (r, method) in enumerate(selected, 1)]}
            pack['risk_comparisons'] = {'href': 'risk-comparisons.html', 'groups': self.comparison_groups(records, pack['cases'])}
            pack['risk_comparisons']['group_count'] = len(pack['risk_comparisons']['groups'])
            pack['pack_sha256'] = digest(pack)
            (self.output / 'data.json').write_text(json.dumps(pack, ensure_ascii=False, indent=2) + '\n')
            self.write_ui(jobs)
            membership = self.all_candidates(records, pack['cases'], pack)
            self.write_comparisons(records, pack)
            for path, expected in self.sources.items():
                if sha256(inside(path).read_bytes()).hexdigest() != expected:
                    raise ValueError('source changed during build; do not mix versions: ' + path)
            after_protected = self.protected_reviews()
            if protected != after_protected:
                raise ValueError('existing review files changed during this isolated build')
            files = {str(p.relative_to(self.output)): sha256(p.read_bytes()).hexdigest() for p in self.output.rglob('*') if p.is_file()}
            manifest = {'schema_version': 'current-output-review-manifest-1', 'pack_id': pack['pack_id'], 'pack_sha256': pack['pack_sha256'],
                'plan_sha256': self.expected_plan, 'cases': len(pack['cases']), 'questions': sum(len(c['questions']) for c in pack['cases']),
                'total_current_candidates': total, 'logical_jobs': 6, 'planned_independent_inputs': 5,
                'group_counts': counts, 'sample_group_counts': pack['sample_group_counts'],
                'output_binding_sha256': pack['output_binding_sha256'], 'question_semantics_rule': pack['question_semantics_rule'],
                'bound_directed_review_risks': pack['bound_directed_review_risks'], 'risk_comparisons': pack['risk_comparisons'],
                'page_additional_directed_review_risks': pack['page_additional_directed_review_risks'],
                'mechanically_exportable_unreviewed_candidates': pack['mechanically_exportable_unreviewed_candidates'],
                'delivery_rejected_original_views': pack['delivery_rejected_original_views'],
                'actual_independent_runs_with_model_requests': pack['actual_independent_runs_with_model_requests'],
                'independent_result_files': pack['independent_result_files'], 'execution_status': execution['status'], 'deduplicated_L01_reuse': True,
                'sampling_algorithm': pack['sampling_algorithm'],
                'selection_by_actual_run': selection_by_run, 'all_unreviewed_outputs': pack['all_unreviewed_outputs'],
                'all_candidate_membership': membership,
                'source_files': self.sources, 'files': files, 'source_PDFs_and_existing_reviews_unchanged': True,
                'protected_old_review_directories': {name: {'file_count': len(values), 'before_inventory_sha256': digest(values),
                    'after_inventory_sha256': digest(after_protected[name]), 'all_paths_and_bytes_unchanged': True} for name, values in protected.items()},
                'source_span_and_available_fingerprints_checked': True, 'rejected_views_have_no_legal_delivery_fingerprint': True,
                'model_or_API_calls_by_builder': 0,
                'actual_human_reviews': 0, 'medical_quality_approved': False, 'product_export_approved': False,
                'entry': 'index.html', 'review_scope': SCOPE, 'created_by': 'scripts/build-current-output-review.py'}
            manifest['generator_sha256'] = sha256(Path(__file__).read_bytes()).hexdigest()
            (self.output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
            print(json.dumps({'output': str(self.output.relative_to(CODE)), 'pack_sha256': pack['pack_sha256'],
                'manifest_sha256': sha256((self.output / 'manifest.json').read_bytes()).hexdigest(),
                'cases': len(pack['cases']), 'questions': manifest['questions'], 'original_pages': len(self.pages), 'API_calls': 0}, ensure_ascii=False))
        except Exception:
            # Only files created in this invocation exist here; never remove user opinions.
            shutil.rmtree(self.output)
            raise

    def write_ui(self, jobs=None):
        for name in ['index.html', 'review.css', 'review.js']:
            self.sources[str((TEMPLATE / name).relative_to(CODE))] = sha256((TEMPLATE / name).read_bytes()).hexdigest()
        html = (TEMPLATE / 'index.html').read_text()
        html = html.replace('PDF解析与图文定位核验', '本轮模型输出核验')
        html = html.replace('原页对照 · 本次核验', '原页对照 · 本轮真实输出')
        html = html.replace('选案例 → 对照原页、文字/表格/整图 → 对每个具体核验点给出意见。图片可点击放大。', '选择候选 → 对照原文、语境、图注及原页 → 三选并填写备注。图片可点击放大。')
        html = html.replace('本页展示 PDF 解析与定位结果，不是新一轮 LLM 抽取结果。“看起来正确”仅记录非医学初筛，不等于医学或产品证据批准。',
            '本页展示本轮真实模型抽取的未审核候选。六个逻辑条件计划五个独立输入；实际运行与未完成情况见下方。L01 的 B0/F 共用同一代表结果与成本，不重复作为独立样本。三选仅记录普通初筛，不等于医学或产品批准。')
        html = html.replace('<option value="all">全部类型</option>\n        <option value="figure">整图与图注</option>\n        <option value="table">表格</option>\n        <option value="continuation">跨页 / 跨栏续文</option>',
            '<option value="all">全部候选</option><option value="B0">单独智能体 B0（含 L01 等价复用）</option><option value="F">正向预筛 F 的独立结果</option>')
        html = html.replace('</select>\n      <nav id="case-list"', '</select><label for="role-filter">候选分组</label><select id="role-filter">' +
            '<option value="all">全部分组（含背景与拒绝）</option>' + ''.join('<option value="' + key + '">' + label + '</option>'
                for key, label in REVIEW_GROUPS.items()) + '</select>\n      <nav id="case-list"')
        html = html.replace('<nav id="case-list" aria-label="核验案例"></nav>', '<nav id="case-list" aria-label="核验案例"></nav>' +
            '<p id="no-filter-match" class="hint" hidden>本页样本没有匹配条目；可查看全部未审核输出中的完整分组。</p>')
        html = html.replace('解析结果对照', '本轮候选与图参考').replace('切换修前修后', '当前结果').replace('>修后</button>', '>当前结果</button>').replace('>修前</button>', '>无旧版混入</button>')
        html = html.replace('先确认原页位置，再检查右侧是否遗漏、错序或裁边。', '原 PDF 保留全文。页图为原页完整渲染，可点击放大；图目录参考不代表自动配图。')
        html = html.replace('只需判断能否与原页对应。不确定的地方可选“无法判断”，并写明位置。', '按原文相关性、语境和配图分别记录普通意见；不确定可选“无法判断”。本轮候选少则全列，抽样不设置正式质量门槛。')
        html = html.replace('<p id="message"', '<p id="pack-summary" class="hint"></p><p id="group-summary" class="scope"></p><p><a id="all-outputs" href="all-candidates.html" target="_blank" rel="noopener">查看本轮全部未审核输出及未入样条目 ↗</a> · <a id="risk-comparisons" href="risk-comparisons.html" target="_blank" rel="noopener">并排看同源分组差异与可能重复（待核） ↗</a></p>' +
            '<section id="run-summary" aria-label="本轮运行情况"><h2>本轮运行情况</h2>' + self.run_table(jobs or []) +
            '</section><details class="storage-help"><summary>查看运行与覆盖的详细记录</summary><pre id="run-status" class="original-text"></pre></details><p id="message"')
        (self.output / 'index.html').write_text(html)
        (self.output / 'review.css').write_text((TEMPLATE / 'review.css').read_text() + '\n#view-before{display:none}.parsed-section>summary{cursor:pointer;font-weight:600}.parsed-section .image-button{margin:12px 0}.original-text{overflow-wrap:anywhere}#pack-summary,#group-summary{max-width:1100px}.run-table{border-collapse:collapse;width:100%;max-width:1100px;font-size:.9rem}.run-table th,.run-table td{border:1px solid #d8dee7;padding:8px;text-align:left;overflow-wrap:anywhere}.case-sidebar>label{display:block;margin-top:12px}#role-filter{width:100%}.risk-comparison-main{max-width:1400px;margin:24px auto;padding:0 20px}.risk-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.risk-member{min-width:0;padding:16px;border:1px solid #d8dee7;border-radius:8px;background:white}.risk-comparison{margin-bottom:40px}.risk-member .original-text{white-space:pre-wrap}@media(max-width:800px){.risk-grid{grid-template-columns:1fr}}\n')
        js = (TEMPLATE / 'review.js').read_text()
        def replace(old, new, count=1):
            nonlocal js
            if js.count(old) != count:
                raise ValueError('review UI template changed: ' + old[:60])
            js = js.replace(old, new)
        replace("const issues = [['missing', '遗漏'], ['order', '顺序'], ['row_column', '错行列'], ['incomplete_figure', '图不完整'], ['wrong_figure', '配错图'], ['other', '其他']];",
            "const issues = [['context_missing', '语境遗漏'], ['source_text_error', '原文或顺序有误'], ['not_target_visual', '不像目标描述'], ['background_unnecessary', '背景可能无需保留'], ['background_should_be_main', '更像独立目标描述'], ['figure_uncertain', '图文对应无法确认'], ['figure_incomplete', '图不完整或缺图'], ['wrong_figure', '配错图'], ['other', '其他']];")
        replace("  const keyOf =", "  const issueAllowed = (q, code) => q.question_id === 'literal_and_context' ? ['context_missing', 'source_text_error', 'other'].includes(code) : q.question_id === 'target_visual_description' ? (q.review_intent === 'confirmed_scope_execution_deviation_visibility' ? ['other'] : q.review_intent === 'background_retention_suitability' ? ['background_unnecessary', 'background_should_be_main', 'other'] : ['not_target_visual', 'other']).includes(code) : ['figure_uncertain', 'figure_incomplete', 'wrong_figure', 'other'].includes(code);\n  const keyOf =")
        replace("for (const [value, label] of issues)", "for (const [value, label] of issues.filter(([code]) => issueAllowed(q, code)))")
        replace("opinion.problem_types.some(v => !issues.some(i => i[0] === v))", "opinion.problem_types.some(v => !issueAllowed(q, v))")
        js = js.replace('pdf-input-review-opinions-1', 'current-output-review-opinions-1').replace('pdf_layout_nonmedical_screening', SCOPE)
        js = js.replace('pdf-input-review-pack-1', SCHEMA).replace('t1-pdf-input-review:', 't1-current-output-review:')
        replace("exported_at: new Date().toISOString(), review_scope:", "questionnaire_version: pack.questionnaire_version, plan_sha256: pack.plan_sha256, execution_report_sha256: pack.execution_report_sha256, exported_at: new Date().toISOString(), review_scope:")
        replace("if (value.review_scope !==", "if (value.questionnaire_version !== pack.questionnaire_version || value.plan_sha256 !== pack.plan_sha256 || value.execution_report_sha256 !== pack.execution_report_sha256) throw new Error('运行或问卷版本不一致，未导入。');\n    if (value.review_scope !==")
        replace("opinion.case_version !== c.case_version)", "opinion.case_version !== c.case_version || stable(opinion.source_binding) !== stable(c.source_binding) || opinion.review_group !== c.review_group || opinion.question_text !== q.text || opinion.question_semantics !== q.review_intent)")
        replace("artifact_sha256: c.artifact_sha256, case_version: c.case_version,", "artifact_sha256: c.artifact_sha256, case_version: c.case_version, source_binding: c.source_binding, review_group: c.review_group, question_text: q.text, question_semantics: q.review_intent,", 2)
        replace("function visibleCases() { return pack.cases.filter(c => $('kind-filter').value === 'all' || c.kind === $('kind-filter').value); }",
            "function visibleCases() { return pack.cases.filter(c => ($('kind-filter').value === 'all' || c.kind === $('kind-filter').value) && ($('role-filter').value === 'all' || c.review_group === $('role-filter').value)); }")
        replace("$('kind-filter').addEventListener('change'", "for (const filterId of ['kind-filter', 'role-filter']) $(filterId).addEventListener('change'")
        replace("const visible = visibleCases(); if (visible.length", "const visible = visibleCases(); $('workspace').querySelector('main').hidden = !visible.length; $('no-filter-match').hidden = Boolean(visible.length); if (visible.length")
        replace("const node = element('section', 'parsed-section'); if (section.title) node.append(element('h4', '', section.title));",
            "const node = element(section.collapsed ? 'details' : 'section', 'parsed-section'); if (section.title) node.append(element(section.collapsed ? 'summary' : 'h4', '', displayTitle(section.title)));")
        replace("function imageBlock(path, title) {", "function imageBlock(path, title) {\n    title = displayTitle(title);")
        replace("$('case-explanation').textContent = c.explanation;", "$('case-explanation').textContent = (c.explanation || '').replace(/\\bneeds_context\\b/g, '语境待核');")
        replace("if (section.note) node.append", "for (const im of section.images || []) node.append(imageBlock(im.image, im.title));\n      if (section.note) node.append")
        replace("({ figure: '整图与图注', table: '表格', continuation: '跨页 / 跨栏续文' })[c.kind]", "({ B0: '单独智能体 B0', F: '正向预筛 F' })[c.kind] + ' · ' + c.review_group_label")
        replace("'当前解析资料指纹：' + c.artifact_sha256]", "'当前IR指纹：' + c.artifact_sha256, '代表运行：' + c.source_binding.run_id, '逻辑条件：' + c.source_binding.logical_job_ids.join(' / '), '候选ID/版本：' + c.source_binding.record_id + ' / ' + c.source_binding.record_version, '结果文件指纹：' + c.source_binding.result_sha256, '交付指纹：' + c.source_binding.delivery_fingerprint]")
        replace("'交付指纹：' + c.source_binding.delivery_fingerprint", "c.source_binding.delivery_fingerprint ? '候选交付指纹：' + c.source_binding.delivery_fingerprint : '无合法交付指纹（校验拒绝）；原始待核视图指纹：' + c.source_binding.raw_view_fingerprint")
        replace("setPage(c.pages[0].physical_page);", "setPage(c.initial_page);")
        replace("selectCase(pack.cases[0].case_id); updateProgress();", "const requested = decodeURIComponent(location.hash.slice(1));\n      selectCase(pack.cases.some(c => c.case_id === requested) ? requested : pack.cases[0].case_id); updateProgress();")
        replace(" || !pack.cases.length", "")
        replace("$('workspace').hidden = false;", "if (!pack.cases.length) { $('progress').textContent = '本轮没有已冻结的可核验记录'; message('请查看本轮运行情况：没有记录不表示已完整处理或没有目标描述。'); return; }\n      $('workspace').hidden = false;")
        replace("pack = await response.json();", "pack = await response.json();\n      const { pack_sha256, ...bound } = pack;\n      const computed = await digestText(stable(bound));\n      if (computed !== pack_sha256) throw new Error('资料指纹校验失败，未加载或套用任何意见。');")
        replace("storageKey = 't1-current-output-review:'", "$('pack-summary').textContent = '本轮 ' + pack.total_current_candidates + ' 条当前记录，本页列出 ' + pack.cases.length + ' 条；' + (pack.sampling === 'all_current_candidates' ? '当前记录全列。' : '每实际运行固定种子最多6条，另列定向风险和分组补样；非正式验收样本。') + ' 实际发起 ' + pack.actual_independent_runs_with_model_requests + ' 个独立输入运行，不表示全部完成；L01-F 与 L01-B0 共用结果和成本。';\n      const groups = pack.group_counts, sample = pack.sample_group_counts;\n      $('group-summary').textContent = '总分母 ' + groups.total_current_records + ' = 主待核 ' + groups.primary_candidate + ' + 仅背景建议 ' + groups.background_suggestion + ' + 交付拒绝 ' + groups.delivery_rejected + '。本页分别纳入 ' + sample.primary_candidate + ' / ' + sample.background_suggestion + ' / ' + sample.delivery_rejected + ' 条；完整记录均可查看。背景只是未批准建议，不证明必须保留；分组变化不表示错误减少或医学准确率提高。';\n      $('run-status').textContent = JSON.stringify({execution_status: pack.execution_status, logical_jobs: pack.logical_jobs, selection_by_actual_run: pack.selection_by_actual_run}, null, 2);\n      storageKey = 't1-current-output-review:'")
        replace("const $ = id => document.getElementById(id);", "const $ = id => document.getElementById(id);\n  const displayTitle = title => /^Figure (None|null)\\b/.test(title || '') ? '未确认图号的图像区域（原页参考，未配给本条）' : title;\n  const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}' : JSON.stringify(value);")
        replace("  let pack, storageKey", SHA256_JS + "\n  let pack, storageKey")
        js = js.replace('本次 PDF 非医学核验', '本轮模型输出普通初筛').replace('PDF解析核验意见-', '本轮输出核验意见-').replace('完整的 input-review 目录', '完整的 output-review 目录')
        js = js.replace('请写明哪里缺了、顺序哪里不对，或为什么无法判断。', '请写明原文、语境、目标相关性或配图的问题；无法判断时可说明原因。')
        (self.output / 'review.js').write_text(js)


def verify_opinions(root, path):
    pack = json.loads((root / 'output-review/data.json').read_text())
    without_hash = {k: v for k, v in pack.items() if k != 'pack_sha256'}
    if pack['pack_sha256'] != digest(without_hash):
        raise ValueError('pack content hash mismatch')
    value = json.loads(inside(path).read_text())
    fields = ['pack_id', 'pack_sha256', 'questionnaire_version', 'plan_sha256', 'execution_report_sha256']
    if value.get('schema_version') != 'current-output-review-opinions-1' or value.get('review_scope') != SCOPE or \
            any(value.get(k) != pack[k] for k in fields) or \
            any(value.get(k) is not False for k in ['human_approved', 'medical_quality_approved', 'product_export_approved']):
        raise ValueError('opinion package/version/approval scope mismatch')
    cases = {c['case_id']: c for c in pack['cases']}
    if len(cases) != len(pack['cases']) or any(c['case_version'] != digest({k: v for k, v in c.items() if k != 'case_version'}) for c in cases.values()):
        raise ValueError('case content/version mismatch')
    opinions = value.get('opinions')
    if not isinstance(opinions, list) or len(opinions) > sum(len(c['questions']) for c in pack['cases']):
        raise ValueError('opinion count/type mismatch')
    seen = set()
    for opinion in opinions:
        c = cases.get(opinion.get('case_id'))
        key = (opinion.get('case_id'), opinion.get('question_id'))
        if not c or key in seen or opinion.get('question_id') not in {q['question_id'] for q in c['questions']} or \
                any(opinion.get(k) != c[k] for k in ['source_id', 'pdf_sha256', 'artifact_sha256', 'case_version', 'source_binding']):
            raise ValueError('opinion record/job/source/version mismatch')
        question = next(q for q in c['questions'] if q['question_id'] == opinion['question_id'])
        if question.get('review_intent') and any(opinion.get(key) != expected for key, expected in {
                'review_group': c['review_group'], 'question_text': question['text'], 'question_semantics': question['review_intent']}.items()):
            raise ValueError('opinion review group/question semantics mismatch')
        allowed_types = LEGACY_PROBLEM_TYPES if pack['questionnaire_version'] == 'current-output-ordinary-screening-1' else \
            Builder.question_problem_types(question)
        if opinion.get('verdict') not in [None, 'looks_correct', 'has_problem', 'cannot_judge'] or \
                not isinstance(opinion.get('note'), str) or len(opinion['note']) > 4000 or \
                not isinstance(opinion.get('location'), str) or len(opinion['location']) > 300 or \
                not isinstance(opinion.get('problem_types'), list) or len(set(opinion['problem_types'])) != len(opinion['problem_types']) or \
                any(v not in allowed_types for v in opinion['problem_types']):
            raise ValueError('opinion value/note format mismatch')
        seen.add(key)
    print(json.dumps({'strict_version_binding': 'passed', 'opinion_points': len(opinions),
        'answered_points': sum(o['verdict'] is not None for o in opinions), 'medical_quality_approved': False}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default=str(DEFAULT_ROOT))
    parser.add_argument('--expected-plan-sha256', default=EXPECTED_PLAN)
    parser.add_argument('--verify-opinions', help='Validate a user-exported JSON against the generated current pack; does not write it.')
    args = parser.parse_args()
    if args.verify_opinions:
        verify_opinions(inside(args.root), args.verify_opinions)
    else:
        Builder(inside(args.root), args.expected_plan_sha256).build()
