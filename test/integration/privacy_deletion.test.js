import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('trace purge removes selected records and optional summaries without deleting newer turns', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-privacy-purge-'));
  const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const dbModule = new URL('../../src/db.js', import.meta.url).href;
  const seed = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createSession, recordTurn, createApproval } from '${dbModule}';
    const now=Date.now();
    const turn=(id,sessionId,createdAt)=>recordTurn({id,session_id:sessionId,turn_index:1,parent_turn_id:null,branch_name:'main',request_payload:'private-fixture',response_payload:'private-fixture',tool_calls:'[]',tool_results:'[]',is_cached:0,breakpoint_hit:0,schema_version:1,engine_version:'1.0.0',request_hash:null,response_hash:null,tokens:1,latency_ms:1,created_at:createdAt});
    createSession('old-session','old','fixture');
    turn('old-turn','old-session',now-1000);
    createSession('mixed-session','mixed','fixture');
    turn('new-turn','mixed-session',now+100000);
    createApproval({id:'old-approval',sessionId:'old-session',action:{name:'write_file'},risk:'MUTATING',expiresAt:now+60000});
  `], { cwd: repoRoot, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr);

  const appPort = await unusedPort();
  const daemon = spawn(process.execPath, ['src/server.js'], { cwd: repoRoot, env: { ...process.env, HOME: home, USERPROFILE: home, HOST: '127.0.0.1', PORT: String(appPort), AGENTGDB_APPROVAL_TOKEN: 'privacy-purge-test-token-0123456789' }, stdio: 'ignore' });
  let db;
  let reader;
  t.after(async () => {
    db?.close();
    reader?.close();
    daemon.kill('SIGTERM');
    if (daemon.exitCode === null) await new Promise((resolve) => daemon.once('exit', resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });

  await waitForServer(daemon, appPort);
  reader = new Database(path.join(home, '.agentgdb', 'traces.db'), { readonly: true });
  reader.exec('BEGIN');
  reader.prepare('SELECT id FROM turns ORDER BY id').all();
  const before = Date.now() + 1000;
  const response = await fetch(`http://127.0.0.1:${appPort}/api/traces?before=${before}&includeSessionMetadata=true`, { method: 'DELETE', headers: { 'x-agentgdb-approval-token': 'privacy-purge-test-token-0123456789' } });
  assert.equal(response.status, 200);
  const deletion = await response.json();
  assert.equal(deletion.deletedTurns, 1);
  assert.equal(deletion.deletedApprovals, 1);
  assert.equal(deletion.deletedSessions, 1);
  assert.equal(deletion.storageCheckpoint.complete, false, 'pinned WAL must not be reported as fully checkpointed');
  assert.ok(Number.isInteger(deletion.storageCheckpoint.busy));

  reader.exec('ROLLBACK');
  reader.close();
  reader = null;
  const retry = await fetch(`http://127.0.0.1:${appPort}/api/traces?before=${before}&includeSessionMetadata=true`, { method: 'DELETE', headers: { 'x-agentgdb-approval-token': 'privacy-purge-test-token-0123456789' } });
  assert.equal(retry.status, 200);
  const retryResult = await retry.json();
  assert.deepEqual(retryResult, {
    deletedTurns: 0, deletedApprovals: 0, deletedSessions: 0,
    storageCheckpoint: { complete: true, busy: 0, framesRemaining: 0 }
  });

  db = new Database(path.join(home, '.agentgdb', 'traces.db'), { readonly: true });
  assert.deepEqual(db.prepare('SELECT id FROM turns ORDER BY id').all().map((row) => row.id), ['new-turn']);
  assert.deepEqual(db.prepare('SELECT id FROM sessions ORDER BY id').all().map((row) => row.id), ['mixed-session']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM approvals').get().n, 0);
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
