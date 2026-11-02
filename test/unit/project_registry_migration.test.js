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
      { id: 'antigravity-live', name: 'Current Antigravity Session', sessionPath: `${home}/.gemini/antigravity/brain/fixture/.system_generated/logs/transcript.jsonl` },
      { id: 'tradebot-live', name: 'TradeBot Engine', workspacePath: `${home}/tradebot` },
      { id: 'tradebot-live', name: 'Current TradeBot Session', sessionPath: `${home}/.codex/sessions/fixture.jsonl` },
      { id: 'my-project', name: 'My project', workspacePath: '/work/app', sessionPath: '/tmp/fixture.jsonl' },
      { id: 'tradebot-live', name: 'My own project using same ID', workspacePath: '/work/tradebot' }
    ]
  };
  fs.writeFileSync(configPath, JSON.stringify(original));

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {loadProjects} from ${JSON.stringify(registryUrl)}; console.log(JSON.stringify(loadProjects()));`], {
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const migrated = JSON.parse(result.stdout);
  assert.equal(migrated.activeProjectId, null);
  assert.deepEqual(migrated.projects, [original.projects[3], original.projects[4]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${configPath}.pre-default-cleanup`, 'utf8')), original);
  assert.equal(fs.statSync(`${configPath}.pre-default-cleanup`).mode & 0o777, 0o600);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(configDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  }
});

test('project registry updates replace the JSON atomically and preserve private permissions', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-projects-atomic-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, '.agentgdb');
  const configPath = path.join(configDir, 'projects.json');
  const saveScript = `import {saveProject} from ${JSON.stringify(registryUrl)}; saveProject({id:'first',name:'First',workspacePath:'/tmp/first'}); saveProject({id:'second',name:'Second',workspacePath:'/tmp/second'});`;

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', saveScript], {
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);

  const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(persisted.projects.map(({ id }) => id), ['first', 'second']);
  assert.deepEqual(fs.readdirSync(configDir).filter((name) => name.endsWith('.tmp')), []);
  if (process.platform !== 'win32') assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});

test('project registry refuses a symlinked state directory without writing through it', (t) => {
  if (process.platform === 'win32') return t.skip('symlink creation permissions vary on Windows runners');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-projects-dir-link-'));
  const outside = path.join(home, 'outside-state');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(home, '.agentgdb'), 'dir');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {loadProjects} from ${JSON.stringify(registryUrl)}; loadProjects();`], {
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing symlinked or non-directory state paths/);
  assert.deepEqual(fs.readdirSync(outside), [], 'registry must not create files in the symlink target');
});

test('project registry refuses a symlinked config file without reading or replacing its target', (t) => {
  if (process.platform === 'win32') return t.skip('symlink creation permissions vary on Windows runners');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-projects-file-link-'));
  const configDir = path.join(home, '.agentgdb');
  const outside = path.join(home, 'outside-projects.json');
  fs.mkdirSync(configDir);
  fs.writeFileSync(outside, '{"sentinel":"outside data"}');
  fs.symlinkSync(outside, path.join(configDir, 'projects.json'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {loadProjects} from ${JSON.stringify(registryUrl)}; loadProjects();`], {
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /regular, singly linked file/);
  assert.equal(fs.readFileSync(outside, 'utf8'), '{"sentinel":"outside data"}');
});

test('project registry refuses a config file hard link to an external file', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-projects-hardlink-'));
  const configDir = path.join(home, '.agentgdb');
  const outside = path.join(home, 'outside-projects.json');
  fs.mkdirSync(configDir);
  fs.writeFileSync(outside, '{"sentinel":"outside data"}');
  fs.linkSync(outside, path.join(configDir, 'projects.json'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {loadProjects} from ${JSON.stringify(registryUrl)}; loadProjects();`], {
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /regular, singly linked file/);
  assert.equal(fs.readFileSync(outside, 'utf8'), '{"sentinel":"outside data"}');
});
