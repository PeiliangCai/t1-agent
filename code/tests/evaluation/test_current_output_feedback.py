"""Offline renderer/feedback compatibility tests. No browser server or model calls."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

CODE = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('current_output_builder', CODE / 'scripts/build-current-output-review.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class CurrentOutputFeedback(unittest.TestCase):
    def test_received_legacy_opinions_keep_their_original_questionnaire_binding(self):
        root = CODE / 'docs/acceptance/s0-s4-recheck-2026-11-08'
        builder.verify_opinions(root, root / 'output-review/本轮输出核验意见-2026-11-08-05-42-28.json')

    def test_future_ui_runs_real_question_controls_and_roundtrips_explicit_issue_codes(self):
        with tempfile.TemporaryDirectory(prefix='review-ui-contract-', dir=CODE / '.tools') as folder:
            instance = builder.Builder(Path(folder), builder.EXPECTED_PLAN)
            instance.output = Path(folder)
            instance.write_ui()
            path = Path(folder) / 'review.js'
            js = path.read_text()
            self.assertNotIn("'row_column'", js)
            self.assertNotIn("'incomplete_figure'", js)
            # Exercise the generated event handlers/payload validator, without
            # touching frozen pages or pretending this is Chromium verification.
            js = js.replace('  load();', "  globalThis.uiTest = {setPack: p => {pack=p;currentId=p.cases[0].case_id;}, renderQuestions, payload, validateOpinions};")
            path.write_text(js)
            program = r"""
const assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
class Element {
  constructor(tag='div') { this.tag=tag;this.children=[];this.dataset={};this.listeners={};this.attributes={};this.value='all'; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children=children; }
  setAttribute(k,v) { this.attributes[k]=v; }
  addEventListener(k,fn) { this.listeners[k]=fn; }
  querySelectorAll(selector) {
    const all=this.children.flatMap(c => c instanceof Element ? [c,...c.querySelectorAll('*')] : []);
    return all.filter(c => selector==='*' || selector==='button' && c.tag==='button' || selector==='input' && c.tag==='input' || selector==='input:checked' && c.tag==='input' && c.checked);
  }
}
const ids=new Map(), document={getElementById:id=>{if(!ids.has(id))ids.set(id,new Element());return ids.get(id);},createElement:tag=>new Element(tag),createTextNode:s=>s};
const ctx=vm.createContext({document,location:{origin:'http://synthetic',hash:''},localStorage:{setItem(){}},TextEncoder,Uint8Array,DataView,console});
vm.runInContext(fs.readFileSync(process.argv[1],'utf8'),ctx);
const c={case_id:'C1',source_id:'synthetic',pdf_sha256:'a',artifact_sha256:'b',case_version:'v',source_binding:{record_version:1},pages:[{physical_page:1}],questions:[{question_id:'literal_and_context',text:'Q1'},{question_id:'target_visual_description',text:'Q2'},{question_id:'figure_correspondence',text:'Q3'}]};
ctx.uiTest.setPack({pack_id:'synthetic',pack_sha256:'sha',questionnaire_version:'current-output-ordinary-screening-2',plan_sha256:'plan',execution_report_sha256:'report',cases:[c]});
ctx.uiTest.renderQuestions();
const card=q=>ids.get('questions').children.find(n=>n.dataset.questionId===q);
const choose=(q,verdict,code)=>{
  const node=card(q), buttons=node.querySelectorAll('button');
  buttons.find(b=>b.dataset.verdict===verdict).listeners.click();
  assert.equal(ctx.uiTest.payload().opinions.find(o=>o.question_id===q).problem_types.length,0,'verdict does not auto-assign problem types');
  const input=node.querySelectorAll('input').find(i=>i.type==='checkbox'&&i.value===code);
  assert.ok(input,code); input.checked=true;input.listeners.change();
};
choose('target_visual_description','has_problem','not_target_visual');
choose('figure_correspondence','cannot_judge','figure_uncertain');
const out=JSON.parse(JSON.stringify(ctx.uiTest.payload()));
assert.deepEqual(out.opinions.map(o=>o.problem_types),[['not_target_visual'],['figure_uncertain']]);
assert.equal(Object.keys(ctx.uiTest.validateOpinions(out)).length,2);
const old=structuredClone(out);old.questionnaire_version='current-output-ordinary-screening-1';assert.throws(()=>ctx.uiTest.validateOpinions(old));
const stale=structuredClone(out);stale.opinions[0].source_binding.record_version=2;assert.throws(()=>ctx.uiTest.validateOpinions(stale));
const duplicate=structuredClone(out);duplicate.opinions.push(duplicate.opinions[0]);assert.throws(()=>ctx.uiTest.validateOpinions(duplicate));
console.log('generated UI runtime controls and bound export/import passed; no automatic issue assignment; no browser/model calls');
"""
            result = subprocess.run([str(CODE / '.tools/node/bin/node'), '-e', program, str(path)], check=True, capture_output=True, text=True)
            self.assertIn('runtime controls and bound export/import passed', result.stdout)


if __name__ == '__main__':
    unittest.main()
