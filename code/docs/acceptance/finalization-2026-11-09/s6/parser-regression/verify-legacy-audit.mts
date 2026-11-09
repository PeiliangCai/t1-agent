import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { auditLegacySourceGlyphs } from '../../../../../packages/agent/src/parser.js';
import { sourceGlyphQuarantine, buildSourceEvidenceUnits } from '../../../../../packages/agent/src/source-evidence-units.js';
import { buildArticleScope } from '../../../../../packages/agent/src/article-scope.js';
import { selectSourceBlocks, taskSourceBlockIds } from '../../../../../packages/agent/src/source-selection.js';
import { locateEvidenceFragment } from '../../../../../packages/agent/src/evidence-validation.js';
const results=[];
for (const [paper,run] of [['IN01','run-0972b0e8-d3f8-4bc6-a603-67be92ed0d46'],['IN02','run-d9bfe79b-d432-4cd3-b531-1279d83cd6ca']]) {
 const path=`runtime-data/s6-independent/execution/workbench/runs/${run}/document-ir.json`;
 const raw=await readFile(path), old=JSON.parse(raw.toString()), before=JSON.stringify(old), {document,audit}=await auditLegacySourceGlyphs(old);
 assert.equal(JSON.stringify(old),before);assert.deepEqual(await readFile(path),raw);
 const quarantine=sourceGlyphQuarantine(document), units=buildSourceEvidenceUnits(document),scope=buildArticleScope(document),selection=selectSourceBlocks(document,scope,'B0'),allowed=taskSourceBlockIds(document,scope);
 assert.ok(quarantine.every(id=>!allowed.includes(id)&&!selection.kept_block_ids.includes(id)));
 const known=audit.uncertain_source_spans.filter(s=>s.font_program_sha256==='c1b3d51d3cfb5aea54e1130eefb6c4e6bc4b01776a0ecc26ba1837a4f64e0a54');
 for(const issue of known) {const b=document.blocks.find(x=>x.block_id===issue.block_id)!;assert.throws(()=>locateEvidenceFragment(document,{block_id:b.block_id,exact_quote:b.text}),/source_glyph_fidelity_unverified/);}
 const oldUnits=buildSourceEvidenceUnits(old);
 const unsafeUnits=units.filter(u=>u.boundary_reasons.includes('source_glyph_fidelity_unverified'));
 results.push({paper,source_sha256:document.file_sha256,original_ir_sha256:createHash('sha256').update(raw).digest('hex'),old_ir_preserved:true,model_calls:0,
 audit,all_source_blocks:document.blocks.length,all_literal_source_units:units.length,directly_flagged_blocks:new Set(audit.uncertain_source_spans.map(s=>s.block_id)).size,
 quarantined_complete_unit_transport_blocks:quarantine.length,quarantined_block_ids:quarantine,flagged_literal_source_units:unsafeUnits.length,
 affected_previously_complete_sentences:unsafeUnits.filter(u=>oldUnits.find(o=>o.unit_id===u.unit_id)?.completeness==='complete').length,
 affected_previously_unverified_units:unsafeUnits.filter(u=>oldUnits.find(o=>o.unit_id===u.unit_id)?.completeness!=='complete').length,
 proven_source_glyph_errors:known.length,other_suspected_glyphs_not_proven_errors:audit.uncertain_source_spans.length-known.length,
 task_scope_blocks:scope.included_block_ids.length-selection.excluded_block_ids.length,model_authorized_blocks:allowed.length,
 quarantine_in_task_unprocessed_denominator:true,quarantine_source_text_not_sent_to_model:true});
}
await writeFile('docs/acceptance/finalization-2026-11-09/s6/parser-regression/legacy-font-audit.json',JSON.stringify(results,null,2)+'\n',{flag:'w'});
console.log(JSON.stringify(results.map(({audit,...r})=>({...r,audit_issue_count:audit.uncertain_source_spans.length}))));
