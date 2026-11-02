import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SemanticScopeMatcher } from '../../src/analysis/semantic_matcher.js';
import { VirtualOverlayFilesystem } from '../../src/vfs/virtual_filesystem.js';
import { GitWorktreeManager } from '../../src/engine/worktree_manager.js';
import { AgentGdbMcpServer } from '../../src/mcp/mcp_server.js';

test('semantic matcher distinguishes these fixture examples', () => {
  const matcher = new SemanticScopeMatcher('Build Postgres cutover database migration');
  assert.equal(matcher.evaluateDrift('execute postgres migration script').isDrifting, false);
  assert.equal(matcher.evaluateDrift('write documentation blog post and twitter announcement').isDrifting, true);
});

test('virtual filesystem supports staged read and rollback', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-vfs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vfs = new VirtualOverlayFilesystem(root);
  vfs.writeFile('test_virtual.txt', 'Hello AgentGDB VFS');
  assert.equal(vfs.getPendingDiffs().length, 1);
  assert.equal(vfs.readFile('test_virtual.txt'), 'Hello AgentGDB VFS');
  assert.equal(vfs.rollback(), 1);
  assert.equal(vfs.virtualFiles.size, 0);
});

test('worktree manager lists the repository worktree without assuming a specific path', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-git-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'tests@example.invalid']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'AgentGDB tests']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  execFileSync('git', ['-C', repo, 'add', 'README.md']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'fixture']);
  const worktrees = new GitWorktreeManager(repo).listWorktrees();
  assert.equal(worktrees.length, 1);
  assert.equal(path.basename(fs.realpathSync(worktrees[0].path)).toLowerCase(), path.basename(fs.realpathSync(repo)).toLowerCase());
});

test('MCP scope check returns UNKNOWN and denied when daemon is unavailable', async () => {
  const mcp = new AgentGdbMcpServer('http://127.0.0.1:1');
  const result = await mcp.handleMcpToolCall('assert_scope_boundary', { targetPath: '.env.production' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.allowed, false);
  assert.equal(parsed.driftStatus, 'UNKNOWN');
});
