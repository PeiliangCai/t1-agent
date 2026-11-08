import { writeFile } from 'node:fs/promises';
import { EvidenceSubmissionSchema, EvidenceRecordSchema, EvidenceCatalogSchema, ScopeMatchSchema } from '@t1/contracts';
for (const [name, schema] of Object.entries({ EvidenceSubmission: EvidenceSubmissionSchema, EvidenceRecord: EvidenceRecordSchema,
  EvidenceCatalog: EvidenceCatalogSchema, EvidenceScopeMatch: ScopeMatchSchema })) {
  await writeFile('packages/contracts/schema/' + name + '.json', JSON.stringify(schema, null, 2) + '\n');
}
