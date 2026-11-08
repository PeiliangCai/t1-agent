import { mkdir, writeFile } from 'node:fs/promises';
import { DocumentIRSchema, DocumentIRV1Schema, DocumentIRV2Schema, DocumentIRV3Schema, StructuredParserRequestSchema, StructuredParserResultSchema, ParserRequestSchema, ParserResultSchema } from '@t1/contracts';

await mkdir('packages/contracts/schema', { recursive: true });
for (const [name, schema] of Object.entries({ DocumentIR: DocumentIRSchema, DocumentIRV1: DocumentIRV1Schema,
  DocumentIRV2: DocumentIRV2Schema, DocumentIRV3: DocumentIRV3Schema, StructuredParserRequest: StructuredParserRequestSchema,
  StructuredParserResult: StructuredParserResultSchema, ParserRequest: ParserRequestSchema, ParserResult: ParserResultSchema })) {
  await writeFile(`packages/contracts/schema/${name}.json`, JSON.stringify({ title: name, ...schema }, null, 2) + '\n');
}
console.log(JSON.stringify({ schemas: 8, legacyFixtureRewritten: false, formalSelectionModified: false }));
