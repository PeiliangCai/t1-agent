import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, lstatSync, mkdtempSync, writeFileSync, rmSync, renameSync, openSync, closeSync, readSync, writeSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const data = '/app/runtime-data';
function files(root, directory = root) {
  return readdirSync(directory).sort().flatMap(name => {
    const path = join(directory, name), stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error('snapshot_unsupported_file');
    return stat.isDirectory() ? files(root, path) : [{ path: relative(root, path), bytes: stat.size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }];
  });
}
const restoring = process.argv[2] === 'restore';
if (restoring && readdirSync(data).length) throw new Error('restore_requires_empty_new_volume');
// Staging a restore on the target filesystem permits atomic renames after all hashes pass.
const temporary = mkdtempSync(join(restoring ? data : tmpdir(), 't1-snapshot-'));
try {
  if (process.argv[2] === 'create') {
    const manifest = { schema_version: 't1-data-snapshot-1', created_at: new Date().toISOString(),
      app_must_be_stopped: true, data_root: 'runtime-data', external_Docling_models_included: false,
      credentials_included: false, files: files(data) };
    writeFileSync(join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    execFileSync('tar', ['-czf', '-', '-C', '/app', 'runtime-data', '-C', temporary, 'manifest.json'], { stdio: ['ignore', 'inherit', 'inherit'] });
  } else if (process.argv[2] === 'restore') {
    const archive = join(temporary, 'snapshot.tar.gz');
    // stdin is copied without parsing shell commands or user-supplied archive paths.
    const output = openSync(archive, 'wx'), buffer = Buffer.alloc(1024 * 1024);
    try { let size; while ((size = readSync(0, buffer, 0, buffer.length, null)) > 0) writeSync(output, buffer, 0, size); } finally { closeSync(output); }
    const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim().split('\n');
    if (members.some(path => path !== 'manifest.json' && path !== 'runtime-data/' && (!path.startsWith('runtime-data/') || path.split('/').includes('..') || path.includes('\\')))) throw new Error('snapshot_invalid_member');
    const details = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (details.split('\n').filter(Boolean).some(line => !['-', 'd'].includes(line[0]))) throw new Error('snapshot_links_forbidden');
    execFileSync('tar', ['-xzf', archive, '--no-same-owner', '--no-same-permissions', '-C', temporary]);
    const manifest = JSON.parse(readFileSync(join(temporary, 'manifest.json'), 'utf8'));
    if (manifest.schema_version !== 't1-data-snapshot-1' || manifest.data_root !== 'runtime-data' || JSON.stringify(files(join(temporary, 'runtime-data'))) !== JSON.stringify(manifest.files)) throw new Error('snapshot_hash_mismatch');
    for (const name of readdirSync(join(temporary, 'runtime-data'))) renameSync(join(temporary, 'runtime-data', name), join(data, name));
    console.error(JSON.stringify({ restored: true, files: manifest.files.length, created_at: manifest.created_at }));
  } else throw new Error('snapshot_operation_required');
} finally { rmSync(temporary, { recursive: true, force: true }); }
