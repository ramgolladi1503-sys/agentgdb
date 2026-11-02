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
  debug: {
    authorization: 'Bearer response-auth-fixture-0123456789',
    cookie: 'session=response-cookie-fixture-0123456789',
    aws_secret_access_key: 'response-aws-secret-fixture-0123456789'
  },
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
        HOME: home, USERPROFILE: home,
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
    const requestPayload = {
      model: 'fixture-model',
      messages: [{ role: 'user', content: 'secret-request-sentinel api_key=AbCdEfGhIjKlMnOp123456' }],
      debug: {
        authorization: 'Bearer request-auth-fixture-0123456789',
        cookie: 'session=request-cookie-fixture-0123456789',
        aws_secret_access_key: 'request-aws-secret-fixture-0123456789'
      }
    };
    const responsePromise = fetch(`http://127.0.0.1:${appPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer upstream-test-key', 'x-agentgdb-session': 'capture-test' },
      body: JSON.stringify(requestPayload)
    });
    {
      let pending;
      for (let attempt = 0; attempt < 30; attempt++) {
        const pendingResponse = await fetch(`http://127.0.0.1:${appPort}/api/approvals`, { headers: { 'x-agentgdb-approval-token': 'integration-test-approval-token-1' } });
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
      for (const secret of ['request-auth-fixture-0123456789', 'request-cookie-fixture-0123456789', 'request-aws-secret-fixture-0123456789']) {
        assert.doesNotMatch(turn.request_payload, new RegExp(secret));
      }
      assert.match(turn.response_payload, /secret-tool-argument-sentinel/);
      assert.doesNotMatch(turn.response_payload, /XyZaBcDeFgHiJkLmNoPq123456/);
      for (const secret of ['response-auth-fixture-0123456789', 'response-cookie-fixture-0123456789', 'response-aws-secret-fixture-0123456789']) {
        assert.doesNotMatch(turn.response_payload, new RegExp(secret));
      }
      assert.match(turn.tool_calls, /secret-tool-argument-sentinel/);
      const replay = await fetch(`http://127.0.0.1:${appPort}/api/sessions/capture-test/replay/1`, { headers: { 'x-agentgdb-approval-token': 'integration-test-approval-token-1' } });
      const replayResult = await replay.json();
      assert.equal(replay.status, 200);
      assert.equal(replayResult.playbackMode, 'stored-turn');
      assert.equal(replayResult.agentReexecuted, false);
      assert.equal(replayResult.deterministicAgentReplay, false);
      assert.equal(replayResult.upstreamCallsDuringPlayback, 0);
      assert.equal(replayResult.deterministic, true);
      assert.equal(replayResult.externalCalls, 0);
    } else {
      assert.equal(turn.request_payload, null);
      assert.equal(turn.response_payload, null);
      assert.doesNotMatch(turn.tool_calls, /secret-tool-argument-sentinel/);
      assert.match(turn.tool_calls, /write_file/);
      const replay = await fetch(`http://127.0.0.1:${appPort}/api/sessions/capture-test/replay/1`, { headers: { 'x-agentgdb-approval-token': 'integration-test-approval-token-1' } });
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
    env: { ...process.env, HOME: home, USERPROFILE: home, HOST: '127.0.0.1', PORT: String(appPort), UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, AGENTGDB_APPROVAL_TIMEOUT_MS: '10000', AGENTGDB_APPROVAL_TOKEN: 'integration-test-approval-token-1' },
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
  const unauthenticatedList = await fetch(`http://127.0.0.1:${appPort}/api/approvals`);
  assert.equal(unauthenticatedList.status, 401);
  let approvals;
  for (let i = 0; i < 30; i++) {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/approvals`, { headers: { 'x-agentgdb-approval-token': 'integration-test-approval-token-1' } });
    approvals = (await response.json()).approvals;
    if (approvals.length) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].status, 'PENDING');
  assert.equal((await fetch(`http://127.0.0.1:${appPort}/api/approvals`, { headers: { 'x-agentgdb-approval-token': 'integration-test-approval-token-1' } })).headers.get('cache-control'), 'no-store');
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

test('proxy withholds an approved mutating call when workspace policy changes while approval is pending', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-proxy-stale-policy-'));
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(home, '.agentgdb'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agentgdb', 'projects.json'), JSON.stringify({
    activeProjectId: 'fixture',
    projects: [{ id: 'fixture', name: 'fixture', workspacePath: workspace, allowedPaths: ['src/**'], forbiddenPaths: [], allowedCommands: [] }]
  }));
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'stale-policy-fixture',
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
        id: 'write-call', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/target.txt', content: 'approved under stale policy' }) }
      }] } }]
    }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const appPort = await unusedPort();
  const approvalToken = 'proxy-stale-policy-test-token-012345';
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(fileURLToPath(new URL('../..', import.meta.url))),
    env: { ...process.env, HOME: home, USERPROFILE: home, HOST: '127.0.0.1', PORT: String(appPort), UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, AGENTGDB_APPROVAL_TIMEOUT_MS: '10000', AGENTGDB_APPROVAL_TOKEN: approvalToken },
    stdio: 'ignore'
  });
  t.after(async () => {
    child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });
  await waitForServer(child, appPort);

  const responsePromise = fetch(`http://127.0.0.1:${appPort}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'write a source file' }] })
  });
  let pending;
  for (let attempt = 0; attempt < 50; attempt++) {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/approvals`, { headers: { 'x-agentgdb-approval-token': approvalToken } });
    pending = (await response.json()).approvals[0];
    if (pending) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(pending, 'proxy creates an approval before returning the mutating call');
  assert.equal(pending.action.approvalContext.workspaceId, 'fixture');
  assert.match(pending.action.approvalContext.policyFingerprint, /^[a-f0-9]{64}$/);

  const policyUpdate = await fetch(`http://127.0.0.1:${appPort}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-agentgdb-approval-token': approvalToken },
    body: JSON.stringify({ id: 'fixture', name: 'fixture', workspacePath: workspace, allowedPaths: ['docs/**'], forbiddenPaths: [], allowedCommands: [] })
  }).then((response) => response.json());
  assert.equal(policyUpdate.success, true, JSON.stringify(policyUpdate));
  const decision = await fetch(`http://127.0.0.1:${appPort}/api/approvals/${pending.id}/decision`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-agentgdb-approval-token': approvalToken },
    body: JSON.stringify({ decision: 'APPROVED' })
  });
  assert.equal(decision.status, 200);

  const response = await responsePromise;
  const body = await response.json();
  assert.deepEqual(body.choices[0].message.tool_calls, [], 'stale call is removed from the response sent to the agent');
  assert.match(body.choices[0].message.content, /workspace or policy changed while approval was pending/);
});

