import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

test('non-loopback HTTP, static, and WebSocket endpoints require the bearer token', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-remote-auth-'));
  const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const appPort = await unusedPort();
  const token = 'remote-auth-integration-token-0123456789';
  const daemon = spawn(process.execPath, ['src/server.js'], { cwd: repoRoot, env: { ...process.env, HOME: home, HOST: '0.0.0.0', PORT: String(appPort), AGENTGDB_AUTH_TOKEN: token, AGENTGDB_APPROVAL_TOKEN: 'remote-auth-approval-token-0123456789' }, stdio: 'ignore' });
  t.after(async () => {
    daemon.kill('SIGTERM');
    if (daemon.exitCode === null) await new Promise((resolve) => daemon.once('exit', resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });
  await waitForServer(daemon, appPort);

  const unauthenticatedApi = await fetch(`http://127.0.0.1:${appPort}/api/projects`);
  assert.equal(unauthenticatedApi.status, 401);
  const unauthenticatedStatic = await fetch(`http://127.0.0.1:${appPort}/index.html`);
  assert.equal(unauthenticatedStatic.status, 401);
  const authenticatedApi = await fetch(`http://127.0.0.1:${appPort}/api/projects`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(authenticatedApi.status, 200);
  const authenticatedStatic = await fetch(`http://127.0.0.1:${appPort}/index.html`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(authenticatedStatic.status, 200);

  const deniedSocket = await websocketResult(`ws://127.0.0.1:${appPort}/ws`);
  assert.equal(deniedSocket.status, 401);
  const acceptedSocket = await websocketResult(`ws://127.0.0.1:${appPort}/ws`, { Authorization: `Bearer ${token}` });
  assert.equal(acceptedSocket.connected, true);
});

test('non-loopback startup refuses to bind without an auth token', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-remote-no-token-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const result = spawnSync(process.execPath, ['src/server.js'], { cwd: repoRoot, env: { ...process.env, HOME: home, HOST: '0.0.0.0', PORT: '0', AGENTGDB_AUTH_TOKEN: '' }, encoding: 'utf8', timeout: 5000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AGENTGDB_AUTH_TOKEN is required when HOST is not loopback/);
});

function websocketResult(url, headers) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once('open', () => { socket.close(); resolve({ connected: true }); });
    socket.once('unexpected-response', (_request, response) => { response.resume(); resolve({ status: response.statusCode }); });
    socket.once('error', reject);
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('WebSocket authentication check timed out')); }, 3000);
    socket.once('close', () => clearTimeout(timer));
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
