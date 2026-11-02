import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA_PATTERN = /^[a-f0-9]{40}$/i;
const TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const REQUIRED_AGENT_CHECKS = [
  'allowlistedRead',
  'approvedWrite',
  'approvedCommand',
  'deniedCommand',
  'timeout',
  'daemonRestart',
  'cancellation'
];

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validEvidenceUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    const validIpv4 = Boolean(ipv4 && ipv4.slice(1).every((part) => Number(part) <= 255));
    const privateIpv4 = validIpv4 && (
      Number(ipv4[1]) === 0 || Number(ipv4[1]) === 10 || Number(ipv4[1]) === 127 ||
      (Number(ipv4[1]) === 172 && Number(ipv4[2]) >= 16 && Number(ipv4[2]) <= 31) ||
      (Number(ipv4[1]) === 192 && Number(ipv4[2]) === 168) ||
      (Number(ipv4[1]) === 169 && Number(ipv4[2]) === 254) ||
      (Number(ipv4[1]) === 100 && Number(ipv4[2]) >= 64 && Number(ipv4[2]) <= 127) ||
      Number(ipv4[1]) >= 224
    );
    const ipv6 = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : '';
    const localIpv6 = ipv6 === '::' || ipv6 === '::1' || ipv6.startsWith('fc') || ipv6.startsWith('fd') || /^fe[89ab]/.test(ipv6) || ipv6.startsWith('::ffff:');
    const isIpLiteral = Boolean(ipv4 || ipv6);
    const publicHostname = !isIpLiteral && hostname.includes('.') && !hostname.endsWith('.local') && !hostname.endsWith('.internal') && hostname !== 'localhost';
    return url.protocol === 'https:' && !url.username && !url.password &&
      (publicHostname || (validIpv4 && !privateIpv4)) && !localIpv6 &&
      !/(?:^|[./_-])example(?:[./_-]|$)|placeholder|change[-_ ]?me|your[-_ ]?(?:repo|project)/i.test(value);
  } catch {
    return false;
  }
}

function checkBoundEvidence(record, label, expectedSha, errors) {
  if (!record || record.commitSha?.toLowerCase() !== expectedSha.toLowerCase()) {
    errors.push(`${label}.commitSha must equal the release commit SHA.`);
  }
  if (!validEvidenceUrl(record?.evidenceUrl)) errors.push(`${label}.evidenceUrl must be a concrete HTTPS evidence link.`);
}

function checkReleaseNotes(notes, root, errors) {
  if (!notes || typeof notes !== 'object') {
    errors.push('releaseNotes must be an object.');
    return;
  }
  const relativePath = notes.path;
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
    errors.push('releaseNotes.path must be a safe repository-relative file path.');
    return;
  }
  let realRoot;
  let realNotesPath;
  try {
    realRoot = fs.realpathSync(root);
    realNotesPath = fs.realpathSync(path.resolve(realRoot, relativePath));
  } catch {
    errors.push('releaseNotes.path must point to an existing file inside the repository.');
    return;
  }
  const relativeResolved = path.relative(realRoot, realNotesPath);
  if (!relativeResolved || relativeResolved === '..' || relativeResolved.startsWith(`..${path.sep}`) || path.isAbsolute(relativeResolved) || !fs.statSync(realNotesPath).isFile()) {
    errors.push('releaseNotes.path must point to an existing file inside the repository.');
    return;
  }
  const content = fs.readFileSync(realNotesPath, 'utf8');
  if (content.trim().length < 200) errors.push('Release notes must contain at least 200 non-whitespace characters.');
  for (const [pattern, description] of [
    [/known limitations/i, 'known limitations'],
    [/supported (hosts|platforms)/i, 'supported hosts or platforms'],
    [/bypass/i, 'known bypasses'],
    [/sandbox|isolation/i, 'sandbox or isolation limits'],
    [/capture/i, 'capture defaults'],
    [/delet/i, 'deletion limits']
  ]) {
    if (!pattern.test(content)) errors.push(`Release notes must describe ${description}.`);
  }
  if (notes.limitationsIncluded !== true) errors.push('releaseNotes.limitationsIncluded must be true.');
  if (typeof notes.reviewedBy !== 'string' || !notes.reviewedBy.trim()) errors.push('releaseNotes.reviewedBy is required.');
  if (!validDate(notes.reviewDate)) errors.push('releaseNotes.reviewDate must use YYYY-MM-DD.');
}

function checkDistributionLicense(root, errors) {
  let packageJson;
  try {
    const packagePath = path.join(root, 'package.json');
    const realRoot = fs.realpathSync(root);
    const realPackagePath = fs.realpathSync(packagePath);
    const relativePackagePath = path.relative(realRoot, realPackagePath);
    if (!relativePackagePath || relativePackagePath === '..' || relativePackagePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePackagePath) || !fs.statSync(realPackagePath).isFile()) {
      throw new Error('package.json must resolve to a regular file inside the repository');
    }
    packageJson = JSON.parse(fs.readFileSync(realPackagePath, 'utf8'));
  } catch {
    errors.push('A valid repository package.json is required for distribution licensing.');
    return;
  }
  if (typeof packageJson.license !== 'string' || !packageJson.license.trim() || packageJson.license.trim().toUpperCase() === 'UNLICENSED') {
    errors.push('package.json must declare the owner-approved distribution license before release.');
  }

  try {
    const realRoot = fs.realpathSync(root);
    const licensePath = path.join(realRoot, 'LICENSE');
    const realLicensePath = fs.realpathSync(licensePath);
    const relativeLicensePath = path.relative(realRoot, realLicensePath);
    if (!relativeLicensePath || relativeLicensePath === '..' || relativeLicensePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeLicensePath) || !fs.statSync(realLicensePath).isFile() || !fs.readFileSync(realLicensePath, 'utf8').trim()) {
      throw new Error('invalid license file');
    }
  } catch {
    errors.push('A non-empty repository LICENSE file is required before release.');
  }
}

