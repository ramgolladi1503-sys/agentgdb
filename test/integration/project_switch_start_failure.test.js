import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const failurePreload = path.join(repoRoot, 'test-support', 'fail-live-watcher-start.mjs');

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(child, port) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`AgentGDB exited during startup with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('AgentGDB did not become ready before timeout');
}

test('project switch preserves the active observer when candidate startup fails', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-switch-start-failure-'));
  const workspace = path.join(home, 'workspace');
  const goodTranscript = path.join(home, 'good.jsonl');
  const failedTranscript = path.join(home, 'candidate.jsonl');
  const appPort = await unusedPort();
  const approvalToken = 'project-switch-failure-test-token-0123456789';
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(home, '.agentgdb'), { recursive: true });
  for (const transcriptPath of [goodTranscript, failedTranscript]) {
    fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: 'session_meta', payload: { cwd: workspace } })}\n`);
  }

  const daemon = spawn(process.execPath, ['--import', failurePreload, 'src/server.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home, USERPROFILE: home,
      HOST: '127.0.0.1',
      PORT: String(appPort),
      AGENTGDB_APPROVAL_TOKEN: approvalToken,
      AGENTGDB_TEST_FAIL_WATCHER_PATH: failedTranscript
    },
    stdio: 'ignore'
  });
  t.after(async () => {
    if (daemon.exitCode === null) {
      daemon.kill('SIGTERM');
      await new Promise((resolve) => daemon.once('exit', resolve));
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  const headers = {
    'content-type': 'application/json',
    'x-agentgdb-approval-token': approvalToken
  };
  const post = (url, body) => fetch(`http://127.0.0.1:${appPort}${url}`, {
    method: 'POST', headers, body: JSON.stringify(body)
  });

  await waitForServer(daemon, appPort);
  for (const project of [
    { id: 'good', name: 'Good transcript', workspacePath: workspace, sessionPath: goodTranscript, allowedPaths: ['src/**'] },
    { id: 'fail-start', name: 'Failing observer', workspacePath: workspace, sessionPath: failedTranscript, allowedPaths: ['src/**'] }
  ]) {
    const response = await post('/api/projects', project);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).success, true);
  }

  const duplicateResponse = await post('/api/projects', {
    id: 'good', name: 'Must not replace existing project', createOnly: true,
    workspacePath: workspace, allowedPaths: ['**']
  });
  assert.equal(duplicateResponse.status, 200);
  const duplicateCreate = await duplicateResponse.json();
  assert.equal(duplicateCreate.success, false);
  assert.match(duplicateCreate.error, /already registered/);
  const afterDuplicate = await fetch(`http://127.0.0.1:${appPort}/api/projects`, { headers }).then((response) => response.json());
  assert.equal(afterDuplicate.projects.find((project) => project.id === 'good').name, 'Good transcript');
  assert.equal(afterDuplicate.projects.some((project) => project.createOnly === true), false);

  const goodSwitch = await post('/api/projects/switch', { projectId: 'good' });
  assert.equal(goodSwitch.status, 200);
  assert.equal((await goodSwitch.json()).isWatching, true);

  const failedSwitch = await post('/api/projects/switch', { projectId: 'fail-start' });
  assert.equal(failedSwitch.status, 500);
  assert.match((await failedSwitch.json()).error, /injected watcher startup failure/);

  const projects = await fetch(`http://127.0.0.1:${appPort}/api/projects`, { headers }).then((response) => response.json());
  assert.equal(projects.activeProjectId, 'good', 'failed candidate must not become active');
  const observer = await fetch(`http://127.0.0.1:${appPort}/api/live/active-goal`, { headers }).then((response) => response.json());
  assert.equal(observer.path, goodTranscript, 'failed candidate must not replace the previous observer');
  assert.equal(observer.isWatching, true, 'previous observer must remain running');
});
