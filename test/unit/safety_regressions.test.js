import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VirtualOverlayFilesystem } from '../../src/vfs/virtual_filesystem.js';
import { AgentGdbMcpServer } from '../../src/mcp/mcp_server.js';
import { run1000DevEvaluation } from '../../src/analysis/evaluation_benchmark.js';
import { evaluateScopePolicy } from '../../src/security/scope_policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('VFS rejects traversal and symlink escapes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-vfs-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-out-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.symlinkSync(outside, path.join(root, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  const vfs = new VirtualOverlayFilesystem(root);
  assert.throws(() => vfs.writeFile('../escape.txt', 'bad'), /traversal is not allowed/);
  assert.throws(() => vfs.writeFile('external/escape.txt', 'bad'), /symlink outside/);
  assert.throws(() => vfs.writeFile('external/../escape.txt', 'bad'), /traversal is not allowed/);
  assert.throws(() => vfs.writeFile('/tmp/escape.txt', 'bad'), /must be relative/);
  assert.equal(fs.existsSync(path.join(outside, 'escape.txt')), false);
});

test('VFS stages and commits in-root writes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-vfs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vfs = new VirtualOverlayFilesystem(root);
  vfs.writeFile('nested/file.txt', 'safe');
  assert.deepEqual(vfs.commitToRealDisk(), ['nested/file.txt']);
  assert.equal(fs.readFileSync(path.join(root, 'nested/file.txt'), 'utf8'), 'safe');
});

