# Reset only this task's dedicated test clone. Production is read-only; source files are never copied back.
from pathlib import Path
import sqlite3,json,datetime
root=Path(__file__).resolve().parents[4];dest=root/'runtime-data/s5-ui-audit/workflow.sqlite'
a=sqlite3.connect('file:'+str(root/'runtime-data/t1.sqlite')+'?mode=ro',uri=True);b=sqlite3.connect(dest);a.backup(b);a.close()
c=sqlite3.connect('file:'+str(root/'runtime-data/s5-controlled-browser/workflow.sqlite')+'?mode=ro',uri=True)
run='run-8c7ac0c1-b83c-4587-b264-5242c7132039';row=c.execute('select * from workbench_runs where id=?',(run,)).fetchone();paper=row[1]
with b:
 for table,col,value in [('workbench_papers','id',paper),('s4_runs','id',run),('workbench_runs','id',run),('s4_events','run_id',run),('s4_versions','run_id',run),('s4_batches','run_id',run),('workbench_reviews','run_id',run),('workbench_annotations','run_id',run)]:
  rows=c.execute('select * from '+table+' where '+col+'=?',(value,)).fetchall()
  for record in rows:b.execute('insert or ignore into '+table+' values('+','.join('?'*len(record))+')',record)
b.close();c.close()
r={'prepared_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'production_db_access':'SQLite read-only backup','saved_source_access':'read-only; original files remain pinned','isolated_database':str(dest),'controlled_fixture_run':run,'controlled_fixture_paper':paper,'write_directory':'runtime-data/s5-ui-audit/workbench','no_model_runner':True,'existing_controlled_replay_not_new_extraction':True}
(Path(__file__).parent/'isolated-fixture.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))
