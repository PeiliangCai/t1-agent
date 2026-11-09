# Read-only logical database and pinned source checks. Never restores or writes production data.
from pathlib import Path
import sqlite3,json,hashlib,datetime,urllib.request
root=Path(__file__).resolve().parents[4];base=Path(__file__).parent
con=sqlite3.connect('file:'+str(root/'runtime-data/t1.sqlite')+'?mode=ro',uri=True)
names=[x[0] for x in con.execute("select name from sqlite_master where type='table' order by name")]
snap={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'tables':{}}
for name in names:
 rows=con.execute('select * from '+name+' order by rowid').fetchall();raw=json.dumps(rows,ensure_ascii=False,separators=(',',':')).encode();snap['tables'][name]={'rows':len(rows),'sha256':hashlib.sha256(raw).hexdigest()}
before=json.loads((base/'production-db-before.json').read_text());snap['all_tables_unchanged']=snap['tables']==before['tables'];snap['changed_tables']=[x for x in set(snap['tables'])|set(before['tables']) if snap['tables'].get(x)!=before['tables'].get(x)]
artifacts={}
def visit(v):
 if isinstance(v,dict):
  if isinstance(v.get('path'),str) and isinstance(v.get('sha256'),str) and len(v['sha256'])==64:artifacts[(v['path'],v['sha256'])]=True
  for part in v.values():visit(part)
 elif isinstance(v,list):
  for part in v:visit(part)
for table in ['workbench_papers','workbench_runs']:
 for (raw,) in con.execute('select payload_json from '+table):visit(json.loads(raw))
checks=[]
for path,expected in artifacts:
 full=(root/path).resolve();assert full.is_relative_to(root)
 if not full.is_file():checks.append({'path':path,'matches_registered_sha256':False,'error':'missing'});continue
 actual=hashlib.file_digest(full.open('rb'),'sha256').hexdigest();checks.append({'path':path,'matches_registered_sha256':actual==expected,'sha256':actual})
result={'at':snap['at'],'all_registered_sources_match':all(x['matches_registered_sha256'] for x in checks),'checked_artifacts':len(checks),'artifacts':checks,'method':'Read hashes against registered pinned artifacts; no source write, file restore or approval operation.'}
(base/'production-db-after.json').write_text(json.dumps(snap,ensure_ascii=False,indent=2)+'\n');(base/'production-source-integrity.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'all_tables_unchanged':snap['all_tables_unchanged'],'changed_tables':snap['changed_tables'],'checked_source_artifacts':len(checks),'all_registered_sources_match':result['all_registered_sources_match']}))
