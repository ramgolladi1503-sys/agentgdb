import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadProjects } from './project_registry.js';
import { createApproval, getApproval, decideApproval, expireApproval, recordApprovalExecution } from './db.js';
import { evaluateScopePolicy, inspectToolCall, pathStaysInWorkspace } from './security/scope_policy.js';
import { containsSensitiveValue, redactSensitive, redactSensitiveText } from './security/redaction.js';
import { describeCommandExecutable } from './security/command_policy.js';
import { runManagedCommand } from './security/managed_command_runner.js';

const DAEMON_URL = process.env.AGENTGDB_DAEMON_URL || 'http://127.0.0.1:9099';
const APPROVAL_TIMEOUT_MS = Number(process.env.AGENTGDB_APPROVAL_TIMEOUT_MS || 300000);
const COMMAND_TIMEOUT_MS = Number(process.env.AGENTGDB_COMMAND_TIMEOUT_MS || 120000);
if (!Number.isInteger(APPROVAL_TIMEOUT_MS) || APPROVAL_TIMEOUT_MS < 1000 || APPROVAL_TIMEOUT_MS > 3600000) throw new Error('AGENTGDB_APPROVAL_TIMEOUT_MS must be an integer from 1000 to 3600000');
if (!Number.isInteger(COMMAND_TIMEOUT_MS) || COMMAND_TIMEOUT_MS < 1000 || COMMAND_TIMEOUT_MS > 600000) throw new Error('AGENTGDB_COMMAND_TIMEOUT_MS must be an integer from 1000 to 600000');
const MAX_FILE_BYTES = 1024 * 1024;
const POLICY_SNAPSHOT_VERSION = 1;

function activePolicy() {
  const config = loadProjects();
  const project = config.projects.find((entry) => entry.id === config.activeProjectId);
  if (!project?.workspacePath || !Array.isArray(project.allowedPaths) || !Array.isArray(project.forbiddenPaths)) {
    throw new Error('No active workspace with an explicit path allowlist is configured.');
  }
  let stat;
  try { stat = fs.statSync(project.workspacePath); } catch { throw new Error('Configured workspace is unavailable.'); }
  if (!stat.isDirectory()) throw new Error('Configured workspace path is not a directory.');
  return { project, scope: { allowedPaths: project.allowedPaths, forbiddenPaths: project.forbiddenPaths, allowedCommands: project.allowedCommands || [] } };
}

function snapshotPolicy(project, scope) {
  const snapshot = {
    version: POLICY_SNAPSHOT_VERSION,
    workspaceId: project.id,
    workspacePath: fs.realpathSync(project.workspacePath),
    allowedPaths: [...scope.allowedPaths].sort(),
    forbiddenPaths: [...scope.forbiddenPaths].sort(),
    allowedCommands: [...scope.allowedCommands].sort()
  };
  return {
    snapshot,
    fingerprint: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
  };
}

function resolveCheckedPath(relativePath, project, scope) {
  const decision = evaluateScopePolicy(relativePath, scope, true);
  if (!decision.allowed) throw new Error(decision.reason || 'Path denied by policy.');
  if (!pathStaysInWorkspace(relativePath, project.workspacePath)) throw new Error('Path does not resolve safely within the active workspace.');
  const root = fs.realpathSync(project.workspacePath);
  const target = path.resolve(root, relativePath);
  const rootRelative = path.relative(root, target);
  if (!rootRelative || rootRelative === '..' || rootRelative.startsWith(`..${path.sep}`) || path.isAbsolute(rootRelative)) throw new Error('Workspace root itself is not a file target.');
  return target;
}

