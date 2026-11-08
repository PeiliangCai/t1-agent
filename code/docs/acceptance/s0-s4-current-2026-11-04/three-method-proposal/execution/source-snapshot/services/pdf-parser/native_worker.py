#!/usr/bin/env python3
"""Local JSON-lines candidate worker. All PDFs are bound by the parent adapter.

Both candidates run serially on CPU, reuse one native parser per process, and
have remote parsing/VLM/LLM helpers disabled. stdout is reserved for protocol.
"""
from contextlib import redirect_stdout
from importlib.metadata import version
from pathlib import Path
import argparse
import json
import os
import resource
import sys
import time
import traceback
from adapter import CODE, native_stdout_to_stderr


class Engine:
    def __init__(self, candidate):
        self.candidate, self.parser = candidate, None

    def parse(self, path):
        start, usage = time.monotonic(), resource.getrusage(resource.RUSAGE_SELF)
        first = self.parser is None
        if self.candidate == 'docling-standard-cpu':
            from docling.document_converter import DocumentConverter, PdfFormatOption
            from docling.datamodel.base_models import InputFormat
            from docling.datamodel.pipeline_options import PdfPipelineOptions
            from docling.datamodel.accelerator_options import AcceleratorOptions, AcceleratorDevice
            import torch
            if self.parser is None:
                torch.set_num_threads(4)
                options = PdfPipelineOptions(do_ocr=False, do_table_structure=True, enable_remote_services=False,
                    artifacts_path=CODE / '.tools/pdf-parser/models', document_timeout=300,
                    accelerator_options=AcceleratorOptions(device=AcceleratorDevice.CPU, num_threads=4))
                self.parser = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
            result = self.parser.convert(path, raises_on_error=False)
            native = result.document.export_to_dict()
            errors = [e.model_dump(mode='json') for e in result.errors]
            status = result.status.value
            config = {'device': 'cpu', 'threads': 4, 'ocr': False, 'table_structure': True,
                      'layout_model': 'docling-project/docling-layout-heron@8f39ad3c0b4c58e9c2d2c84a38465abf757272d8',
                      'table_model': 'docling-project/docling-models@fc0f2d45e2218ea24bce5045f58a389aed16dc23',
                      'remote_services': False, 'gpu_available': torch.cuda.is_available()}
            parser_version = version('docling')
        else:
            from mineru.config import get_config
            from mineru.parser import MinerUParser
            config_object = get_config()
            config_object.model.small_backend = 'onnx'
            config_object.model.onnx_device = 'cpu'
            config_object.model.source = 'local'
            config_object.model.vlm.server_url = None
            config_object.llm_aided.features.title_leveling = False
            config_object.llm_aided.features.cross_page_table_cell_merge = False
            if self.parser is None:
                self.parser = MinerUParser(tier='basic', parse_mode='txt', image_analysis=True)
            result = self.parser.parse(path, page_range='all')
            native = result.to_dict(skip_defaults=False)
            errors = []
            status = 'native_returned_result'
            config = {'device': 'cpu', 'threads': 4, 'inter_op_threads': 1, 'tier': 'basic', 'ocr_mode': 'txt',
                      'small_backend': 'onnx', 'onnx_device': 'cpu', 'page_range': 'all',
                      'model_commit': '358310b4f64b95f9fefc372ad899356e4111f376',
                      'model_base_dir': config_object.model.base_dir, 'source': 'local',
                      'remote_vlm_server': None, 'llm_aided_title_leveling': False, 'llm_aided_cross_page_table_merge': False}
            parser_version = version('mineru')
        after = resource.getrusage(resource.RUSAGE_SELF)
        metrics = {'parser_version': parser_version, 'total_seconds': time.monotonic() - start,
                   'cpu_user_seconds': after.ru_utime - usage.ru_utime, 'cpu_system_seconds': after.ru_stime - usage.ru_stime,
                   'peak_rss_bytes_process_lifetime': after.ru_maxrss * 1024, 'first_call_in_process': first,
                   'configuration': config, 'pid': os.getpid(), 'status': status,
                   'document_result_cache_used': False, 'model_instance_reused': not first,
                   'cache_policy': 'Direct local parser API on original PDF bytes every call; no document library/result-cache lookup'}
        return {'native': native, 'metrics': metrics, 'errors': errors}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate-id', required=True, choices=['docling-standard-cpu', 'mineru-basic-onnx-cpu'])
    args = parser.parse_args()
    # Effective four-CPU affinity caps the tree as well as numerical libraries.
    if hasattr(os, 'sched_getaffinity'):
        os.sched_setaffinity(0, set(sorted(os.sched_getaffinity(0))[:4]))
    engine = Engine(args.candidate_id)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            path = Path(request['path']).resolve()
            if not path.is_relative_to(CODE) or not path.is_file():
                raise ValueError('Native input must be a previously validated local project PDF')
            with redirect_stdout(sys.stderr), native_stdout_to_stderr():
                response = engine.parse(path)
            print(json.dumps({'ok': True, **response}, ensure_ascii=False), flush=True)
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            print(json.dumps({'ok': False, 'error': {'code': 'native_candidate_failed', 'message': str(exc)[:300],
                                                     'exception_type': type(exc).__name__}}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
