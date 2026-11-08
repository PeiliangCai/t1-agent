"""Read-only binding audit of an exported PDF layout review; never rebuild a pack."""
from collections import Counter
from hashlib import sha256
from pathlib import Path
from datetime import datetime
import importlib.util
import json
import sys

sys.dont_write_bytecode = True

CODE = Path(__file__).resolve().parents[1]
PUBLIC = CODE / 'apps/pi-web/public/input-review'
FROZEN = CODE / 'docs/acceptance/pdf-structure-review-2026-11-07'
FEEDBACK = PUBLIC / 'PDF解析核验意见-2026-11-08-02-06-10.json'
PACK_SHA = '5e63abbf7bc477d7beefa3fecca518ea5ea9ea20dff758b7b0b17b38f3de85c4'


def no_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        assert key not in result, 'duplicate JSON key: ' + key
        result[key] = value
    return result


def read(path):
    return json.loads(path.read_text(), object_pairs_hook=no_duplicate_keys)


def file_sha(path):
    return sha256(path.read_bytes()).hexdigest()


def digest(value):
    return sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def audit():
    pack = read(PUBLIC / 'data.json')
    feedback = read(FEEDBACK)
    assert pack['schema_version'] == 'pdf-input-review-pack-1'
    assert feedback['schema_version'] == 'pdf-input-review-opinions-1'
    assert pack['pack_id'] == feedback['pack_id'] == 'pdf-structure-review-2026-11-07-v1'
    assert pack['pack_sha256'] == feedback['pack_sha256'] == PACK_SHA
    assert digest({k: v for k, v in pack.items() if k != 'pack_sha256'}) == PACK_SHA
    assert feedback['review_scope'] == 'pdf_layout_nonmedical_screening'
    exported = datetime.fromisoformat(feedback['exported_at'].replace('Z', '+00:00'))
    for obj in [pack, feedback]:
        assert all(obj[key] is False for key in ['human_approved', 'medical_quality_approved', 'product_export_approved'])

    # Reconstruct artifact/case/question identity from the frozen owner evidence.
    # Asset copying and page rendering are replaced with strict existing-byte
    # checks. The original builder's main() is never invoked; nothing is written.
    spec = importlib.util.spec_from_file_location('frozen_review_binding', CODE / 'scripts/build-input-review.py')
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    builder.read = read
    page_images = {}
    for case in pack['cases']:
        for page in case['pages']:
            key = (case['source_id'], page['physical_page'])
            assert key not in page_images or page_images[key] == page
            page_images[key] = page
            assert file_sha(PUBLIC / page['image']) == page['sha256']

    def existing_asset(path, expected=None):
        actual = builder.source_path(path)
        hash_ = file_sha(actual)
        assert expected is None or hash_ == expected
        relative = 'assets/' + hash_[:20] + actual.suffix.lower()
        assert file_sha(PUBLIC / relative) == hash_
        return relative, hash_

    builder.copy_asset = existing_asset

    class ReadOnlySources(builder.Sources):
        def page(self, source_id, number):
            return page_images[(source_id, number)]

    sources = ReadOnlySources()
    expected_cases = builder.figure_cases(sources) + [builder.shared_case(c, sources) for c in read(FROZEN / 'review-cases-tables-continuations.json')['cases']]
    assert expected_cases == pack['cases'], 'pack cases differ from bound frozen owner artifacts/questions'
    cases = {case['case_id']: case for case in pack['cases']}
    assert len(cases) == len(pack['cases']) == 20
    expected = {(case['case_id'], question['question_id']) for case in cases.values() for question in case['questions']}
    assert len(expected) == sum(len(case['questions']) for case in cases.values()) == 43
    seen = set()
    for opinion in feedback['opinions']:
        assert set(opinion) == {'case_id', 'question_id', 'source_id', 'pdf_sha256', 'artifact_sha256', 'case_version',
                                'verdict', 'problem_types', 'location', 'note', 'updated_at'}
        key = (opinion['case_id'], opinion['question_id'])
        assert key in expected and key not in seen, 'unknown or duplicate opinion identity'
        seen.add(key)
        case = cases[key[0]]
        assert all(opinion[field] == case[field] for field in ['source_id', 'pdf_sha256', 'artifact_sha256', 'case_version'])
        assert opinion['verdict'] in ['looks_correct', 'has_problem', 'cannot_judge', None]
        assert isinstance(opinion['problem_types'], list) and isinstance(opinion['location'], str) and isinstance(opinion['note'], str)
        assert datetime.fromisoformat(opinion['updated_at'].replace('Z', '+00:00')) <= exported
    assert seen == expected, 'incomplete review point coverage'
    source_bindings = []
    source_unit_version = read(FROZEN / 'source-checkpoint.json')['source_unit_version']
    assert source_unit_version == 'literal-source-sentences-4'
    for source_id, (document, ir_sha) in sorted(sources.documents.items()):
        matching = [case for case in cases.values() if case['source_id'] == source_id]
        assert all(case['source_ir_sha256'] == ir_sha and case['pdf_sha256'] == document['file_sha256'] for case in matching)
        assert file_sha(PUBLIC / matching[0]['pdf']) == document['file_sha256']
        source_bindings.append({'source_id': source_id, 'pdf_sha256': document['file_sha256'], 'text_version': document['text_version'],
                                'source_ir_sha256': ir_sha, 'source_units': source_unit_version, 'cases': len(matching)})
    return {'status': 'passed', 'feedback_path': str(FEEDBACK.relative_to(CODE)), 'feedback_sha256': file_sha(FEEDBACK),
            'data_file_sha256': file_sha(PUBLIC / 'data.json'), 'pack_id': pack['pack_id'], 'pack_sha256': PACK_SHA,
            'case_count': len(cases), 'point_count': len(expected), 'opinions_count': len(seen),
            'verdict_counts': dict(Counter(o['verdict'] for o in feedback['opinions'])),
            'case_kinds': dict(Counter(c['kind'] for c in cases.values())),
            'nonempty_notes': sum(bool(o['note']) for o in feedback['opinions']),
            'nonempty_locations': sum(bool(o['location']) for o in feedback['opinions']),
            'nonempty_problem_types': sum(bool(o['problem_types']) for o in feedback['opinions']),
            'binding_checks': ['strict_no_duplicate_JSON_keys', 'known_pack_id_and_recomputed_canonical_SHA256',
                               'full_case_and_question_reconstruction_from_frozen_owner_artifacts', 'unique_complete_case_question_opinions',
                               'every_opinion_source_PDF_artifact_and_case_version', 'source_IR_PDF_and_existing_assets_SHA256'],
            'source_bindings': source_bindings,
            'scope': 'Actual user PDF layout/location feedback only; no medical/product per-record approval or full S3/S4 acceptance.',
            'old_pack_rebuilt_or_written': False, 'page_images_rerendered': False,
            'PDF_layout_points_look_correct': all(o['verdict'] == 'looks_correct' for o in feedback['opinions']),
            'medical_quality_approved': False, 'product_export_approved': False}


if __name__ == '__main__':
    print(json.dumps(audit(), ensure_ascii=False, indent=2))
