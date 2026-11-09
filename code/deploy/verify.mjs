import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Operator test tool only: unique deployment volumes, synthetic paper, no external model calls.
const subdirectory = process.env.T1_S7_EVIDENCE_SUBDIR ?? '';
assert.match(subdirectory, /^[a-z0-9-]{0,40}$/);
const evidence = resolve('docs/acceptance/finalization-2026-11-09/s7', subdirectory);
mkdirSync(evidence, { recursive: true });
const verificationId = process.env.T1_S7_VERIFY_ID ?? '20261109-a3';
assert.match(verificationId, /^[a-z0-9-]{1,40}$/);
const project = 't1-s7-verification-' + verificationId;
const env = { ...process.env, T1_COMPOSE_PROJECT: project, T1_DATA_VOLUME: project + '-data', T1_WEB_PORT: '30142',
  T1_IMAGE: 't1-workbench:s7-20261109', T1_DEPLOY_MODEL_ENABLED: 'false', T1_DEPLOY_MODEL_API_KEY: '' };
const compose = (...args) => execFileSync('docker', ['compose', '-f', 'compose.yaml', '-f', 'deploy/compose.verify.yaml', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 150_000 });
const docker = (...args) => execFileSync('docker', args, { env, encoding: 'utf8', timeout: 100_000 });
const sha = value => createHash('sha256').update(value).digest('hex');
const base = 'http://127.0.0.1:30142/api/t1';
const report = { schema_version: 's7-container-runtime-verification-1', started_at: new Date().toISOString(), controlled_synthetic: true, paid_requests: 0, production_writes: false, checks: [], unverified: [] };
function checked(name, detail) { report.checks.push({ name, passed: true, detail, at: new Date().toISOString() }); writeFileSync(resolve(evidence, 'runtime-verification.json'), JSON.stringify(report, null, 2) + '\n'); }
async function request(path, method = 'GET', body, expected = 200) {
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { response = await fetch(base + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(90_000) }); break; }
    catch (error) {
      // A service restart can invalidate an idle undici socket. Retry only reads;
      // never retry uploads, starts, review writes or any model admission.
      if (method !== 'GET' || attempt === 2 || !['UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED'].includes(error.cause?.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  if (response.status !== expected) assert.fail(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response;
}
async function json(path, method, body, expected) { return (await request(path, method, body, expected)).json(); }
async function ordinary() {
  const snapshot = {};
  for (const path of ['/health', '/api/workbench/papers', '/api/workbench/runs']) {
    const response = await fetch('http://127.0.0.1:3210' + path); assert.equal(response.status, 200);
    snapshot[path] = sha(await response.text());
  }
  const database = new DatabaseSync(resolve('runtime-data/t1.sqlite'), { readOnly: true });
  try {
    database.exec('BEGIN');
    snapshot.database_tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => {
      assert.match(name, /^[a-zA-Z0-9_]+$/);
      const rows = database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
      return { table: name, rows: rows.length, sha256: sha(JSON.stringify(rows)) };
    });
    database.exec('COMMIT');
  } finally { database.close(); }
  return snapshot;
}
const before = await ordinary(); report.ordinary_before = before;
let runId, paperId, approved;
try {
  // A deliberate rerun must use fresh names, never overwrite an earlier test or user volume.
  assert.equal(docker('volume', 'ls', '--filter', `name=^${env.T1_DATA_VOLUME}$`, '--format', '{{.Name}}').trim(), '', 'verification volume already exists');
  const imageProof = JSON.parse(docker('run', '--rm', '--entrypoint', 'node', env.T1_IMAGE, '-e', `const fs=require('fs');const forbidden=['/app/.env','/app/evaluation','/app/apps/pi-web/public/input-review','/app/apps/pi-web/public/output-review','/app/runtime-data/t1.sqlite']; console.log(JSON.stringify({uid:process.getuid(),node:process.version,forbidden:forbidden.filter(p=>fs.existsSync(p)),docs:fs.readdirSync('/app/docs/acceptance')}));`));
  assert.equal(imageProof.uid, 10001); assert.deepEqual(imageProof.forbidden, []); assert.deepEqual(imageProof.docs.sort(), ['s3', 's4']);
  checked('image contains code and fresh locked dependencies without host data/credentials', imageProof);
  compose('up', '-d', '--wait', '--wait-timeout', '120');
  assert.equal((await json('/workbench/capabilities')).controlled_fixture, true);
  checked('container Next proxy + Fastify health and explicit controlled mode', { url: base + '/workbench/capabilities', fixed_loopback_model_fixture: true, external_model_credentials: false });
  for (const path of ['/api/sessions', '/api/files', '/api/terminal', '/input-review']) {
    const response = await fetch('http://127.0.0.1:30142' + path); assert.equal(response.status, 404);
  }
  checked('generic upstream coding/file/terminal and retired review routes stay closed', { paths: ['/api/sessions', '/api/files', '/api/terminal', '/input-review'], status: 404 });
  execFileSync(resolve('.venv/bin/python'), ['-c', 'import sys\nfrom reportlab.pdfgen.canvas import Canvas\nc=Canvas(sys.argv[1]);c.drawString(72,750,"S7 ENGINEERING FIXTURE");c.drawString(72,710,"CT shows a round nodule.");c.drawString(72,670,"Synthetic text; not medical evidence.");c.showPage();c.save()', resolve(evidence, 'synthetic.pdf')]);
  const pdf = readFileSync(resolve(evidence, 'synthetic.pdf'));
  const uploadedResponse = await fetch(base + '/workbench/papers', { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-t1-filename': 's7-engineering.pdf', 'x-t1-title': 'S7%20ENGINEERING%20ONLY' }, body: pdf });
  assert.equal(uploadedResponse.status, 201); paperId = (await uploadedResponse.json()).paper.id;
  const catalog = await json('/workbench/catalog');
  assert.equal(catalog.restricted_available, false);
  runId = (await json(`/workbench/papers/${paperId}/runs`, 'POST', { scope: catalog.default_scope }, 202)).run.run_id;
  report.paper_id = paperId; report.run_id = runId;
  let detail;
  for (let index = 0; index < 180; index++) {
    detail = await json(`/workbench/runs/${runId}`);
    if (['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(detail.run.state)) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(detail.run.state, 'completed', JSON.stringify(detail));
  assert.equal(detail.source_status, 'valid'); assert.equal(detail.output.records.length, 1);
  assert.equal(detail.output.origin, 'controlled_fixture'); assert.equal(detail.output.records[0].text_approved, false);
  assert.equal(detail.output.records[0].fragments.map(f => f.exact_quote).join('\n'), 'CT shows a round nodule.');
  checked('Next upload -> fresh container Docling CPU -> installed Pi B0 -> persisted candidate', { run_id: runId, records: detail.output.records.length, coverage: detail.output.coverage, medical_quality_approved: false });
  const original = await (await request(`/workbench/papers/${paperId}/pdf`)).arrayBuffer(); assert.equal(sha(new Uint8Array(original)), sha(pdf));
  checked('original PDF download matches uploaded bytes', { sha256: sha(pdf), bytes: pdf.length });
  const record = detail.output.records[0];
  approved = (await json(`/workbench/runs/${runId}/records/${record.id}/review`, 'POST', { expected_version: record.version, action: 'approve_text', reviewer: 'S7 engineering fixture operator', reason: 'Synthetic deployment persistence test only; no medical approval', source_text_checked: true, relevance_checked: true, context_checked: true })).record;
  assert.equal(approved.text_approved, true); assert.equal(approved.figures_approved, false);
  checked('isolated manual text version stored independently from image approval', { record_id: approved.id, version: approved.version, text_approved: true, figures_approved: false, production_approval: false });
  for (const kind of ['candidate_jsonl', 'candidate_csv', 'candidate_package', 'approved_jsonl', 'approved_csv', 'approved_package']) {
    const response = await request(`/workbench/runs/${runId}/exports/${kind}`), bytes = new Uint8Array(await response.arrayBuffer());
    assert.ok(bytes.length); writeFileSync(resolve(evidence, kind + (kind.endsWith('package') ? '.tar.gz' : kind.endsWith('csv') ? '.csv' : '.jsonl')), bytes);
    checked('download ' + kind, { bytes: bytes.length, sha256: sha(bytes), content_type: response.headers.get('content-type') });
  }
  const exportManifest = JSON.parse(execFileSync('tar', ['-xOf', resolve(evidence, 'approved_package.tar.gz'), './manifest.json'], { encoding: 'utf8' }));
  assert.equal(exportManifest.schema_version, 'verbatim-figure-export-1'); assert.equal(exportManifest.mode, 'approved'); assert.equal(exportManifest.run_id, runId);
  assert.equal(exportManifest.controlled_fixture, true); assert.equal(exportManifest.medical_quality_approved, false);
  checked('T2 package manifest keeps current source/run identity and controlled provenance', { schema: exportManifest.schema_version, mode: exportManifest.mode, run_id: runId, medical_quality_approved: false });
  const cid = compose('ps', '-q', 'app').trim();
  const parserProof = docker('exec', cid, 'node', '-e', `const fs=require('fs'),path=require('path');const root='/app/runtime-data';function walk(p){return fs.readdirSync(p,{withFileTypes:true}).flatMap(d=>d.isDirectory()?walk(path.join(p,d.name)):[path.join(p,d.name)]);}for(const p of walk(root).filter(p=>p.endsWith('document-ir.json'))){const v=JSON.parse(fs.readFileSync(p));console.log(JSON.stringify({path:p,parser:v.parser,metrics:v.metrics}));}`);
  writeFileSync(resolve(evidence, 'container-parser-metrics.jsonl'), parserProof);
  const parsedProof = JSON.parse(parserProof.trim());
  assert.equal(parsedProof.parser.id, 'docling-standard-cpu'); assert.equal(parsedProof.metrics.native_metrics.configuration.device, 'cpu');
  assert.equal(parsedProof.metrics.native_metrics.document_result_cache_used, false); assert.equal(parsedProof.metrics.remote_document_uploads, 0); assert.equal(parsedProof.metrics.llm_calls, 0);
  checked('fresh native CPU parser proof without document cache/remote service', { parser_id: parsedProof.parser.id, native_seconds: parsedProof.metrics.native_seconds, document_result_cache_used: false, llm_calls: 0 });
  compose('restart', 'app'); compose('up', '-d', '--wait', '--wait-timeout', '120');
  let restored = await json(`/workbench/runs/${runId}`);
  assert.deepEqual(restored.output.records[0], approved); assert.equal(restored.source_status, 'valid');
  checked('container restart retains SQLite/current human version/source files', { version: approved.version, source_status: restored.source_status });
  const eventResponse = await request(`/workbench/runs/${runId}/events?after=0`), reader = eventResponse.body.getReader();
  let eventText = '';
  while (!/^id: \d+/m.test(eventText)) { const part = await reader.read(); if (part.done) break; eventText += new TextDecoder().decode(part.value); }
  await reader.cancel(); assert.match(eventText, /^id: \d+/m); writeFileSync(resolve(evidence, 'restart-sse.txt'), eventText);
  checked('persisted SSE events replay after container restart', { first_ids: [...eventText.matchAll(/^id: (\d+)/gm)].slice(0, 5).map(match => Number(match[1])) });
  for (const [name, needle] of [['web', 'next-server'], ['backend', 'deploy/controlled-server.ts']]) {
    const id = compose('ps', '-q', 'app').trim();
    docker('exec', id, 'node', '-e', `const fs=require('fs');for(const p of fs.readdirSync('/proc')){if(!/^\\d+$/.test(p)||+p===process.pid)continue;try{const a=fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0');if(a.some(v=>v.includes(${JSON.stringify(needle)}))){process.kill(+p,'SIGKILL');console.log(p);break;}}catch{}}`);
    assert.equal(docker('wait', id).trim(), '1');
    checked('supervisor stops whole container after ' + name + ' child exits', { exit_code: 1 });
    compose('up', '-d', '--wait', '--wait-timeout', '120');
    restored = await json(`/workbench/runs/${runId}`); assert.deepEqual(restored.output.records[0], approved);
  }
  // Production backup wrapper itself is exercised against this isolated volume.
  const backup = resolve(evidence, 'isolated-backup.tar.gz');
  execFileSync('sh', ['deploy/backup.sh', backup], { env: { ...env, COMPOSE_FILE: 'compose.yaml:deploy/compose.verify.yaml' }, encoding: 'utf8', timeout: 160_000 });
  const restoredVolume = project + '-restored';
  assert.equal(docker('volume', 'ls', '--filter', `name=^${restoredVolume}$`, '--format', '{{.Name}}').trim(), '');
  execFileSync('sh', ['deploy/restore.sh', backup], { env: { ...env, T1_DATA_VOLUME: restoredVolume, COMPOSE_FILE: 'compose.yaml:deploy/compose.verify.yaml' }, encoding: 'utf8', timeout: 160_000 });
  checked('stopped consistent backup restored into a separate empty volume', { backup: 'isolated-backup.tar.gz', sha256: sha(readFileSync(backup)), restored_volume: restoredVolume });
  compose('stop', 'app'); env.T1_DATA_VOLUME = restoredVolume; compose('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '120');
  restored = await json(`/workbench/runs/${runId}`); assert.deepEqual(restored.output.records[0], approved); assert.equal(restored.source_status, 'valid');
  assert.equal(sha(new Uint8Array(await (await request(`/workbench/papers/${paperId}/pdf`)).arrayBuffer())), sha(pdf));
  checked('restored service retains run/versions/review and exact PDF/IR', { paper_id: paperId, run_id: runId, version: approved.version, source_status: restored.source_status });
  compose('stop', 'app');
  assert.throws(() => execFileSync('sh', ['deploy/restore.sh', backup], { env: { ...env, COMPOSE_FILE: 'compose.yaml:deploy/compose.verify.yaml' }, timeout: 100_000, stdio: 'pipe' }), error => error.stderr?.toString().includes('restore_requires_empty_new_volume'));
  checked('restore refuses a nonempty volume', { overwrite: false });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = { message: error.message?.slice(0, 1800), cause: error.cause?.code, stack: error.stack?.split('\n').slice(0, 5) }; process.exitCode = 1; }
finally {
  try { writeFileSync(resolve(evidence, 'container-runtime.log'), compose('logs', '--no-color', 'app')); } catch {}
  try { compose('down'); } catch (error) { report.cleanup_error = error.message; process.exitCode = 1; }
  report.ordinary_after = await ordinary(); assert.deepEqual(report.ordinary_after, before);
  report.ordinary_preserved = true; report.finished_at = new Date().toISOString();
  writeFileSync(resolve(evidence, 'runtime-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, report: relative(process.cwd(), resolve(evidence, 'runtime-verification.json')) }));
}
