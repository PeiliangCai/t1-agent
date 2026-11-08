#!/usr/bin/env python3
"""Versioned local CPU parser/locator CLI for explicitly chosen candidates."""
import argparse
import json
from pathlib import Path
import sys
import traceback
from adapter import CODE, ParseInput, ParserError, resolve_segments
from structured import StructuredParserAdapter, validate_structured


def output(value, target):
    raw = json.dumps(value, ensure_ascii=False, indent=2) + '\n'
    if target:
        path = (CODE / target).resolve()
        if not path.is_relative_to(CODE):
            raise ParserError('output_outside_code_root', 'Output must be inside code/')
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with path.open('x') as stream:
                stream.write(raw)
        except FileExistsError as exc:
            raise ParserError('output_already_exists', 'Choose a new immutable output path') from exc
        print(json.dumps({'status': value.get('status', 'located'), 'output': str(path.relative_to(CODE))}), flush=True)
    else:
        print(raw, end='', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    parse = sub.add_parser('parse')
    for option in ['candidate-id', 'run-id', 'document-id', 'file-reference', 'file-sha256']:
        parse.add_argument('--' + option, required=True)
    parse.add_argument('--fixture', action='store_true'); parse.add_argument('--output')
    parse.add_argument('--log-directory')
    locate = sub.add_parser('locate')
    locate.add_argument('--document', required=True); locate.add_argument('--reference', required=True); locate.add_argument('--output')
    args = parser.parse_args(); run_id = getattr(args, 'run_id', 'locator')
    try:
        if args.command == 'parse':
            value = ParseInput(args.run_id, args.document_id, args.file_reference, args.file_sha256, args.fixture)
            if args.output and (CODE / args.output).exists():
                raise ParserError('output_already_exists', 'Choose a new immutable output path')
            log_directory = (CODE / args.log_directory).resolve() if args.log_directory else None
            if log_directory and not log_directory.is_relative_to(CODE):
                raise ParserError('log_outside_code_root', 'Logs must be inside code/')
            adapter = StructuredParserAdapter(args.candidate_id, log_directory=log_directory)
            try:
                document = adapter.parse(value)
            finally:
                adapter.close()
            state = {'parsed': 'ok', 'partial': 'partial', 'unsupported': 'unsupported'}[document['parser']['status']]
            payload = {'schema_version': 'parser-result-2', 'run_id': run_id, 'status': state, 'document': document, 'error': None}
            output(payload, args.output)
            return 0 if state == 'ok' else 2
        document = json.loads((CODE / args.document).read_text())['document']
        validate_structured(document)
        reference = json.loads((CODE / args.reference).read_text())
        located = resolve_segments(document, **reference)
        located['quote_authority'] = 'individual_source_segments_only_display_composite_is_not_contiguous_source'
        output(located, args.output); return 0
    except ParserError as exc:
        error = exc.as_dict()
    except Exception:
        traceback.print_exc(file=sys.stderr)
        error = {'code': 'structured_parser_internal_error', 'message': 'Inspect local stderr evidence', 'retryable': False}
    output({'schema_version': 'parser-result-2', 'run_id': run_id, 'status': 'error', 'document': None, 'error': error}, None)
    return 1


if __name__ == '__main__':
    sys.exit(main())
