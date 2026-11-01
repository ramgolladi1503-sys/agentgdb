import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const responsePayload = {
  id: 'completion-fixture',
  choices: [{ message: { role: 'assistant', content: 'access_token: "XyZaBcDeFgHiJkLmNoPq123456"', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'write_file', arguments: '{"path":"secret-tool-argument-sentinel"}' } }] } }],
  usage: { total_tokens: 9 }
};

for (const captureEnabled of [false, true]) {
  test(`proxy payload capture ${captureEnabled ? 'stores full payloads when enabled' : 'is metadata-only by default'}`, async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-proxy-'));
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(responsePayload));
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const appPort = await unusedPort();
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: path.resolve(fileURLToPath(new URL('../..', import.meta.url))),
      env: {
        ...process.env,
        HOME: home,
        HOST: '127.0.0.1',
        PORT: String(appPort),
        UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
        AGENTGDB_TRACE_CAPTURE: captureEnabled ? 'true' : 'false',
      AGENTGDB_APPROVAL_TIMEOUT_MS: '10000',
      AGENTGDB_APPROVAL_TOKEN: 'integration-test-approval-token-1'
      },
      stdio: 'ignore'
    });
    let db;
    t.after(async () => {
      db?.close();
      child.kill('SIGTERM');
      if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
      await new Promise((resolve) => upstream.close(resolve));
      fs.rmSync(home, { recursive: true, force: true });
    });

    await waitForServer(child, appPort);
    fs.mkdirSync(path.join(home, '.agentgdb'), { recursive: true });
    const workspace = path.join(home, 'workspace');
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(home, '.agentgdb', 'projects.json'), JSON.stringify({ activeProjectId: 'fixture', projects: [{ id: 'fixture', name: 'fixture', workspacePath: workspace, allowedPaths: ['**'], forbiddenPaths: [] }] }));
    const requestPayload = { model: 'fixture-model', messages: [{ role: 'user', content: 'secret-request-sentinel api_key=AbCdEfGhIjKlMnOp123456' }] };
    const responsePromise = fetch(`http://127.0.0.1:${appPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer upstream-test-key', 'x-agentgdb-session': 'capture-test' },
      body: JSON.stringify(requestPayload)
    });
    {
      let pending;
      for (let attempt = 0; attempt < 30; attempt++) {
        const pendingResponse = await fetch(`http://127.0.0.1:${appPort}/api/approvals`);
        pending = (await pendingResponse.json()).approvals[0];
        if (pending) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(pending);
      await fetch(`http://127.0.0.1:${appPort}/api/approvals/${pending.id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agentgdb-approval-token': 'integration-test-approval-token-1' }, body: JSON.stringify({ decision: 'APPROVED' }) });
      const resolved = await responsePromise;
      assert.equal(resolved.status, 200);
    }
    const response = await responsePromise;
    if (!captureEnabled) assert.equal(response.status, 200);

    db = new Database(path.join(home, '.agentgdb', 'traces.db'), { readonly: true });
    const turn = db.prepare("SELECT request_payload, response_payload, tool_calls FROM turns WHERE session_id = 'capture-test'").get();
    assert.ok(turn);
    if (captureEnabled) {
      assert.match(turn.request_payload, /secret-request-sentinel/);
      assert.doesNotMatch(turn.request_payload, /AbCdEfGhIjKlMnOp123456/);
      assert.match(turn.response_payload, /secret-tool-argument-sentinel/);
      assert.doesNotMatch(turn.response_payload, /XyZaBcDeFgHiJkLmNoPq123456/);
      assert.match(turn.tool_calls, /secret-tool-argument-sentinel/);
      const replay = await fetch(`http://127.0.0.1:${appPort}/api/sessions/capture-test/replay/1`);
      const replayResult = await replay.json();
      assert.equal(replay.status, 200);
      assert.equal(replayResult.deterministic, true);
      assert.equal(replayResult.externalCalls, 0);
    } else {
      assert.equal(turn.request_payload, null);
      assert.equal(turn.response_payload, null);
      assert.doesNotMatch(turn.tool_calls, /secret-tool-argument-sentinel/);
      assert.match(turn.tool_calls, /write_file/);
      const replay = await fetch(`http://127.0.0.1:${appPort}/api/sessions/capture-test/replay/1`);
      assert.equal(replay.status, 409);
    }
  });
}

test('streamed mutating tool call is buffered until durable approval decision', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-approval-'));
  const upstream = http.createServer((_req, res) => {
    const base = { id: 'stream-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture' };
    const chunks = [
      { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'write_file', arguments: '{"path":"src/' } }] }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'main.js"}' } }] }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const appPort = await unusedPort();
  fs.mkdirSync(path.join(home, '.agentgdb'), { recursive: true });
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(home, '.agentgdb', 'projects.json'), JSON.stringify({ activeProjectId: 'fixture', projects: [{ id: 'fixture', name: 'fixture', workspacePath: workspace, allowedPaths: ['**'], forbiddenPaths: [] }] }));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(fileURLToPath(new URL('../..', import.meta.url))),
    env: { ...process.env, HOME: home, HOST: '127.0.0.1', PORT: String(appPort), UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, AGENTGDB_APPROVAL_TIMEOUT_MS: '10000', AGENTGDB_APPROVAL_TOKEN: 'integration-test-approval-token-1' },
    stdio: 'ignore'
  });
  t.after(async () => {
    child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });
  await waitForServer(child, appPort);
  const requestPromise = fetch(`http://127.0.0.1:${appPort}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-agentgdb-session': 'approval-test' },
    body: JSON.stringify({ model: 'fixture', messages: [], stream: true })
  });
  let approvals;
  for (let i = 0; i < 30; i++) {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/approvals`);
    approvals = (await response.json()).approvals;
    if (approvals.length) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].status, 'PENDING');
  const unauthorized = await fetch(`http://127.0.0.1:${appPort}/api/approvals/${approvals[0].id}/decision`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'APPROVED' })
  });
  assert.equal(unauthorized.status, 401);
  const decision = await fetch(`http://127.0.0.1:${appPort}/api/approvals/${approvals[0].id}/decision`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-agentgdb-approval-token': 'integration-test-approval-token-1' }, body: JSON.stringify({ decision: 'APPROVED' })
  });
  assert.equal(decision.status, 200);
  const response = await requestPromise;
  const body = await response.text();
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.match(body, /"id":"call-1"/);
  assert.match(body, /write_file/);
});

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(child, port) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error(`AgentGDB exited during startup with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('AgentGDB did not start before timeout');
}
