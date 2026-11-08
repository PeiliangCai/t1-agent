#!/usr/bin/env python3
"""Fetch only five explicitly authorized sources, without challenge circumvention."""
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import hashlib
import importlib.util
import json
import time

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'evaluation/corpus/development-candidates'
LOG = ROOT / 'docs/acceptance/s2/downloads.json'
SOURCES = [
    ('MED03', 'https://link.springer.com/content/pdf/10.1007/s11547-021-01418-9.pdf'),
    ('L07', 'https://link.springer.com/content/pdf/10.1007/s00261-023-03893-2.pdf'),
    ('L05', 'https://link.springer.com/content/pdf/10.1007/s12672-024-00872-x.pdf'),
    ('L01', 'https://www.yxyjzz.com/public/static/index/uploads/att/20241211/f4314818470eabb4ca65700b904a792c.pdf'),
    ('L02', 'https://www.yxyjzz.com/public/static/index/uploads/att/20241119/53e2d507489a3cfc3731a9d50bfc4263.pdf'),
]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    assert not LOG.exists(), 'Download evidence exists; use a new named attempt log'
    report = {'recorded_at': datetime.now(timezone.utc).isoformat(), 'purpose': 'S2 development/annotation candidates only; no independent acceptance data',
              'pypdf_available': bool(importlib.util.find_spec('pypdf')), 'formal_parser_invoked': False,
              'model_calls': 0, 'challenge_bypass': False, 'sources': []}
    for source_id, url in SOURCES:
        record = {'source_id': source_id, 'requested_url': url, 'attempts': [], 'file_verified': False,
                  'local_path': None, 'sha256': None, 'bytes': None, 'physical_pages': None,
                  'page_count_method': None, 'status': 'pending', 'medical_review': 'pending'}
        for attempt in range(1, 3):
            entry = {'attempt': attempt, 'time': datetime.now(timezone.utc).isoformat()}
            try:
                request = Request(url, headers={'User-Agent': 'T1-S2-corpus-preparation/1.0', 'Accept': 'application/pdf'})
                with urlopen(request, timeout=25) as response:
                    entry['http_status'] = response.status
                    entry['final_url'] = response.geturl()
                    entry['content_type'] = response.headers.get('Content-Type')
                    raw = response.read(30 * 1024 * 1024 + 1)
                if len(raw) > 30 * 1024 * 1024:
                    record['status'] = 'size_limit_not_saved'
                elif not raw.startswith(b'%PDF-'):
                    record['status'] = 'non_pdf_response_not_saved'
                    entry['body_saved'] = False
                else:
                    path = OUT / (source_id + '.pdf')
                    assert not path.exists(), 'Refuse to overwrite existing original'
                    path.write_bytes(raw)
                    record.update({'status': 'downloaded_pdf_magic_verified', 'file_verified': True,
                                   'local_path': str(path.relative_to(ROOT)), 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw),
                                   'retrieved_at': datetime.now(timezone.utc).isoformat()})
                    if report['pypdf_available']:
                        try:
                            from pypdf import PdfReader
                            record['physical_pages'] = len(PdfReader(path).pages)
                            record['page_count_method'] = 'pypdf_page_tree_probe_only_not_S3_parser_acceptance'
                        except Exception as error:
                            record['page_probe_error_type'] = type(error).__name__
                record['attempts'].append(entry)
                break
            except HTTPError as error:
                entry['http_status'] = error.code
                record['status'] = 'http_access_error'
                record['attempts'].append(entry)
                # Stop immediately on 403/401/challenges; no modified URLs, proxies or cookies.
                if error.code not in [429, 500, 502, 503, 504] or attempt == 2:
                    break
            except (URLError, TimeoutError, OSError) as error:
                entry['error_type'] = type(error).__name__
                record['attempts'].append(entry)
                record['status'] = 'network_error'
                if attempt == 2:
                    break
            time.sleep(1)
        report['sources'].append(record)
        LOG.parent.mkdir(parents=True, exist_ok=True)
        LOG.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'source_id': source_id, 'status': record['status'], 'file_verified': record['file_verified']}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
