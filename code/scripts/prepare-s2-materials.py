#!/usr/bin/env python3
"""Create shared S2 source/catalog/scoring materials and a negative evaluator fixture.

The cancelled full-text reference-answer templates, guides and work register are
not generated. This historical preparation entry never creates medical approval.
"""
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
import csv
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PLAN = ROOT.parent / '方案/子任务T1'
OUT = ROOT / 'evaluation'
NOW = datetime.now(timezone.utc).isoformat()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8') as f:
        f.write(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def write_csv(path, rows):
    with path.open('x', encoding='utf-8-sig', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def source_materials():
    old = json.loads((PLAN / '资料来源.json').read_text())
    downloads = json.loads((ROOT / 'docs/acceptance/s2/downloads.json').read_text())
    downloaded = {s['source_id']: s for s in downloads['sources']}
    verified = {
        'MED03': ('https://link.springer.com/article/10.1007/s11547-021-01418-9', '2021-11-06', 2022, 9, 'CC BY 4.0'),
        'MED04': ('https://link.springer.com/article/10.1007/s00261-023-03893-2', '2023-05-05', 2023, 15, 'CC BY 4.0'),
        'L07': ('https://link.springer.com/article/10.1007/s00261-023-03893-2', '2023-05-05', 2023, 15, 'CC BY 4.0'),
        'L05': ('https://link.springer.com/article/10.1007/s12672-024-00872-x', '2024-02-04', 2024, 10, 'CC BY 4.0'),
        'L01': ('https://www.yxyjzz.com/public/static/index/uploads/att/20241211/f4314818470eabb4ca65700b904a792c.pdf', None, 2024, 4, None),
    }
    sources = []
    historical_inputs = [(s['reference_id'], s, 'paper_length_survey', i) for i, s in enumerate(old['paper_length_survey']['samples'])]
    medical = [s for s in old['previous_medical_sources'] if s['id'].startswith('MED')]
    historical_inputs += [(s['id'], s, 'previous_medical_sources', old['previous_medical_sources'].index(s)) for s in medical]
    for source_id, s, section, index in historical_inputs:
        survey = section == 'paper_length_survey'
        doi = s.get('doi')
        family = 'doi:' + doi.lower() if doi else 'historical-identity:' + source_id
        verification = verified.get(source_id)
        dl = downloaded.get('L07' if source_id == 'MED04' else source_id)
        has_file = bool(dl and dl['file_verified'])
        if source_id in ['L01', 'L03', 'L04', 'L05', 'L08']:
            topic, cancer, modality = 'lung disease / historical title mentions lung cancer or nodules', '肺部相关；具体病灶及是否确诊癌待核', 'CT' if source_id != 'L08' else None
        elif source_id in ['L02', 'L06', 'L07', 'MED04', 'MED05']:
            topic, cancer, modality = 'rectal cancer imaging / historical title', '直肠癌（来源主题，逐条适用性待核）', 'MRI'
        elif source_id == 'MED03':
            topic, cancer, modality = 'colon cancer CT structured reporting', '结肠癌（来源主题，逐条适用性待核）', 'CT'
        elif source_id == 'MED01':
            topic, cancer, modality = 'pulmonary nodules, not equivalent to confirmed lung cancer', '肺结节；不可自动归为确诊肺癌', 'CT'
        elif source_id == 'MED02':
            topic, cancer, modality = 'thoracic imaging terminology', None, None
        else:
            topic, cancer, modality = 'brain tumor segmentation / historical title', '脑肿瘤（对照模态未验证）', None
        urls = [s['url']]
        if s.get('alternate_url'):
            urls.append(s['alternate_url'])
        if verification and verification[0] not in urls:
            urls.append(verification[0])
        if doi:
            reliable = 'doi:' + doi
        elif source_id == 'L01':
            reliable = 'publisher article code:2096-3807(2024)23-0115-04; DOI unknown'
        elif source_id == 'L09':
            reliable = 'MICCAI 2024 paper/2795_paper.pdf; DOI unknown'
        else:
            reliable = 'historical publisher URL + title; DOI unknown; full identity recheck pending'
        alias = [s['id']] if survey else []
        if source_id == 'MED04':
            alias.append('L07')
        if source_id == 'L07':
            alias.append('MED04')
        record = {
            'source_id': source_id, 'historical_aliases': alias,
            'title': s['title'], 'doi': doi, 'reliable_identifier': reliable, 'source_urls': urls,
            'language': s.get('language', 'en'), 'document_type': s.get('document_type'),
            'source_topic': topic, 'cancer_inclusion_tag': {'label': cancer, 'basis': 'historical_source_topic', 'status': 'pending_medical_review'},
            'modality_tag': {'label': modality, 'basis': 'historical_source_topic', 'status': 'pending_medical_review'},
            'article_family_id': family, 'family_review_status': 'same_doi_linked_other_overlap_pending' if doi else 'pending',
            'publication_version': s.get('publication_label', str(s['year']) if 'year' in s else None), 'version_review_status': 'pending_full_text_check',
            'permission': {'license': verification[4] if verification else None, 'status': 'publisher_license_verified_by_main_session' if verification and verification[4] else 'unknown',
                           'evidence_url': verification[0] if verification else None, 'redistribution': 'per_license_requirements' if verification and verification[4] else 'not_established'},
            'publisher_verification': {'status': 'metadata_checked_by_main_session' if verification else 'not_rechecked', 'checked_date': '2026-11-02' if verification else None,
                                       'publication_date': verification[1] if verification else None, 'publication_year': verification[2] if verification else None,
                                       'url': verification[0] if verification else None, 'reported_pdf_pages': verification[3] if verification else None, 'medical_review_completed': False},
            'access': {'status': dl['status'] if dl else 'not_retrieved_in_S2', 'file_verified': has_file,
                       'local_path': dl['local_path'] if has_file else None, 'sha256': dl['sha256'] if has_file else None,
                       'bytes': dl['bytes'] if has_file else None, 'retrieved_at': dl.get('retrieved_at') if has_file else None,
                       'page_count_method': dl['page_count_method'] if has_file else None},
            'current_composition': {'physical_pages': dl['physical_pages'] if has_file else None, 'body_pages': None, 'reference_pages': None,
                                    'figure_table_pages': None, 'appendix_pages': None, 'separate_supplement_pages': None, 'mixed_pages': None,
                                    'layout': None, 'text_layer_status': 'not_verified'},
            'historical_observations': [{'source_pointer': f'方案/子任务T1/资料来源.json#/{section}/' + ('samples/' if survey else '') + str(index),
                                          'checked_date': old['paper_length_survey']['checked_date'] if survey else old.get('checked_date'),
                                          'recorded_sha256': s.get('sha256'), 'recorded_pdf_pages': s.get('pdf_pages'), 'recorded_bytes': s.get('bytes'),
                                          'notes': '历史身份/页数/哈希未当作本次原件核验。' + (s.get('reviewed', '') + '；' + s.get('limits', '') if not survey else '完整历史记录保留原文件，不覆盖。')}],
            'exposure': {'used_in_prior_research': True, 'uses': ['prior_length_survey'] if survey else ['prior_feature_planning_and_source_research'],
                         'full_text_human_read_status': 'not_established_by_this_package', 'independent_acceptance_eligible': False},
            'allocation': {'role': 'development_candidate' if source_id in ['MED03', 'MED04', 'L01', 'L02', 'L05', 'L07'] else 'reference',
                           'split_status': 'not_sealed', 'final_split': None,
                           'selection_reason': '既有已曝光来源，仅作开发/标注候选或术语参考；纳入组合及全文可用性需人核对，不充当独立验收。'},
            'annotation_status': 'pending', 'medical_review_status': 'pending',
        }
        sources.append(record)
    manifest = {'schema_version': 's2-sources-1', 'manifest_version': 's2-source-draft-1', 'created_at': NOW,
                'independent_acceptance_source_count': 0, 'formal_sample_count': None, 'sources': sources}
    write_json(OUT / 'manifests/source-register.json', manifest)
    csv_rows = []
    for s in sources:
        csv_rows.append({'source_id': s['source_id'], 'title': s['title'], 'doi': s['doi'], 'reliable_identifier': s['reliable_identifier'],
                         'source_urls': ' | '.join(s['source_urls']), 'language': s['language'], 'source_topic': s['source_topic'],
                         'cancer_inclusion_tag_pending': s['cancer_inclusion_tag']['label'], 'modality_tag_pending': s['modality_tag']['label'],
                         'license': s['permission']['license'], 'license_status': s['permission']['status'],
                         'article_family_id': s['article_family_id'], 'version_pending': s['publication_version'],
                         'access_status': s['access']['status'], 'file_verified': s['access']['file_verified'], 'local_path': s['access']['local_path'],
                         'current_sha256': s['access']['sha256'], 'current_bytes': s['access']['bytes'], 'current_pages': s['current_composition']['physical_pages'],
                         'current_composition': json.dumps(s['current_composition'], ensure_ascii=False), 'exposure': ';'.join(s['exposure']['uses']),
                         'independent_acceptance_eligible': False, 'split_status': 'not_sealed', 'role': s['allocation']['role'],
                         'selection_reason': s['allocation']['selection_reason'], 'historical_observations': json.dumps(s['historical_observations'], ensure_ascii=False)})
    write_csv(OUT / 'manifests/source-register.csv', csv_rows)
    families = defaultdict(list)
    for s in sources:
        families[s['article_family_id']].append(s['source_id'])
    splits = {'schema_version': 's2-splits-1', 'status': 'draft_pending_human_confirmation', 'formal_sample_count': None,
              'assignments': [{'article_family_id': family, 'source_ids': ids, 'split': 'unassigned', 'status': 'candidate_only',
                               'reason': '已曝光来源，仅参考/开发候选；同DOI版本及重复段落不得跨组，最终用途和相似来源仍待人核验。'} for family, ids in sorted(families.items())],
              'acceptance_seal': {'status': 'not_prepared', 'source_ids': [], 'sealed_by': None, 'sealed_at': None},
              'coverage_directions': ['从临床有依据的肺部/结肠/直肠相关CT/MRI组合起步，肺结节不等于确诊肺癌', '中英文文本型论文；真实可用文本层待核验',
                                      '研究/综述/共识、不同版式和实际全文件页数组成', '否定、不确定、条件、无相关视觉表述、跨模态比较与跨页语境',
                                      '不限与严格选择模式分别评估；不机械均分癌种×模态，不设正式样本数']}
    write_json(OUT / 'manifests/family-split-draft.json', splits)
    write_json(OUT / 'manifests/method-reference-register.json', {'status': 'method_reference_not_medical_corpus', 'sources': [s for s in old['previous_medical_sources'] if not s['id'].startswith('MED')],
                                                               'reason': 'TOOL01只作为方法来源，不混入14项医学/工程负载来源清单或金标。'})
    archives = []
    for p in [ROOT.parent / '方案/历史归档.zip', ROOT.parent / 'research/调研原始资料.zip']:
        with zipfile.ZipFile(p) as z:
            archives.append({'archive': str(p.relative_to(ROOT.parent)), 'pdf_members': [{'name': i.filename, 'bytes': i.file_size} for i in z.infolist() if i.filename.lower().endswith('.pdf')], 'extracted': False})
    write_json(ROOT / 'docs/acceptance/s2/archive-pdf-inventory.json', {'method': 'ZIP directory listing only', 'archives': archives})


def feature_materials():
    path = ROOT.parent / '方案/首批医学影像特征清单.json'
    raw = path.read_bytes()
    old = json.loads(raw)
    screening = []
    english = {'LUNG04': 'spiculation', 'LUNG05': 'lobulation', 'LUNG06': 'sphericity', 'LUNG08': 'subtlety',
               'LUNG09': 'likelihood of malignancy', 'COLON01': 'lesion site', 'COLON02': 'lesion type', 'COLON03': 'size',
               'RECT01': 'sigmoid take-off (STO)', 'RECT03': 'extramural invasion', 'RECT05': 'MRF', 'RECT06': 'EMVI'}
    engineering = {'META01', 'META02', 'META03', 'GEO03', 'GEO04', 'GEO05'}
    clinical_label = {'LUNG09', 'COLON07', 'COLON08'}
    mixed = {'COLON04', 'COLON05', 'COLON06', 'RECT05', 'RECT06', 'RECT07', 'RECT08', 'RECT09'}
    measurements = {'GEO01', 'GEO02', 'COLON03', 'RECT02', 'RECT03', 'RECT04'}
    for f in old['features']:
        fid = f['feature_id']
        if fid in engineering:
            cls, eligibility = 'engineering_metadata_or_validation', 'excluded_as_independent_visual_feature'
            reason = '元数据、坐标、生成结果检查或掩膜计算；不直接当作T1论文视觉证据。原文明示的解剖位置/测量需另立有来源证据。'
        elif fid in clinical_label:
            cls, eligibility = 'clinical_composite_label', 'clinical_label_not_standalone_visual_feature'
            reason = '分期或恶性可能性本身不自动是独立视觉特征；保留必要临床语境，具体影像依据应拆开另标，不把评分当病理确诊。'
        elif fid in mixed:
            cls, eligibility = 'mixed_visual_description_or_clinical_conclusion', 'requires_separating_visual_evidence_and_composite_conclusion'
            reason = '可能同时含具体影像外观/测量与复合临床判读；不能仅按名称排除，也不能整项直接作为纯视觉特征。需全文和医学复核。'
        elif fid in measurements:
            cls, eligibility = 'imaging_measurement_candidate', 'candidate_only_when_explicitly_described_in_paper'
            reason = '仅考虑论文直接报告且有明确影像含义的测量；保留原始定义、参照、单位及条件，不实现掩膜计算，不擅用工程定义替代临床含义。'
        else:
            cls, eligibility = 'visual_appearance_or_location_candidate', 'candidate_only_when_explicitly_described_in_paper'
            reason = '原文外观/部位表述候选；主体、模态、原定义、否定及限定须核对，来源主题不代表已确诊癌种。'
        proposed = []
        if fid in english:
            proposed = [{'text': english[fid], 'relation_type': 'translation_or_correspondence_candidate', 'source_ids': f['source_ids'].split(';'), 'status': 'pending_medical_review', 'approved_for_matching': False}]
        row = {'feature_id': fid, 'historical_record': f, 'name_raw': f['name'], 'source_ids': f['source_ids'].split(';'),
               'historical_evidence_locator': f['evidence_locator'], 'screening_class_draft': cls, 'standalone_eligibility_draft': eligibility,
               'reason': reason, 'medical_review_status': 'pending', 'source_support_status': 'historical_lead_pending_full_text_verification',
               'source_topic_does_not_confirm_cancer': True, 'proposed_terms': proposed,
               'synonym_status': 'pending', 'hierarchy_status': 'pending', 'merge_status': 'no_merge_approved',
               'sequence_phase_condition_status': 'pending', 'condition_notes': f['operational_definition'],
               'applicability': {'cancer_ids': [], 'modality_ids': [], 'status': 'pending_medical_review', 'historical_category_hint': f['category']},
               'product_default_catalog_enabled': False}
        screening.append(row)
    write_json(OUT / 'catalog/feature-screening-draft.json', {'version': 's2-feature-screening-draft-1', 'status': 'draft_pending_medical_review',
                                                            'original_file': str(path.relative_to(ROOT.parent)), 'original_file_sha256': hashlib.sha256(raw).hexdigest(),
                                                            'original_35_items_unchanged': True, 'product_catalog_enabled': False,
                                                            'class_counts': dict(Counter(s['screening_class_draft'] for s in screening)), 'features': screening})
    write_csv(OUT / 'catalog/feature-screening-draft.csv', [{'feature_id': f['feature_id'], 'name_raw': f['name_raw'], 'historical_category': f['historical_record']['category'],
                                                          'source_ids': ';'.join(f['source_ids']), 'historical_evidence_locator': f['historical_evidence_locator'],
                                                          'screening_class_draft': f['screening_class_draft'], 'standalone_eligibility_draft': f['standalone_eligibility_draft'],
                                                          'reason': f['reason'], 'proposed_terms': json.dumps(f['proposed_terms'], ensure_ascii=False),
                                                          'source_support_status': f['source_support_status'], 'medical_review_status': 'pending', 'synonym_status': 'pending',
                                                          'hierarchy_status': 'pending', 'merge_status': 'no_merge_approved', 'sequence_phase_condition_status': 'pending',
                                                          'product_default_catalog_enabled': False} for f in screening])
    write_json(OUT / 'catalog/evaluation-feature-catalog-draft.json', {'version': 's2-evaluation-vocabulary-draft-1', 'purpose': 'evaluation_preparation_only',
               'status': 'pending_medical_review_not_product_catalog', 'product_default_catalog_enabled': False,
               'features': [{'feature_id': f['feature_id'], 'name_raw': f['name_raw'], 'screening_class_draft': f['screening_class_draft'],
                             'source_ids': f['source_ids'], 'proposed_terms': f['proposed_terms'], 'applicability': f['applicability'],
                             'condition_notes': f['condition_notes'], 'status': 'pending'} for f in screening if f['feature_id'] not in engineering],
               'approved_bindings': [], 'approved_synonyms': [], 'approved_hierarchy_edges': [],
               'relationship_proposals': [
                   {'from': 'COLON03', 'to': ['GEO01', 'GEO02'], 'relationship': 'measurement_options_not_synonyms', 'status': 'pending', 'basis': '原35项记录已有大小与几何量关联，体积与直径不可混并。'},
                   {'from': 'LUNG02', 'to': ['solidity', 'texture'], 'relationship': 'historical_related_terms_not_approved_synonyms', 'status': 'pending', 'basis': '保留原体系定义；未经复核不互换。'},
                   {'from': '肠癌', 'to': ['结肠癌', '直肠癌'], 'relationship': 'proposed_broader_narrower_categories_not_synonyms', 'status': 'pending', 'basis': '历史计划使用这些类别，具体适用与包含关系待医学来源及用户确认。'},
                   {'from': '肺结节', 'to': ['肺癌'], 'relationship': 'not_automatic_subtype_or_synonym', 'status': 'pending', 'basis': 'LIDC肺结节研究不证明所有结节均为癌。'}],
               'sequence_phase_conditions': [{'feature_id': f['feature_id'], 'source_ids': f['source_ids'], 'raw_historical_hint': f['condition_notes'], 'status': 'pending_full_text_and_medical_review'} for f in screening if f['feature_id'].startswith('RECT')],
               'scope_warning': '本稿不能作为已核验医学白名单、同义表或产品默认配置。不限模式仍开放；受限模式不自动扩大到上下位项。'})


def rules_and_fixture():
    rule = {'version': 's2-scoring-draft-1', 'status': 'pending_user_and_medical_confirmation', 'scope': 'S2 preparation only',
            'unit': 'one canonical manually adjudicated claim/evidence unit per document; segments may cross pages/blocks',
            'matching': 'maximum_cardinality_bipartite_matching_over_reviewed_edges',
            'string_match_validates_medical_semantics': False, 'model_judge_used': False,
            'tp': 'one prediction record matched to one in-scope canonical gold unit with all context checks preserved',
            'fp': 'each unmatched independent prediction record, including extra duplicates and out-of-scope records',
            'fn': 'each unmatched in-scope gold unit, including gold from failed/partial/interrupted/cancelled papers',
            'gold_out_of_scope': 'excluded from FN; keep counts and rationale', 'duplicates': 'additional prediction records cannot increase TP and count FP; repeated blocks are segments of one unit, never additional gold units',
            'zero_denominators': {'precision': None, 'recall': None, 'status': 'not_applicable_zero_denominator'},
            'real_gate': ['rules approved', 'current original-file identity', 'independent human full-text annotation with complete page checklist', 'medical gold review', 'all scope labels and matching edges adjudicated with actor/time/basis'],
            'missing_gate': 'not_evaluable; totals=null; no stage/official pass', 'official_acceptance': 'not_assessed_by_S2_preparation_evaluator',
            'strata': ['language', 'cancer_tag', 'modality_tag', 'layout_tag'], 'overall_aggregation': 'micro TP/FP/FN across every listed document without dropping failures',
            'numeric_thresholds': None, 'formal_sample_count': None,
            'preliminary_directions': ['证据引用、否定、不确定、条件及数值单位可逐条核对', '严格范围内漏抽和范围外独立误收分别报告；不限模式保留新特征',
                                       '跨页及重复表述按预先裁定单元计数', '论文族防泄漏、完整金标和失败输入均可追溯',
                                       '质量保证下减少等待，S3/S4开发集实测后共同确定最终数值，S6前冻结'],
            'human_confirmation_items': ['证据单元拆分和同篇重复表述归并规则', '定义/本研究观察/转引均保留但分列的口径',
                                         '临床复合结论与其具体影像表现如何拆分', '具体同义、上下位、序列/期相和癌种适用关系',
                                         '来源许可和全文范围核对，最终开发/回归及另行收集封存资料划分'],
            'history': [{'version': 's2-scoring-draft-1', 'created_at': NOW, 'status': 'draft_not_human_approved'}]}
    write_json(OUT / 'rules/scoring-rules-draft.json', rule)
    scope = {'scope_version': '1', 'cancers': {'mode': 'all', 'ids': []}, 'image_types': {'mode': 'all', 'ids': []},
             'features': {'mode': 'all', 'binding_ids': []}, 'catalog_version': 'evaluation-preparation-not-product', 'matching_policy_version': rule['version']}
    write_json(OUT / 'fixtures/scoring/unevaluable-real-input.json', {'schema_version': 's2-evaluation-1', 'dataset_id': 'unpopulated-preparation-template', 'fixture': False,
               'purpose': 'development_measurement', 'rule_version': rule['version'], 'rules_status': 'pending_confirmation', 'gold_version': 'none-human-work-pending', 'scope': scope, 'documents': []})


def main():
    for directory in ['contracts', 'reports/fixtures', 'reports/real', 'fixtures/scoring', 'catalog', 'manifests']:
        (OUT / directory).mkdir(parents=True, exist_ok=True)
    source_materials()
    feature_materials()
    rules_and_fixture()
    print(json.dumps({'sources': 14, 'distinct_known_doi_or_identity_families': 13, 'original_features_screened': 35,
                      'human_gold_created': False, 'medical_approval': False, 'S2_status': 'in_progress'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
