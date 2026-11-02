import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluateScopePolicy, inspectToolCall, normalizeActionPath, normalizeScopePattern, pathStaysInWorkspace } from '../../src/security/scope_policy.js';
import { redactSensitive, redactSensitiveText, containsSensitiveValue } from '../../src/security/redaction.js';

test('path policy rejects traversal, absolute and drive-relative paths, and empty segments', () => {
  assert.equal(normalizeActionPath('../secrets'), null);
  assert.equal(normalizeActionPath('/etc/passwd'), null);
  assert.equal(normalizeActionPath('C:/Windows/system.ini'), null);
  assert.equal(normalizeActionPath('C:temp\\file.txt'), null);
  assert.equal(normalizeActionPath('\\\\server\\share\\file.txt'), null);
  assert.equal(normalizeActionPath('src//main.js'), null);
  assert.equal(normalizeActionPath('src/CON'), null);
  assert.equal(normalizeActionPath('src/aux.txt'), null);
  assert.equal(normalizeActionPath('src/COM¹.log'), null);
  assert.equal(normalizeActionPath('src/file:stream'), null);
  assert.equal(normalizeActionPath('src/name.'), null);
  assert.equal(normalizeActionPath('src/name '), null);
  assert.equal(normalizeActionPath('src/invalid?.txt'), null);
  assert.equal(evaluateScopePolicy('src/main.js', null).allowed, false);
});

test('explicit allowlist matches path boundaries and denies forbidden paths', () => {
  const scope = { allowedPaths: ['src/**'], forbiddenPaths: ['src/secrets/**'] };
  assert.equal(evaluateScopePolicy('src/main.js', scope).allowed, true);
  assert.equal(evaluateScopePolicy('src/secrets/key.txt', scope).allowed, false);
  assert.equal(evaluateScopePolicy('src-other/main.js', scope).allowed, false);
});

test('exact path rules match only the exact path; descendants require an explicit recursive rule', () => {
  const exactAllow = { allowedPaths: ['src/file.js'], forbiddenPaths: [] };
  assert.equal(evaluateScopePolicy('src/file.js', exactAllow).allowed, true);
  assert.equal(evaluateScopePolicy('src/file.js/child.txt', exactAllow).allowed, false);

  const exactDeny = { allowedPaths: ['src/**'], forbiddenPaths: ['src/secrets/key.txt'] };
  assert.equal(evaluateScopePolicy('src/secrets/key.txt', exactDeny).allowed, false);
  assert.equal(evaluateScopePolicy('src/secrets/key.txt/child.txt', exactDeny).allowed, true,
    'an exact forbidden path does not silently become a directory rule');
});

test('scope patterns reject ambiguous wildcards and invalid stored policies fail closed', () => {
  assert.equal(normalizeScopePattern('src/**'), 'src/**');
  assert.equal(normalizeScopePattern('src/main.js'), 'src/main.js');
  assert.equal(normalizeScopePattern('**'), '**');
  for (const pattern of ['*', 'src*', 'src/*', '**/*.js', 'src/**/private', '../src/**']) {
    assert.equal(normalizeScopePattern(pattern), null, `${pattern} is outside the supported pattern grammar`);
    const decision = evaluateScopePolicy('src-private/key.js', { allowedPaths: [pattern], forbiddenPaths: [] });
    assert.equal(decision.allowed, false, `${pattern} must not authorize an ambiguous path`);
    assert.equal(decision.driftStatus, 'UNKNOWN');
  }
  const invalidDenyRule = evaluateScopePolicy('src-private/key.js', { allowedPaths: ['**'], forbiddenPaths: ['src*'] });
  assert.equal(invalidDenyRule.allowed, false, 'an invalid deny rule must fail closed even with a broad allowlist');
  assert.equal(invalidDenyRule.driftStatus, 'UNKNOWN');
});

