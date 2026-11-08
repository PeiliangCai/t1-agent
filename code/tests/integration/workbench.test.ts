import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RunStore } from '@t1/agent';
import { buildApp } from '../../apps/server/src/app.js';
import { WorkbenchSources } from '../../apps/server/src/workbench.js';
import { isT1ApiPath, t1BackendPath } from '../../apps/pi-web/t1/gateway-policy.js';

test('T1 path allowlist rejects generic coding APIs, path injection and unknown routes', () => {
  for (const path of ['/api/terminal', '/api/files/etc/passwd', '/api/auth/providers', '/api/agent/new', '/api/sessions', '/api/t1/agent/new', '/api/t1/workbench/papers/../pdf']) assert.equal(isT1ApiPath(path), false, path);
  assert.equal(t1BackendPath(['workbench', 'papers', 'L05']), '/api/workbench/papers/L05');
  for (const parts of [['workbench', 'papers', '..'], ['workbench', 'papers', 'L01/pdf'], ['workbench', 'papers', '%2e%2e'], ['terminal']]) assert.equal(t1BackendPath(parts), null);
  assert.equal(t1BackendPath(['runs', 'known:run-1', 'events']), '/api/runs/known%3Arun-1/events');
});

test('registered historical evidence is source-bound, verbatim and visibly unapproved', async () => {
  const sources = new WorkbenchSources(), papers = await sources.papers();
  assert.equal(papers.length, 5);
  let records = 0, paired = 0;
  for (const paper of papers) {
    const detail = await sources.detail(paper.id);
    assert.equal(detail.source_verified, true); assert.equal(detail.read_only, true);
    assert.equal(detail.paper.sha256, paper.sha256);
    for (const output of detail.outputs) {
      assert.equal(output.origin, 'historical_compatibility_replay');
      assert.equal(output.medical_quality_approved, false); assert.equal(output.full_recall_claimed, false);
      records += output.records.length;
      for (const record of output.records) {
        assert.ok(record.fragments.length); assert.ok(record.fragments.every(fragment => fragment.text_version === detail.text_version));
        if (record.association === 'paired') { paired++; assert.ok(record.figure_ids.length); }
        else assert.equal(record.figure_ids.length, 0);
      }
    }
    assert.ok(detail.figures.filter(figure => figure.verification === 'needs_review').every(figure => figure.assets.length === 0));
  }
  assert.equal(records, 119); assert.equal(paired, 1);
});

test('source changes and paths outside code are rejected before serving results', async () => {
  const directory = await mkdtemp(resolve('runtime-data/workbench-source-test-'));
  const registry = JSON.parse(await readFile(resolve('config/pi-web-workbench.json'), 'utf8'));
  const path = resolve(directory, 'registry.json');
  try {
    registry.papers[0].ir.sha256 = '0'.repeat(64);
    await writeFile(path, JSON.stringify(registry));
    await assert.rejects(new WorkbenchSources(process.cwd(), path).detail('L01'), /workbench_source_changed/);
    registry.papers[0].pdf.path = '/bin/sh';
    await writeFile(path, JSON.stringify(registry));
    await assert.rejects(new WorkbenchSources(process.cwd(), path).pdf('L01'), /workbench_source_outside_code/);
  } finally { await rm(directory, { recursive: true }); }
});

test('read-only HTTP views serve exact original assets and preserve unavailable capabilities', async () => {
  const store = new RunStore(), app = buildApp(store);
  try {
    const caps = (await app.inject('/api/workbench/capabilities')).json();
    for (const key of ['paper_upload', 'extraction_start', 'persisted_review', 'approved_export', 'full_S5_complete']) assert.equal(caps[key], false);
    assert.equal(caps.backend_pi_sdk, '1.4.0'); assert.equal('annotation_url' in caps, false);
    assert.deepEqual((await app.inject('/api/workbench/runs')).json(), { runs: [] });
    assert.equal((await app.inject('/api/workbench/papers/unknown')).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: '/api/workbench/papers' })).statusCode, 404);
    const detail = (await app.inject('/api/workbench/papers/L05')).json();
    const pdf = await app.inject('/api/workbench/papers/L05/pdf');
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.equal(createHash('sha256').update(pdf.rawPayload).digest('hex'), detail.paper.sha256);
    const figure = detail.figures.find((value: { assets: unknown[] }) => value.assets.length);
    const asset = figure.assets[0];
    const response = await app.inject(`/api/workbench/papers/L05/figures/${asset.id}`);
    assert.equal(response.headers['content-type'], 'image/png');
    assert.equal(createHash('sha256').update(response.rawPayload).digest('hex'), asset.sha256);
    const pending = detail.figures.find((value: { verification: string }) => value.verification === 'needs_review');
    if (pending) assert.equal((await app.inject(`/api/workbench/papers/L05/figures/${pending.id}-0`)).statusCode, 404);
    assert.equal((await app.inject('/api/workbench/papers/L05/figures/unknown')).statusCode, 404);
  } finally { await app.close(); store.close(); }
});
