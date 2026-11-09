#!/usr/bin/env python3
"""JSON-only CLI. Partial/unsupported = exit 2; errors = 1; no implicit overwrite."""
from pathlib import Path
import argparse
import json
import sys
from adapter import CODE, DoclingParseTextAdapter, ParseInput, ParserError, resolve_segments, validate_ir_semantics


def validate_document(document):
    import jsonschema
    schema = json.loads((CODE / 'packages/contracts/schema/DocumentIR.json').read_text())
    jsonschema.validate(document, schema)
    validate_ir_semantics(document)


def write_output(payload, target):
    raw = json.dumps(payload, ensure_ascii=False, indent=2) + '\n'
    if target:
        path = (CODE / target).resolve()
        if not path.is_relative_to(CODE):
            raise ParserError('output_outside_code_root', 'Output must be inside the application directory')
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with path.open('x') as f:
                f.write(raw)
        except FileExistsError as exc:
            raise ParserError('output_already_exists', 'Existing output is immutable; choose a new path') from exc
        document = payload.get('document')
        print(json.dumps({'status': payload.get('status', 'located'), 'output': str(path.relative_to(CODE)),
                          'pages': len(document['pages']) if document else None,
                          'blocks': len(document['blocks']) if document else None}, ensure_ascii=False))
    else:
        print(raw, end='')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    parse = sub.add_parser('parse')
    for flag in ['run-id', 'document-id', 'file-reference', 'file-sha256']:
        parse.add_argument('--' + flag, required=True)
    parse.add_argument('--fixture', action='store_true', help='Explicit generated engineering PDF only; never use for real papers')
    parse.add_argument('--adapter', choices=['docling-parse-text'], default='docling-parse-text')
    parse.add_argument('--config-revision', default='1')
    parse.add_argument('--output')
    locate = sub.add_parser('locate')
    locate.add_argument('--document', required=True, help='Saved ParserResult JSON')
    locate.add_argument('--reference', required=True, help='JSON with document_id, text_version, exact segments, joiner')
    locate.add_argument('--output')
    args = parser.parse_args()
    run_id = getattr(args, 'run_id', 'localization')
    try:
        if args.command == 'parse':
            value = ParseInput(args.run_id, args.document_id, args.file_reference, args.file_sha256, args.fixture)
            document = DoclingParseTextAdapter(config_revision=args.config_revision).parse(value)
            validate_document(document)
            status = {'parsed': 'ok', 'partial': 'partial', 'unsupported': 'unsupported'}[document['parser']['status']]
            payload = {'schema_version': 'parser-result-1', 'run_id': run_id, 'status': status, 'document': document, 'error': None}
            code = 0 if status == 'ok' else 2
        else:
            document = json.loads((CODE / args.document).read_text())['document']
            validate_document(document)
            reference = json.loads((CODE / args.reference).read_text())
            payload = resolve_segments(document, **reference)
            code = 0
        write_output(payload, args.output)
        return code
    except ParserError as exc:
        failure = exc.as_dict()
    except Exception as exc:
        # Native stacks / raw PDF content are kept out of the JSON API.
        print(type(exc).__name__ + ': ' + str(exc)[:300], file=sys.stderr)
        failure = {'code': 'parser_internal_error', 'message': 'Parser failed; inspect the local stderr log', 'retryable': False}
    print(json.dumps({'schema_version': 'parser-result-1', 'run_id': run_id, 'status': 'error', 'document': None, 'error': failure}, ensure_ascii=False))
    return 1


if __name__ == '__main__':
    sys.exit(main())
