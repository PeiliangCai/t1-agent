/** One new, explicitly authorized B0 development regression. Preparation/preflight never call a model. */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ContractError } from '@t1/contracts';
import { safeError } from '../packages/agent/src/config.js';
import { prepareB0Revalidation, preflightB0Revalidation, executeB0Revalidation } from '../packages/agent/src/b0-revalidation.js';
const args = process.argv.slice(2), action = args.shift(), flags = new Map<string, string>();
if (action === '--help') {
  process.stdout.write('revalidate-b0.ts prepare --directory NEW_DIRECTORY [--config config/b0-s4-revalidation.json]\nrevalidate-b0.ts preflight --directory PREPARED_DIRECTORY [--authorization NEW_USER_AUTHORIZATION]\nrevalidate-b0.ts execute --directory PREPARED_DIRECTORY --authorization NEW_USER_AUTHORIZATION\nprepare/preflight are offline. B0 only, no comparison, no old quota or execution resume.\n');
} else try {
  for (let i = 0; i < args.length; i += 2) {
    if (!['--directory', '--config', '--authorization'].includes(args[i]!) || !args[i + 1] || flags.has(args[i]!)) throw new ContractError('b0_arguments_invalid');
    flags.set(args[i]!, args[i + 1]!);
  }
  if (!flags.has('--directory') || !['prepare', 'preflight', 'execute'].includes(action ?? '') ||
    action !== 'prepare' && flags.has('--config') || action === 'prepare' && flags.has('--authorization')) throw new ContractError('b0_action_arguments_invalid');
  const directory = resolve(flags.get('--directory')!);
  if (action === 'prepare') {
    const result = await prepareB0Revalidation(flags.get('--config') ?? 'config/b0-s4-revalidation.json', directory);
    process.stdout.write(JSON.stringify({ status: result.plan.status, directory, plan_sha256: result.plan_sha256, model_provider_requests: 0 }) + '\n');
  } else if (action === 'preflight') {
    const { report } = await preflightB0Revalidation(directory, flags.get('--authorization'));
    await writeFile(resolve(directory, 'preflight.json'), JSON.stringify(report, null, 2) + '\n'); process.stdout.write(JSON.stringify(report) + '\n');
  } else {
    if (!flags.has('--authorization')) throw new ContractError('new_b0_revalidation_user_authorization_required');
    const report = await executeB0Revalidation(directory, flags.get('--authorization')!); if (report.status === 'stopped_after_failure') process.exitCode = 1;
    process.stdout.write(JSON.stringify(report) + '\n');
  }
} catch (error) { process.stdout.write(JSON.stringify({ status: 'failed', error: safeError(error), usage_evidence: 'Use any execution/report.json and its shared call-ledger; an error line never resets or proves zero usage.' }) + '\n'); process.exitCode = 1; }
