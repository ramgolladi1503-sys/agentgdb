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
  fs.symlinkSync(path.join(workspace, 'src'), path.join(workspace, 'src', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const fixtureSecret = 'sk-0123456789abcdef0123456789';
  fs.writeFileSync(path.join(workspace, 'src', 'secret.txt'), `api_key=${fixtureSecret}`);
  fs.writeFileSync(path.join(home, '.agentgdb', 'projects.json'), JSON.stringify({ activeProjectId: null, projects: [] }));
  const appPort = await unusedPort();
  const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const approvalToken = 'managed-mcp-integration-token-012345';
  const approvalAuthHeaders = { 'x-agentgdb-approval-token': approvalToken };
  const fetch = (url, options = {}) => globalThis.fetch(url, {
    ...options,
    headers: { ...approvalAuthHeaders, ...(options.headers || {}) }
  });
  const commandArgs = [process.execPath, '-e', 'process.stdout.write("managed-command-ok " + ["sk-0123456789", "abcdef0123456789"].join(""))'];
  const staleCommandMarker = path.join(workspace, 'src', 'stale-command-ran.txt');
  const staleCommandArgs = [process.execPath, '-e', `require("node:fs").writeFileSync(${JSON.stringify(staleCommandMarker)}, "ran")`];
  const descendantStartedMarker = path.join(workspace, 'src', 'descendant-started');
  const descendantSurvivorMarker = path.join(workspace, 'src', 'descendant-survived');
  const descendantCode = `require('node:fs').writeFileSync(${JSON.stringify(descendantStartedMarker)}, 'started'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(descendantSurvivorMarker)}, 'survived'), 2500)`;
  const timeoutCommandArgs = [process.execPath, '-e', `require('node:child_process').spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(descendantCode)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`];
  const daemon = spawn(process.execPath, ['src/server.js'], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, USERPROFILE: home, HOST: '127.0.0.1', PORT: String(appPort), AGENTGDB_APPROVAL_TOKEN: approvalToken, AGENTGDB_MAX_TRANSCRIPT_BYTES: '1048576', AGENTGDB_COMMAND_TIMEOUT_MS: '1000' },
    stdio: 'ignore'
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, 'bin', 'agentgdb-mcp.js')],
    cwd: repoRoot,
    env: { ...process.env, HOME: home, USERPROFILE: home, AGENTGDB_DAEMON_URL: `http://127.0.0.1:${appPort}`, AGENTGDB_APPROVAL_TIMEOUT_MS: '10000', AGENTGDB_COMMAND_TIMEOUT_MS: '1000' },
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
  const dashboardHtml = await fetch(`http://127.0.0.1:${appPort}/`).then((response) => response.text());
  assert.match(dashboardHtml, /Workspace directory/);
  assert.match(dashboardHtml, /Transcript file \(optional observer\)/);
  assert.match(dashboardHtml, /Register and activate workspace/);
  assert.match(dashboardHtml, /project\.validateTranscript = true/);
  assert.match(dashboardHtml, /Enter your configured <code>AGENTGDB_APPROVAL_TOKEN<\/code>/);
  assert.match(dashboardHtml, /never give it to the coding agent/i);
  assert.match(dashboardHtml, /Load approvals/);
  assert.match(dashboardHtml, /x-agentgdb-approval-token/);
  assert.doesNotMatch(dashboardHtml, /sessionStorage/);
  const stylesheet = await fetch(`http://127.0.0.1:${appPort}/tailwind.css`);
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get('content-type'), /text\/css/);
  assert.match(await stylesheet.text(), /\.flex/);
  const invalidScopePattern = await fetch(`http://127.0.0.1:${appPort}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'invalid-scope', name: 'Invalid scope', workspacePath: workspace, allowedPaths: ['src*'] })
  });
  assert.equal(invalidScopePattern.status, 200);
  const invalidScope = await invalidScopePattern.json();
  assert.equal(invalidScope.success, false);
  assert.match(invalidScope.error, /Other wildcard forms are unsupported/);
  assert.equal((await fetch(`http://127.0.0.1:${appPort}/api/projects`).then((response) => response.json())).projects.some((project) => project.id === 'invalid-scope'), false);
  const setup = await fetch(`http://127.0.0.1:${appPort}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'fixture', name: 'fixture', workspacePath: workspace, allowedPaths: ['src/**'], allowedCommands: [JSON.stringify(commandArgs), JSON.stringify(staleCommandArgs)] })
  }).then((response) => response.json());
  assert.equal(setup.success, true);
  const missingAllowlist = await fetch(`http://127.0.0.1:${appPort}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'no-allowlist', name: 'No allowlist', workspacePath: workspace, allowedPaths: [] })
  }).then((response) => response.json());
  assert.equal(missingAllowlist.success, false);
  assert.match(missingAllowlist.error, /At least one explicit allowedPaths rule/);
  const activation = await fetch(`http://127.0.0.1:${appPort}/api/projects/switch`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'fixture' })
  }).then((response) => response.json());
  assert.equal(activation.success, true);
  const demo = await fetch(`http://127.0.0.1:${appPort}/api/demo/start`, { method: 'POST' }).then((response) => response.json());
  assert.equal(demo.persisted, false);
  assert.equal(demo.elapsedHours, 0);
  assert.equal(demo.mode, 'synthetic-demo');
  assert.equal(demo.event.toolName, 'read_file');
  assert.equal(demo.event.targetPath, 'src/example.js');
  assert.match(demo.message, /returned in memory/);
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
  const invalidTranscriptRegistration = await fetch(`http://127.0.0.1:${appPort}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'invalid-transcript', name: 'Invalid transcript', workspacePath: workspace, sessionPath: workspace, allowedPaths: ['src/**'] })
  });
  assert.equal(invalidTranscriptRegistration.status, 200);
  assert.match((await invalidTranscriptRegistration.json()).error, /must identify a transcript file/);
  const staleTranscript = path.join(home, 'stale.jsonl');
  fs.writeFileSync(staleTranscript, `${JSON.stringify({ type: 'session_meta', payload: { cwd: workspace } })}\n`);
  const malformedOnlyTranscript = path.join(home, 'malformed-only.jsonl');
  fs.writeFileSync(malformedOnlyTranscript, 'malformed private transcript line\n');
  const unsupportedOnlyTranscript = path.join(home, 'unsupported-only.jsonl');
  fs.writeFileSync(unsupportedOnlyTranscript, `${JSON.stringify({ type: 'unknown_event' })}\n`);
  for (const [id, sessionPath, expectedMessage] of [
    ['retry-malformed', malformedOnlyTranscript, /no valid parseable JSONL events/],
    ['retry-unsupported', unsupportedOnlyTranscript, /no supported agent events were recognized/]
  ]) {
    const rejected = await fetch(`http://127.0.0.1:${appPort}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: id, workspacePath: workspace, sessionPath, allowedPaths: ['src/**'], createOnly: true, validateTranscript: true })
    });
    assert.equal(rejected.status, 422);
    assert.match((await rejected.json()).error, expectedMessage);
    assert.equal((await fetch(`http://127.0.0.1:${appPort}/api/projects`).then((response) => response.json())).projects.some((project) => project.id === id), false, 'invalid transcript is rejected before registration');
  }
  const retriedSetup = await fetch(`http://127.0.0.1:${appPort}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'retry-malformed', name: 'Corrected transcript', workspacePath: workspace, sessionPath: validTranscript, allowedPaths: ['src/**'], createOnly: true, validateTranscript: true })
  });
  assert.equal((await retriedSetup.json()).success, true, 'the same ID can be retried after correcting the transcript');
  const retriedProject = (await fetch(`http://127.0.0.1:${appPort}/api/projects`).then((response) => response.json())).projects.find((project) => project.id === 'retry-malformed');
  assert.equal(retriedProject.createOnly, undefined);
  assert.equal(retriedProject.validateTranscript, undefined);
  const parsedTranscript = await fetch(`http://127.0.0.1:${appPort}/api/local/watch`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionPath: validTranscript })
  });
  assert.equal(parsedTranscript.status, 200);
  assert.equal((await parsedTranscript.json()).totalSteps, 1);
  const oversizedTranscript = path.join(home, 'oversized.jsonl');
  fs.writeFileSync(oversizedTranscript, Buffer.alloc(1048577, 0x78));
  const oversizedResult = await fetch(`http://127.0.0.1:${appPort}/api/local/watch`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionPath: oversizedTranscript })
  });
  assert.equal(oversizedResult.status, 413);
  assert.match((await oversizedResult.json()).error, /configured 1048576-byte limit/);
  assert.equal((await fetch(`http://127.0.0.1:${appPort}/api/live/active-goal`).then((response) => response.json())).path, validTranscript, 'oversized candidate leaves the existing observer active');

  for (const project of [
    { id: 'transcript-project', name: 'Transcript project', sessionPath: validTranscript },
    { id: 'oversized-transcript-project', name: 'Oversized transcript project', sessionPath: oversizedTranscript },
    { id: 'stale-transcript-project', name: 'Stale transcript project', sessionPath: staleTranscript },
    { id: 'malformed-transcript-project', name: 'Malformed transcript project', sessionPath: malformedOnlyTranscript },
    { id: 'unsupported-transcript-project', name: 'Unsupported transcript project', sessionPath: unsupportedOnlyTranscript },
    { id: 'workspace-only-project', name: 'Workspace only project', workspacePath: workspace, allowedPaths: ['src/**'] }
  ]) {
    const saved = await fetch(`http://127.0.0.1:${appPort}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(project)
    }).then((response) => response.json());
    assert.equal(saved.success, true);
  }
  const transcriptSwitch = await fetch(`http://127.0.0.1:${appPort}/api/projects/switch`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'transcript-project' })
  }).then((response) => response.json());
  assert.equal(transcriptSwitch.isWatching, true);
  assert.equal(transcriptSwitch.totalSteps, 1);
  assert.equal(transcriptSwitch.parseErrorCount, 0);
  const oversizedSwitch = await fetch(`http://127.0.0.1:${appPort}/api/projects/switch`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'oversized-transcript-project' })
  });
  assert.equal(oversizedSwitch.status, 413);
  assert.match((await oversizedSwitch.json()).error, /configured 1048576-byte limit/);
  assert.equal((await fetch(`http://127.0.0.1:${appPort}/api/projects`).then((response) => response.json())).activeProjectId, 'transcript-project');
  assert.equal((await fetch(`http://127.0.0.1:${appPort}/api/live/active-goal`).then((response) => response.json())).path, validTranscript,
    'oversized project candidate leaves the active project and observer unchanged');
  const malformedSwitch = await fetch(`http://127.0.0.1:${appPort}/api/projects/switch`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'malformed-transcript-project' })
  });
  assert.equal(malformedSwitch.status, 422);
  assert.match((await malformedSwitch.json()).error, /no valid parseable JSONL/);
  assert.equal((await fetch(`http://127.0.0.1:${appPort}/api/projects`).then((response) => response.json())).activeProjectId, 'transcript-project');
  const unsupportedSwitch = await fetch(`http://127.0.0.1:${appPort}/api/projects/switch`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'unsupported-transcript-project' })
  });
  assert.equal(unsupportedSwitch.status, 422);
  assert.match((await unsupportedSwitch.json()).error, /no supported agent events/);
  assert.equal((await fetch(`http://127.0.0.1:${appPort}/api/projects`).then((response) => response.json())).activeProjectId, 'transcript-project');
  fs.unlinkSync(staleTranscript);
  const missingTranscriptSwitch = await fetch(`http://127.0.0.1:${appPort}/api/projects/switch`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'stale-transcript-project' })
  });
  assert.equal(missingTranscriptSwitch.status, 400);
  assert.match((await missingTranscriptSwitch.json()).error, /transcript is unavailable/);
  assert.equal((await fetch(`http://127.0.0.1:${appPort}/api/projects`).then((response) => response.json())).activeProjectId, 'transcript-project');
  assert.equal((await fetch(`http://127.0.0.1:${appPort}/api/live/active-goal`).then((response) => response.json())).path, validTranscript);
  const workspaceSwitch = await fetch(`http://127.0.0.1:${appPort}/api/projects/switch`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'workspace-only-project' })
  }).then((response) => response.json());
  assert.equal(workspaceSwitch.isWatching, false);
  assert.deepEqual(await fetch(`http://127.0.0.1:${appPort}/api/live/active-goal`).then((response) => response.json()), {
    activeGoal: null, isWatching: false, path: null
  });
  const fixtureSwitch = await fetch(`http://127.0.0.1:${appPort}/api/projects/switch`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'fixture' })
  }).then((response) => response.json());
  assert.equal(fixtureSwitch.isWatching, false);

  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ['agentgdb_read_file', 'agentgdb_run_command', 'agentgdb_write_file']);

  const read = await client.callTool({ name: 'agentgdb_read_file', arguments: { path: 'src/input.txt' } });
  assert.match(read.content[0].text, /read fixture/);
  const linkedRead = await client.callTool({ name: 'agentgdb_read_file', arguments: { path: 'src/linked/input.txt' } });
  assert.equal(linkedRead.isError, true);
  const secretRead = await client.callTool({ name: 'agentgdb_read_file', arguments: { path: 'src/secret.txt' } });
  assert.equal(secretRead.content[0].text.includes(fixtureSecret), false);
  assert.match(secretRead.content[0].text, /REDACTED/);
  const outside = await client.callTool({ name: 'agentgdb_read_file', arguments: { path: '../outside.txt' } });
  assert.equal(outside.isError, true);

  const exactPathPolicy = await fetch(`http://127.0.0.1:${appPort}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'fixture', name: 'fixture', workspacePath: workspace, allowedPaths: ['src'], forbiddenPaths: [], allowedCommands: [JSON.stringify(commandArgs), JSON.stringify(staleCommandArgs)] })
  }).then((response) => response.json());
  assert.equal(exactPathPolicy.success, true);
  const descendantWrite = await client.callTool({ name: 'agentgdb_write_file', arguments: { path: 'src/exact-rule-child.txt', content: 'must be denied' } });
  assert.equal(descendantWrite.isError, true, 'an exact path rule must not authorize a descendant write');
  assert.match(descendantWrite.content[0].text, /does not match any configured allowlist path/);
  assert.equal(fs.existsSync(path.join(workspace, 'src', 'exact-rule-child.txt')), false);
  const noApprovalForDeniedWrite = await fetch(`http://127.0.0.1:${appPort}/api/approvals`, { headers: approvalAuthHeaders }).then((response) => response.json());
  assert.equal(noApprovalForDeniedWrite.approvals.length, 0, 'a policy-denied action must not reach the approval queue');

  const recursivePathPolicy = await fetch(`http://127.0.0.1:${appPort}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'fixture', name: 'fixture', workspacePath: workspace, allowedPaths: ['src/**'], forbiddenPaths: [], allowedCommands: [JSON.stringify(commandArgs), JSON.stringify(staleCommandArgs)] })
  }).then((response) => response.json());
  assert.equal(recursivePathPolicy.success, true);

  const writePromise = client.callTool({ name: 'agentgdb_write_file', arguments: { path: 'src/output.txt', content: 'approved fixture' } });
  const unauthenticatedList = await globalThis.fetch(`http://127.0.0.1:${appPort}/api/approvals`);
  assert.equal(unauthenticatedList.status, 401);
  let pending;
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/approvals`, { headers: approvalAuthHeaders });
    pending = (await response.json()).approvals[0];
    if (pending) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(pending, 'managed MCP call creates a durable pending approval');
  assert.equal(pending.action.name, 'write_file');
  assert.equal(pending.action.targetPath, 'src/output.txt');
  assert.deepEqual(pending.action.arguments, { path: 'src/output.txt', content: 'approved fixture' });
  assert.equal(pending.action.approvalContext.workspaceId, 'fixture');
  assert.equal(pending.action.approvalContext.workspacePath, fs.realpathSync(workspace));
  assert.equal(pending.action.approvalContext.policyVersion, 1);
  assert.match(pending.action.approvalContext.policyFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(pending.action.approvalContext.policy.allowedPaths, ['src/**']);
  assert.deepEqual(pending.action.approvalContext.policy.forbiddenPaths, []);
  assert.equal(pending.risk, 'MUTATING');
  const deniedAttempt = await globalThis.fetch(`http://127.0.0.1:${appPort}/api/approvals/${pending.id}/decision`, {
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
  const recentResponse = await fetch(`http://127.0.0.1:${appPort}/api/approvals`, { headers: approvalAuthHeaders });
  assert.equal(recentResponse.headers.get('cache-control'), 'no-store');
  const recent = await recentResponse.json();
  assert.equal(recent.recent.find((item) => item.id === pending.id).execution_status, 'COMPLETED');

  const stalePolicyWrite = client.callTool({ name: 'agentgdb_write_file', arguments: { path: 'src/stale-policy.txt', content: 'must not write after policy change' } });
  let stalePolicyApproval;
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/approvals`, { headers: approvalAuthHeaders });
    stalePolicyApproval = (await response.json()).approvals[0];
    if (stalePolicyApproval) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(stalePolicyApproval, 'write creates a pending approval before policy changes');
  const changedPolicy = await fetch(`http://127.0.0.1:${appPort}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'fixture', name: 'fixture', workspacePath: workspace, allowedPaths: ['src/**', 'docs/**'], allowedCommands: [JSON.stringify(commandArgs), JSON.stringify(staleCommandArgs)] })
  }).then((response) => response.json());
  assert.equal(changedPolicy.success, true);
  const stalePolicyDecision = await fetch(`http://127.0.0.1:${appPort}/api/approvals/${stalePolicyApproval.id}/decision`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-agentgdb-approval-token': approvalToken },
    body: JSON.stringify({ decision: 'APPROVED' })
  });
  assert.equal(stalePolicyDecision.status, 200);
  const stalePolicyResult = await stalePolicyWrite;
  assert.equal(stalePolicyResult.isError, true, 'an approval bound to the earlier policy is denied even while its file remains allowlisted');
  assert.match(stalePolicyResult.content[0].text, /Workspace policy changed while approval was pending/);
  assert.equal(fs.existsSync(path.join(workspace, 'src', 'stale-policy.txt')), false);
  const restoredPolicy = await fetch(`http://127.0.0.1:${appPort}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'fixture', name: 'fixture', workspacePath: workspace, allowedPaths: ['src/**'], allowedCommands: [JSON.stringify(commandArgs), JSON.stringify(staleCommandArgs)] })
  }).then((response) => response.json());
  assert.equal(restoredPolicy.success, true);

  const deniedCommand = await client.callTool({ name: 'agentgdb_run_command', arguments: { executable: process.execPath, args: ['-e', 'process.stdout.write("not-allowlisted")'] } });
  assert.equal(deniedCommand.isError, true);
  const allowedCommandPromise = client.callTool({ name: 'agentgdb_run_command', arguments: { executable: commandArgs[0], args: commandArgs.slice(1) } });
  let commandApproval;
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/approvals`, { headers: approvalAuthHeaders });
    commandApproval = (await response.json()).approvals[0];
    if (commandApproval) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(commandApproval);
  assert.equal(commandApproval.action.name, 'run_command');
  assert.equal(commandApproval.action.executable, commandArgs[0]);
  assert.deepEqual(commandApproval.action.args, commandArgs.slice(1));
  assert.equal(commandApproval.action.commandIdentity, JSON.stringify(commandArgs));
  await fetch(`http://127.0.0.1:${appPort}/api/approvals/${commandApproval.id}/decision`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-agentgdb-approval-token': approvalToken }, body: JSON.stringify({ decision: 'APPROVED' })
  });
  const commandResult = await allowedCommandPromise;
  assert.equal(commandResult.isError, undefined, 'successful managed command is not marked as an MCP error');
  assert.match(commandResult.content[0].text, /managed-command-ok/);
  assert.equal(commandResult.content[0].text.includes(fixtureSecret), false);
  assert.match(commandResult.content[0].text, /REDACTED/);
  const finalHistory = await fetch(`http://127.0.0.1:${appPort}/api/approvals`, { headers: approvalAuthHeaders }).then((response) => response.json());
  assert.equal(finalHistory.recent.find((item) => item.id === commandApproval.id).execution_status, 'COMPLETED');

  if (process.platform !== 'win32') {
    const approvedScript = path.join(workspace, 'src', 'approved-command.sh');
    const marker = path.join(workspace, 'src', 'changed-command-ran');
    fs.writeFileSync(approvedScript, '#!/bin/sh\nprintf original\n', { mode: 0o700 });
    const scriptIdentity = JSON.stringify([approvedScript]);
    const scriptPolicy = await fetch(`http://127.0.0.1:${appPort}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...approvalAuthHeaders },
      body: JSON.stringify({ id: 'fixture', name: 'fixture', workspacePath: workspace, allowedPaths: ['src/**'], forbiddenPaths: [], allowedCommands: [JSON.stringify(commandArgs), scriptIdentity, JSON.stringify(staleCommandArgs)] })
    }).then((response) => response.json());
    assert.equal(scriptPolicy.success, true);

    const changedExecutableCall = client.callTool({ name: 'agentgdb_run_command', arguments: { executable: approvedScript, args: [] } });
    let changedExecutableApproval;
    for (let attempt = 0; attempt < 60; attempt++) {
      const response = await fetch(`http://127.0.0.1:${appPort}/api/approvals`, { headers: approvalAuthHeaders });
      changedExecutableApproval = (await response.json()).approvals[0];
      if (changedExecutableApproval) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(changedExecutableApproval);
    assert.equal(changedExecutableApproval.action.resolvedExecutable, fs.realpathSync(approvedScript));
    assert.match(changedExecutableApproval.action.executableSha256, /^[a-f0-9]{64}$/);
    fs.writeFileSync(approvedScript, `#!/bin/sh\nprintf changed > '${marker}'\n`);
    await fetch(`http://127.0.0.1:${appPort}/api/approvals/${changedExecutableApproval.id}/decision`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...approvalAuthHeaders }, body: JSON.stringify({ decision: 'APPROVED' })
    });
    const changedExecutableResult = await changedExecutableCall;
    assert.match(changedExecutableResult.content[0].text, /executable changed while approval was pending/);
    assert.equal(fs.existsSync(marker), false, 'modified executable must not run after the older binary was approved');
  }

  const stalePolicyCommand = client.callTool({ name: 'agentgdb_run_command', arguments: { executable: staleCommandArgs[0], args: staleCommandArgs.slice(1) } });
  let staleCommandApproval;
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/approvals`, { headers: approvalAuthHeaders });
    staleCommandApproval = (await response.json()).approvals[0];
    if (staleCommandApproval) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(staleCommandApproval, 'allowlisted command creates a pending approval');
  const removedCommandPolicy = await fetch(`http://127.0.0.1:${appPort}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'fixture', name: 'fixture', workspacePath: workspace, allowedPaths: ['src/**'], allowedCommands: [JSON.stringify(commandArgs)] })
  }).then((response) => response.json());
  assert.equal(removedCommandPolicy.success, true);
  const staleCommandDecision = await fetch(`http://127.0.0.1:${appPort}/api/approvals/${staleCommandApproval.id}/decision`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-agentgdb-approval-token': approvalToken },
    body: JSON.stringify({ decision: 'APPROVED' })
  });
  assert.equal(staleCommandDecision.status, 200);
  const staleCommandResult = await stalePolicyCommand;
  assert.match(staleCommandResult.content[0].text, /Workspace policy changed while approval was pending/);
  assert.equal(fs.existsSync(staleCommandMarker), false, 'command removed during approval must never start');

  const timeoutPolicy = await fetch(`http://127.0.0.1:${appPort}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'fixture', name: 'fixture', workspacePath: workspace, allowedPaths: ['src/**'], forbiddenPaths: [], allowedCommands: [JSON.stringify(timeoutCommandArgs)] })
  }).then((response) => response.json());
  assert.equal(timeoutPolicy.success, true);
  const timedCommand = client.callTool({ name: 'agentgdb_run_command', arguments: { executable: timeoutCommandArgs[0], args: timeoutCommandArgs.slice(1) } });
  let timeoutApproval;
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/approvals`, { headers: approvalAuthHeaders });
    timeoutApproval = (await response.json()).approvals[0];
    if (timeoutApproval) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(timeoutApproval, 'timeout command must wait for explicit operator approval');
  await fetch(`http://127.0.0.1:${appPort}/api/approvals/${timeoutApproval.id}/decision`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...approvalAuthHeaders }, body: JSON.stringify({ decision: 'APPROVED' })
  });
  const timedResult = await timedCommand;
  assert.equal(timedResult.isError, true, 'timed-out command is reported as an MCP tool error');
  assert.match(timedResult.content[0].text, /Command timed out after 1000 ms/);
  assert.equal(fs.existsSync(descendantStartedMarker), true, 'the approved command launched its descendant before timeout');
  await new Promise((resolve) => setTimeout(resolve, 1800));
  assert.equal(fs.existsSync(descendantSurvivorMarker), false, 'timed-out managed command must terminate its descendant process');
  const timeoutHistory = await fetch(`http://127.0.0.1:${appPort}/api/approvals`, { headers: approvalAuthHeaders }).then((response) => response.json());
  assert.equal(timeoutHistory.recent.find((item) => item.id === timeoutApproval.id).execution_status, 'FAILED');

  const deniedWrite = client.callTool({ name: 'agentgdb_write_file', arguments: { path: 'src/operator-denied.txt', content: 'must not write' } });
  let deniedApproval;
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/approvals`, { headers: approvalAuthHeaders });
    deniedApproval = (await response.json()).approvals[0];
    if (deniedApproval) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(deniedApproval, 'mutating request waits for an explicit operator decision');
  const operatorDenial = await fetch(`http://127.0.0.1:${appPort}/api/approvals/${deniedApproval.id}/decision`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-agentgdb-approval-token': approvalToken },
    body: JSON.stringify({ decision: 'DENIED', reason: 'operator rejected in integration test' })
  });
  assert.equal(operatorDenial.status, 200);
  const deniedWriteResult = await deniedWrite;
  assert.equal(deniedWriteResult.isError, true, 'operator denial is returned to the waiting caller');
  assert.equal(fs.existsSync(path.join(workspace, 'src', 'operator-denied.txt')), false);
  const deniedHistory = await fetch(`http://127.0.0.1:${appPort}/api/approvals`, { headers: approvalAuthHeaders }).then((response) => response.json());
  const deniedRecord = deniedHistory.recent.find((item) => item.id === deniedApproval.id);
  assert.equal(deniedRecord.status, 'DENIED');
  assert.equal(deniedRecord.decided_by, 'token-holder');
  assert.equal(deniedRecord.decision_reason, 'operator rejected in integration test');

  const cancelController = new AbortController();
  const cancelledCall = client.callTool({ name: 'agentgdb_write_file', arguments: { path: 'src/cancelled.txt', content: 'must not write' } }, { signal: cancelController.signal }).catch((error) => error);
  let cancelledApproval;
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/approvals`, { headers: approvalAuthHeaders });
    cancelledApproval = (await response.json()).approvals[0];
    if (cancelledApproval) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(cancelledApproval);
  cancelController.abort();
  await cancelledCall;
  await new Promise((resolve) => setTimeout(resolve, 300));
  const cancelledHistory = await fetch(`http://127.0.0.1:${appPort}/api/approvals`, { headers: approvalAuthHeaders }).then((response) => response.json());
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
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(repoRoot, 'bin', 'agentgdb-mcp.js')], cwd: repoRoot, env: { ...process.env, HOME: home, USERPROFILE: home, AGENTGDB_DAEMON_URL: 'http://127.0.0.1:1' }, stderr: 'ignore' });
  const client = new Client({ name: 'agentgdb-unavailable-test', version: '1.0.0' }, { capabilities: {} });
  t.after(async () => { await client.close().catch(() => {}); fs.rmSync(home, { recursive: true, force: true }); });
  await client.connect(transport);
  const result = await client.callTool({ name: 'agentgdb_write_file', arguments: { path: 'src/never-written.txt', content: 'deny' } });
  assert.equal(result.isError, true);
  assert.equal(fs.existsSync(path.join(workspace, 'src', 'never-written.txt')), false);
});

