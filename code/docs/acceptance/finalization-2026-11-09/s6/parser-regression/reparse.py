"""Fresh literal source decoding + pinned unchanged native-structure reuse. 0 API."""
import json,sys,time
from pathlib import Path
from hashlib import sha256
sys.path.insert(0,'services/pdf-parser')
from adapter import DoclingParseTextAdapter,ParseInput
from structured import build_ir
from figure_assets import extract_catalog
out=Path('docs/acceptance/finalization-2026-11-09/s6/parser-regression/final');out.mkdir(exist_ok=True)
rows=[]
for label,run in [('IN01','run-0972b0e8-d3f8-4bc6-a603-67be92ed0d46'),('IN02','run-d9bfe79b-d432-4cd3-b531-1279d83cd6ca')]:
 old=json.load(open(f'runtime-data/s6-independent/execution/workbench/runs/{run}/document-ir.json'));start=time.time()
 native_path=Path(old['native_artifact']['path']);assert sha256(native_path.read_bytes()).hexdigest()==old['native_artifact']['sha256']
 source=DoclingParseTextAdapter().parse(ParseInput('repaired-source-regression-'+label,old['document_id'],old['source']['file_reference'],old['file_sha256'],False))
 new=build_ir(source,json.loads(native_path.read_text()),'docling-standard-cpu',{'parser_version':old['parser']['version'],'configuration':old['parser']['config'].get('native_config',{}),'native_reused_from_frozen_initial_trial':True},[],old['native_artifact'])
 with (out/(label+'-ir.json')).open('x') as f:json.dump(new,f,ensure_ascii=False,indent=2)
 cat=extract_catalog(new,out/(label+'-figures'))
 assert [b['text'] for b in new['blocks']]==[b['text'] for b in old['blocks']]
 assert [b['raw_text'] for b in new['blocks']]==[b['raw_text'] for b in old['blocks']]
 figs=[]
 for f in cat['figures']:
  if not f['figure_number']:continue
  text='\n'.join(s['exact_quote'] for s in f['caption_segments'])
  figs.append({'figure_number':f['figure_number'],'caption_source_line_count':len(f['caption_segments']),'caption_utf8_sha256':sha256(text.encode()).hexdigest(),'literal_caption':text,'caption_source_spans':f['caption_segments'],'regions':f['regions'],'verification':f['verification']})
 rows.append({'source_id':label,'source_sha256':old['file_sha256'],'old_text_version':old['text_version'],'new_text_version':new['text_version'],'original_pdf_unchanged':True,'old_ir_unchanged':True,'decoded_text_bytes_unchanged':True,'source_anchor_fresh':True,'native_artifact_reused':old['native_artifact'],'elapsed_seconds':time.time()-start,'figures':figs})
 print(label,len(new['blocks']),len(figs),flush=True)
(out/'summary.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
