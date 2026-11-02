import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('dashboard title describes the supported session-inspection job', () => {
  const dashboard = fs.readFileSync(path.join(repoRoot, 'public/index.html'), 'utf8');
  assert.match(dashboard, /<title>AgentGDB \| Coding-Agent Session Inspector<\/title>/);
  assert.doesNotMatch(dashboard, /Live Autonomous Agent Drift Monitor/);
});

test('dashboard reflows its getting-started and inspection panes on narrow viewports', () => {
  const dashboard = fs.readFileSync(path.join(repoRoot, 'public/index.html'), 'utf8');
  assert.match(dashboard, /@media \(max-width: 900px\)/);
  assert.match(dashboard, /#dashboardHeader\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(dashboard, /#sessionWorkspace\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(dashboard, /#sessionTimeline\s*\{[^}]*width:\s*100%/s);
  assert.match(dashboard, /#sessionInspector\s*\{[^}]*min-height:\s*320px/s);
  assert.match(dashboard, /#inspectPayload\s*\{[^}]*white-space:\s*pre-wrap/s,
    'inspector content should preserve newlines while wrapping on narrow screens');
  assert.match(dashboard, /#inspectPayload\s*\{[^}]*overflow-wrap:\s*anywhere/s,
    'long paths and tokens should not expand the inspector beyond the viewport');
});

test('dashboard first run gives token guidance without showing an auth failure', () => {
  const dashboard = fs.readFileSync(path.join(repoRoot, 'public/index.html'), 'utf8');
  assert.match(dashboard, /Enter the dashboard\/operator token to load or register a workspace\. The privacy-safe demo works without a token\./);
  assert.match(dashboard, /if \(!token\) \{\s*list\.replaceChildren\(\);\s*history\.replaceChildren\(\);\s*panel\.classList\.add\('hidden'\);/);
  assert.match(dashboard, /if \(res\.status === 401\) throw new Error\('Operator token is invalid\.'\);/);
});

test('dashboard authenticates on open and revokes the existing socket when token changes', () => {
  const dashboard = fs.readFileSync(path.join(repoRoot, 'public/index.html'), 'utf8');
  assert.match(dashboard, /if \(dashboardSocket && dashboardSocket\.readyState !== WebSocket\.CLOSED\) \{\s*dashboardSocket\.close\(1000, 'Operator token changed'\);\s*\} else if \(token\) \{\s*connectDashboardSocket\(\);/);
  assert.match(dashboard, /socket\.onopen = \(\) => \{\s*authenticateDashboardSocket\(socket\);/);
});

test('dashboard exposes authenticated, confirmed trace deletion and reports incomplete WAL checkpointing', () => {
  const dashboard = fs.readFileSync(path.join(repoRoot, 'public/index.html'), 'utf8');
  assert.match(dashboard, /id="traceDeleteBefore" type="datetime-local"/);
  assert.match(dashboard, /id="traceDeleteMetadata" type="checkbox"/);
  assert.match(dashboard, /id="deleteTraces" type="button" disabled/);
  assert.match(dashboard, /before > Date\.now\(\)/, 'future cutoffs should be refused in the UI');
  assert.match(dashboard, /window\.confirm\(`Permanently delete turns and approval records created before/);
  assert.match(dashboard, /method: 'DELETE', cache: 'no-store'/);
  assert.match(dashboard, /could not fully checkpoint the WAL[\s\S]*retry the same cutoff/);
});

test('CLI help describes the supported workflow and its enforcement boundary', () => {
  const cli = path.join(repoRoot, 'bin', 'agentgdb.js');
  const result = spawnSync(process.execPath, [cli, 'help'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /local coding-agent session inspector and supervised MCP tools/);
  assert.match(result.stdout, /privacy-safe demo/);
  assert.match(result.stdout, /control agent execution/);
  assert.match(result.stdout, /not an operating-system sandbox/);
  assert.doesNotMatch(result.stdout, /Chrome DevTools|240.hour|zero.cost|split tmux panes/i);
});