async function dashboardIsAvailable() {
  try {
    const response = await fetch(`${DAEMON_URL}/healthz`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch { return false; }
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Tool request was cancelled.'));
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', aborted); resolve(); }
    function aborted() { clearTimeout(timer); reject(new Error('Tool request was cancelled.')); }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

async function requestApproval(action, project, policy, signal) {
  if (!await dashboardIsAvailable()) throw new Error('Approval dashboard unavailable; action denied without execution.');
  const id = randomUUID();
  const approvedAction = {
    ...action,
    approvalContext: {
      workspaceId: project.id,
      workspacePath: policy.snapshot.workspacePath,
      policyVersion: policy.snapshot.version,
      policyFingerprint: policy.fingerprint,
      policy: policy.snapshot
    }
  };
  if (containsSensitiveValue(approvedAction)) {
    throw new Error('Approval details contain credential-like content that cannot be shown safely; action denied.');
  }
  createApproval({
    id,
    sessionId: `mcp-${process.pid}`,
    action: approvedAction,
    risk: 'MUTATING',
    expiresAt: Date.now() + APPROVAL_TIMEOUT_MS
  });
  while (true) {
    if (signal?.aborted) {
      decideApproval(id, 'DENIED', 'managed-mcp', 'Calling agent cancelled the request');
      throw new Error('Tool request cancelled; action denied.');
    }
    if (!await dashboardIsAvailable()) {
      decideApproval(id, 'DENIED', 'managed-mcp', 'Approval dashboard became unavailable');
      throw new Error('Approval dashboard became unavailable; action denied without execution.');
    }
    const current = getApproval(id);
    if (!current || current.status !== 'PENDING') {
      if (current?.status === 'APPROVED') return id;
      throw new Error(`Action was not approved (${current?.status || 'approval record missing'}).`);
    }
    if (Date.now() >= current.expires_at) {
      expireApproval(id);
      throw new Error('Approval timed out; action denied without execution.');
    }
    try {
      await delay(250, signal);
    } catch (error) {
      decideApproval(id, 'DENIED', 'managed-mcp', 'Calling agent cancelled the request');
      throw error;
    }
  }
}

async function performRead(args) {
  const { project, scope } = activePolicy();
  const target = resolveCheckedPath(args.path, project, scope);
  const stat = fs.statSync(target);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Only files up to 1 MiB can be read through this adapter.');
  // Workspace files can contain credentials even when the path is allowlisted.
  // Redact known patterns before the bytes cross the MCP boundary to an agent.
  return redactSensitiveText(fs.readFileSync(target, 'utf8'));
}

async function performWrite(args, context) {
  const { project, scope } = activePolicy();
  const proposed = { function: { name: 'write_file', arguments: JSON.stringify(args) } };
  const check = inspectToolCall(proposed, scope);
  if (!check.allowed) throw new Error(check.reason || 'Write denied by policy.');
  if (containsSensitiveValue(args)) throw new Error('Credential-like value detected; write denied.');
  const target = resolveCheckedPath(args.path, project, scope);
  if (Buffer.byteLength(args.content, 'utf8') > MAX_FILE_BYTES) throw new Error('Writes are limited to 1 MiB.');
  const policy = snapshotPolicy(project, scope);
  const approvalId = await requestApproval(check.action, project, policy, context.mcpReq.signal);
  let tempPath;
  const startedAt = Date.now();
  try {
    const latest = activePolicy();
    if (latest.project.id !== project.id || latest.project.workspacePath !== project.workspacePath) throw new Error('Active workspace changed while approval was pending.');
    if (snapshotPolicy(latest.project, latest.scope).fingerprint !== policy.fingerprint) throw new Error('Workspace policy changed while approval was pending.');
    const checkedTarget = resolveCheckedPath(args.path, latest.project, latest.scope);
    fs.mkdirSync(path.dirname(checkedTarget), { recursive: true });
    if (!pathStaysInWorkspace(args.path, latest.project.workspacePath)) throw new Error('Path changed during approval; write denied.');
    const mode = fs.existsSync(checkedTarget) ? fs.statSync(checkedTarget).mode & 0o777 : 0o600;
    tempPath = path.join(path.dirname(checkedTarget), `.agentgdb-${randomUUID()}.tmp`);
    fs.writeFileSync(tempPath, args.content, { encoding: 'utf8', flag: 'wx', mode });
    if (!pathStaysInWorkspace(args.path, latest.project.workspacePath)) throw new Error('Path changed before commit; write denied.');
    fs.renameSync(tempPath, checkedTarget);
    recordApprovalExecution(approvalId, 'COMPLETED', { durationMs: Date.now() - startedAt });
    return `Wrote ${args.path} after approval.`;
  } catch (error) {
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    recordApprovalExecution(approvalId, 'FAILED', { durationMs: Date.now() - startedAt, error: error.message.slice(0, 300) });
    throw error;
  }
}

async function performCommand(args, context) {
  const { project, scope } = activePolicy();
  const commandIdentity = JSON.stringify([args.executable, ...args.args]);
  if (!scope.allowedCommands.includes(commandIdentity)) throw new Error('Command is not an exact member of the active workspace allowlist.');
  const workspacePath = fs.realpathSync(project.workspacePath);
  const executableIdentity = await describeCommandExecutable(args.executable, workspacePath);
  const action = {
    name: 'run_command', executable: args.executable, resolvedExecutable: executableIdentity.path,
    executableSha256: executableIdentity.sha256, args: args.args, commandIdentity
  };
  if (containsSensitiveValue(action)) throw new Error('Credential-like command argument detected; command denied.');
  const policy = snapshotPolicy(project, scope);
  const approvalId = await requestApproval(action, project, policy, context.mcpReq.signal);
  const startedAt = Date.now();
  try {
    const latest = activePolicy();
    if (latest.project.id !== project.id || fs.realpathSync(latest.project.workspacePath) !== workspacePath || snapshotPolicy(latest.project, latest.scope).fingerprint !== policy.fingerprint || !latest.scope.allowedCommands.includes(commandIdentity)) {
      throw new Error('Workspace policy changed while approval was pending.');
    }
    const latestExecutableIdentity = await describeCommandExecutable(args.executable, workspacePath);
    if (latestExecutableIdentity.path !== executableIdentity.path || latestExecutableIdentity.sha256 !== executableIdentity.sha256) {
      throw new Error('Command executable changed while approval was pending.');
    }
    const env = {};
    for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TMP', 'TEMP', 'LANG', 'LC_ALL']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const result = await runManagedCommand(executableIdentity.path, args.args, {
      cwd: workspacePath,
      env,
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxOutputBytes: MAX_FILE_BYTES,
      signal: context.mcpReq.signal
    });
    recordApprovalExecution(approvalId, 'COMPLETED', { durationMs: Date.now() - startedAt, exitCode: 0 });
    return {
      isError: false,
      text: `Command completed (exit 0).\nstdout:\n${redactSensitiveText(result.stdout)}\nstderr:\n${redactSensitiveText(result.stderr)}`
    };
  } catch (error) {
    recordApprovalExecution(approvalId, 'FAILED', { durationMs: Date.now() - startedAt, exitCode: Number.isInteger(error.code) ? error.code : null, error: String(error.message).slice(0, 300) });
    return {
      isError: true,
      text: `Command failed. ${redactSensitiveText(String(error.message).slice(0, 500))}\nstdout:\n${redactSensitiveText(error.stdout || '')}\nstderr:\n${redactSensitiveText(error.stderr || '')}`
    };
  }
}

export function createManagedMcpServer() {
  const server = new McpServer({ name: 'agentgdb-managed-tools', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.registerTool('agentgdb_read_file', {
    title: 'Read workspace file',
    description: 'Read one allowlisted relative file from the active AgentGDB workspace. Files over 1 MiB and paths outside the workspace are denied.',
    inputSchema: z.object({ path: z.string().min(1).max(1024) }).strict()
  }, async (args) => ({ content: [{ type: 'text', text: await performRead(args) }] }));
  server.registerTool('agentgdb_write_file', {
    title: 'Write workspace file',
    description: 'Write one allowlisted relative file. Requires durable operator approval before the write is performed; no native filesystem tool should be enabled alongside this tool when mediation is required.',
    inputSchema: z.object({ path: z.string().min(1).max(1024), content: z.string().max(MAX_FILE_BYTES) }).strict()
  }, async (args, context) => ({ content: [{ type: 'text', text: await performWrite(args, context) }] }));
  server.registerTool('agentgdb_run_command', {
    title: 'Run exact allowlisted command',
    description: 'Run an executable with an argument array, without a shell. The exact JSON array [executable,...args] must be in the workspace allowedCommands list and requires operator approval.',
    inputSchema: z.object({ executable: z.string().min(1).max(256), args: z.array(z.string().max(4096)).max(64).default([]) }).strict()
  }, async (args, context) => {
    const result = await performCommand(args, context);
    return { content: [{ type: 'text', text: result.text }], ...(result.isError ? { isError: true } : {}) };
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createManagedMcpServer();
  await server.connect(new StdioServerTransport());
}