test('default project registry is empty and contains no developer paths', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // Run in a child process so module-level HOME-derived paths are isolated.
  const { spawnSync } = process.getBuiltinModule('node:child_process');
  const projectRegistryUrl = new URL('../../src/project_registry.js', import.meta.url).href;
  const script = `import { loadProjects } from ${JSON.stringify(projectRegistryUrl)}; console.log(JSON.stringify(loadProjects()));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.deepEqual(config, { activeProjectId: null, projects: [] });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(home, '.agentgdb')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(home, '.agentgdb', 'projects.json')).mode & 0o777, 0o600);
  }
});

test('database initialization refuses symlinked state directories and database files', (t) => {
  if (process.platform === 'win32') return t.skip('Unix symlink and mode semantics are tested on POSIX; Windows ACL validation is a separate release gate.');
  const dbModule = new URL('../../src/db.js', import.meta.url).href;
  const importDatabase = (home) => {
    const script = `await import(${JSON.stringify(dbModule)});`;
    return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8'
    });
  };

  const dirHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-symlink-dir-'));
  const outsideDir = path.join(dirHome, 'outside');
  fs.mkdirSync(outsideDir);
  fs.symlinkSync(outsideDir, path.join(dirHome, '.agentgdb'), 'dir');
  t.after(() => fs.rmSync(dirHome, { recursive: true, force: true }));
  const dirResult = importDatabase(dirHome);
  assert.notEqual(dirResult.status, 0);
  assert.match(dirResult.stderr, /database directory must be a real directory/);
  assert.equal(fs.existsSync(path.join(outsideDir, 'traces.db')), false);

  const fileHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-symlink-db-'));
  const dbDir = path.join(fileHome, '.agentgdb');
  const outsideFile = path.join(fileHome, 'outside.db');
  fs.mkdirSync(dbDir);
  fs.writeFileSync(outsideFile, 'must remain untouched');
  fs.symlinkSync(outsideFile, path.join(dbDir, 'traces.db'), 'file');
  t.after(() => fs.rmSync(fileHome, { recursive: true, force: true }));
  const fileResult = importDatabase(fileHome);
  assert.notEqual(fileResult.status, 0);
  assert.match(fileResult.stderr, /database file must be a regular file/);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'must remain untouched');
});

test('MCP approval is not falsely reported as pending', async () => {
  const mcp = new AgentGdbMcpServer();
  await assert.rejects(() => mcp.handleMcpToolCall('request_human_approval', { actionSummary: 'delete data' }), /not implemented/);
});

test('synthetic 1,000-developer report generation is disabled', () => {
  assert.throws(() => run1000DevEvaluation(), /Synthetic respondent generation is intentionally disabled/);
});

test('scope policy requires a positive allowlist and respects path boundaries', () => {
  assert.equal(evaluateScopePolicy('src-old/file.js', { allowedPaths: ['src/**'], forbiddenPaths: [] }, true).allowed, false);
  assert.equal(evaluateScopePolicy('src/file.js', { allowedPaths: ['src/**'], forbiddenPaths: [] }, true).allowed, true);
  assert.equal(evaluateScopePolicy('src/secrets/key.txt', { allowedPaths: ['src/**'], forbiddenPaths: ['src/secrets/**'] }, true).allowed, false);
  assert.equal(evaluateScopePolicy('src/file.js', { allowedPaths: [], forbiddenPaths: ['.env'] }, true).driftStatus, 'UNKNOWN');
  assert.equal(evaluateScopePolicy('../outside', { allowedPaths: ['src/**'], forbiddenPaths: [] }, true).driftStatus, 'UNKNOWN');
});

test('server safety defaults are loopback, token-gated remotely, and payload capture is opt-in', () => {
  const server = fs.readFileSync(path.join(__dirname, '../../src/server.js'), 'utf8');
  assert.match(server, /process\.env\.HOST \|\| '127\.0\.0\.1'/);
  assert.match(server, /AGENTGDB_AUTH_TOKEN is required when HOST is not loopback/);
  assert.match(server, /TRACE_CAPTURE \? JSON\.stringify\(redactSensitive\(req\.body\)\) : null/);
  assert.match(server, /TRACE_CAPTURE \? JSON\.stringify\(redactSensitive\(responseJson\)\) : null/);
  assert.match(server, /timingSafeEqual\(supplied, expected\)/);
  assert.match(server, /tool_calls: null/);
  assert.match(server, /sessionPath must be an explicit absolute path/);
  const scopePolicy = fs.readFileSync(path.join(__dirname, '../../src/security/scope_policy.js'), 'utf8');
  assert.match(scopePolicy, /No active scope policy is configured/);
  assert.match(scopePolicy, /No explicit allowlist is configured/);
  assert.match(scopePolicy, /enforcement: 'PROXY_TOOL_CALL_ONLY'/);
  const liveWatcher = fs.readFileSync(path.join(__dirname, '../../src/live_session_stream.js'), 'utf8');
  assert.match(liveWatcher, /this\.driftStatus = driftEvaluation\.isDrift \? 'DRIFT_DETECTED' : 'IN_SCOPE'/);
});

test('dashboard surfaces WebSocket failures and retries with capped backoff', () => {
  const dashboard = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
  assert.match(dashboard, /id="connectionStatus"/);
  assert.match(dashboard, /socket\.onerror/);
  assert.match(dashboard, /socket\.onclose/);
  assert.match(dashboard, /maxDashboardReconnectDelay = 30000/);
  assert.match(dashboard, /Dashboard disconnected; retrying in/);
  assert.match(dashboard, /connectDashboardSocket\(\);/);
});

test('trace retention reports and purges expired sessions, turns, and approvals when configured', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-retention-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { spawnSync } = process.getBuiltinModule('node:child_process');
  const dbUrl = new URL('../../src/db.js', import.meta.url).href;
  const script = `
    import db, { createSession, createApproval, recordTurn, applyTraceRetention, getAllSessions, getTurnsForSession } from ${JSON.stringify(dbUrl)};
    const now = Date.now();
    createSession('old', 'old', 'test');
    createSession('new', 'new', 'test');
    createSession('long-running', 'long-running', 'test');
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(now - 8 * 86400000, 'old');
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(now - 30 * 86400000, 'long-running');
    const makeTurn = (id, session_id, created_at) => recordTurn({ id, session_id, turn_index: 1, parent_turn_id: null, branch_name: 'main', request_payload: 'secret', response_payload: 'secret', tool_calls: null, tool_results: null, is_cached: 0, breakpoint_hit: 0, tokens: 0, latency_ms: 0, created_at });
    makeTurn('old-turn', 'old', now - 8 * 86400000);
    makeTurn('new-turn', 'new', now);
    makeTurn('recent-turn-long-session', 'long-running', now);
    createApproval({ id: 'old-approval', sessionId: 'old', action: { name: 'write_file' }, risk: 'MUTATING', expiresAt: now - 8 * 86400000 });
    db.prepare('UPDATE approvals SET created_at = ? WHERE id = ?').run(now - 8 * 86400000, 'old-approval');
    console.log(JSON.stringify({ purged: applyTraceRetention(now), sessions: getAllSessions().map(s => s.id).sort(), oldTurns: getTurnsForSession('old').length, newTurns: getTurnsForSession('new').length, longRunningTurns: getTurnsForSession('long-running').length }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: home, USERPROFILE: home, AGENTGDB_TRACE_RETENTION_DAYS: '7' }, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { purged: { turns: 1, approvals: 1, sessions: 1 }, sessions: ['long-running', 'new'], oldTurns: 0, newTurns: 1, longRunningTurns: 1 });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(home, '.agentgdb')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(home, '.agentgdb', 'traces.db')).mode & 0o777, 0o600);
  }
});

