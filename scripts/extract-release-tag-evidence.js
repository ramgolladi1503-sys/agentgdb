import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/i;
const MAX_TAG_MESSAGE_BYTES = 64 * 1024;

function git(args, root) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}

function parseTagMessage(rawTagObject) {
  if (Buffer.byteLength(rawTagObject, 'utf8') > MAX_TAG_MESSAGE_BYTES) {
    throw new Error('Annotated release tag object exceeds the 64 KiB evidence limit.');
  }
  const separator = rawTagObject.indexOf('\n\n');
  if (separator < 0) throw new Error('Annotated release tag has no message body.');
  const body = rawTagObject.slice(separator + 2).trimStart();
  if (!body.startsWith('{')) throw new Error('Annotated release tag message must start with the JSON evidence object.');

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) { end = index + 1; break; }
      if (depth < 0) break;
    }
  }
  if (end < 0 || inString) throw new Error('Annotated release tag contains incomplete JSON evidence.');
  const trailing = body.slice(end).trim();
  if (trailing) throw new Error('Annotated release tag message must contain only the JSON evidence object; signed tags are not supported by this gate.');
  let manifest;
  try { manifest = JSON.parse(body.slice(0, end)); }
  catch (error) { throw new Error(`Annotated release tag contains invalid JSON evidence: ${error.message}`); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Release evidence in the tag must be a JSON object.');
  }
  return manifest;
}

export function extractReleaseTagEvidence({ tag, sha, root = process.cwd() }) {
  if (!TAG_PATTERN.test(tag || '')) throw new Error('Release tag must use vMAJOR.MINOR.PATCH format.');
  if (!SHA_PATTERN.test(sha || '')) throw new Error('Release commit SHA must be a 40-character hexadecimal SHA.');

  const tagRef = `refs/tags/${tag}`;
  let tagType;
  try { tagType = git(['cat-file', '-t', tagRef], root); }
  catch { throw new Error(`Release tag ${tag} is missing from this checkout.`); }
  if (tagType !== 'tag') throw new Error('Release evidence must be attached to an annotated tag, not a lightweight tag.');

  const targetSha = git(['rev-parse', '--verify', `${tagRef}^{commit}`], root);
  if (targetSha.toLowerCase() !== sha.toLowerCase()) {
    throw new Error('Annotated release tag does not point to the requested release commit SHA.');
  }
  const manifest = parseTagMessage(git(['cat-file', 'tag', tagRef], root));
  if (manifest.releaseTag !== tag) throw new Error('Tag evidence releaseTag must match the annotated tag name.');
  if (typeof manifest.commitSha !== 'string' || manifest.commitSha.toLowerCase() !== sha.toLowerCase()) {
    throw new Error('Tag evidence commitSha must match the annotated tag target commit SHA.');
  }

  const realRoot = fs.realpathSync(root);
  const docsPath = path.join(realRoot, 'docs');
  const docsStat = fs.lstatSync(docsPath);
  if (!docsStat.isDirectory() || docsStat.isSymbolicLink()) throw new Error('Repository docs directory must be a real directory.');
  const outputPath = path.join(docsPath, 'release-evidence.json');
  try {
    fs.lstatSync(outputPath);
    throw new Error('Refusing to overwrite existing docs/release-evidence.json.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return outputPath;
}

function getOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run() {
  try {
    const outputPath = extractReleaseTagEvidence({ tag: getOption('--tag'), sha: getOption('--sha'), root: process.cwd() });
    console.log(`Extracted release evidence from the annotated tag into ${path.relative(process.cwd(), outputPath)}.`);
  } catch (error) {
    console.error(`Release evidence extraction failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) run();