test('proxy denies a mutating call when approval context would be redacted', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-proxy-redacted-approval-'));
  const workspace = path.join(home, 'token=opaque-context-fixture-0123456789');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(home, '.agentgdb'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agentgdb', 'projects.json'), JSON.stringify({
    activeProjectId: 'fixture',
    projects: [{ id: 'fixture', name: 'fixture', workspacePath: workspace, allowedPaths: ['src/**'], forbiddenPaths: [], allowedCommands: [] }]
  }));
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'redacted-context-fixture',
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
        id: 'write-call', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/target.txt', content: 'must not be returned for execution' }) }
      }] } }]
    }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const appPort = await unusedPort();
  const approvalToken = 'proxy-redacted-context-token-0123456789';
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(fileURLToPath(new URL('../..', import.meta.url))),
    env: { ...process.env, HOME: home, USERPROFILE: home, HOST: '127.0.0.1', PORT: String(appPort), UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, AGENTGDB_APPROVAL_TOKEN: approvalToken },
    stdio: 'ignore'
  });
  t.after(async () => {
    child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });
  await waitForServer(child, appPort);

  const response = await fetch(`http://127.0.0.1:${appPort}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'write a source file' }] })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.choices[0].message.content, /approval details contain credential-like content/i);
  assert.deepEqual(body.choices[0].message.tool_calls, [], 'the proposed mutating call is removed from the upstream response');
  const approvals = await fetch(`http://127.0.0.1:${appPort}/api/approvals`, { headers: { 'x-agentgdb-approval-token': approvalToken } }).then((result) => result.json());
  assert.equal(approvals.approvals.length, 0);
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
