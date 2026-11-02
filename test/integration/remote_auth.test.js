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
  const daemon = spawn(process.execPath, ['src/server.js'], { cwd: repoRoot, env: { ...process.env, HOME: home, USERPROFILE: home, HOST: '0.0.0.0', PORT: String(appPort), AGENTGDB_AUTH_TOKEN: token, AGENTGDB_APPROVAL_TOKEN: 'remote-auth-approval-token-0123456789' }, stdio: 'ignore' });
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
  const result = spawnSync(process.execPath, ['src/server.js'], { cwd: repoRoot, env: { ...process.env, HOME: home, USERPROFILE: home, HOST: '0.0.0.0', PORT: '0', AGENTGDB_AUTH_TOKEN: '' }, encoding: 'utf8', timeout: 5000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AGENTGDB_AUTH_TOKEN is required when HOST is not loopback/);
});

test('loopback daemon rejects cross-origin and DNS-rebinding browser requests', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-origin-auth-'));
  const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const appPort = await unusedPort();
  const daemon = spawn(process.execPath, ['src/server.js'], { cwd: repoRoot, env: { ...process.env, HOME: home, USERPROFILE: home, HOST: '127.0.0.1', PORT: String(appPort), AGENTGDB_APPROVAL_TOKEN: 'origin-check-approval-token-0123456789' }, stdio: 'ignore' });
  t.after(async () => {
    daemon.kill('SIGTERM');
    if (daemon.exitCode === null) await new Promise((resolve) => daemon.once('exit', resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });
  await waitForServer(daemon, appPort);

  const baseUrl = `http://127.0.0.1:${appPort}`;
  const noToken = await fetch(`${baseUrl}/api/projects`);
  assert.equal(noToken.status, 401);
  const unauthenticatedPurge = await fetch(`${baseUrl}/api/traces?before=${Date.now() + 1000}`, { method: 'DELETE' });
  assert.equal(unauthenticatedPurge.status, 401, 'loopback trace deletion requires the local operator token');
  const sameOrigin = await fetch(`${baseUrl}/api/projects`, { headers: { origin: baseUrl, 'x-agentgdb-approval-token': 'origin-check-approval-token-0123456789' } });
  assert.equal(sameOrigin.status, 200);

  const unauthenticatedDemo = await fetch(`${baseUrl}/api/demo/start`, { method: 'POST' });
  assert.equal(unauthenticatedDemo.status, 200, 'synthetic in-memory demo remains available without an API/operator key');

  const foreignOrigin = await fetch(`${baseUrl}/api/demo/start`, { method: 'POST', headers: { origin: 'https://attacker.example' } });
  assert.equal(foreignOrigin.status, 403);

  // A rebinding page can make Host and Origin agree on its own hostname.
  // Loopback mode must still reject non-loopback authorities.
  const reboundOrigin = await fetch(`${baseUrl}/api/demo/start`, { method: 'POST', headers: { origin: `http://attacker.example:${appPort}`, host: `attacker.example:${appPort}` } });
  assert.equal(reboundOrigin.status, 403);

  const deniedSocket = await websocketResult(`ws://127.0.0.1:${appPort}/ws`, { Origin: 'https://attacker.example' });
  assert.equal(deniedSocket.status, 403);
  const socketUrl = `ws://127.0.0.1:${appPort}/ws`;
  const unauthenticatedSocket = await openAuthenticatedSocket(socketUrl, { Origin: baseUrl });
  assert.deepEqual(unauthenticatedSocket.events, ['auth_required'], 'loopback sockets receive no authenticated/live state without the operator token');
  const invalidSocket = await websocketAuthResult(socketUrl, { Origin: baseUrl }, 'wrong-operator-token');
  assert.deepEqual(invalidSocket, ['auth_required', 'auth_failed']);
  assert.equal(await websocketPayloadLimit(socketUrl, { Origin: baseUrl }), 1009, 'oversized pre-authentication frames are rejected at the WebSocket parser');
  const authenticatedSocket = await openAuthenticatedSocket(socketUrl, { Origin: baseUrl }, 'origin-check-approval-token-0123456789');
  assert.deepEqual(authenticatedSocket.events, ['auth_required', 'authenticated']);

  const transcriptPath = path.join(home, 'live.jsonl');
  fs.writeFileSync(transcriptPath, '');
  const watchResponse = await fetch(`${baseUrl}/api/live/watch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agentgdb-approval-token': 'origin-check-approval-token-0123456789' },
    body: JSON.stringify({ sessionPath: transcriptPath })
  });
  assert.equal(watchResponse.status, 200);
  const liveEvent = waitForSocketEvent(authenticatedSocket.socket, 'live_step_added');
  fs.appendFileSync(transcriptPath, `${JSON.stringify({ step_index: 1, tool_calls: [{ name: 'read_file', args: { path: 'src/private.js' } }] })}\n`);
  await liveEvent;
  assert.deepEqual(unauthenticatedSocket.events, ['auth_required'], 'unauthenticated sockets are not subscribed to the live event broadcast');
  unauthenticatedSocket.socket.close();
  authenticatedSocket.socket.close();
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

function websocketAuthResult(url, headers, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const events = [];
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('WebSocket authentication check timed out')); }, 3000);
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      response.resume();
      resolve({ status: response.statusCode });
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      events.push(message.event);
      if (message.event === 'auth_required' && token) {
        socket.send(JSON.stringify({ event: 'authenticate', token }));
      }
      if (message.event === 'authenticated' || message.event === 'auth_failed') {
        clearTimeout(timer);
        socket.close();
        resolve(events);
      }
    });
    socket.once('open', () => {
      if (!token) {
        const settle = setTimeout(() => {
          clearTimeout(timer);
          socket.close();
          resolve(events);
        }, 100);
        socket.once('close', () => clearTimeout(settle));
      }
    });
  });
}

function openAuthenticatedSocket(url, headers, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const events = [];
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('WebSocket authentication check timed out')); }, 3000);
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString()).event;
      events.push(event);
      if (event === 'auth_required' && token) socket.send(JSON.stringify({ event: 'authenticate', token }));
      if (event === 'auth_required' && !token || event === 'authenticated') {
        clearTimeout(timer);
        resolve({ socket, events });
      }
    });
  });
}

function waitForSocketEvent(socket, expectedEvent) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`Timed out waiting for WebSocket ${expectedEvent}`));
    }, 3000);
    function onMessage(raw) {
      if (JSON.parse(raw.toString()).event !== expectedEvent) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve();
    }
    socket.on('message', onMessage);
  });
}

function websocketPayloadLimit(url, headers) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('WebSocket payload limit check timed out')); }, 3000);
    socket.once('error', () => {});
    socket.once('open', () => socket.send(Buffer.alloc(4097)));
    socket.once('close', (code) => { clearTimeout(timer); resolve(code); });
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
