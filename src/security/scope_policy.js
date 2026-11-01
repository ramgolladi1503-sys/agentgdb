import fs from 'fs';
import path from 'path';

/** Normalize a candidate as a relative POSIX path. Never resolves traversal away. */
export function normalizeActionPath(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return null;
  const raw = value.replaceAll('\\', '/');
  if (raw.startsWith('/') || /^[a-zA-Z]:\//.test(raw) || raw.startsWith('//')) return null;
  const segments = raw.split('/');
  if (segments.some((part) => part === '..' || part === '' || part === '.')) return null;
  return segments.join('/');
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
        if (stat.isSymbolicLink()) {
          const realTarget = fs.realpathSync(probe);
          const targetRelative = path.relative(root, realTarget);
          if (targetRelative === '..' || targetRelative.startsWith(`..${path.sep}`) || path.isAbsolute(targetRelative)) return false;
        }
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
export function evaluateScopePolicy(targetPath, scope, monitoringActive = true) {
  const normalizedTarget = normalizeActionPath(targetPath);
  if (!normalizedTarget) return { allowed: false, driftStatus: 'UNKNOWN', reason: 'Target must be a normalized relative path' };
  if (monitoringActive !== true) return { targetPath, allowed: false, driftStatus: 'UNKNOWN', reason: 'No active scope policy is configured' };
  const allowedPaths = scope?.allowedPaths;
  const forbiddenPaths = scope?.forbiddenPaths;
  if (!Array.isArray(allowedPaths) || !Array.isArray(forbiddenPaths) || allowedPaths.length === 0) {
    return { targetPath, allowed: false, driftStatus: 'UNKNOWN', reason: 'No explicit allowlist is configured' };
  }

  const normalizePattern = (value) => {
    if (typeof value !== 'string') return null;
    const wildcard = value.endsWith('/**') ? '/**' : value.endsWith('*') ? '*' : '';
    const base = wildcard ? value.slice(0, -wildcard.length).replace(/\/$/, '') : value;
    const normalized = base === '' && wildcard ? '**' : normalizeActionPath(base);
    return normalized !== null ? `${normalized}${wildcard}` : null;
  };
  const target = normalizedTarget;
  const matches = (rawPattern) => {
    const pattern = normalizePattern(rawPattern);
    if (!pattern) return false;
    if (pattern === '**') return true;
    if (pattern.endsWith('/**')) {
      const directory = pattern.slice(0, -3).replace(/\/$/, '');
      return target === directory || target.startsWith(`${directory}/`);
    }
    if (pattern.endsWith('*')) return target.startsWith(pattern.slice(0, -1));
    return target === pattern || target.startsWith(`${pattern}/`);
  };

  const denied = forbiddenPaths.some(matches);
  const permitted = !denied && allowedPaths.some(matches);
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