test('managed MCP denies a pending write when the approval daemon stops', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-approval-outage-'));
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.mkdirSync(path.join(home, '.agentgdb'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agentgdb', 'projects.json'), JSON.stringify({ activeProjectId: 'fixture', projects: [{ id: 'fixture', name: 'fixture', workspacePath: workspace, allowedPaths: ['src/**'], forbiddenPaths: [], allowedCommands: [] }] }));
  const appPort = await unusedPort();
  const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const approvalToken = 'managed-mcp-outage-token-0123456789';
  const startDaemon = () => spawn(process.execPath, ['src/server.js'], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, USERPROFILE: home, HOST: '127.0.0.1', PORT: String(appPort), AGENTGDB_APPROVAL_TOKEN: approvalToken },
    stdio: 'ignore'
  });
  let daemon = startDaemon();
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(repoRoot, 'bin', 'agentgdb-mcp.js')], cwd: repoRoot, env: { ...process.env, HOME: home, USERPROFILE: home, AGENTGDB_DAEMON_URL: `http://127.0.0.1:${appPort}`, AGENTGDB_APPROVAL_TIMEOUT_MS: '10000' }, stderr: 'ignore' });
  const client = new Client({ name: 'agentgdb-approval-outage-test', version: '1.0.0' }, { capabilities: {} });
  t.after(async () => {
    await client.close().catch(() => {});
    if (daemon.exitCode === null) {
      daemon.kill('SIGTERM');
      await new Promise((resolve) => daemon.once('exit', resolve));
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  await waitForServer(daemon, appPort);
  await client.connect(transport);
  const write = client.callTool({ name: 'agentgdb_write_file', arguments: { path: 'src/daemon-outage.txt', content: 'must not write' } });
  let pending;
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/approvals`, { headers: { 'x-agentgdb-approval-token': approvalToken } });
    pending = (await response.json()).approvals[0];
    if (pending) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(pending, 'write is durably queued before the service outage');
  daemon.kill('SIGTERM');
  await new Promise((resolve) => daemon.once('exit', resolve));

  const result = await write;
  assert.equal(result.isError, true, 'caller receives fail-closed result after the approval service stops');
  assert.equal(fs.existsSync(path.join(workspace, 'src', 'daemon-outage.txt')), false);

  daemon = startDaemon();
  await waitForServer(daemon, appPort);
  const records = await fetch(`http://127.0.0.1:${appPort}/api/approvals`, { headers: { 'x-agentgdb-approval-token': approvalToken } }).then((response) => response.json());
  const denied = records.recent.find((item) => item.id === pending.id);
  assert.equal(denied.status, 'DENIED');
  assert.match(denied.decision_reason, /Approval dashboard became unavailable/);
});

test('managed MCP expires an unanswered write approval without writing', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-expired-approval-'));
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(home, '.agentgdb'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agentgdb', 'projects.json'), JSON.stringify({ activeProjectId: 'fixture', projects: [{ id: 'fixture', name: 'fixture', workspacePath: workspace, allowedPaths: ['src/**'], forbiddenPaths: [], allowedCommands: [] }] }));
  const appPort = await unusedPort();
  const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const daemon = spawn(process.execPath, ['src/server.js'], { cwd: repoRoot, env: { ...process.env, HOME: home, USERPROFILE: home, HOST: '127.0.0.1', PORT: String(appPort), AGENTGDB_APPROVAL_TIMEOUT_MS: '1000', AGENTGDB_APPROVAL_TOKEN: 'managed-mcp-timeout-token-0123456789' }, stdio: 'ignore' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(repoRoot, 'bin', 'agentgdb-mcp.js')], cwd: repoRoot, env: { ...process.env, HOME: home, USERPROFILE: home, AGENTGDB_DAEMON_URL: `http://127.0.0.1:${appPort}`, AGENTGDB_APPROVAL_TIMEOUT_MS: '1000' }, stderr: 'ignore' });
  const client = new Client({ name: 'agentgdb-timeout-test', version: '1.0.0' }, { capabilities: {} });
  t.after(async () => { await client.close().catch(() => {}); daemon.kill('SIGTERM'); if (daemon.exitCode === null) await new Promise((resolve) => daemon.once('exit', resolve)); fs.rmSync(home, { recursive: true, force: true }); });
  await waitForServer(daemon, appPort);
  await client.connect(transport);
  const result = await client.callTool({ name: 'agentgdb_write_file', arguments: { path: 'src/expired.txt', content: 'deny' } });
  assert.equal(result.isError, true);
  assert.equal(fs.existsSync(path.join(workspace, 'src', 'expired.txt')), false);
  const records = await fetch(`http://127.0.0.1:${appPort}/api/approvals`, { headers: { 'x-agentgdb-approval-token': 'managed-mcp-timeout-token-0123456789' } }).then((response) => response.json());
  assert.equal(records.recent[0].status, 'EXPIRED');
});

test('managed MCP denies approval when policy context would be redacted', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-redacted-approval-'));
  const workspace = path.join(home, 'token=opaque-context-fixture-0123456789');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(home, '.agentgdb'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agentgdb', 'projects.json'), JSON.stringify({ activeProjectId: 'fixture', projects: [{ id: 'fixture', name: 'fixture', workspacePath: workspace, allowedPaths: ['src/**'], forbiddenPaths: [], allowedCommands: [] }] }));
  const appPort = await unusedPort();
  const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const approvalToken = 'managed-mcp-redaction-token-0123456789';
  const daemon = spawn(process.execPath, ['src/server.js'], { cwd: repoRoot, env: { ...process.env, HOME: home, USERPROFILE: home, HOST: '127.0.0.1', PORT: String(appPort), AGENTGDB_APPROVAL_TIMEOUT_MS: '1000', AGENTGDB_APPROVAL_TOKEN: approvalToken }, stdio: 'ignore' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(repoRoot, 'bin', 'agentgdb-mcp.js')], cwd: repoRoot, env: { ...process.env, HOME: home, USERPROFILE: home, AGENTGDB_DAEMON_URL: `http://127.0.0.1:${appPort}`, AGENTGDB_APPROVAL_TIMEOUT_MS: '1000' }, stderr: 'ignore' });
  const client = new Client({ name: 'agentgdb-redaction-test', version: '1.0.0' }, { capabilities: {} });
  t.after(async () => { await client.close().catch(() => {}); daemon.kill('SIGTERM'); if (daemon.exitCode === null) await new Promise((resolve) => daemon.once('exit', resolve)); fs.rmSync(home, { recursive: true, force: true }); });
  await waitForServer(daemon, appPort);
  await client.connect(transport);
  const result = await client.callTool({ name: 'agentgdb_write_file', arguments: { path: 'src/denied.txt', content: 'must not write' } });
  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text || '', /approval details contain credential-like content/i);
  assert.equal(fs.existsSync(path.join(workspace, 'src', 'denied.txt')), false);
  const records = await fetch(`http://127.0.0.1:${appPort}/api/approvals`, { headers: { 'x-agentgdb-approval-token': approvalToken } }).then((response) => response.json());
  assert.equal(records.approvals.length, 0);
});

test('dashboard startup durably rejects approvals left pending by a previous run', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-daemon-restart-'));
  const dbDir = path.join(home, '.agentgdb');
  fs.mkdirSync(dbDir, { recursive: true });
  const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const dbModule = new URL('../../src/db.js', import.meta.url).href;
  const seed = spawnSync(process.execPath, ['--input-type=module', '-e', `import { createApproval } from '${dbModule}'; createApproval({id:'restart-fixture',sessionId:'mcp-test',action:{name:'write_file',path:'src/pending'},risk:'MUTATING',expiresAt:Date.now()+60000});`], { cwd: repoRoot, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr);
  const appPort = await unusedPort();
  const daemon = spawn(process.execPath, ['src/server.js'], { cwd: repoRoot, env: { ...process.env, HOME: home, USERPROFILE: home, HOST: '127.0.0.1', PORT: String(appPort), AGENTGDB_APPROVAL_TOKEN: 'managed-mcp-restart-token-0123456789' }, stdio: ['ignore', 'pipe', 'ignore'] });
  let daemonOutput = '';
  daemon.stdout.setEncoding('utf8');
  daemon.stdout.on('data', (chunk) => { daemonOutput += chunk; });
  t.after(async () => { daemon.kill('SIGTERM'); if (daemon.exitCode === null) await new Promise((resolve) => daemon.once('exit', resolve)); fs.rmSync(home, { recursive: true, force: true }); });
  await waitForServer(daemon, appPort);
  const records = await fetch(`http://127.0.0.1:${appPort}/api/approvals`, { headers: { 'x-agentgdb-approval-token': 'managed-mcp-restart-token-0123456789' } }).then((response) => response.json());
  const restarted = records.recent.find((item) => item.id === 'restart-fixture');
  assert.equal(restarted.status, 'REJECTED_RESTART');
  assert.match(restarted.decision_reason, /cannot be resumed/);
  assert.match(daemonOutput, /Startup persistence maintenance complete/);
  assert.match(daemonOutput, /"rejectedPendingApprovals":1/);
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
