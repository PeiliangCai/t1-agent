import { spawn } from 'node:child_process';

// Fixed application entrypoints. No shell, user commands, network endpoint selection or coding API.
const entry = process.env.T1_SERVER_ENTRY ?? 'apps/server/src/main.ts';
if (!['apps/server/src/main.ts', 'deploy/controlled-server.ts', 'deploy/one-run-server.ts'].includes(entry)) throw new Error('invalid_server_entry');
const children = [
  ['backend', ['--import', 'tsx', entry], '/app'],
  ['web', ['node_modules/next/dist/bin/next', 'start', '--hostname', '0.0.0.0', '--port', '30141'], '/app/apps/pi-web'],
].map(([name, args, cwd]) => ({ name, child: spawn(process.execPath, args, { cwd, stdio: 'inherit', detached: true }), done: false }));
let closing = false;
function signal(child, value) { try { process.kill(-child.pid, value); } catch (error) { if (error.code !== 'ESRCH') console.error('child_signal_failed', error.code); } }
async function close(code) {
  if (closing) return; closing = true;
  for (const { child, done } of children) if (!done) signal(child, 'SIGTERM');
  const timer = setTimeout(() => { for (const { child, done } of children) if (!done) signal(child, 'SIGKILL'); }, 65_000);
  await Promise.all(children.map(({ child, done }) => done ? undefined : new Promise(resolve => child.once('exit', resolve))));
  clearTimeout(timer); process.exitCode = code;
}
for (const item of children) {
  item.child.once('error', () => { item.done = true; console.error('application_child_spawn_failed', item.name); void close(1); });
  item.child.once('exit', (code, signal) => { item.done = true; console.error('application_child_exit', item.name, code, signal); if (!closing) void close(1); });
}
process.once('SIGTERM', () => void close(0));
process.once('SIGINT', () => void close(0));
