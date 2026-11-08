import { writeFile } from 'node:fs/promises';
import { EvaluationInputSchema, SourceManifestSchema, SplitManifestSchema, GoldUnitSchema, PredictionSchema, MatchEdgeSchema } from '../evaluation/src/contracts.js';

for (const [name, schema] of Object.entries({ EvaluationInput: EvaluationInputSchema, SourceManifest: SourceManifestSchema,
  SplitManifest: SplitManifestSchema, GoldUnit: GoldUnitSchema, Prediction: PredictionSchema, MatchEdge: MatchEdgeSchema })) {
  await writeFile(`evaluation/contracts/${name}.schema.json`, JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', ...schema }, null, 2) + '\n');
}
