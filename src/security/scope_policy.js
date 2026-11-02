import fs from 'fs';
import path from 'path';

/** Normalize a candidate as a relative POSIX path. Never resolves traversal away. */
export function normalizeActionPath(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return null;
  const raw = value.replaceAll('\\', '/');
  // Reject every drive-prefixed path, including Windows drive-relative forms
  // such as `C:temp/file`, whose base depends on the process drive directory.
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw) || raw.startsWith('//')) return null;
  const segments = raw.split('/');
  if (segments.some((part) => {
    if (part === '..' || part === '' || part === '.' || /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part)) return true;
    // Windows treats these device names as special even when an extension is
    // present. Reject them on every platform so the same policy has one meaning.
    return /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?$/i.test(part);
  })) return null;
  return segments.join('/');
}

/** Accept only exact paths, explicit directory recursion, or an explicit all-paths rule. */
export function normalizeScopePattern(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (value === '**') return '**';
  const recursive = value.endsWith('/**');
  const base = recursive ? value.slice(0, -3) : value;
  const normalized = normalizeActionPath(base);
  if (!normalized) return null;
  return recursive ? `${normalized}/**` : normalized;
}

/** Snapshot check for lexical containment and existing symlink escapes. */
export function pathStaysInWorkspace(relativePath, workspacePath) {
  if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) return false;
  try {
    const root = fs.realpathSync(workspacePath);
    const candidate = path.resolve(root, relativePath);
    const relative = path.relative(root, candidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    let probe = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      probe = path.join(probe, segment);
      try {
        const stat = fs.lstatSync(probe);
        // Deny links even when their current target is inside the workspace.
        // A target can be swapped after this snapshot check, so following links
        // would make the allowlist's meaning depend on mutable filesystem state.
        if (stat.isSymbolicLink()) return false;
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') break;
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Enforcement decision for proposed tool calls. Missing policy always denies. */
export function evaluateScopePolicy(targetPath, scope, monitoringActive = true, platform = process.platform) {
  const normalizedTarget = normalizeActionPath(targetPath);
  if (!normalizedTarget) return { allowed: false, driftStatus: 'UNKNOWN', reason: 'Target must be a normalized relative path' };
  if (monitoringActive !== true) return { targetPath, allowed: false, driftStatus: 'UNKNOWN', reason: 'No active scope policy is configured' };
  const allowedPaths = scope?.allowedPaths;
  const forbiddenPaths = scope?.forbiddenPaths;
  if (!Array.isArray(allowedPaths) || !Array.isArray(forbiddenPaths) || allowedPaths.length === 0) {
    return { targetPath, allowed: false, driftStatus: 'UNKNOWN', reason: 'No explicit allowlist is configured' };
  }

  const normalizedAllowedPaths = allowedPaths.map(normalizeScopePattern);
  const normalizedForbiddenPaths = forbiddenPaths.map(normalizeScopePattern);
  if (normalizedAllowedPaths.some((pattern) => pattern === null) || normalizedForbiddenPaths.some((pattern) => pattern === null)) {
    return { targetPath, allowed: false, driftStatus: 'UNKNOWN', reason: 'Scope policy contains an invalid path pattern.' };
  }
  const caseInsensitive = platform === 'win32';
  const target = caseInsensitive ? normalizedTarget.toLowerCase() : normalizedTarget;
  const matches = (pattern) => {
    const comparablePattern = caseInsensitive ? pattern.toLowerCase() : pattern;
    if (comparablePattern === '**') return true;
    if (comparablePattern.endsWith('/**')) {
      const directory = comparablePattern.slice(0, -3).replace(/\/$/, '');
      return target === directory || target.startsWith(`${directory}/`);
    }
    return target === comparablePattern;
  };

  const denied = normalizedForbiddenPaths.some(matches);
  const permitted = !denied && normalizedAllowedPaths.some(matches);
  return {
    targetPath,
    allowed: permitted,
    driftStatus: permitted ? 'IN_SCOPE' : 'DRIFT_DETECTED',
    reason: denied ? 'Target matches a forbidden path.' : (permitted ? 'Target matches a configured allowlist path.' : 'Target does not match any configured allowlist path.'),
    enforcement: 'PROXY_TOOL_CALL_ONLY'
  };
}

/** Parse only well-understood filesystem actions; unsupported schemas deny. */
export function inspectToolCall(call, scope) {
  const name = call?.function?.name;
  let args;
  try { args = JSON.parse(call?.function?.arguments || '{}'); } catch { args = null; }
  if (!name || !args || typeof args !== 'object' || Array.isArray(args)) {
    return { allowed: false, risk: 'UNKNOWN', reason: 'Malformed or unsupported tool call', action: { name: name || null } };
  }
  const lowerName = name.toLowerCase();
  const pathValue = args.path ?? args.file_path ?? args.filePath ?? args.target ?? args.filename;
  if (/file|write|edit|patch|delete|move|rename/.test(lowerName) && pathValue !== undefined) {
    const selectedPathKey = ['path', 'file_path', 'filePath', 'target', 'filename'].find((key) => args[key] !== undefined);
    const secondaryTargets = Object.keys(args).filter((key) => key !== selectedPathKey && /(path|file|target|dest|source)/i.test(key));
    if (secondaryTargets.length) return { allowed: false, driftStatus: 'UNKNOWN', risk: 'UNKNOWN', reason: 'Multi-target file action schema is unsupported', action: { name, arguments: args } };
    const decision = evaluateScopePolicy(pathValue, scope, true);
    const readOnly = /^(read|get|list|search|stat|inspect)[_-]/.test(lowerName);
    return { ...decision, risk: readOnly ? 'READ' : 'MUTATING', action: { name, arguments: args, targetPath: normalizeActionPath(pathValue) } };
  }
  if (/shell|terminal|command|exec/.test(lowerName)) {
    const command = args.command ?? args.cmd;
    const exact = typeof command === 'string' && Array.isArray(scope?.allowedCommands) && scope.allowedCommands.includes(command);
    return { allowed: exact, driftStatus: exact ? 'IN_SCOPE' : 'UNKNOWN', risk: 'MUTATING', reason: exact ? 'Exact command matches allowlist' : 'Shell tool is unsupported unless the complete command exactly matches the allowlist', action: { name, arguments: args, command: typeof command === 'string' ? command : null } };
  }
  return { allowed: false, driftStatus: 'UNKNOWN', risk: 'UNKNOWN', reason: 'Tool schema is not supported by the enforcement policy', action: { name, arguments: args } };
}
