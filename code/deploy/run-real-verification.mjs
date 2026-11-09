import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { runContainerBrowser } from './browser-run.mjs';
import { DatabaseSync } from 'node:sqlite';
import { processableScopeCompleted } from './coverage-check.mjs';

// Operator-only harness. check/dry-run never load real credentials or dispatch a provider.
const [command, planPath, suppliedSha] = process.argv.slice(2);
const code = process.cwd(), hash = bytes => createHash('sha256').update(bytes).digest('hex');
function inside(path) { const rel = relative(code, resolve(path)); assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel)); }
async function ordinarySnapshot() {
  const snapshot = {};
  for (const path of ['/health', '/api/workbench/papers', '/api/workbench/runs']) {
    const response = await fetch('http://127.0.0.1:3210' + path); assert.equal(response.status, 200);
    const text = await response.text(); snapshot[path] = hash(text);
    if (path.endsWith('/runs')) assert.ok(JSON.parse(text).runs.every(run => ['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(run.state)), 'ordinary user task is active');
  }
  const database = new DatabaseSync(resolve('runtime-data/t1.sqlite'), { readOnly: true });
  try {
    database.exec('BEGIN');
    snapshot.tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => {
      assert.match(name, /^[a-zA-Z0-9_]+$/); const rows = database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
      return { table: name, rows: rows.length, sha256: hash(JSON.stringify(rows)) };
    }); database.exec('COMMIT');
  } finally { database.close(); }
  return snapshot;
}
const bytes = await readFile(resolve(planPath)), plan = JSON.parse(bytes.toString()), planSha = hash(bytes), dry = command === 'dry-run';
inside(planPath); inside(plan.input.path); inside(plan.evidence_directory);
assert.match(plan.plan_id, /^[a-z0-9-]{1,55}$/);
assert.equal(hash(await readFile(resolve(plan.input.path))), plan.input.sha256);
for (const [path, digest] of Object.entries(plan.code_sha256 ?? {})) { inside(path); assert.equal(hash(await readFile(resolve(path))), digest, 'host source pin changed'); }
const docker = (...args) => execFileSync('sudo', ['-n', 'docker', ...args], { encoding: 'utf8', timeout: 160_000 });
function collectState(imageId, volume) {
  // SQLite in WAL mode may need transient -shm files even for a read-only connection.
  // Keep the stopped source volume readonly and open an isolated /tmp copy instead.
  return execFileSync('sudo', ['-n', 'docker', 'run', '--rm', '--mount', `type=volume,src=${volume},dst=/app/runtime-data,readonly`, '--entrypoint', 'node', imageId, '-e',
    `const fs=require('fs'),path=require('path'),{DatabaseSync}=require('node:sqlite');const root='/app/runtime-data';function walk(p){return fs.readdirSync(p,{withFileTypes:true}).flatMap(d=>d.isDirectory()?walk(path.join(p,d.name)):[path.join(p,d.name)]);}const all=walk(root),data={};for(const p of all.filter(p=>p.endsWith('allowance.json')||p.endsWith('request-ledger.json')||p.endsWith('loopback-ledger.json')))data[path.relative(root,p)]=JSON.parse(fs.readFileSync(p));const tmp=fs.mkdtempSync('/tmp/t1-state-');for(const n of ['t1.sqlite','t1.sqlite-wal','t1.sqlite-shm'])if(fs.existsSync(root+'/'+n))fs.copyFileSync(root+'/'+n,tmp+'/'+n);const db=new DatabaseSync(tmp+'/t1.sqlite',{readOnly:true});data.reviews=db.prepare('SELECT COUNT(*) n FROM workbench_reviews').get().n;data.annotations=db.prepare('SELECT COUNT(*) n FROM workbench_annotations').get().n;data.runs=db.prepare('SELECT id,state FROM s4_runs').all();db.close();fs.rmSync(tmp,{recursive:true});console.log(JSON.stringify(data));`], { encoding: 'utf8', timeout: 120_000 });
}
const image = JSON.parse(docker('image', 'inspect', plan.image_id))[0]; assert.equal(image.Id, plan.image_id);
if (!dry && (command !== 'collect-state' || plan.schema_version === 's7-one-container-run-1')) { const { assertContainerPlan } = await import('./one-run-allowance.ts'); assertContainerPlan(plan); }
docker('run', '--rm', '--entrypoint', 'node', image.Id, '-e', `const fs=require('fs'),c=require('crypto'),pins=JSON.parse(process.argv[1]);for(const [p,d]of Object.entries(pins)){if(c.createHash('sha256').update(fs.readFileSync('/app/'+p)).digest('hex')!==d)throw Error('image_code_pin_changed:'+p);}console.log('image code pins verified; no requests');`, JSON.stringify(plan.code_sha256 ?? {}));
if (command === 'collect-state') {
  const snapshot = collectState(image.Id, 't1-s7-' + plan.plan_id + '-data');
  await writeFile(resolve(plan.evidence_directory, 'allowance-ledger-and-state.json'), JSON.stringify(JSON.parse(snapshot), null, 2) + '\n');
  console.log(JSON.stringify({ collected: true, provider_requests_dispatched: 0 }));
}
else if (command === 'check') { console.log(JSON.stringify({ plan_sha256: planSha, host_input_and_code_pins: true, image_code_pins: true, image_id: image.Id, paid_requests: 0 })); }
else if (dry || command === 'execute') {
  if (!dry) {
    assert.equal(suppliedSha, planSha, 'exact new approved plan SHA required');
    assert.equal(plan.authorization?.authorized_runs, 1); assert.equal(plan.authorization.scope, 'S7_single_container_deployment_reverification');
  }
  const project = 't1-s7-' + plan.plan_id, volume = project + '-data', runtime = resolve('runtime-data/s7-real-deployment', plan.plan_id), evidence = resolve(plan.evidence_directory);
  inside(runtime); assert.equal(existsSync(runtime), false, 'one attempt only; no implicit retry');
  assert.equal(docker('volume', 'ls', '--filter', `name=^${volume}$`, '--format', '{{.Name}}').trim(), '', 'must use a fresh volume');
  await mkdir(runtime, { recursive: true, mode: 0o700 }); await mkdir(evidence, { recursive: true, mode: 0o700 });
  const secret = resolve(runtime, 'model.env'), report = { schema_version: 's7-one-container-verification-1', plan_sha256: planSha, dry_run: dry, started_at: new Date().toISOString(),
    image_id: image.Id, volume, project, production_data_touched: false, business_review_added: false, phase: 'preparing' };
  const variables = ['T1_COMPOSE_PROJECT', 'T1_DATA_VOLUME', 'T1_WEB_PORT', 'T1_IMAGE', 'T1_DEPLOY_MODEL_ENABLED', 'T1_DEPLOY_MODEL_API_KEY', 'T1_VERIFY_PLAN', 'T1_VERIFY_SECRET'];
  const env = { ...process.env, T1_COMPOSE_PROJECT: project, T1_DATA_VOLUME: volume, T1_WEB_PORT: '30142', T1_IMAGE: image.Id,
    T1_DEPLOY_MODEL_ENABLED: 'false', T1_DEPLOY_MODEL_API_KEY: '', T1_VERIFY_PLAN: resolve(planPath), T1_VERIFY_SECRET: secret };
  const files = ['-f', 'compose.yaml', '-f', dry ? 'deploy/compose.verify.yaml' : 'deploy/compose.real-verification.yaml'];
  const compose = (...args) => execFileSync('sudo', ['-n', '--preserve-env=' + variables.join(','), 'docker', 'compose', ...files, ...args], { env, encoding: 'utf8', timeout: 160_000 });
  const save = () => writeFile(resolve(evidence, 'execution-report.json'), JSON.stringify(report, null, 2) + '\n');
  try {
    report.ordinary_before = await ordinarySnapshot();
    if (!dry) {
      const { loadModelConfig } = await import('../packages/agent/src/config.ts');
      const config = loadModelConfig(resolve('.env'), { T1_MODEL_PROVIDER: plan.model.provider, T1_MODEL_BASE_URL: plan.model.endpoint, T1_MODEL_ID: plan.model.model_id });
      await writeFile(secret, 'T1_MODEL_API_KEY=' + JSON.stringify(config.apiKey()) + '\n', { flag: 'wx', mode: 0o400 });
      execFileSync('sudo', ['-n', 'chown', '10001:10001', secret]);
    }
    await save(); compose('up', '-d', '--wait', '--wait-timeout', '120');
    const cid = compose('ps', '-q', 'app').trim(), container = JSON.parse(docker('inspect', cid))[0];
    const values = Object.fromEntries(container.Config.Env.map(value => value.split(/=(.*)/s).slice(0, 2)));
    assert.equal(Boolean(values.T1_MODEL_API_KEY), false);
    report.container = { id: cid, image: container.Image, configured_image: container.Config.Image, model_key_in_docker_environment: false,
      private_key_file_mounted: !dry, private_key_read_only: dry ? null : container.Mounts.find(mount => mount.Destination === '/run/secrets/t1-model.env')?.RW === false };
    report.phase = 'browser'; await save();
    report.browser = await runContainerBrowser({ ...plan, controlled_fixture: dry, seconds: plan.limits?.seconds ?? 120 });
    const processableComplete = processableScopeCompleted(report.browser);
    report.phase = 'terminal'; report.processable_scope_completed_with_disclosed_source_gaps = processableComplete;
    report.full_document_processing_claimed = false; report.passed = report.browser.passed && processableComplete;
    if (!report.passed) process.exitCode = 1;
  } catch (error) { report.phase = 'stopped'; report.passed = false; report.error = error.stack?.split('\n').slice(0, 5); process.exitCode = 1; }
  finally {
    // Browser cleanup errors never bypass this independent container/data/secret cleanup.
    try { await writeFile(resolve(evidence, 'container.log'), compose('logs', '--no-color', 'app')); } catch {}
    try { compose('down'); report.container_stopped = true; } catch (error) { report.container_stop_error = error.message; process.exitCode = 1; }
    try {
      const snapshot = collectState(image.Id, volume);
      await writeFile(resolve(evidence, 'allowance-ledger-and-state.json'), JSON.stringify(JSON.parse(snapshot), null, 2) + '\n');
      const state = JSON.parse(snapshot); assert.equal(state.reviews, 0); assert.equal(state.annotations, 0);
      report.review_rows = 0; report.annotation_rows = 0;
      if (!dry) { assert.equal(state['allowance.json']?.closed, true); assert.equal(state['allowance.json']?.unused_allowance_closed, true); report.unused_allowance_closed = true; }
    } catch (error) { report.state_collection_error = error.message; report.passed = false; process.exitCode = 1; }
    try { await unlink(secret); report.private_key_copy_removed = true; } catch (error) { if (error.code !== 'ENOENT') { report.secret_cleanup_error = error.message; process.exitCode = 1; } }
    try { report.ordinary_after = await ordinarySnapshot(); assert.deepEqual(report.ordinary_after, report.ordinary_before); report.ordinary_preserved = true; }
    catch (error) { report.ordinary_comparison_error = error.message; report.passed = false; process.exitCode = 1; }
    report.finished_at = new Date().toISOString(); await save(); console.log(JSON.stringify({ passed: report.passed, dry_run: dry, phase: report.phase, report: relative(code, resolve(evidence, 'execution-report.json')) }));
  }
} else throw new Error('use check, dry-run, or execute with an explicitly approved plan SHA');
