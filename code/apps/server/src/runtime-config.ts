import { resolve, relative, isAbsolute } from 'node:path';

/** Service operator configuration only. Request bodies never select paths or listeners. */
export function serverRuntime(environment: NodeJS.ProcessEnv = process.env, codeRoot = process.cwd()) {
  const host = environment.T1_SERVER_HOST ?? '127.0.0.1';
  const port = Number(environment.T1_SERVER_PORT ?? '3210');
  if (!['127.0.0.1', '0.0.0.0'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_server_listener');
  const directory = resolve(codeRoot, environment.T1_DATA_DIR ?? 'runtime-data');
  const rel = relative(resolve(codeRoot), directory);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('server_data_directory_outside_code');
  const retained = environment.T1_IMPORT_RETAINED ?? 'true';
  if (!['true', 'false'].includes(retained)) throw new Error('invalid_retained_import_switch');
  return { host, port, directory, database: resolve(directory, 't1.sqlite'), workflowDirectory: resolve(directory, 'workbench'), importRetained: retained === 'true' };
}
