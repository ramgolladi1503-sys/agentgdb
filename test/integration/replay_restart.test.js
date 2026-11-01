import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('captured single-turn playback remains hash-valid after daemon restart and makes no upstream call', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-replay-restart-'));
  const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const dbModule = new URL('../../src/db.js', import.meta.url).href;
  const request = { model: 'fixture-model', messages: [{ role: 'user', content: 'fixture input' }] };
  const response = { id: 'fixture-response', choices: [{ index: 0, message: { role: 'assistant', content: 'fixture output' }, finish_reason: 'stop' }] };
  const seed = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createSession, recordTurn } from '${dbModule}';
    createSession('restart-replay-fixture','restart fixture','fixture-model');
    recordTurn({id:'turn-fixture',session_id:'restart-replay-fixture',turn_index:1,parent_turn_id:null,branch_name:'main',request_payload:${JSON.stringify(JSON.stringify(request))},response_payload:${JSON.stringify(JSON.stringify(response))},tool_calls:'[]',tool_results:'[]',is_cached:0,breakpoint_hit:0,schema_version:1,engine_version:'1.0.0',tokens:4,latency_ms:7,created_at:Date.now()});
  `], { cwd: repoRoot, env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr);

  const appPort = await unusedPort();
  const startDaemon = () => spawn(process.execPath, ['src/server.js'], { cwd: repoRoot, env: { ...process.env, HOME: home, HOST: '127.0.0.1', PORT: String(appPort), AGENTGDB_APPROVAL_TOKEN: 'replay-restart-test-token-0123456789' }, stdio: 'ignore' });
  let daemon = startDaemon();
  t.after(async () => {
    if (daemon && daemon.exitCode === null) await stopDaemon(daemon);
    fs.rmSync(home, { recursive: true, force: true });
  });

  await waitForServer(daemon, appPort);
  await stopDaemon(daemon);
  daemon = startDaemon();
  await waitForServer(daemon, appPort);

  const replay = await fetch(`http://127.0.0.1:${appPort}/api/sessions/restart-replay-fixture/replay/1`);
  assert.equal(replay.status, 200);
  const result = await replay.json();
  assert.deepEqual(result.request, request);
  assert.deepEqual(result.response, response);
  assert.equal(result.deterministic, true);
  assert.equal(result.externalCalls, 0);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.engineVersion, '1.0.0');
});

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(child, port) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`AgentGDB exited during startup with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('AgentGDB did not start before timeout');
}

async function stopDaemon(child) {
  child.kill('SIGTERM');
  if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
}
