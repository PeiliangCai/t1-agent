/** Zero-model-call recovery of reports/packages from the stopped, unchanged initial execution. */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { exportEvidenceDelivery } from '../../../../packages/agent/src/evidence-delivery.ts';
import { DatabaseSync } from 'node:sqlite';
const code=process.cwd(),base=resolve('docs/acceptance/finalization-2026-11-09/s6'),runtime=resolve('runtime-data/s6-independent/execution');
const load=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
const plan=await load(resolve(base,'plan.json')), events=(await readFile(resolve(base,'progress.jsonl'),'utf8')).trim().split('\n').map(JSON.parse), db=new DatabaseSync(resolve(runtime,'workflow.sqlite'),{readOnly:true});
const report:any={at:new Date().toISOString(),model_calls:0,production_mutations:0,original_trial_not_rewritten:true,rows:[]};
for(const admission of events.filter((r:any)=>r.type==='http_admission')){
 const {run_id,source_id}=admission.details,row=JSON.parse(db.prepare('SELECT payload_json FROM workbench_runs WHERE id=?').get(run_id)!.payload_json as string),source=plan.inputs.find((p:any)=>p.source_id===source_id);
 const raw=await load(resolve(row.directory,'result.json')),document=row.source.document,catalog=row.source.catalog,versions=raw.versions??raw.records;
 const destination=resolve(runtime,'candidate-packages',source_id),parent=dirname(destination);
 if(source_id==='IN02'){
  try{await exportEvidenceDelivery(document,versions,{codeRoot:code,directory:resolve(runtime,'missing-parent-reproduction-never-created','IN02'),catalog,mode:'candidates',coverage:row.coverage??{}});report.probe={reproduced:false};}
  catch(error){const e=error as NodeJS.ErrnoException;report.probe={reproduced:true,code:e.code,syscall:e.syscall,path:e.path,stack:e.stack};}
  if(report.probe?.code!=='ENOENT')throw new Error('expected missing package parent reproduction');
 }
 await mkdir(parent,{recursive:true});try{await access(resolve(destination,'manifest.json'));}catch{await exportEvidenceDelivery(document,versions,{codeRoot:code,directory:destination,catalog,mode:'candidates',coverage:row.coverage??{}});}
 const detail=await load(resolve(base,source_id+'-workbench-detail.json')),delivery=await load(resolve(base,source_id+'-delivery.json')),material=await load(resolve(base,source_id+'-review-material.json'));
 const business=(await readFile(resolve(base,source_id+'-events.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 const first=business[0]?.received_at??null,candidate=business.find(e=>e.event.type==='candidate')?.received_at??null,terminal=business.filter(e=>e.event.type==='state').at(-1)?.received_at??null;
 const parseStart=events.find((r:any)=>r.type==='fresh_cpu_parse_start'&&r.details.source_id===source_id)?.at,parseEnd=events.find((r:any)=>r.type==='fresh_cpu_parse_end'&&r.details.source_id===source_id)?.at;
 const ledger=await load(resolve(row.directory,'request-ledger.json'));const coverage=row.coverage??{};
 const state=(db.prepare('SELECT state FROM s4_runs WHERE id=?').get(run_id) as any).state;
 const result={source_id,paper_id:row.paper_id,run_id,status:state,admitted_at:admission.at,terminal_at:terminal,task_processing_complete:coverage.task_processing_complete===true,
  timing:{http_admission_seconds:null,http_admission_note:'Client-side timer was lost when package export threw before result persistence; no invented value.',first_progress_seconds:first?(Date.parse(first)-Date.parse(admission.at))/1000:null,first_candidate_seconds:candidate?(Date.parse(candidate)-Date.parse(admission.at))/1000:null,terminal_seconds:terminal?(Date.parse(terminal)-Date.parse(admission.at))/1000:null,anchor:'Observed SSE receipt minus backend admission; original client POST timestamp unavailable.',population_p95:null},
  parse_started_at:parseStart,parse_finished_at:parseEnd,fresh_parse_seconds:(Date.parse(parseEnd)-Date.parse(parseStart))/1000,
  usage:{requests:ledger.requests.length,input_tokens:ledger.requests.reduce((n:number,r:any)=>n+(r.input_tokens??r.input_ceiling),0),output_tokens:ledger.requests.reduce((n:number,r:any)=>n+(r.output_tokens??r.output_ceiling),0)},ledger:relative(code,resolve(row.directory,'request-ledger.json')),
  parser_status:document.parser.status,parser_limits:document.coverage.limitations,output_count:delivery.records.length+(delivery.background_records?.length??0),primary_count:delivery.records.length,background_count:delivery.background_records?.length??0,figure_count:catalog?.figures.length??0,
  random_sample_count:material.random_sample_count,random_denominator:material.random_denominator,unprocessed_block_ids:coverage.task_scope_unprocessed_source_block_ids??[],failed_block_ids:coverage.task_scope_failed_source_block_ids??[],
  processed_block_count:coverage.explicitly_completed_source_blocks,task_block_count:coverage.task_scope_source_blocks,candidate_package:relative(code,destination),raw_ir:row.source.ir,figure_catalog:row.source.catalog_artifact,postprocessing_recovered_after_stop:true,model_calls_during_recovery:0,medical_quality_approved:false,actual_human_reviewed_count:0};
 try{await access(resolve(base,source_id+'-result.json'));}catch{await writeFile(resolve(base,source_id+'-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});}report.rows.push(result);
}
db.close();report.unadmitted_source_ids=plan.inputs.map((p:any)=>p.source_id).filter((id:string)=>!report.rows.some((r:any)=>r.source_id===id));report.actual_two_task_overlap=report.rows.some((a:any)=>report.rows.some((b:any)=>a.source_id!==b.source_id&&Date.parse(a.admitted_at)<Date.parse(b.terminal_at)&&Date.parse(b.admitted_at)<Date.parse(a.terminal_at)));report.original_summary_overlap_false_is_postprocessing_artifact=true;
await writeFile(resolve(base,'postprocessing-recovery.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({rows:report.rows.map((r:any)=>({source_id:r.source_id,state:r.status,complete:r.task_processing_complete,output:r.output_count})),probe:report.probe?.code,unadmitted:report.unadmitted_source_ids,actual_overlap:report.actual_two_task_overlap,model_calls:0}));
