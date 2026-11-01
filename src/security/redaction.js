const SECRET_PATTERNS = [
  { label: 'PRIVATE_KEY', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { label: 'OPENAI_KEY', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { label: 'GITHUB_TOKEN', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g },
  { label: 'AWS_ACCESS_KEY', pattern: /\b(?:AKIA|ASIA|A3T[A-Z0-9]|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/g },
  { label: 'SLACK_TOKEN', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { label: 'LABELED_SECRET', pattern: /((?:api[_-]?key|auth[_-]?token|access[_-]?token|token|secret|password)\s*[:=]\s*)(["']?)[A-Za-z0-9_./+=-]{12,}\2/gi }
];

export function redactSensitiveText(text) {
  let result = String(text);
  for (const { label, pattern } of SECRET_PATTERNS) {
    result = result.replace(pattern, (match, prefix) => `${prefix || ''}[REDACTED:${label}]`);
  }
  return result;
}

export function redactSensitive(value) {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redactSensitiveText(key), redactSensitive(entry)]));
  }
  return value;
}

export function containsSensitiveValue(value) {
  return JSON.stringify(redactSensitive(value)) !== JSON.stringify(value);
}
