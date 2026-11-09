import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { makeEvidenceFixture } from '../../../../../tests/extraction/fixtures/evidence-fixtures.js';
import { validateEvidenceSubmission } from '../../../../../packages/agent/src/evidence-validation.js';
import { reconcileEvidence } from '../../../../../packages/agent/src/reconciliation.js';
import { ExtractionSummaryTools } from '../../../../../packages/agent/src/extraction-summary.js';
import { ExtractionStore } from '../../../../../packages/agent/src/extraction-store.js';
import { buildArticleScope } from '../../../../../packages/agent/src/article-scope.js';
import { taskSourceBlockIds } from '../../../../../packages/agent/src/source-selection.js';
import type { EvidenceRecord, EvidenceSubmission } from '@t1/contracts';
const base='docs/acceptance/finalization-2026-11-09/s6/post-holdout-raw-name-repair';
const bytes=await readFile(base+'/IN04-frozen-result.json'),raw=JSON.parse(bytes.toString());
const document=JSON.parse(await readFile(base+'/IN04-frozen-document-ir.json','utf8'));
const versions=raw.records;const first=versions[0].record as EvidenceRecord;
const f=makeEvidenceFixture();f.context.document=document;f.input.run_id=first.extraction_trace.run_id;f.input.document_id=document.document_id;f.input.file_sha256=document.file_sha256;f.input.fixture=false;f.input.scope=first.extraction_trace.scope;
f.context.catalog.catalog_version=f.input.scope.catalog_version;f.context.evidencePolicyVersion=first.extraction_trace.evidence_policy_version;
f.context.metadata={task_id:first.extraction_trace.task_id,article_family_id:first.article_family_id,source_version:first.source_version,document_access:first.document_access,created_at:'2026-11-09T10:03:35.208Z'};
f.context.allowedBlockIds=taskSourceBlockIds(document,buildArticleScope(document));f.context.readBlockIds=raw.coverage.summary_reread_source_block_ids;
const fragments=(xs:any[])=>xs.map(({block_id,exact_quote,occurrence})=>({block_id,exact_quote,occurrence}));
const observed=(o:any)=>o?{value:o.value,status:o.status,evidence:fragments(o.evidence)}:null;
function submission(r:EvidenceRecord):EvidenceSubmission{return {binding:r.extraction_trace.source_binding,source_fragments:fragments(r.quote_span.segments),context_fragments:fragments(r.context.fragments),display_joiner:r.quote_span.display_joiner,feature_binding_id:null,feature_name_raw:r.feature_name_raw,feature_category:r.feature_category,evidence_type:r.evidence_type,disease_or_lesion:observed(r.disease_or_lesion)!,modality:observed(r.modality)!,sequence_or_phase:observed(r.sequence_or_phase),assertion:{...r.assertion,evidence:fragments(r.assertion.evidence)},applicability:{...r.applicability,evidence:fragments(r.applicability.evidence)},numeric_expressions:r.numeric_expressions.map(n=>({...n,evidence:fragments(n.evidence)})),provenance:{...r.context.source_attribution,evidence:fragments(r.context.source_attribution.evidence)},translation_zh:null};}
const valid=versions.map((v:any)=>{const input=submission(v.record);const checked=validateEvidenceSubmission(input,f.context);return {version:v,input,checked};});
let chosen:any;
for(const attempted of valid)for(const target of versions){
 if(chosen||!attempted.checked.record||target.record.record_id===attempted.version.record.record_id)continue;
 const candidate=structuredClone(attempted.checked.record);candidate.extraction_trace.updates_record_id=target.record.record_id;
 try{reconcileEvidence(candidate,versions);}catch(error){if(error instanceof Error&&error.message==='update_target_feature_mismatch')chosen={attempted,target};}
}
assert.ok(chosen,'Need a real-source constructed conflicting target case');
const store=new ExtractionStore(':memory:');store.create(f.input,f.context.metadata);store.transition(f.input.run_id,'extracting');
for(const v of versions)store.apply(f.input.run_id,reconcileEvidence(v.record,store.versions(f.input.run_id)));
store.transition(f.input.run_id,'reconciling');const tools=new ExtractionSummaryTools(f.context,buildArticleScope(document),store,'baseline');
const invoke=(name:string,value:any)=>tools.invoke(name,{run_id:f.input.run_id,document_id:f.input.document_id,...value},'offline-IN04-constructed-target');
await invoke('get_document_context',{});await invoke('read_document_blocks',{block_ids:f.context.readBlockIds});
const before=store.versions(f.input.run_id),input={...chosen.attempted.input,updates_record_id:chosen.target.record.record_id};let caught:any;
try{await invoke('submit_candidate_records',{summary:'Offline constructed target diagnosis only',reviews:[],links:[],updates:[input],summary_complete:false});}catch(error){caught=error;}
assert.equal(caught?.code,'summary_target_feature_requires_explicit_choice');assert.deepEqual(store.versions(f.input.run_id),before);
const source=(r:EvidenceRecord)=>({record_id:r.record_id,feature_name_raw:r.feature_name_raw,source_fragments:r.quote_span.segments,source_sha256:r.source_version.file_sha256,text_version:r.text_version});
const proof={model_calls:0,original_IN04_modified:false,original_wire_target_and_feature_values_available:false,original_log_proves_error_category_only:'update_target_feature_mismatch',constructed_replay_not_original_wire:true,source_and_field_validation_passed:chosen.attempted.checked.accepted,target:source(chosen.target.record),attempted_feature:source(chosen.attempted.version.record),diagnosis:caught.target_conflict_diagnostic,atomic_versions_unchanged:true,source_binding_unchanged:true,no_parameters_rewritten:true,original_frozen_result_sha256:createHash('sha256').update(bytes).digest('hex'),all_six_initial_records:versions.map((v:any)=>({record_id:v.record.record_id,version:v.version,feature_name_raw:v.record.feature_name_raw}))};
await writeFile(base+'/IN04-constructed-target-replay.json',JSON.stringify(proof,null,2)+'\n',{flag:'wx'});store.close();console.log(JSON.stringify({model_calls:0,reproduced_constructed_same_source_target:true,target:proof.target.record_id,original_feature:proof.target.feature_name_raw,constructed_proposed_feature:proof.attempted_feature.feature_name_raw,atomic:true}));
