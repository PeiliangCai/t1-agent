import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, { alias: { '@': process.cwd() }, moduleCache: false });
const { invalidateSessionListCache, getSessionListVersion, listAllSessions } = await jiti.import('./session-reader.ts');
const { isT1ApiPath } = await jiti.import('../t1/gateway-policy.ts');
const sdk = pathToFileURL(join(process.cwd(), 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href;

for (const mode of ['sessions-dir-present', 'sessions-dir-absent']) test(`retained session-reader library observes independent SDK writes (${mode})`, { timeout: 15000 }, async (t) => {
  const existingRoot = mode === 'sessions-dir-present';
  const dir = await mkdtemp(join(tmpdir(), 'pi-membership-api-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  invalidateSessionListCache();
  const requestList = async () => ({ sessions: await listAllSessions(), sessionListVersion: getSessionListVersion() });

  try {
    if (existingRoot) await mkdir(join(dir, 'sessions'));
    const initial = await requestList();
    assert.deepEqual(initial.sessions, []);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { SessionManager } from ${JSON.stringify(sdk)};
      const sm = SessionManager.create(${JSON.stringify(dir)});
      sm.appendMessage({ role: 'user', content: 'external SDK writer', timestamp: Date.now() });
      console.log(sm.getSessionId());
    `], { encoding: 'utf8', env: process.env });
    assert.equal(result.status, 0, result.stderr);
    const id = result.stdout.trim();
    const persistedAt = Date.now();
    let snapshot;
    const deadline = Date.now() + 3000;
    do {
      snapshot = { sessionListVersion: getSessionListVersion() };
      if (snapshot.sessionListVersion > initial.sessionListVersion) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.ok(snapshot.sessionListVersion > initial.sessionListVersion, 'disk change must advance the version without force refresh');
    t.diagnostic(`new file observed ${Date.now() - persistedAt}ms after external writer exited`);
    assert.equal(isT1ApiPath('/api/sessions'), false, 'retained cache does not reopen the session API');
    assert.equal(isT1ApiPath('/api/agent/running'), false, 'SDK file writes do not publish an agent API');
    const updated = await requestList();
    assert.equal(updated.sessions.find(s => s.id === id)?.firstMessage, 'external SDK writer');
    const stable = updated.sessionListVersion;
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(getSessionListVersion(), stable, 'reads must not create an invalidation loop');
    if (existingRoot) {
      const file = updated.sessions.find(s => s.id === id).path;
      for (const operation of ['append', 'delete']) {
        const before = getSessionListVersion();
        const source = operation === 'append'
          ? `import { SessionManager } from ${JSON.stringify(sdk)}; SessionManager.open(${JSON.stringify(file)}).appendMessage({role:'user',content:'second message',timestamp:Date.now()});`
          : `import { unlinkSync } from 'node:fs'; unlinkSync(${JSON.stringify(file)});`;
        const writer = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', env: process.env });
        assert.equal(writer.status, 0, writer.stderr);
        if (operation === 'append') {
          await new Promise(resolve => setTimeout(resolve, 500));
          assert.equal(getSessionListVersion(), before, 'appending output does not invalidate the catalogue');
        } else {
          const until = Date.now() + 3000;
          while (getSessionListVersion() === before && Date.now() < until) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          assert.ok(getSessionListVersion() > before);
          assert.equal((await requestList()).sessions.find(s => s.id === id), undefined);
        }
      }
    }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    await rm(dir, { recursive: true, force: true });
  }
});
