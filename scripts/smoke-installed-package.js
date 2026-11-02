import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-package-smoke-'));
const installPrefix = path.join(tempRoot, 'install');
const home = path.join(tempRoot, 'home');
const workspace = path.join(tempRoot, 'workspace');
const approvalToken = 'agentgdb-package-smoke-token-0123456789';
let daemon;
let client;

function runNpm(args, cwd) {
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', timeout: 180000 })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      cwd, encoding: 'utf8', timeout: 180000, shell: process.platform === 'win32'
    });
  if (result.error || result.status !== 0) {
    throw new Error(`npm ${args[0]} failed.\n${result.stdout || ''}\n${result.stderr || ''}\n${result.error?.message || ''}`);
  }
  return result.stdout;
}

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForDaemon(url) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (daemon.exitCode !== null) throw new Error(`Packaged daemon exited with code ${daemon.exitCode}.`);
    try {
      const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Packaged daemon did not become healthy before timeout.');
}

async function waitForPendingApproval(url) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${url}/api/approvals`, {
      headers: { 'x-agentgdb-approval-token': approvalToken },
      signal: AbortSignal.timeout(1000)
    });
    if (!response.ok) throw new Error(`Approval list returned HTTP ${response.status}.`);
    const { approvals } = await response.json();
    if (approvals?.length) return approvals[0];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Packaged MCP write did not create a pending approval.');
}

async function stopDaemon() {
  if (!daemon || daemon.exitCode !== null) return;
  daemon.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => daemon.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000))
  ]);
  if (daemon.exitCode === null) daemon.kill('SIGKILL');
}

async function main() {
  fs.mkdirSync(installPrefix, { recursive: true });
  fs.mkdirSync(path.join(home, '.agentgdb'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'input.txt'), 'packed MCP read fixture');
  fs.writeFileSync(path.join(home, '.agentgdb', 'projects.json'), JSON.stringify({
    activeProjectId: 'package-smoke',
    projects: [{
      id: 'package-smoke', name: 'Package smoke', workspacePath: workspace,
      allowedPaths: ['src/**'], forbiddenPaths: [], allowedCommands: []
    }]
  }));

  runNpm(['pack', '--silent', '--pack-destination', tempRoot], repoRoot);
  const tarball = fs.readdirSync(tempRoot).find((entry) => /^agentgdb-.*\.tgz$/.test(entry));
  if (!tarball) throw new Error('npm pack did not create an AgentGDB tarball.');
  runNpm(['install', '--omit=dev', '--no-audit', '--no-fund', '--prefix', installPrefix, path.join(tempRoot, tarball)], repoRoot);

  const packageRoot = path.join(installPrefix, 'node_modules', 'agentgdb');
  const help = spawnSync(process.execPath, [path.join(packageRoot, 'bin', 'agentgdb.js'), 'help'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(help.status, 0, help.stderr || help.error?.message);
  assert.match(help.stdout, /Usage:/);

  const port = await unusedPort();
  const daemonUrl = `http://127.0.0.1:${port}`;
  daemon = spawn(process.execPath, [path.join(packageRoot, 'bin', 'agentgdb.js'), 'start'], {
    cwd: packageRoot,
    env: {
      ...process.env, HOME: home, USERPROFILE: home, HOST: '127.0.0.1', PORT: String(port),
      AGENTGDB_APPROVAL_TOKEN: approvalToken
    },
    stdio: 'ignore'
  });
  await waitForDaemon(daemonUrl);

  const dashboard = await fetch(`${daemonUrl}/`);
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /Coding-Agent Session Inspector/);
  const demoResponse = await fetch(`${daemonUrl}/api/demo/start`, { method: 'POST' });
  assert.equal(demoResponse.status, 200);
  const demo = await demoResponse.json();
  assert.equal(demo.persisted, false);
  assert.equal(demo.mode, 'synthetic-demo');

  client = new Client({ name: 'agentgdb-package-smoke', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(packageRoot, 'bin', 'agentgdb-mcp.js')],
    cwd: packageRoot,
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      AGENTGDB_DAEMON_URL: daemonUrl, AGENTGDB_APPROVAL_TIMEOUT_MS: '15000'
    },
    stderr: 'ignore'
  });
  await client.connect(transport);
  const read = await client.callTool({ name: 'agentgdb_read_file', arguments: { path: 'src/input.txt' } });
  assert.equal(read.isError, undefined, read.content?.[0]?.text);
  assert.equal(read.content?.[0]?.text, 'packed MCP read fixture');

  const writePromise = client.callTool({
    name: 'agentgdb_write_file',
    arguments: { path: 'src/output.txt', content: 'written after packaged approval' }
  }).then((value) => ({ value }), (error) => ({ error }));
  const approval = await waitForPendingApproval(daemonUrl);
  assert.equal(approval.action.name, 'write_file');
  assert.equal(approval.action.targetPath, 'src/output.txt');
  const decision = await fetch(`${daemonUrl}/api/approvals/${approval.id}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agentgdb-approval-token': approvalToken },
    body: JSON.stringify({ decision: 'APPROVED' })
  });
  assert.equal(decision.status, 200);
  const writeOutcome = await writePromise;
  if (writeOutcome.error) throw writeOutcome.error;
  const write = writeOutcome.value;
  assert.equal(write.isError, undefined, write.content?.[0]?.text);
  assert.equal(fs.readFileSync(path.join(workspace, 'src', 'output.txt'), 'utf8'), 'written after packaged approval');

  process.stdout.write('Packed install, CLI, daemon, dashboard, demo, MCP read, and approved MCP write passed.\n');
}

try {
  await main();
} finally {
  await client?.close().catch(() => {});
  await stopDaemon();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
