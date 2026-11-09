import { spawnSync } from 'node:child_process';
import { resolve, relative } from 'node:path';
import assert from 'node:assert/strict';

/** Actual fresh source-anchor decoding plus unchanged pinned native JSON reuse.
 * No paid inference, old IR relabeling or frozen artifact mutation. */
export function freshPreparedSource(sourceId: 'L05' | 'L07', directory: string) {
  const output = resolve(directory, 'fresh-source-' + sourceId);
  const script = String.raw`
import sys,json
from pathlib import Path
from hashlib import sha256
sys.path.insert(0,'services/pdf-parser')
from adapter import DoclingParseTextAdapter,ParseInput
from structured import build_ir
from figure_assets import extract_catalog
name,out=sys.argv[1],Path(sys.argv[2]);out.mkdir()
old=json.load(open('docs/acceptance/pdf-structure-review-2026-11-07/derived/'+name+'/parser-result.json'))['document']
native_path=Path(old['native_artifact']['path']);assert sha256(native_path.read_bytes()).hexdigest()==old['native_artifact']['sha256']
source=DoclingParseTextAdapter().parse(ParseInput('new-source-fixture-'+name,name,old['source']['file_reference'],old['file_sha256'],False))
document=build_ir(source,json.loads(native_path.read_text()),'docling-standard-cpu',{'parser_version':old['parser']['version'],'configuration':old['parser']['config']['native_config'],'native_reused_for_zero_model_regression':True},[],old['native_artifact'])
(out/'parser-result.json').write_text(json.dumps({'document':document})+'\n')
extract_catalog(document,out/'figure-assets')
`;
  const result = spawnSync(resolve('.venv/bin/python'), ['-c', script, sourceId, output], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  return { source_id: sourceId, prepared_directory: relative(resolve('.'), output), figure_catalog: relative(resolve('.'), resolve(output, 'figure-assets/catalog.json')) };
}
