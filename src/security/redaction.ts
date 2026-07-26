const RULES: ReadonlyArray<{ kind: string; pattern: RegExp; keepPrefix?: boolean }> = [
  { kind: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "aws-access-key-id", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { kind: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "api-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    // Keyword must end at the match ("tokenizer" stays untouched); the
    // value must be at least 8 unbroken characters so prose stays intact.
    kind: "credential",
    pattern: /([A-Za-z0-9_.-]*(?:api[_-]?keys?|secrets?|tokens?|passwords?|passwd|credentials?)(?:[_.-][A-Za-z0-9]+)*["']?\s*[=:]\s*["']?)(?!\[REDACTED:)[^\s"']{8,}/gi,
    keepPrefix: true,
  },
  { kind: "bearer-token", pattern: /(\bbearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, keepPrefix: true },
];

// Sensitive path globs excluded from captured Git diffs. Git pathspec
// wildcards match across directory separators, so "*.pem" also matches
// nested files; dotfiles such as ".env*" need a second "*/.env*" entry
// because the literal prefix must match from the repository root.
export const SENSITIVE_PATH_GLOBS: readonly string[] = [
  ".env*",
  "*/.env*",
  ".npmrc",
  "*/.npmrc",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "*/id_rsa*",
  "id_ed25519*",
  "*/id_ed25519*",
];

export interface RedactionResult {
  content: string;
  redactions: number;
}

export function redactSecrets(content: string): RedactionResult {
  let redactions = 0;
  let result = content;
  for (const rule of RULES) {
    result = result.replace(rule.pattern, (...args) => {
      redactions++;
      const marker = `[REDACTED:${rule.kind}]`;
      return rule.keepPrefix ? `${String(args[1])}${marker}` : marker;
    });
  }
  return { content: result, redactions };
}
