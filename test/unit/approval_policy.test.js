import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluateScopePolicy, inspectToolCall, normalizeActionPath, pathStaysInWorkspace } from '../../src/security/scope_policy.js';
import { redactSensitive, containsSensitiveValue } from '../../src/security/redaction.js';

test('path policy rejects traversal, absolute paths, and empty segments', () => {
  assert.equal(normalizeActionPath('../secrets'), null);
  assert.equal(normalizeActionPath('/etc/passwd'), null);
  assert.equal(normalizeActionPath('src//main.js'), null);
  assert.equal(evaluateScopePolicy('src/main.js', null).allowed, false);
});

test('explicit allowlist matches path boundaries and denies forbidden paths', () => {
  const scope = { allowedPaths: ['src/**'], forbiddenPaths: ['src/secrets/**'] };
  assert.equal(evaluateScopePolicy('src/main.js', scope).allowed, true);
  assert.equal(evaluateScopePolicy('src/secrets/key.txt', scope).allowed, false);
  assert.equal(evaluateScopePolicy('src-other/main.js', scope).allowed, false);
});

test('tool calls fail closed for unknown schemas and shell calls', () => {
  assert.equal(inspectToolCall({ function: { name: 'mystery', arguments: '{}' } }, { allowedPaths: ['src/**'] }).allowed, false);
  const shell = { function: { name: 'run_shell', arguments: JSON.stringify({ command: 'rm -rf build' }) } };
  assert.equal(inspectToolCall(shell, { allowedPaths: ['src/**'], allowedCommands: [] }).allowed, false);
  assert.equal(inspectToolCall(shell, { allowedPaths: ['src/**'], allowedCommands: ['rm -rf build'] }).allowed, true);
});

test('mutating file tool is marked for human approval', () => {
  const call = { function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/main.js', content: 'fixture' }) } };
  const result = inspectToolCall(call, { allowedPaths: ['src/**'], forbiddenPaths: [] });
  assert.equal(result.allowed, true);
  assert.equal(result.risk, 'MUTATING');
  const create = inspectToolCall({ function: { name: 'create_file', arguments: JSON.stringify({ path: 'src/new.js' }) } }, { allowedPaths: ['src/**'], forbiddenPaths: [] });
  assert.equal(create.risk, 'MUTATING');
});

test('workspace path check rejects symlink escapes and missing roots', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-scope-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-outside-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(pathStaysInWorkspace('src/new.js', root), true);
  assert.equal(pathStaysInWorkspace('escape/secret.txt', root), false);
  assert.equal(pathStaysInWorkspace('src/new.js', path.join(root, 'missing')), false);
});

test('pending approval is durably rejected after database restart', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-approval-restart-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dbModule = new URL('../../src/db.js', import.meta.url).href;
  const create = spawnSync(process.execPath, ['--input-type=module', '-e', `import { createApproval } from '${dbModule}'; createApproval({id:'restart-fixture',sessionId:'s',action:{name:'write_file'},risk:'MUTATING',expiresAt:Date.now()+60000});`], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(create.status, 0, create.stderr);
  const restart = spawnSync(process.execPath, ['--input-type=module', '-e', `import { getApproval, rejectPendingApprovals } from '${dbModule}'; rejectPendingApprovals(); console.log(getApproval('restart-fixture').status);`], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(restart.status, 0, restart.stderr);
  assert.match(restart.stdout, /REJECTED_RESTART/);
});

test('trace redaction masks common credential formats and detects secret-bearing actions', () => {
  const payload = { message: 'token=AbCdEfGhIjKlMnOp123456', authorization: 'Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789' };
  const redacted = redactSensitive(payload);
  assert.doesNotMatch(JSON.stringify(redacted), /AbCdEfGhIjKlMnOp123456/);
  assert.doesNotMatch(JSON.stringify(redacted), /ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
  assert.equal(containsSensitiveValue(payload), true);
  assert.equal(containsSensitiveValue({ path: 'src/file.js' }), false);
});
