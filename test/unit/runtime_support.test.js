import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

test('declared Node LTS majors match the CI and release platform matrices', () => {
  assert.equal(packageJson.engines.node, '^22 || ^24 || ^26');
  for (const workflow of ['ci.yml', 'release.yml']) {
    const source = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', workflow), 'utf8');
    assert.match(source, /os:\s*\[ubuntu-latest,\s*macos-latest,\s*windows-latest\]/, `${workflow} covers all supported operating systems`);
    assert.match(source, /node:\s*\[22,\s*24,\s*26\]/, `${workflow} covers every declared Node LTS major`);
    assert.match(source, /run:\s*npm run smoke:package/, `${workflow} exercises the packed production install`);
  }
  const ci = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /required:[\s\S]*?needs:\s*\[test\]/, 'required check waits for the full platform matrix');
  assert.match(ci, /MATRIX_RESULT:\s*\$\{\{\s*needs\.test\.result\s*\}\}/, 'required check reads the matrix aggregate result');
  assert.match(ci, /test "\$MATRIX_RESULT" = "success"/, 'required check fails unless the matrix passes');
  const release = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(release, /evidence-gate:[\s\S]*?needs:\s*platform-validation/, 'release evidence is gated on all platform jobs');
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  assert.match(readme, /Node\.js 22\.x, 24\.x, or 26\.x LTS/);
});
