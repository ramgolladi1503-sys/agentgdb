import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('official MCP stdio tool path reads safely and gates a real workspace write', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-managed-mcp-'));
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.mkdirSync(path.join(home, '.agentgdb'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'input.txt'), 'read fixture');
  fs.writeFileSync(path.join(home, '.agentgdb', 'projects.json'), JSON.stringify({ activeProjectId: null, projects: [] }));
  const appPort = await unusedPort();
  const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const approvalToken = 'managed-mcp-integration-token-012345';
  const commandArgs = [process.execPath, '-e', 'process.stdout.write("managed-command-ok")'];
  const daemon = spawn(process.execPath, ['src/server.js'], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, HOST: '127.0.0.1', PORT: String(appPort), AGENTGDB_APPROVAL_TOKEN: approvalToken },
    stdio: 'ignore'
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, 'bin', 'agentgdb-mcp.js')],
    cwd: repoRoot,
    env: { ...process.env, HOME: home, AGENTGDB_DAEMON_URL: `http://127.0.0.1:${appPort}`, AGENTGDB_APPROVAL_TIMEOUT_MS: '10000' },
    stderr: 'inherit'
  });
  const client = new Client({ name: 'agentgdb-integration-test', version: '1.0.0' }, { capabilities: {} });
  t.after(async () => {
    await client.close().catch(() => {});
    daemon.kill('SIGTERM');
    if (daemon.exitCode === null) await new Promise((resolve) => daemon.once('exit', resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });

  await waitForServer(daemon, appPort);
  const stylesheet = await fetch(`http://127.0.0.1:${appPort}/tailwind.css`);
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get('content-type'), /text\/css/);
  assert.match(await stylesheet.text(), /\.flex/);
  const setup = await fetch(`http://127.0.0.1:${appPort}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'fixture', name: 'fixture', workspacePath: workspace, allowedPaths: ['src/**'], allowedCommands: [JSON.stringify(commandArgs)] })
  }).then((response) => response.json());
  assert.equal(setup.success, true);
  const activation = await fetch(`http://127.0.0.1:${appPort}/api/projects/switch`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'fixture' })
  }).then((response) => response.json());
  assert.equal(activation.success, true);
  const demo = await fetch(`http://127.0.0.1:${appPort}/api/demo/start`, { method: 'POST' }).then((response) => response.json());
  assert.equal(demo.persisted, false);
  assert.equal((await fetch(`http://127.0.0.1:${appPort}/api/sessions`).then((response) => response.json())).length, 0);
  const malformedTranscript = path.join(home, 'malformed.jsonl');
  fs.writeFileSync(malformedTranscript, 'not json at all\n');
  const parseFailure = await fetch(`http://127.0.0.1:${appPort}/api/local/watch`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionPath: malformedTranscript })
  });
  assert.equal(parseFailure.status, 422);
  assert.match((await parseFailure.json()).error, /no valid parseable JSONL/);
  const validTranscript = path.join(home, 'valid.jsonl');
  fs.writeFileSync(validTranscript, `${JSON.stringify({ type: 'session_meta', payload: { cwd: workspace } })}\n`);
  const parsedTranscript = await fetch(`http://127.0.0.1:${appPort}/api/local/watch`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionPath: validTranscript })
  });
  assert.equal(parsedTranscript.status, 200);
  assert.equal((await parsedTranscript.json()).totalSteps, 1);

  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ['agentgdb_read_file', 'agentgdb_run_command', 'agentgdb_write_file']);

  const read = await client.callTool({ name: 'agentgdb_read_file', arguments: { path: 'src/input.txt' } });
  assert.match(read.content[0].text, /read fixture/);
  const outside = await client.callTool({ name: 'agentgdb_read_file', arguments: { path: '../outside.txt' } });
  assert.equal(outside.isError, true);

  const writePromise = client.callTool({ name: 'agentgdb_write_file', arguments: { path: 'src/output.txt', content: 'approved fixture' } });
  let pending;
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/approvals`);
    pending = (await response.json()).approvals[0];
    if (pending) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(pending, 'managed MCP call creates a durable pending approval');
  assert.equal(pending.action.name, 'write_file');
  assert.equal(pending.risk, 'MUTATING');
  const deniedAttempt = await fetch(`http://127.0.0.1:${appPort}/api/approvals/${pending.id}/decision`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'APPROVED' })
  });
  assert.equal(deniedAttempt.status, 401);
  const decision = await fetch(`http://127.0.0.1:${appPort}/api/approvals/${pending.id}/decision`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-agentgdb-approval-token': approvalToken },
    body: JSON.stringify({ decision: 'APPROVED' })
  });
  assert.equal(decision.status, 200);
  const writeResult = await writePromise;
  assert.equal(writeResult.isError, undefined);
  assert.equal(fs.readFileSync(path.join(workspace, 'src', 'output.txt'), 'utf8'), 'approved fixture');
  const recent = await fetch(`http://127.0.0.1:${appPort}/api/approvals`).then((response) => response.json());
  assert.equal(recent.recent.find((item) => item.id === pending.id).execution_status, 'COMPLETED');

  const deniedCommand = await client.callTool({ name: 'agentgdb_run_command', arguments: { executable: process.execPath, args: ['-e', 'process.stdout.write("not-allowlisted")'] } });
  assert.equal(deniedCommand.isError, true);
  const allowedCommandPromise = client.callTool({ name: 'agentgdb_run_command', arguments: { executable: commandArgs[0], args: commandArgs.slice(1) } });
  let commandApproval;
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/approvals`);
    commandApproval = (await response.json()).approvals[0];
    if (commandApproval) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(commandApproval);
  assert.equal(commandApproval.action.name, 'run_command');
  await fetch(`http://127.0.0.1:${appPort}/api/approvals/${commandApproval.id}/decision`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-agentgdb-approval-token': approvalToken }, body: JSON.stringify({ decision: 'APPROVED' })
  });
  const commandResult = await allowedCommandPromise;
  assert.match(commandResult.content[0].text, /managed-command-ok/);
  const finalHistory = await fetch(`http://127.0.0.1:${appPort}/api/approvals`).then((response) => response.json());
  assert.equal(finalHistory.recent.find((item) => item.id === commandApproval.id).execution_status, 'COMPLETED');

  const cancelController = new AbortController();
  const cancelledCall = client.callTool({ name: 'agentgdb_write_file', arguments: { path: 'src/cancelled.txt', content: 'must not write' } }, { signal: cancelController.signal }).catch((error) => error);
  let cancelledApproval;
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/approvals`);
    cancelledApproval = (await response.json()).approvals[0];
    if (cancelledApproval) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(cancelledApproval);
  cancelController.abort();
  await cancelledCall;
  await new Promise((resolve) => setTimeout(resolve, 300));
  const cancelledHistory = await fetch(`http://127.0.0.1:${appPort}/api/approvals`).then((response) => response.json());
  assert.equal(cancelledHistory.recent.find((item) => item.id === cancelledApproval.id).status, 'DENIED');
  assert.equal(fs.existsSync(path.join(workspace, 'src', 'cancelled.txt')), false);
});

