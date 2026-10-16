/**
 * Best-effort secret redaction applied to every piece of text before it leaves the editor.
 * Pure function; unit-tested.
 */

export const REDACTED = "‹redacted›"; // ‹redacted›

interface Rule {
  re: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}

const RULES: Rule[] = [
  // PEM private key blocks (RSA, EC, OPENSSH, ENCRYPTED, plain PRIVATE KEY ...).
  {
    re: /-----BEGIN ([A-Z0-9 ]*?)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/g,
    replace: () => REDACTED,
  },
  // GitHub fine-grained PATs.
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: () => REDACTED },
  // GitHub classic tokens: ghp_, gho_, ghu_, ghs_, ghr_.
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: () => REDACTED },
  // OpenAI / Anthropic style keys: sk-..., sk-proj-..., sk-ant-...
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, replace: () => REDACTED },
  // AWS access key ids.
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: () => REDACTED },
  // Slack tokens.
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: () => REDACTED },
  // password / secret / token / api_key assignments with a quoted value:
  //   password = "hunter2"   API_TOKEN: 'abc'   "secret": "x"   clientSecret="y"
  {
    re: /((?:["']?)[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)(["'`])((?:\\.|(?!\2)[^\\\r\n])+)\2/gi,
    replace: (_m, prefix: string, quote: string) => `${prefix}${quote}${REDACTED}${quote}`,
  },
  // Unquoted env-file style: PASSWORD=hunter2, API_TOKEN=abc123 (value up to whitespace).
  {
    re: /^(\s*(?:export\s+)?[A-Za-z0-9_.-]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY)[A-Za-z0-9_.-]*\s*=\s*)(?!["'`])(\S+)/gim,
    replace: (_m, prefix: string) => `${prefix}${REDACTED}`,
  },
];

export function redact(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, rule.replace as (substring: string, ...args: unknown[]) => string);
  }
  return out;
}
