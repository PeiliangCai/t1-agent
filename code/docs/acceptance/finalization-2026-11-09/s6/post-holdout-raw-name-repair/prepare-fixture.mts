// Read-only exact-record round trip. No shared runtime edit and no API call.
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { makeEvidenceFixture } from '../../../../../tests/extraction/fixtures/evidence-fixtures.js';
import { validateEvidenceSubmission } from '../../../../../packages/agent/src/evidence-validation.js';
import type { EvidenceSubmission, EvidenceRecord } from '@t1/contracts';
const prior='docs/acceptance/finalization-2026-11-09/s6/repaired-holdout-IN03';
const result=JSON.parse(await readFile(prior+'/IN03-result.json','utf8'));
const raw=JSON.parse(await readFile(result.ledger.replace('/request-ledger.json','/result.json'),'utf8'));
const record=raw.records.find((v:any)=>v.record.record_id==='ev-58499ee404f45eb7134e5852cc0f69c926d7449e').record as EvidenceRecord;
const document=JSON.parse(await readFile(result.raw_ir.path,'utf8'));
const f=makeEvidenceFixture(); f.context.document=document;f.input.run_id=record.extraction_trace.run_id;f.input.document_id=document.document_id;
f.input.file_sha256=document.file_sha256;f.input.fixture=false;f.input.scope=record.extraction_trace.scope;
f.context.catalog.catalog_version=f.input.scope.catalog_version;f.context.evidencePolicyVersion=record.extraction_trace.evidence_policy_version;
f.context.metadata={task_id:record.extraction_trace.task_id,article_family_id:record.article_family_id,source_version:record.source_version,
 document_access:record.document_access,created_at:'2026-11-09T09:32:23.566Z'};
f.context.allowedBlockIds=document.blocks.map((b:any)=>b.block_id);f.context.readBlockIds=[...f.context.allowedBlockIds];
const fragments=(xs:any[])=>xs.map(({block_id,exact_quote,occurrence})=>({block_id,exact_quote,occurrence}));
const observation=(o:any)=>o?{value:o.value,status:o.status,evidence:fragments(o.evidence)}:null;
const submission:EvidenceSubmission={binding:record.extraction_trace.source_binding,source_fragments:fragments(record.quote_span.segments),
 context_fragments:fragments(record.context.fragments),display_joiner:record.quote_span.display_joiner,feature_binding_id:null,
 feature_name_raw:record.feature_name_raw,feature_category:record.feature_category,evidence_type:record.evidence_type,
 disease_or_lesion:observation(record.disease_or_lesion)!,modality:observation(record.modality)!,sequence_or_phase:observation(record.sequence_or_phase),
 assertion:{...record.assertion,evidence:fragments(record.assertion.evidence)},applicability:{...record.applicability,evidence:fragments(record.applicability.evidence)},
 numeric_expressions:record.numeric_expressions.map(n=>({...n,evidence:fragments(n.evidence)})),
 provenance:{...record.context.source_attribution,evidence:fragments(record.context.source_attribution.evidence)},translation_zh:null};
const cases=[];
for (const name of [null,'对比度','对比\n度']) {
 const input={...submission,feature_name_raw:name};const r=validateEvidenceSubmission(input,f.context);
 cases.push({name,accepted:r.accepted,issues:r.issues,quote_unchanged:r.record?.original_quote===record.original_quote,
  fragments_unchanged:r.record?JSON.stringify(r.record.quote_span.segments)===JSON.stringify(record.quote_span.segments):null});
}
assert.equal(cases[0]!.accepted,true);assert.equal(cases[1]!.accepted,false);
assert.deepEqual(cases[1]!.issues.filter(i=>i.severity==='reject').map(i=>[i.code,i.path]),[['feature_name_not_in_evidence','feature_name_raw']]);
assert.equal(cases[2]!.accepted,true);assert.ok(cases.filter(c=>c.accepted).every(c=>c.quote_unchanged&&c.fragments_unchanged));
await writeFile('docs/acceptance/finalization-2026-11-09/s6/post-holdout-raw-name-repair/fixture.json',JSON.stringify({
 model_calls:0,shared_runtime_changed:false,original_IN03_modified:false,record_id:record.record_id,record_version:1,
 source_text_version:record.text_version,file_sha256:record.source_version.file_sha256,submission,cases,
 meaning:'Read-only reconstruction from delivered v1. This is not full original failed tool-call replay because that wire argument body was not saved. It isolates the same literal raw-name boundary against unchanged actual source.'},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({model_calls:0,cases:cases.map(c=>({name:c.name,accepted:c.accepted,quote_unchanged:c.quote_unchanged}))}));
