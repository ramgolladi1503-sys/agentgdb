/**
 * Lexical scope assessment for display/advisory use only. This does not enforce
 * file or process access and must never be treated as a security boundary.
 */
export function evaluateScopePolicy(targetPath, scope, monitoringActive) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    return { allowed: false, driftStatus: 'UNKNOWN', reason: 'targetPath must be provided' };
  }
  if (monitoringActive !== true) {
    return { targetPath, allowed: false, driftStatus: 'UNKNOWN', reason: 'No active scope policy is configured' };
  }
  const allowedPaths = scope?.allowedPaths;
  const forbiddenPaths = scope?.forbiddenPaths;
  if (!Array.isArray(allowedPaths) || !Array.isArray(forbiddenPaths) || allowedPaths.length === 0) {
    return { targetPath, allowed: false, driftStatus: 'UNKNOWN', reason: 'No explicit allowlist is configured' };
  }

  const normalize = (value) => String(value)
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  const target = normalize(targetPath);
  if (!target || target.split('/').includes('..')) {
    return { targetPath, allowed: false, driftStatus: 'UNKNOWN', reason: 'Target path is not a normalized relative path' };
  }
  const matches = (rawPattern) => {
    const pattern = normalize(rawPattern);
    if (!pattern) return false;
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
    enforcement: 'ADVISORY_ONLY',
    warning: 'This assessment does not mediate filesystem or shell operations and cannot block agent execution.'
  };
}
