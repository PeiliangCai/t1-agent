import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { evaluate } from '../evaluation/src/evaluator.js';

// Explicit input and purpose-specific output paths. No model, database, dotenv or parser imports.
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const input = flag('--input'), output = flag('--output');
if (!input || !output || args.length !== 4) throw new Error('usage: npm run eval:quality -- --input FILE --output FILE');
const root = process.cwd();
const inputBytes = await readFile(resolve(root, input));
const report = { ...evaluate(JSON.parse(inputBytes.toString('utf8'))), input_file_path: input,
  input_file_sha256: createHash('sha256').update(inputBytes).digest('hex') };
const allowedRoot = resolve(root, report.fixture === true ? 'evaluation/reports/fixtures' : 'evaluation/reports/real');
const outputPath = resolve(root, output);
const relation = relative(allowedRoot, outputPath);
if (relation === '' || relation.startsWith('..' + sep) || relation === '..' || resolve(allowedRoot, relation) !== outputPath) throw new Error('output_must_be_inside_purpose_specific_report_directory');
// Exclusive creation preserves earlier reports. Parent directories are intentionally prepared in the package.
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ status: report.status, fixture: report.fixture, official_acceptance: report.official_acceptance, output }) + '\n');
if (report.status === 'invalid_input') process.exitCode = 1;
if (report.status === 'not_evaluable') process.exitCode = 2;
