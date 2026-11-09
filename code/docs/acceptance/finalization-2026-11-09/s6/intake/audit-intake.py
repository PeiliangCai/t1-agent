# Identity/exposure audit only: no model, algorithm, source-paper annotations, or production DB writes.
from pathlib import Path
import json,hashlib,subprocess,unicodedata,re,zipfile,datetime
root=Path(__file__).resolve().parents[6];code=root/'code';base=Path(__file__).parent
normalize=lambda s:''.join(c for c in unicodedata.normalize('NFKC',s).casefold() if c.isalnum())
provenance=json.loads((base/'download-provenance.json').read_text());physical=json.loads((base/'pdf-identity-and-physical-pages.json').read_text())
metadata=[]
for id,doi in [('IN01','10.3389/fonc.2024.1515240'),('IN02','10.3389/fonc.2025.1680308')]:
 p=base/(id+'-publisher-metadata.json');data=json.loads(p.read_text());m=data['metadata'];assert m['citation_doi']==[doi]
 m.pop('citation_abstract',None);p.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
 metadata.append({'source_id':id,'article_family_id':'doi:'+doi,'doi':doi,'title':m['citation_title'][0],'source_url':m['citation_pdf_url'][0]})
metadata.append({'source_id':'IN03','article_family_id':'yxyjyy:2024:8:19:152-154:hongyafei','doi':None,'title':'磁共振成像应用于直肠癌诊断中的价值研究','source_url':provenance[2]['requested_url']})
for m in metadata:
 check=next(x for x in physical if x['source_id']==m['source_id']);assert normalize(m['title']) in normalize(check['identity_first_page_excerpt'])
 check['identity_first_page_excerpt']=check['identity_first_page_excerpt'].split('Background:')[0].split('Colorectal cancer is')[0].split('【摘要】')[0]
 assert check['physical_pages']==(3 if m['source_id']=='IN03' else 7);assert check['text_layer_on_all_pages']
 (base/(m['source_id']+'-registration-metadata.json')).write_text(json.dumps(m,ensure_ascii=False,indent=2)+'\n')
(base/'pdf-identity-and-physical-pages.json').write_text(json.dumps(physical,ensure_ascii=False,indent=2)+'\n')
historical=json.loads((code/'evaluation/manifests/source-register.json').read_text())['sources']
collisions=[]
for m in metadata:
 own=next(x for x in provenance if x['source_id']==m['source_id'])
 for old in historical:
  if m['article_family_id']==old['article_family_id'] or normalize(m['title'])==normalize(old['title']) or (m['doi'] and m['doi'].casefold()==str(old['doi']).casefold()) or own['sha256']==old['access'].get('sha256'):collisions.append({'id':m['source_id'],'historical_source':old['source_id']})
patterns=[m['doi'] for m in metadata if m['doi']]+[m['title'] for m in metadata]+[p['sha256'] for p in provenance]+['2096-3807(2024)19-0152-03','1237ebe75c7566fe12d90ff4a07855e1']
common=['--hidden','--no-ignore','-g','!**/node_modules/**','-g','!**/.tools/**','-g','!**/.next/**','-g','!.git/**','-g','!code/third_party/**']
args=['rg','-l','-i','-F',*common]
for needle in patterns:args+=['-e',needle]
args+=['.'];hit=subprocess.run(args,cwd=root,text=True,capture_output=True);assert hit.returncode in [0,1],hit.stderr
text_hits=[x.removeprefix('./') for x in hit.stdout.splitlines()]
files=subprocess.run(['rg','--files',*common,'-g','*.pdf','.'],cwd=root,text=True,capture_output=True,check=True).stdout.splitlines();pdf_matches=[]
sha_ids={p['sha256']:p['source_id'] for p in provenance}
for name in files:
 p=root/name;actual=hashlib.file_digest(p.open('rb'),'sha256').hexdigest()
 if actual in sha_ids:pdf_matches.append({'source_id':sha_ids[actual],'path':name.removeprefix('./'),'sha256':actual})
archives=subprocess.run(['rg','--files',*common,'-g','*.docx','-g','*.xlsx','.'],cwd=root,text=True,capture_output=True,check=True).stdout.splitlines();xml_hits=[]
for name in archives:
 try:
  with zipfile.ZipFile(root/name) as z:
   body=' '.join(z.read(x).decode('utf8','ignore') for x in z.namelist() if x.endswith('.xml'))
  n=normalize(re.sub('<[^>]*>',' ',body));matches=[m['source_id'] for m in metadata if normalize(m['title']) in n or m['doi'] and normalize(m['doi']) in n]
  if matches:xml_hits.append({'path':name.removeprefix('./'),'source_ids':matches})
 except (zipfile.BadZipFile,FileNotFoundError):xml_hits.append({'path':name,'read_race_or_invalid_zip':True})
expected_prefixes=('code/docs/acceptance/finalization-2026-11-09/','code/runtime-data/s6-independent/','code/evaluation/corpus/independent-sealed/','code/runtime-data/agent-notes/','code/evaluation/manifests/independent-intake.json')
unexpected=[p for p in text_hits if not p.startswith(expected_prefixes) and 'audit-intake.py' not in p]
old_pdf_matches=[p for p in pdf_matches if not p['path'].startswith(('code/runtime-data/s6-independent/','code/evaluation/corpus/independent-sealed/'))]
report={'schema_version':'s6-independent-identity-exposure-audit-1','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'purpose':'Identity/holdout intake only; never used for tuning, method selection, regression or output-based source replacement.','historical_sources':len(historical),'historical_families':len(set(s['article_family_id'] for s in historical)),'historical_identity_collisions':collisions,'workspace_root':str(root),'workspace_text_marker_hits':text_hits,'unexpected_workspace_text_hits':unexpected,'pdfs_hashed':len(files),'matching_pdfs':pdf_matches,'unexpected_preexisting_pdf_copies':old_pdf_matches,'office_archives_inspected':len(archives),'office_xml_identity_hits':xml_hits,'excluded':'Dependency/tool/Next build trees, git objects and immutable upstream source archive; project application/evaluation/runtime/evidence/research/plan text and PDF files are included.','new_identity_inputs':metadata,'passed':not collisions and not old_pdf_matches and not unexpected and not xml_hits,'paid_model_requests':0,'medical_quality_approved':False}
(base/'exposure-audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:report[k] for k in ['passed','historical_sources','historical_families','pdfs_hashed','office_archives_inspected','unexpected_workspace_text_hits','unexpected_preexisting_pdf_copies','office_xml_identity_hits']},ensure_ascii=False))
