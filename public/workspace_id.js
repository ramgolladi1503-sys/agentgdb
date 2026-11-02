/** Convert a human-readable workspace name to a stable, URL-safe suggested ID. */
export function workspaceIdFromName(name, existingIds = []) {
  if (typeof name !== 'string') return '';
  const base = name.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  if (!base) return '';
  const usedIds = new Set(Array.isArray(existingIds)
    ? existingIds.filter((id) => typeof id === 'string').map((id) => id.toLowerCase())
    : []);
  if (!usedIds.has(base)) return base;
  for (let suffixNumber = 2; suffixNumber < Number.MAX_SAFE_INTEGER; suffixNumber += 1) {
    const suffix = `-${suffixNumber}`;
    const candidate = `${base.slice(0, 63 - suffix.length).replace(/-+$/g, '')}${suffix}`;
    if (!usedIds.has(candidate)) return candidate;
  }
  throw new Error('Unable to generate a unique workspace ID.');
}
