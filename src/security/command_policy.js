import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const MAX_EXECUTABLE_BYTES = Number(process.env.AGENTGDB_MAX_COMMAND_EXECUTABLE_BYTES || 512 * 1024 * 1024);
if (!Number.isSafeInteger(MAX_EXECUTABLE_BYTES) || MAX_EXECUTABLE_BYTES < 1024 * 1024 || MAX_EXECUTABLE_BYTES > 2 * 1024 * 1024 * 1024) {
  throw new Error('AGENTGDB_MAX_COMMAND_EXECUTABLE_BYTES must be an integer from 1048576 to 2147483648');
}

function executableCandidates(executable, workingDirectory, env, platform) {
  const pathApi = platform === 'win32' ? path.win32 : path;
  const hasSeparator = executable.includes('/') || executable.includes('\\');
  const direct = pathApi.isAbsolute(executable) || hasSeparator;
  const roots = direct
    ? [pathApi.isAbsolute(executable) ? executable : pathApi.resolve(workingDirectory, executable)]
    : String(env.PATH || '').split(pathApi.delimiter).filter(Boolean).map((directory) => pathApi.join(directory, executable));

  if (platform !== 'win32') return roots;
  const extensions = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  return roots.flatMap((candidate) => {
    if (pathApi.extname(candidate)) return [candidate];
    return [candidate, ...extensions.map((extension) => `${candidate}${extension.toLowerCase()}`), ...extensions.map((extension) => `${candidate}${extension.toUpperCase()}`)];
  });
}

/** Resolve a command exactly as a child process would, then pin it to a real file. */
export function resolveCommandExecutable(executable, workingDirectory, env = process.env, platform = process.platform) {
  if (typeof executable !== 'string' || !executable.trim() || executable.includes('\0')) {
    throw new Error('Command executable must be a non-empty path without NUL bytes.');
  }
  const pathApi = platform === 'win32' ? path.win32 : path;
  let requiresShellLauncher = false;
  for (const candidate of executableCandidates(executable, workingDirectory, env, platform)) {
    try {
      const canonicalPath = fs.realpathSync(candidate);
      const stat = fs.statSync(canonicalPath);
      if (!stat.isFile() || stat.size > MAX_EXECUTABLE_BYTES) continue;
      if (platform !== 'win32') fs.accessSync(canonicalPath, fs.constants.X_OK);
      if (platform === 'win32' && /\.(?:bat|cmd)$/i.test(canonicalPath)) {
        requiresShellLauncher = true;
        continue;
      }
      return pathApi.normalize(canonicalPath);
    } catch {}
  }
  if (requiresShellLauncher) throw new Error('Windows .bat/.cmd launchers are denied because they require shell interpretation; configure a direct executable instead.');
  throw new Error('Command executable could not be resolved to an executable regular file.');
}

export async function describeCommandExecutable(executable, workingDirectory, env = process.env, platform = process.platform) {
  const canonicalPath = resolveCommandExecutable(executable, workingDirectory, env, platform);
  const statBefore = fs.statSync(canonicalPath);
  const digest = createHash('sha256');
  let bytesRead = 0;
  for await (const chunk of fs.createReadStream(canonicalPath)) {
    bytesRead += chunk.length;
    if (bytesRead > MAX_EXECUTABLE_BYTES) throw new Error('Command executable exceeds the configured identity-check limit.');
    digest.update(chunk);
  }
  const statAfter = fs.statSync(canonicalPath);
  if (statBefore.dev !== statAfter.dev || statBefore.ino !== statAfter.ino || statBefore.size !== statAfter.size || statBefore.mtimeMs !== statAfter.mtimeMs || bytesRead !== statAfter.size) {
    throw new Error('Command executable changed while its identity was being checked.');
  }
  return { path: canonicalPath, sha256: digest.digest('hex') };
}
