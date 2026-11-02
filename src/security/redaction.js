const SECRET_PATTERNS = [
  { label: 'PRIVATE_KEY', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { label: 'OPENAI_KEY', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { label: 'GITHUB_TOKEN', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g },
  { label: 'AWS_ACCESS_KEY', pattern: /\b(?:AKIA|ASIA|A3T[A-Z0-9]|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/g },
  { label: 'SLACK_TOKEN', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { label: 'AUTH_SCHEME_CREDENTIAL', pattern: /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi },
  { label: 'AUTHORIZATION_HEADER', pattern: /((?:proxy-)?authorization\s*:\s*)[^\r\n]+/gi },
  { label: 'COOKIE_HEADER', pattern: /((?:set-)?cookie\s*:\s*)[^\r\n]+/gi },
  { label: 'LABELED_SECRET', pattern: /((?:aws[_-]?secret[_-]?access[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token|auth[_-]?token|api[_-]?key|token|secret|password|passwd)\s*[:=]\s*)(["']?)[A-Za-z0-9_./+=-]{8,}\2/gi }
];

function isSensitiveFieldName(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized === 'auth' || normalized === 'authorization' || normalized === 'proxyauthorization' ||
    normalized === 'cookie' || normalized === 'setcookie' || normalized === 'token' ||
    normalized.endsWith('token') || normalized.endsWith('apikey') || normalized.endsWith('secret') ||
    normalized.endsWith('secretkey') || normalized.endsWith('secretaccesskey') ||
    normalized.endsWith('password') || normalized.endsWith('passwd') || normalized.endsWith('privatekey') ||
    normalized.endsWith('credential') || normalized.endsWith('credentials');
}

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
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      redactSensitiveText(key),
      isSensitiveFieldName(key) ? '[REDACTED:SENSITIVE_FIELD]' : redactSensitive(entry)
    ]));
  }
  return value;
}

export function containsSensitiveValue(value) {
  return JSON.stringify(redactSensitive(value)) !== JSON.stringify(value);
}
