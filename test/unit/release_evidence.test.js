import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateReleaseEvidence } from '../../scripts/validate-release-evidence.js';

const SHA = 'a'.repeat(40);
const TAG = 'v1.2.3';
const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

function validManifest(root) {
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', license: 'MIT' }));
  fs.writeFileSync(path.join(root, 'LICENSE'), 'Fixture license text for validator tests.');
  fs.writeFileSync(path.join(root, 'docs', 'release-notes.md'), [
    '# Release notes',
    'Supported platforms and hosts are Node 22 on macOS, Linux, and Windows.',
    'Known limitations include client bypasses and the absence of an OS sandbox.',
    'Payload capture is opt-in; deletion does not cover backups.'
  ].join('\n'));
  const checks = Object.fromEntries([
    'allowlistedRead', 'approvedWrite', 'approvedCommand', 'deniedCommand',
    'timeout', 'daemonRestart', 'cancellation'
  ].map((name) => [name, true]));
  return {
    schemaVersion: 1,
    releaseTag: TAG,
    commitSha: SHA,
    realAgent: {
      status: 'PASS', host: 'Fixture Host', version: '1.0', commitSha: SHA,
      evidenceUrl: 'https://github.com/ramgolladi1503-sys/agentgdb/actions/runs/123',
      alternateToolsDisabled: true, checks
    },
    securityReview: {
      status: 'PASS', reviewer: 'Independent Reviewer', reviewDate: '2026-11-02',
      commitSha: SHA, evidenceUrl: 'https://github.com/ramgolladi1503-sys/agentgdb/pull/123#pullrequestreview-456',
      criticalFindings: 0, highFindings: 0, disposition: 'No critical or high findings remain open.'
    },
    userPilot: {
      status: 'COMPLETE', participants: 8,
      method: 'Observed eight active coding-agent users completing setup and recovery tasks.',
      date: '2026-11-02', commitSha: SHA,
      evidenceUrl: 'https://github.com/ramgolladi1503-sys/agentgdb/issues/123'
    },
    releaseNotes: {
      path: 'docs/release-notes.md', reviewedBy: 'Release Owner',
      reviewDate: '2026-11-02', limitationsIncluded: true
    }
  };
}

function withTempRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgdb-release-evidence-'));
  try { fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('release evidence accepts a complete manifest tied to the release tag and commit', () => {
  withTempRoot((root) => {
    assert.deepEqual(validateReleaseEvidence(validManifest(root), { tag: TAG, sha: SHA, root }), []);
  });
});

test('release evidence fails closed for placeholders and incomplete evidence', () => {
  withTempRoot((root) => {
    const errors = validateReleaseEvidence({}, { tag: TAG, sha: SHA, root });
    assert.ok(errors.some((error) => error.includes('realAgent.status')));
    assert.ok(errors.some((error) => error.includes('securityReview.status')));
    assert.ok(errors.some((error) => error.includes('userPilot.status')));
  });
});

test('release evidence requires an owner-selected package license and repository license file', () => {
  withTempRoot((root) => {
    const manifest = validManifest(root);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', license: 'UNLICENSED' }));
    fs.rmSync(path.join(root, 'LICENSE'));
    const errors = validateReleaseEvidence(manifest, { tag: TAG, sha: SHA, root });
    assert.ok(errors.some((error) => error.includes('owner-approved distribution license')));
    assert.ok(errors.some((error) => error.includes('repository LICENSE file')));
  });
});

test('current repository license satisfies the distribution-license gate', () => {
  const errors = validateReleaseEvidence({}, { tag: TAG, sha: SHA, root: repoRoot });
  assert.equal(errors.some((error) => /distribution license|repository LICENSE file/i.test(error)), false);
});

test('draft release notes disclose platform, bypass, sandbox, capture, and deletion limits', () => {
  const notes = fs.readFileSync(path.join(repoRoot, 'docs', 'RELEASE_NOTES_DRAFT.md'), 'utf8');
  for (const pattern of [/supported hosts and platforms/i, /bypass/i, /sandbox/i, /capture/i, /delet/i]) {
    assert.match(notes, pattern);
  }
  assert.match(notes, /Do not publish or describe this candidate as production ready/);
  assert.match(notes, /not reviewed or approved for release/i);
});

test('release evidence rejects a LICENSE symlink that escapes the repository', (t) => {
  if (process.platform === 'win32') return t.skip('symlink creation permissions vary on Windows runners');
  withTempRoot((root) => {
    const manifest = validManifest(root);
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside-license`);
    fs.writeFileSync(outside, 'This external file must not satisfy the repository license gate.');
    t.after(() => fs.rmSync(outside, { force: true }));
    fs.rmSync(path.join(root, 'LICENSE'));
    fs.symlinkSync(outside, path.join(root, 'LICENSE'));
    const errors = validateReleaseEvidence(manifest, { tag: TAG, sha: SHA, root });
    assert.ok(errors.some((error) => error.includes('repository LICENSE file')));
  });
});

test('release evidence rejects example and placeholder repository URLs', () => {
  withTempRoot((root) => {
    const manifest = validManifest(root);
    manifest.realAgent.evidenceUrl = 'https://github.com/example-project/agentgdb/actions/runs/123';
    const errors = validateReleaseEvidence(manifest, { tag: TAG, sha: SHA, root });
    assert.ok(errors.some((error) => error.includes('realAgent.evidenceUrl')));
  });
});

test('release evidence rejects links with embedded credentials', () => {
  withTempRoot((root) => {
    const manifest = validManifest(root);
    manifest.userPilot.evidenceUrl = 'https://attacker@github.com/ramgolladi1503-sys/agentgdb/issues/123';
    const errors = validateReleaseEvidence(manifest, { tag: TAG, sha: SHA, root });
    assert.ok(errors.some((error) => error.includes('userPilot.evidenceUrl')));
  });
});

test('release evidence rejects localhost, private, link-local, and noncanonical IP destinations', () => {
  withTempRoot((root) => {
    for (const evidenceUrl of [
      'https://localhost/review/1',
      'https://127.0.0.1/review/1',
      'https://10.0.0.8/review/1',
      'https://172.20.0.5/review/1',
      'https://192.168.1.10/review/1',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/review/1',
      'https://[fd00::1]/review/1',
      'https://999.1.1.1/review/1',
      'https://review.local/review/1'
    ]) {
      const manifest = validManifest(root);
      manifest.realAgent.evidenceUrl = evidenceUrl;
      assert.ok(validateReleaseEvidence(manifest, { tag: TAG, sha: SHA, root }).some((error) => error.includes('realAgent.evidenceUrl')), evidenceUrl);
    }
  });
});

test('release gate CLI fails closed when the evidence manifest is missing', () => {
  withTempRoot((root) => {
    const validator = path.resolve('scripts/validate-release-evidence.js');
    const result = spawnSync(process.execPath, [validator, '--tag', TAG, '--sha', SHA], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr.replaceAll('\\', '/'), /missing docs\/release-evidence\.json/);
  });
});

test('release gate CLI rejects an evidence manifest symlink outside the repository', (t) => {
  if (process.platform === 'win32') return t.skip('symlink creation permissions vary on Windows runners');
  withTempRoot((root) => {
    const manifest = validManifest(root);
    const outside = path.join(path.dirname(root), `${path.basename(root)}-manifest.json`);
    fs.writeFileSync(outside, JSON.stringify(manifest));
    t.after(() => fs.rmSync(outside, { force: true }));
    const linkPath = path.join(root, 'docs', 'release-evidence.json');
    fs.symlinkSync(outside, linkPath);
    const validator = path.resolve('scripts/validate-release-evidence.js');
    const result = spawnSync(process.execPath, [validator, '--tag', TAG, '--sha', SHA], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must resolve to a regular file inside the repository/);
  });
});

test('release evidence requires exact release commit binding for every external review', () => {
  withTempRoot((root) => {
    const manifest = validManifest(root);
    manifest.realAgent.commitSha = 'b'.repeat(40);
    assert.ok(validateReleaseEvidence(manifest, { tag: TAG, sha: SHA, root }).some((error) => error.includes('realAgent.commitSha')));
  });
});

test('release evidence blocks any missing real-agent gate check', () => {
  withTempRoot((root) => {
    const manifest = validManifest(root);
    manifest.realAgent.checks.daemonRestart = false;
    assert.ok(validateReleaseEvidence(manifest, { tag: TAG, sha: SHA, root }).some((error) => error.includes('daemonRestart')));
  });
});

test('release evidence blocks critical or high security findings', () => {
  withTempRoot((root) => {
    const manifest = validManifest(root);
    manifest.securityReview.highFindings = 1;
    assert.ok(validateReleaseEvidence(manifest, { tag: TAG, sha: SHA, root }).some((error) => error.includes('highFindings')));
  });
});

test('release evidence rejects release notes outside the repository or without limits', () => {
  withTempRoot((root) => {
    const manifest = validManifest(root);
    manifest.releaseNotes.path = '../release-notes.md';
    assert.ok(validateReleaseEvidence(manifest, { tag: TAG, sha: SHA, root }).some((error) => error.includes('repository-relative')));
  });
});

test('release evidence rejects release-note symlinks that escape the repository', (t) => {
  if (process.platform === 'win32') return t.skip('symlink creation permissions vary on Windows runners');
  withTempRoot((root) => {
    const manifest = validManifest(root);
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.md`);
    fs.writeFileSync(outside, 'External release notes must not satisfy the in-repository note requirement.');
    t.after(() => fs.rmSync(outside, { force: true }));
    const notePath = path.join(root, 'docs', 'release-notes-link.md');
    fs.symlinkSync(outside, notePath);
    manifest.releaseNotes.path = 'docs/release-notes-link.md';
    assert.ok(validateReleaseEvidence(manifest, { tag: TAG, sha: SHA, root }).some((error) => error.includes('inside the repository')));
  });
});

test('release evidence binds its version tag and requires a real user pilot', () => {
  withTempRoot((root) => {
    const manifest = validManifest(root);
    manifest.releaseTag = 'v9.9.9';
    manifest.userPilot.participants = 2;
    const errors = validateReleaseEvidence(manifest, { tag: TAG, sha: SHA, root });
    assert.ok(errors.some((error) => error.includes('releaseTag')));
    assert.ok(errors.some((error) => error.includes('at least 8')));
  });
});

test('release ancestry check uses Bash explicitly on every platform', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
  const ancestryStep = workflow.split('- name: Require release commit on the default branch')[1]?.split('\n      - uses: actions/setup-node')[0];
  assert.ok(ancestryStep, 'release ancestry validation step is present');
  assert.match(ancestryStep, /\n\s+shell: bash\s*\n/);
  assert.match(ancestryStep, /git merge-base --is-ancestor "\$RELEASE_SHA"/);
});