test('Windows policy matching ignores case for allowed and forbidden path segments', () => {
  const scope = { allowedPaths: ['Workspace/**'], forbiddenPaths: ['Workspace/Secrets/**'] };
  assert.equal(evaluateScopePolicy('workspace/src/main.js', scope, true, 'win32').allowed, true);
  const denied = evaluateScopePolicy('WORKSPACE/secrets/key.txt', scope, true, 'win32');
  assert.equal(denied.allowed, false);
  assert.equal(denied.driftStatus, 'DRIFT_DETECTED');
  assert.equal(evaluateScopePolicy('workspace/src/main.js', scope, true, 'linux').allowed, false,
    'POSIX matching stays case-sensitive');
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
  const inside = path.join(root, 'inside-target');
  fs.mkdirSync(inside);
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(inside, path.join(root, 'internal-link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(pathStaysInWorkspace('src/new.js', root), true);
  assert.equal(pathStaysInWorkspace('escape/secret.txt', root), false);
  assert.equal(pathStaysInWorkspace('internal-link/file.txt', root), false);
  assert.equal(pathStaysInWorkspace('src/new.js', path.join(root, 'missing')), false);
});

test('pending approval is durably rejected after database restart', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-approval-restart-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dbModule = new URL('../../src/db.js', import.meta.url).href;
  const create = spawnSync(process.execPath, ['--input-type=module', '-e', `import { createApproval } from '${dbModule}'; createApproval({id:'restart-fixture',sessionId:'s',action:{name:'write_file'},risk:'MUTATING',expiresAt:Date.now()+60000});`], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
  assert.equal(create.status, 0, create.stderr);
  const restart = spawnSync(process.execPath, ['--input-type=module', '-e', `import { getApproval, rejectPendingApprovals } from '${dbModule}'; rejectPendingApprovals(); console.log(getApproval('restart-fixture').status);`], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
  assert.equal(restart.status, 0, restart.stderr);
  assert.match(restart.stdout, /REJECTED_RESTART/);
});

test('approval execution summaries are redacted before database persistence', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-execution-redaction-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dbModule = new URL('../../src/db.js', import.meta.url).href;
  const actionSecret = 'opaque-approval-action-fixture-0123456789';
  const reasonSecret = 'opaque-approval-reason-fixture-0123456789';
  const executionSecret = 'opaque-execution-error-fixture-0123456789';
  const script = `
    import { createApproval, decideApproval, recordApprovalExecution, getApproval } from ${JSON.stringify(dbModule)};
    createApproval({ id: 'redaction-fixture', sessionId: 'test', action: { name: 'run_command', authorization: 'Bearer ${actionSecret}' }, risk: 'MUTATING', expiresAt: Date.now() + 60000 });
    decideApproval('redaction-fixture', 'APPROVED', 'test', 'Authorization: Bearer ${reasonSecret}');
    recordApprovalExecution('redaction-fixture', 'FAILED', { error: 'Authorization: Bearer ${executionSecret}' });
    console.log(JSON.stringify(getApproval('redaction-fixture')));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  for (const secret of [actionSecret, reasonSecret, executionSecret]) assert.doesNotMatch(result.stdout, new RegExp(secret));
  assert.match(result.stdout, /REDACTED/);
});

test('trace redaction masks common credential formats and detects secret-bearing actions', () => {
  const payload = {
    message: 'token=AbCdEfGhIjKlMnOp123456',
    headers: {
      authorization: 'Bearer opaque-bearer-fixture-token-0123456789',
      'x-api-key': 'opaque-api-key-fixture-0123456789',
      Cookie: 'session=session-cookie-fixture-0123456789'
    },
    commandArgs: ['Bearer opaque-command-credential-fixture-0123456789'],
    aws_secret_access_key: 'aws-secret-fixture-0123456789'
  };
  const redacted = redactSensitive(payload);
  assert.doesNotMatch(JSON.stringify(redacted), /AbCdEfGhIjKlMnOp123456/);
  assert.doesNotMatch(JSON.stringify(redacted), /opaque-bearer-fixture-token-0123456789/);
  assert.doesNotMatch(JSON.stringify(redacted), /opaque-api-key-fixture-0123456789/);
  assert.doesNotMatch(JSON.stringify(redacted), /session-cookie-fixture-0123456789/);
  assert.doesNotMatch(JSON.stringify(redacted), /opaque-command-credential-fixture-0123456789/);
  assert.doesNotMatch(JSON.stringify(redacted), /aws-secret-fixture-0123456789/);
  const commandLog = redactSensitiveText('Authorization: Bearer opaque-header-fixture-0123456789\nCookie: session=opaque-cookie-fixture-0123456789\nAWS_SECRET_ACCESS_KEY=opaque-aws-fixture-0123456789');
  assert.doesNotMatch(commandLog, /opaque-(?:header|cookie|aws)-fixture/);
  assert.equal(containsSensitiveValue(payload), true);
  assert.equal(containsSensitiveValue({ path: 'src/file.js' }), false);
});
