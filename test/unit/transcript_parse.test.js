import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UniversalAgentWatcher } from '../../src/universal_watcher.js';

test('transcript parser reports malformed JSONL lines without exposing the line contents', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-transcript-'));
  const file = path.join(dir, 'session.jsonl');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { cwd: 'fixture' } })}\n${'private malformed transcript data'}\n`);
  const result = await new UniversalAgentWatcher().parseSessionTranscript(file);
  assert.equal(result.totalSteps, 1);
  assert.deepEqual(result.parseErrors, [{ line: 2, message: 'Invalid JSON line' }]);
  assert.doesNotMatch(JSON.stringify(result.parseErrors), /private malformed/);
});

test('hostile transcript markup remains data and the dashboard renders event text as text', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-hostile-transcript-'));
  const file = path.join(dir, 'session.jsonl');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hostile = '</pre><img src=x onerror="alert(1)"><script>window.pwned=true</script>';
  fs.writeFileSync(file, `${JSON.stringify({ type: 'event_msg', payload: { item: { type: 'AgentMessage', text: hostile } } })}\n`);
  const result = await new UniversalAgentWatcher().parseSessionTranscript(file);
  assert.equal(result.timeline[0].content, hostile);

  const dashboard = fs.readFileSync(fileURLToPath(new URL('../../public/index.html', import.meta.url)), 'utf8');
  assert.match(dashboard, /target\.textContent = step\.targetPath \|\| step\.content/);
  assert.match(dashboard, /document\.getElementById\('activeGoalText'\)\.textContent = step\.activeGoal/);
  for (const [, assignment] of dashboard.matchAll(/innerHTML\s*=\s*([^;]+)/g)) {
    assert.match(assignment.trim(), /^['"`]/, 'innerHTML may only receive static UI strings');
  }
});
