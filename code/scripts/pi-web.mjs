import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, mkdirSync } from 'node:fs';

const code = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = resolve(code, 'apps/pi-web');
const command = process.argv[2];
const executable = command === 'check'
  ? resolve(frontend, 'node_modules/typescript/bin/tsc')
  : resolve(frontend, 'node_modules/next/dist/bin/next');
const args = command === 'check' ? ['--noEmit']
  : command === 'build' ? ['build', '--webpack']
  : ['dev', 'start'].includes(command) ? [command, '--hostname', '127.0.0.1', '--port', '5173'] : null;
if (!args) throw new Error('Use pi-web.mjs dev|build|start|check');
if (command === 'dev' || command === 'build') {
  const pdf = resolve(frontend, 'node_modules/pdfjs-dist');
  const output = resolve(frontend, 'public/t1-assets/pdfjs');
  mkdirSync(output, { recursive: true });
  cpSync(resolve(pdf, 'build/pdf.worker.min.mjs'), resolve(output, 'pdf.worker.min.mjs'));
  cpSync(resolve(pdf, 'LICENSE'), resolve(output, 'LICENSE'));
  for (const directory of ['cmaps', 'standard_fonts', 'wasm']) cpSync(resolve(pdf, directory), resolve(output, directory), { recursive: true });
}
const child = spawn(process.execPath, [executable, ...args, ...process.argv.slice(3)], {
  cwd: frontend, stdio: 'inherit', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { console.error('Pi Web dependencies unavailable. Run npm ci in apps/pi-web with --ignore-scripts.'); process.exitCode = 1; });
child.on('exit', (status, signal) => { process.exitCode = status ?? (signal ? 1 : 0); });
