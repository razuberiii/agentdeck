const SECRET_PATTERNS = [
  /\b(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)\s*=\s*[^\s"'`]+/ig,
  /\b(Authorization|x-api-key)\s*[:=]\s*[^\s,;]+/ig,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/ig,
  /\bsk-ant-[A-Za-z0-9._-]+/ig,
];

export function redactClaudeSecrets(value: any): any {
  if (typeof value === 'string') return redactClaudeText(value);
  if (Array.isArray(value)) return value.map(redactClaudeSecrets);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, any> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/token|secret|password|api[_-]?key|authorization/i.test(key)) out[key] = '[redacted]';
    else out[key] = redactClaudeSecrets(raw);
  }
  return out;
}

export function redactClaudeText(text: string) {
  let next = String(text || '');
  for (const pattern of SECRET_PATTERNS) next = next.replace(pattern, match => {
    if (/^sk-ant-/i.test(match)) return maskSecret(match);
    if (/^Bearer\s+/i.test(match)) return 'Bearer [redacted]';
    return match.replace(/[:=]\s*.*/, '=[redacted]');
  });
  return next;
}

export function maskSecret(value: string) {
  const raw = String(value || '');
  if (raw.length <= 8) return '••••';
  return `${raw.slice(0, Math.min(7, raw.length - 4))}••••••••${raw.slice(-4)}`;
}

