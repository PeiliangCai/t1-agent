import { mkdir, writeFile } from 'node:fs/promises';
import { ScopeSchema, FeatureBindingSchema, RunInputSchema, DocumentIRSchema, CandidateRecordSchema, BusinessEventSchema } from '@t1/contracts';
import { makeFixture } from '@t1/agent';

await mkdir('packages/contracts/schema', { recursive: true });
for (const [name, schema] of Object.entries({ Scope: ScopeSchema, FeatureBinding: FeatureBindingSchema, RunInput: RunInputSchema, DocumentIR: DocumentIRSchema, CandidateRecord: CandidateRecordSchema, BusinessEvent: BusinessEventSchema })) {
  await writeFile(`packages/contracts/schema/${name}.json`, JSON.stringify({ title: name, ...schema }, null, 2) + '\n');
}
const fixture = makeFixture({ provider: 'engineering-fixture', modelId: 'not-executed', baseUrl: 'https://example.invalid/v1' });
fixture.input.run_id = 'example-fixture-run';
fixture.input.document_id = fixture.document.document_id = 'example-fixture-document';
fixture.document.blocks.forEach(block => { block.document_id = fixture.document.document_id; });
await writeFile('evaluation/fixtures/engineering-example.json', JSON.stringify({ fixture: true, medical_evidence: false, ...fixture }, null, 2) + '\n');
await writeFile('resources/feature-catalog/engineering-demo.json', JSON.stringify(fixture.catalog, null, 2) + '\n');
console.log(JSON.stringify({ schemas: 6, fixture: 'evaluation/fixtures/engineering-example.json', medical_evidence: false }));
