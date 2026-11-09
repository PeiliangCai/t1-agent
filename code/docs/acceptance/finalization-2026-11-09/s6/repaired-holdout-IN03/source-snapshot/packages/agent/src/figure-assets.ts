import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { relative, resolve } from 'node:path';
import { ContractError, type FigureAssetCatalog } from '@t1/contracts';
import type { ExtractionDocument } from './article-scope.js';
import { assertParsedDocument } from './parser.js';
import { assertFigureCatalog } from './evidence-delivery.js';

const CODE = fileURLToPath(new URL('../../../', import.meta.url));
/** A current extraction may not relabel an old IR as the evidence for a changed/missing PDF. */
export async function assertLivePdfSource(document: ExtractionDocument): Promise<void> {
  if (document.fixture) return;
  const code = await realpath(CODE);
  const path = await realpath(resolve(code, document.source.file_reference)).catch(() => { throw new ContractError('source_pdf_unavailable'); });
  const rel = relative(code, path);
  if (!rel || rel.startsWith('..')) throw new ContractError('source_pdf_outside_code');
  const bytes = await readFile(path).catch(() => { throw new ContractError('source_pdf_unavailable'); });
  if (createHash('sha256').update(bytes).digest('hex') !== document.file_sha256) throw new ContractError('source_pdf_changed_since_ir');
}
/** Local CPU source-asset step, outside the model's tool boundary. Failure must not suppress valid text. */
export async function discoverPdfFigures(document: ExtractionDocument, directory: string, signal?: AbortSignal): Promise<FigureAssetCatalog> {
  assertParsedDocument(document);
  await assertLivePdfSource(document);
  if (signal?.aborted) throw new ContractError('figure_discovery_cancelled');
  const root = await realpath(CODE), parent = await realpath(directory), rel = relative(root, parent);
  if (rel.startsWith('..') || rel === '') throw new ContractError('figure_directory_outside_code');
  const inputPath = resolve(parent, 'figure-discovery-input.json'), assetsPath = resolve(parent, 'figure-assets');
  await writeFile(inputPath, JSON.stringify(document)+'\n', { flag: 'wx', mode: 0o600 });
  await new Promise<void>((accept, reject) => {
    const child = spawn(resolve(root, '.venv/bin/python'), [resolve(root, 'services/pdf-parser/figure_assets.py'),
      '--document', inputPath, '--output', assetsPath], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', env: { ...process.env, OMP_NUM_THREADS: '4', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } });
    let ended = false;
    const finish = (error?: Error) => {
      if (ended) return; ended = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) {
        try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* exited */ }
        reject(error);
      } else accept();
    };
    const abort = () => finish(new ContractError('figure_discovery_cancelled'));
    const timer = setTimeout(() => finish(new ContractError('figure_discovery_timeout')), 60000);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    child.on('error', () => finish(new ContractError('figure_discovery_process_unavailable')));
    child.on('close', code => finish(code === 0 ? undefined : new ContractError('figure_discovery_failed')));
    if (signal?.aborted) abort();
  });
  const catalog: unknown = JSON.parse(await readFile(resolve(assetsPath, 'catalog.json'), 'utf8'));
  assertFigureCatalog(document, catalog);
  return catalog;
}
