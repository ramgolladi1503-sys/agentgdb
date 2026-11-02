import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractReleaseTagEvidence } from '../../scripts/extract-release-tag-evidence.js';
import { validateReleaseEvidence } from '../../scripts/validate-release-evidence.js';

const TAG = 'v1.2.3';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function createTaggedFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-tag-evidence-'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, '.gitignore'), 'docs/release-evidence.json\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', license: 'MIT' }));
  fs.writeFileSync(path.join(root, 'LICENSE'), 'Fixture license text.');
  fs.writeFileSync(path.join(root, 'docs', 'release-notes.md'), [
    '# Release notes',
    'Supported platforms and hosts are Node 22 on macOS, Linux, and Windows.',
    'Known limitations include client bypasses and the absence of an OS sandbox.',
    'Payload capture is opt-in; deletion does not cover backups.'
  ].join('\n'));

  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Release Test']);
  git(root, ['config', 'user.email', 'release-test@example.invalid']);
  git(root, ['add', '.gitignore', 'package.json', 'LICENSE', 'docs/release-notes.md']);
  git(root, ['commit', '-qm', 'release candidate']);
  const sha = git(root, ['rev-parse', 'HEAD']);

  const checks = Object.fromEntries([
    'allowlistedRead', 'approvedWrite', 'approvedCommand', 'deniedCommand',
    'timeout', 'daemonRestart', 'cancellation'
  ].map((name) => [name, true]));
  const manifest = {
    schemaVersion: 1,
    releaseTag: TAG,
    commitSha: sha,
    realAgent: {
      status: 'PASS', host: 'Fixture Host', version: '1.0', commitSha: sha,
      evidenceUrl: 'https://github.com/ramgolladi1503-sys/agentgdb/actions/runs/123',
      alternateToolsDisabled: true, checks
    },
    securityReview: {
      status: 'PASS', reviewer: 'Independent Reviewer', reviewDate: '2026-11-02',
      commitSha: sha, evidenceUrl: 'https://github.com/ramgolladi1503-sys/agentgdb/pull/123#pullrequestreview-456',
      criticalFindings: 0, highFindings: 0, disposition: 'No critical or high findings remain open.'
    },
    userPilot: {
      status: 'COMPLETE', participants: 8,
      method: 'Observed eight active coding-agent users completing setup and recovery tasks.',
      date: '2026-11-02', commitSha: sha,
      evidenceUrl: 'https://github.com/ramgolladi1503-sys/agentgdb/issues/123'
    },
    releaseNotes: {
      path: 'docs/release-notes.md', reviewedBy: 'Release Owner',
      reviewDate: '2026-11-02', limitationsIncluded: true
    }
  };

  const messagePath = path.join(os.tmpdir(), `agentgdb-release-tag-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(messagePath, JSON.stringify(manifest, null, 2));
  git(root, ['tag', '-a', '-F', messagePath, TAG, sha]);
  fs.rmSync(messagePath, { force: true });
  return { root, sha, manifest };
}

test('annotated tag evidence binds to the target commit without self-reference', (t) => {
  const fixture = createTaggedFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const outputPath = extractReleaseTagEvidence({ tag: TAG, sha: fixture.sha, root: fixture.root });
  const extracted = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.deepEqual(extracted, fixture.manifest);
  assert.deepEqual(validateReleaseEvidence(extracted, { tag: TAG, sha: fixture.sha, root: fixture.root }), []);
  assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), fixture.sha, 'materializing the manifest does not change the tagged commit');
});

test('tag extraction and release validation CLIs pass end to end for an exact annotated tag', (t) => {
  const fixture = createTaggedFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const extractor = fileURLToPath(new URL('../../scripts/extract-release-tag-evidence.js', import.meta.url));
  const validator = fileURLToPath(new URL('../../scripts/validate-release-evidence.js', import.meta.url));
  const extracted = spawnSync(process.execPath, [extractor, '--tag', TAG, '--sha', fixture.sha], { cwd: fixture.root, encoding: 'utf8' });
  assert.equal(extracted.status, 0, extracted.stderr);
  const validated = spawnSync(process.execPath, [validator, '--tag', TAG, '--sha', fixture.sha], { cwd: fixture.root, encoding: 'utf8' });
  assert.equal(validated.status, 0, validated.stderr);
  assert.match(validated.stdout, new RegExp(`validated for ${TAG} at ${fixture.sha}`));
  assert.doesNotThrow(() => git(fixture.root, ['check-ignore', '-q', 'docs/release-evidence.json']),
    'generated evidence manifest is ignored');
  assert.equal(git(fixture.root, ['status', '--porcelain']), '', 'generated ignored evidence leaves the tagged checkout clean');
  assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), fixture.sha);
});

test('tag evidence extraction refuses a target SHA mismatch without writing a manifest', (t) => {
  const fixture = createTaggedFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  assert.throws(() => extractReleaseTagEvidence({ tag: TAG, sha: 'b'.repeat(40), root: fixture.root }), /does not point to the requested release commit/);
  assert.equal(fs.existsSync(path.join(fixture.root, 'docs', 'release-evidence.json')), false);
});

test('release evidence extraction rejects lightweight tags', (t) => {
  const fixture = createTaggedFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  git(fixture.root, ['tag', '-d', TAG]);
  git(fixture.root, ['tag', TAG, fixture.sha]);
  assert.throws(() => extractReleaseTagEvidence({ tag: TAG, sha: fixture.sha, root: fixture.root }), /annotated tag, not a lightweight tag/);
});

test('release evidence extraction rejects tag-message text outside the JSON object', (t) => {
  const fixture = createTaggedFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  git(fixture.root, ['tag', '-d', TAG]);
  const messagePath = path.join(os.tmpdir(), `agentgdb-release-extra-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(messagePath, `${JSON.stringify(fixture.manifest)}\nextra message text`);
  git(fixture.root, ['tag', '-a', '-F', messagePath, TAG, fixture.sha]);
  fs.rmSync(messagePath, { force: true });
  assert.throws(() => extractReleaseTagEvidence({ tag: TAG, sha: fixture.sha, root: fixture.root }), /message must contain only the JSON evidence object/);
});

test('release workflow extracts annotated-tag evidence before running the manifest validator', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
  const evidenceJob = workflow.split('\n  evidence-gate:')[1];
  assert.ok(evidenceJob, 'release evidence job is present');
  assert.match(evidenceJob, /ref: \$\{\{ github\.ref \}\}[\s\S]*fetch-depth: 0/);
  const extractIndex = evidenceJob.indexOf('scripts/extract-release-tag-evidence.js');
  const validateIndex = evidenceJob.indexOf('scripts/validate-release-evidence.js');
  assert.ok(extractIndex >= 0 && validateIndex > extractIndex, 'tag evidence is extracted before validation');
});