export function validateReleaseEvidence(manifest, { tag, sha, root = process.cwd() }) {
  const errors = [];
  if (!TAG_PATTERN.test(tag || '')) errors.push('Release tag must use vMAJOR.MINOR.PATCH format.');
  if (!SHA_PATTERN.test(sha || '')) errors.push('Release commit SHA must be a 40-character hexadecimal SHA.');
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return [...errors, 'Release evidence manifest must be a JSON object.'];
  }
  if (manifest.schemaVersion !== 1) errors.push('schemaVersion must be 1.');
  if (manifest.releaseTag !== tag) errors.push('releaseTag must exactly match the pushed tag.');
  if (typeof manifest.commitSha !== 'string' || manifest.commitSha.toLowerCase() !== String(sha).toLowerCase()) {
    errors.push('commitSha must exactly match the release commit SHA.');
  }

  const agent = manifest.realAgent;
  if (!agent || agent.status !== 'PASS') errors.push('realAgent.status must be PASS.');
  if (typeof agent?.host !== 'string' || !agent.host.trim()) errors.push('realAgent.host is required.');
  if (typeof agent?.version !== 'string' || !agent.version.trim()) errors.push('realAgent.version is required.');
  if (agent?.alternateToolsDisabled !== true) errors.push('realAgent.alternateToolsDisabled must be true.');
  checkBoundEvidence(agent, 'realAgent', sha || '', errors);
  for (const check of REQUIRED_AGENT_CHECKS) {
    if (agent?.checks?.[check] !== true) errors.push(`realAgent.checks.${check} must be true.`);
  }

  const review = manifest.securityReview;
  if (!review || review.status !== 'PASS') errors.push('securityReview.status must be PASS.');
  if (typeof review?.reviewer !== 'string' || !review.reviewer.trim()) errors.push('securityReview.reviewer is required.');
  if (!validDate(review?.reviewDate)) errors.push('securityReview.reviewDate must use YYYY-MM-DD.');
  if (!Number.isInteger(review?.criticalFindings) || review.criticalFindings !== 0) errors.push('securityReview.criticalFindings must be 0.');
  if (!Number.isInteger(review?.highFindings) || review.highFindings !== 0) errors.push('securityReview.highFindings must be 0.');
  if (typeof review?.disposition !== 'string' || review.disposition.trim().length < 10) errors.push('securityReview.disposition must describe how findings were handled.');
  checkBoundEvidence(review, 'securityReview', sha || '', errors);

  const pilot = manifest.userPilot;
  if (!pilot || pilot.status !== 'COMPLETE') errors.push('userPilot.status must be COMPLETE.');
  if (!Number.isInteger(pilot?.participants) || pilot.participants < 8) errors.push('userPilot.participants must be at least 8.');
  if (typeof pilot?.method !== 'string' || pilot.method.trim().length < 30) errors.push('userPilot.method must describe the observed study.');
  if (!validDate(pilot?.date)) errors.push('userPilot.date must use YYYY-MM-DD.');
  checkBoundEvidence(pilot, 'userPilot', sha || '', errors);

  checkReleaseNotes(manifest.releaseNotes, root, errors);
  checkDistributionLicense(root, errors);
  return errors;
}

function getOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run() {
  const tag = getOption('--tag');
  const sha = getOption('--sha');
  const root = process.cwd();
  const manifestPath = path.join(root, 'docs', 'release-evidence.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`Release blocked: missing ${path.relative(root, manifestPath)}.`);
    process.exitCode = 1;
    return;
  }
  let realManifestPath;
  try {
    const realRoot = fs.realpathSync(root);
    realManifestPath = fs.realpathSync(manifestPath);
    const relativeManifestPath = path.relative(realRoot, realManifestPath);
    if (!relativeManifestPath || relativeManifestPath === '..' || relativeManifestPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeManifestPath) || !fs.statSync(realManifestPath).isFile()) {
      throw new Error('outside repository');
    }
  } catch {
    console.error('Release blocked: docs/release-evidence.json must resolve to a regular file inside the repository.');
    process.exitCode = 1;
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(realManifestPath, 'utf8'));
  } catch (error) {
    console.error(`Release blocked: invalid JSON in docs/release-evidence.json: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const errors = validateReleaseEvidence(manifest, { tag, sha, root });
  if (errors.length) {
    console.error(`Release blocked (${errors.length} unmet evidence requirements):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Release evidence validated for ${tag} at ${sha}.`);
  console.log('Evidence validation checks manifest fields and URL shape only; a release owner must independently verify linked evidence and reviewer/pilot authenticity.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) run();
