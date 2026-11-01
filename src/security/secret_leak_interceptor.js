import crypto from 'crypto';

/**
 * Secret & Credential Leak Interceptor
 * Scans all tool calls, shell inputs, and file diffs for exposed credentials before execution.
 */
export class SecretLeakInterceptor {
  constructor() {
    this.patterns = [
      { name: 'OpenAI API Key', regex: /sk-[a-zA-Z0-9]{20,T3BlbkFJ[a-zA-Z0-9]{20,}/ },
      { name: 'Generic Secret Key / Token', regex: /(?:api[_-]?key|auth[_-]?token|secret|password|access[_-]?token)\s*[:=]\s*['"][a-zA-Z0-9_\-]{16,}['"]/i },
      { name: 'AWS Access Key ID', regex: /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/ },
      { name: 'GitHub Personal Access Token', regex: /gh[pousr]_[a-zA-Z0-9]{36,255}/ },
      { name: 'Private Key Block', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
      { name: 'Slack Bot Token', regex: /xoxb-[0-9]{11,13}-[0-9]{11,13}-[a-zA-Z0-9]{24}/ }
    ];
  }

  scan(content) {
    if (!content) return { safe: true };
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    
    for (const pat of this.patterns) {
      if (pat.regex.test(text)) {
        return {
          safe: false,
          leakType: pat.name,
          reason: `Detected unmasked credential (${pat.name}) in agent payload.`
        };
      }
    }

    return { safe: true };
  }
}
