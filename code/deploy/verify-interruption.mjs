import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Separate fixture volume; interrupt an actual open local Responses stream after a candidate is saved.
const env = { ...process.env, T1_COMPOSE_PROJECT: 't1-s7-interruption', T1_DATA_VOLUME: 't1-s7-interruption-data', T1_WEB_PORT: '30142',
  T1_IMAGE: 't1-workbench:s7-20261109', T1_DEPLOY_MODEL_ENABLED: 'false', T1_S7_FIXTURE_SUMMARY_DELAY_MS: '30000' };
const compose = (...args) => execFileSync('docker', ['compose', '-f', 'compose.yaml', '-f', 'deploy/compose.verify.yaml', ...args], { env, encoding: 'utf8', timeout: 150_000 });
const base = 'http://127.0.0.1:30142/api/t1/workbench';
const path = resolve('docs/acceptance/finalization-2026-11-09/s7/container-interruption.json');
const report = { schema_version: 's7-container-active-interruption-1', controlled_synthetic: true, paid_requests: 0, started_at: new Date().toISOString() };
async function request(suffix, method = 'GET', body, status = 200) {
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { response = await fetch(base + suffix, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40_000) }); break; }
    catch (error) { if (method !== 'GET' || attempt === 2) throw error; await new Promise(resolve => setTimeout(resolve, 300)); }
  }
  assert.equal(response.status, status); return response.json();
}
async function savedCandidate(id) {
  for (let i = 0; i < 90; i++) {
    const detail = await request('/runs/' + id);
    if (detail.output.records.length && detail.run.state === 'reconciling') return detail;
    if (['failed', 'cancelled', 'interrupted', 'completed', 'partial'].includes(detail.run.state)) assert.fail('fixture did not hold its summary stream: ' + detail.run.state);
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.fail('candidate not saved before summary hold');
}
try {
  assert.equal(execFileSync('docker', ['volume', 'ls', '--filter', `name=^${env.T1_DATA_VOLUME}$`, '--format', '{{.Name}}'], { encoding: 'utf8' }).trim(), '', 'use a fresh interruption volume');
  compose('up', '-d', '--wait', '--wait-timeout', '100');
  const uploaded = await fetch(base + '/papers', { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-t1-filename': 'interruption-engineering.pdf' }, body: readFileSync(resolve('docs/acceptance/finalization-2026-11-09/s7/synthetic.pdf')) });
  assert.equal(uploaded.status, 201); const paper = (await uploaded.json()).paper, catalog = await request('/catalog');
  const first = (await request(`/papers/${paper.id}/runs`, 'POST', { scope: catalog.default_scope }, 202)).run.run_id;
  const original = await savedCandidate(first); assert.equal(original.output.records.length, 1);
  compose('restart', 'app'); compose('up', '-d', '--wait', '--wait-timeout', '100');
  const interrupted = await request('/runs/' + first);
  assert.equal(interrupted.run.state, 'interrupted'); assert.equal(interrupted.source_status, 'valid'); assert.deepEqual(interrupted.output.records, original.output.records);
  await new Promise(resolve => setTimeout(resolve, 1500)); assert.equal((await request('/runs/' + first)).run.state, 'interrupted');
  const second = (await request(`/papers/${paper.id}/runs`, 'POST', { scope: catalog.default_scope }, 202)).run.run_id;
  assert.notEqual(second, first); const fresh = await savedCandidate(second);
  assert.equal(fresh.source_status, 'valid'); assert.equal(fresh.output.records[0].run_id, second); assert.equal(fresh.output.records[0].text_approved, false);
  await request('/runs/' + second + '/cancel', 'POST', {});
  assert.equal((await request('/runs/' + second)).run.state, 'cancelled'); assert.equal((await request('/runs/' + first)).run.state, 'interrupted');
  Object.assign(report, { passed: true, first_run: first, second_run: second, first_saved_candidates: 1, second_saved_candidates: 1, automatic_resume: false,
    original_human_reviews: 0, new_run_approval: false, new_run_from_original_pdf: true, states: { first: 'interrupted', second: 'cancelled' } });
} catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; }
finally {
  try { writeFileSync(resolve('docs/acceptance/finalization-2026-11-09/s7/container-interruption.log'), compose('logs', '--no-color', 'app')); } catch {}
  try { compose('down'); } catch (error) { report.cleanup_error = error.message; process.exitCode = 1; }
  report.finished_at = new Date().toISOString(); writeFileSync(path, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
}
