import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const registryUrl = new URL('../../src/project_registry.js', import.meta.url).href;

test('legacy seeded personal defaults are backed up and removed without dropping user projects', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-projects-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, '.agentgdb');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'projects.json');
  const original = {
    activeProjectId: 'tradebot-live',
    projects: [
      { id: 'antigravity-live', name: 'Current Antigravity Session', sessionPath: `${home}/.gemini/antigravity/brain/554eb738-91a4-4f63-9ce5-90279b2400b3/.system_generated/logs/transcript.jsonl` },
      { id: 'tradebot-live', name: 'TradeBot Engine', workspacePath: '/Users/madhuram/tradebot' },
      { id: 'my-project', name: 'My project', workspacePath: '/work/app', sessionPath: '/tmp/fixture.jsonl' },
      { id: 'tradebot-live', name: 'My own project using same ID', workspacePath: '/work/tradebot' }
    ]
  };
  fs.writeFileSync(configPath, JSON.stringify(original));

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {loadProjects} from ${JSON.stringify(registryUrl)}; console.log(JSON.stringify(loadProjects()));`], {
    cwd: root,
    env: { ...process.env, HOME: home },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const migrated = JSON.parse(result.stdout);
  assert.equal(migrated.activeProjectId, null);
  assert.deepEqual(migrated.projects, [original.projects[2], original.projects[3]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${configPath}.pre-default-cleanup`, 'utf8')), original);
  assert.equal(fs.statSync(`${configPath}.pre-default-cleanup`).mode & 0o777, 0o600);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(configDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  }
});