test('managed MCP refuses mutating actions when the approval dashboard is unavailable', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-no-approval-service-'));
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(home, '.agentgdb'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agentgdb', 'projects.json'), JSON.stringify({ activeProjectId: 'fixture', projects: [{ id: 'fixture', name: 'fixture', workspacePath: workspace, allowedPaths: ['src/**'], forbiddenPaths: [], allowedCommands: [] }] }));
  const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(repoRoot, 'bin', 'agentgdb-mcp.js')], cwd: repoRoot, env: { ...process.env, HOME: home, AGENTGDB_DAEMON_URL: 'http://127.0.0.1:1' }, stderr: 'ignore' });
  const client = new Client({ name: 'agentgdb-unavailable-test', version: '1.0.0' }, { capabilities: {} });
  t.after(async () => { await client.close().catch(() => {}); fs.rmSync(home, { recursive: true, force: true }); });
  await client.connect(transport);
  const result = await client.callTool({ name: 'agentgdb_write_file', arguments: { path: 'src/never-written.txt', content: 'deny' } });
  assert.equal(result.isError, true);
  assert.equal(fs.existsSync(path.join(workspace, 'src', 'never-written.txt')), false);
});

test('managed MCP expires an unanswered write approval without writing', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-expired-approval-'));
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(home, '.agentgdb'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agentgdb', 'projects.json'), JSON.stringify({ activeProjectId: 'fixture', projects: [{ id: 'fixture', name: 'fixture', workspacePath: workspace, allowedPaths: ['src/**'], forbiddenPaths: [], allowedCommands: [] }] }));
  const appPort = await unusedPort();
  const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const daemon = spawn(process.execPath, ['src/server.js'], { cwd: repoRoot, env: { ...process.env, HOME: home, HOST: '127.0.0.1', PORT: String(appPort), AGENTGDB_APPROVAL_TIMEOUT_MS: '1000', AGENTGDB_APPROVAL_TOKEN: 'managed-mcp-timeout-token-0123456789' }, stdio: 'ignore' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(repoRoot, 'bin', 'agentgdb-mcp.js')], cwd: repoRoot, env: { ...process.env, HOME: home, AGENTGDB_DAEMON_URL: `http://127.0.0.1:${appPort}`, AGENTGDB_APPROVAL_TIMEOUT_MS: '1000' }, stderr: 'ignore' });
  const client = new Client({ name: 'agentgdb-timeout-test', version: '1.0.0' }, { capabilities: {} });
  t.after(async () => { await client.close().catch(() => {}); daemon.kill('SIGTERM'); if (daemon.exitCode === null) await new Promise((resolve) => daemon.once('exit', resolve)); fs.rmSync(home, { recursive: true, force: true }); });
  await waitForServer(daemon, appPort);
  await client.connect(transport);
  const result = await client.callTool({ name: 'agentgdb_write_file', arguments: { path: 'src/expired.txt', content: 'deny' } });
  assert.equal(result.isError, true);
  assert.equal(fs.existsSync(path.join(workspace, 'src', 'expired.txt')), false);
  const records = await fetch(`http://127.0.0.1:${appPort}/api/approvals`).then((response) => response.json());
  assert.equal(records.recent[0].status, 'EXPIRED');
});

test('dashboard startup durably rejects approvals left pending by a previous run', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-daemon-restart-'));
  const dbDir = path.join(home, '.agentgdb');
  fs.mkdirSync(dbDir, { recursive: true });
  const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const dbModule = new URL('../../src/db.js', import.meta.url).href;
  const seed = spawnSync(process.execPath, ['--input-type=module', '-e', `import { createApproval } from '${dbModule}'; createApproval({id:'restart-fixture',sessionId:'mcp-test',action:{name:'write_file',path:'src/pending'},risk:'MUTATING',expiresAt:Date.now()+60000});`], { cwd: repoRoot, env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr);
  const appPort = await unusedPort();
  const daemon = spawn(process.execPath, ['src/server.js'], { cwd: repoRoot, env: { ...process.env, HOME: home, HOST: '127.0.0.1', PORT: String(appPort), AGENTGDB_APPROVAL_TOKEN: 'managed-mcp-restart-token-0123456789' }, stdio: 'ignore' });
  t.after(async () => { daemon.kill('SIGTERM'); if (daemon.exitCode === null) await new Promise((resolve) => daemon.once('exit', resolve)); fs.rmSync(home, { recursive: true, force: true }); });
  await waitForServer(daemon, appPort);
  const records = await fetch(`http://127.0.0.1:${appPort}/api/approvals`).then((response) => response.json());
  const restarted = records.recent.find((item) => item.id === 'restart-fixture');
  assert.equal(restarted.status, 'REJECTED_RESTART');
  assert.match(restarted.decision_reason, /cannot be resumed/);
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
