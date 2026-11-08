import { readFile, writeFile } from 'node:fs/promises';
import { FigureAssetCatalogSchema, DeliveryReviewSchema, OutputSampleReviewSchema } from '@t1/contracts';
for (const [name, schema] of Object.entries({ FigureAssetCatalog: FigureAssetCatalogSchema, DeliveryReview: DeliveryReviewSchema,
  OutputSampleReview: OutputSampleReviewSchema })) {
  const path = `packages/contracts/schema/${name}.json`, expected = JSON.stringify(schema, null, 2)+'\n';
  const old = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (old !== undefined && old !== expected) throw new Error('delivery_schema_exists_with_different_content:' + name);
  if (old === undefined) await writeFile(path, expected, { flag: 'wx' });
}
process.stdout.write(JSON.stringify({ schemas: 3, legacy_schemas_changed: false })+'\n');
