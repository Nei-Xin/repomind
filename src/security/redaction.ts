import { filterSensitiveToolData, referencesSensitivePath, suppressToolContent } from "./tool-output.js";

const RULES: ReadonlyArray<{ kind: string; pattern: RegExp; keepPrefix?: boolean }> = [
  { kind: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "aws-access-key-id", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { kind: "github-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "stripe-key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: "google-api-key", pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { kind: "url-credential", pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:)(?!\[REDACTED:)[^\s/@]+(?=@)/gi, keepPrefix: true },
  { kind: "connection-key", pattern: /(\b(?:AccountKey|SharedAccessKey|SharedAccessSignature)\s*=\s*)(?!\[REDACTED:)[^;\s"']+/gi, keepPrefix: true },
  { kind: "cookie", pattern: /(\b(?:set-cookie|cookie)["']?\s*[:=]\s*["']?)(?!\[REDACTED:)[^\s"'][^\r\n"']*/gi, keepPrefix: true },
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

export interface DeepRedactionResult<T> {
  value: T;
  redactions: number;
}

/**
 * Redacts every string leaf of a JSON-shaped value. Structured metadata is
 * redacted leaf by leaf rather than after serialization so a pattern that
 * spans a JSON escape sequence cannot corrupt the document.
 */
export function redactDeep<T>(value: T): DeepRedactionResult<T> {
  let redactions = 0;
  const sensitiveKey = (key: string): boolean => {
    const normalized = key.replace(/([a-z0-9])([A-Z])/gu, "$1_$2");
    return /(?:^|[_.-])(?:api[_-]?keys?|passwords?|passwd|secrets?|credentials?|(?:access[_-]|refresh[_-]|auth[_-]|bearer[_-])?tokens?|authorization|(?:set[_-])?cookie|account[_-]?key|shared[_-]?access[_-]?(?:key|signature)|connection[_-]?string)$/iu.test(normalized);
  };
  const walk = (node: unknown, sensitive = false): unknown => {
    if (typeof node === "string") {
      if (sensitive && node && !/^\[REDACTED:[^\]]+\]$/u.test(node)) {
        redactions++;
        return "[REDACTED:credential]";
      }
      const result = redactSecrets(node);
      redactions += result.redactions;
      return result.content;
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, sensitive));
    if (node && typeof node === "object") {
      const filtered = filterSensitiveToolData(node as Record<string, unknown>);
      if (filtered !== node) redactions++;
      return Object.fromEntries(Object.entries(filtered).map(([key, item]) => [key, walk(item, sensitive || sensitiveKey(key))]));
    }
    return node;
  };
  return { value: walk(value) as T, redactions };
}

/** Persist provider JSONL safely, pairing Claude's separate tool use/results.
 * Assessment still uses the original trace; this is a persistence boundary. */
export function redactAgentTranscript(content: string): RedactionResult {
  const uses = new Map<string, boolean>();
  const lines: unknown[] = content.split("\n").map((line) => {
    try { return JSON.parse(line) as unknown; } catch { return line; }
  });
  const blocks = (value: object): Array<Record<string, unknown>> => {
    const message = (value as Record<string, unknown>).message;
    if (!message || typeof message !== "object") return [];
    const content = (message as Record<string, unknown>).content;
    return Array.isArray(content) ? content.filter((block): block is Record<string, unknown> =>
      !!block && typeof block === "object" && !Array.isArray(block)) : [];
  };
  for (const event of lines) {
    if (!event || typeof event !== "object") continue;
    for (const block of blocks(event)) if (block.type === "tool_use" && typeof block.id === "string") {
      uses.set(block.id, (uses.get(block.id) ?? false) || referencesSensitivePath(block.input));
    }
  }
  let redactions = 0;
  const result = lines.map((line) => {
    if (typeof line === "string") {
      // A truncated JSON event can contain a partial secret or file body.
      if (/^\s*\{/u.test(line)) { redactions++; return "[REDACTED:incomplete-event]"; }
      const clean = redactSecrets(line); redactions += clean.redactions; return clean.content;
    }
    if (line && typeof line === "object") {
      const event = line as Record<string, unknown>;
      let sensitiveResult = false;
      for (const block of blocks(event)) {
        if (block.type === "tool_result" && (typeof block.tool_use_id !== "string" || uses.get(block.tool_use_id) !== false)) {
          block.content = suppressToolContent(block.content, false);
          sensitiveResult = true;
          redactions++;
        }
      }
      if (sensitiveResult && event.tool_use_result) event.tool_use_result = suppressToolContent(event.tool_use_result);
    }
    const clean = redactDeep(line); redactions += clean.redactions;
    return JSON.stringify(clean.value);
  }).join("\n");
  return { content: result, redactions };
}
