import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describeCommandExecutable, resolveCommandExecutable } from '../../src/security/command_policy.js';

test('absolute command executable resolves to a canonical regular executable', () => {
  assert.equal(resolveCommandExecutable(process.execPath, process.cwd()), fs.realpathSync(process.execPath));
});

test('bare command resolution follows PATH and returns the canonical executable', (t) => {
  if (process.platform === 'win32') return t.skip('fixture uses a POSIX executable symlink');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-command-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.symlinkSync(process.execPath, path.join(root, 'agentgdb-node'));
  assert.equal(resolveCommandExecutable('agentgdb-node', root, { PATH: root }), fs.realpathSync(process.execPath));
});

test('command identity changes when an executable changes while its path stays the same', async (t) => {
  if (process.platform === 'win32') return t.skip('fixture executable uses a POSIX shebang');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-command-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, 'approved-command');
  fs.writeFileSync(executable, '#!/bin/sh\nprintf first\n', { mode: 0o700 });

  const first = await describeCommandExecutable(executable, root);
  fs.writeFileSync(executable, '#!/bin/sh\nprintf second\n');
  const second = await describeCommandExecutable(executable, root);

  assert.equal(first.path, second.path);
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(first.sha256, second.sha256);
});

test('command executable resolution denies missing, non-files, and non-executable files', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX execute permission bits do not apply on Windows');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-command-deny-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const notExecutable = path.join(root, 'not-executable');
  fs.writeFileSync(notExecutable, 'data', { mode: 0o600 });
  assert.throws(() => resolveCommandExecutable(path.join(root, 'missing'), root), /could not be resolved/);
  assert.throws(() => resolveCommandExecutable(notExecutable, root), /could not be resolved/);
  assert.throws(() => resolveCommandExecutable(root, root), /could not be resolved/);
});

test('command executable size setting rejects out-of-range values at module startup', () => {
  const moduleUrl = new URL('../../src/security/command_policy.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import '${moduleUrl}';`], {
    env: { ...process.env, AGENTGDB_MAX_COMMAND_EXECUTABLE_BYTES: '1024' },
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AGENTGDB_MAX_COMMAND_EXECUTABLE_BYTES must be an integer/);
});

test('Windows batch launchers fail with a clear no-shell explanation', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows path and filesystem semantics are required');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-command-batch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'npm.cmd'), '@echo off\r\necho not executed\r\n');
  assert.throws(() => resolveCommandExecutable('npm', root, {
    PATH: root,
    PATHEXT: '.COM;.EXE;.BAT;.CMD'
  }, 'win32'), /\.bat\/.cmd launchers are denied because they require shell interpretation/);
});
