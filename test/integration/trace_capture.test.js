import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const responsePayload = {
  id: 'completion-fixture',
  choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'write_file', arguments: '{"path":"secret-tool-argument-sentinel"}' } }] } }],
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
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: {
        ...process.env,
        HOME: home,
        HOST: '127.0.0.1',
        PORT: String(appPort),
        UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
        AGENTGDB_TRACE_CAPTURE: captureEnabled ? 'true' : 'false'
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
    const requestPayload = { model: 'fixture-model', messages: [{ role: 'user', content: 'secret-request-sentinel' }] };
    const response = await fetch(`http://127.0.0.1:${appPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer upstream-test-key', 'x-agentgdb-session': 'capture-test' },
      body: JSON.stringify(requestPayload)
    });
    assert.equal(response.status, 200);

    db = new Database(path.join(home, '.agentgdb', 'traces.db'), { readonly: true });
    const turn = db.prepare("SELECT request_payload, response_payload, tool_calls FROM turns WHERE session_id = 'capture-test'").get();
    assert.ok(turn);
    if (captureEnabled) {
      assert.match(turn.request_payload, /secret-request-sentinel/);
      assert.match(turn.response_payload, /secret-tool-argument-sentinel/);
      assert.match(turn.tool_calls, /secret-tool-argument-sentinel/);
    } else {
      assert.equal(turn.request_payload, null);
      assert.equal(turn.response_payload, null);
      assert.doesNotMatch(turn.tool_calls, /secret-tool-argument-sentinel/);
      assert.match(turn.tool_calls, /write_file/);
    }
  });
}

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
