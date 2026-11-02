import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('npm package contains runtime files and excludes development and evaluation material', () => {
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = npmCli ? [npmCli, 'pack', '--dry-run', '--json'] : ['pack', '--dry-run', '--json'];
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30000,
    shell: !npmCli && process.platform === 'win32'
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);

  const [archive] = JSON.parse(result.stdout);
  const paths = new Set(archive.files.map((file) => file.path));
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  assert.equal(packageJson.license, 'MIT', 'distribution metadata declares the owner-selected license');
  assert.equal(packageLock.packages[''].license, packageJson.license, 'lockfile root metadata matches the package license');
  const licenseText = fs.readFileSync(path.join(repoRoot, 'LICENSE'), 'utf8').replaceAll('\r\n', '\n');
  assert.match(licenseText, /^MIT License\n\nCopyright \(c\) 2026 ramgolladi1503-sys\n/);
  for (const required of [
    'README.md',
    'LICENSE',
    'bin/agentgdb.js',
    'bin/agentgdb-mcp.js',
    'public/index.html',
    'public/tailwind.css',
    'public/workspace_id.js',
    'src/server.js',
    'src/managed_mcp_server.js',
    'src/security/command_policy.js'
  ]) {
    assert.ok(paths.has(required), `npm package must include ${required}`);
  }
  for (const file of archive.files) {
    assert.doesNotMatch(file.path, /^(?:\.github|docs|examples|test|test-support)\//, `${file.path} is development or evaluation material`);
    assert.doesNotMatch(file.path, /(?:^|\/)(?:\.env|\.agentgdb|node_modules)(?:\/|$)/, `${file.path} is local or dependency data`);
  }
});
