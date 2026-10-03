export const SENSITIVE_TOOL_CONTENT = "[REDACTED:sensitive-file]";

/** Lexical detection includes quoted, absolute and Windows paths. This is not
 * a shell interpreter: aliases, symlinks and computed paths remain a limit. */
export function referencesSensitivePath(value: unknown): boolean {
  if (typeof value === "string") {
    return /(?:^|[\s/\\'"=<>;|&([{])(?:\.env[^\s/\\'";|&)]*|\.npmrc|id_(?:rsa|ed25519)[^\s/\\'";|&)]*|[^\s/\\'";|&()]+\.(?:pem|key|p12|pfx))(?=$|[\s/\\'";|&)>\]}])/iu.test(value);
  }
  if (Array.isArray(value)) return value.some(referencesSensitivePath);
  return !!value && typeof value === "object" && Object.values(value).some(referencesSensitivePath);
}

export function suppressToolContent(value: unknown, preserveStatus = true): unknown {
  if (typeof value === "string") return value ? SENSITIVE_TOOL_CONTENT : value;
  if (Array.isArray(value)) return value.map(item => suppressToolContent(item, false));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      const exit = ["exitCode", "exit_code", "exit", "code"].includes(key) && typeof item === "number" && Number.isInteger(item);
      const flag = ["interrupted", "is_error", "isError", "timedOut", "aborted", "run_in_background"].includes(key) && typeof item === "boolean";
      const status = key === "status" && ["completed", "error", "running", "pending"].includes(String(item));
      return [key, preserveStatus && (exit || flag || status) ? item
        : suppressToolContent(item, preserveStatus && ["metadata", "result"].includes(key))];
    }));
  }
  // Only collector status survives; numeric/boolean file contents are private too.
  return value === null || value === undefined ? value : SENSITIVE_TOOL_CONTENT;
}

/** Handles interactive envelopes, OpenCode state and normalized command evidence. */
export function filterSensitiveToolData(node: Record<string, unknown>): Record<string, unknown> {
  const inputKey = "toolInput" in node ? "toolInput" : "tool_input" in node ? "tool_input" : "input";
  const sensitiveInput = referencesSensitivePath(node[inputKey]);
  const sensitiveCommand = typeof node.command === "string"
    && (referencesSensitivePath(node.command) || referencesSensitivePath(node.invokedAs));
  if (!sensitiveInput && !sensitiveCommand) return node;
  const result = { ...node };
  const fields = sensitiveCommand
    ? ["summary", "stdout", "stderr", "output", "error"]
    : ["toolResponse", "tool_response", "error", "output", "content", "metadata"];
  if (sensitiveInput && node[inputKey] && typeof node[inputKey] === "object") {
    // Preserve invocation identity for status/recovery assessment. Credential
    // patterns still redact command strings; opaque inline shell literals are
    // subject to the same documented limitation as arbitrary agent prose.
    result[inputKey] = Object.fromEntries(Object.entries(node[inputKey]).map(([key, value]) => [key,
      ["command", "path", "file_path", "filePath"].includes(key) ? value : suppressToolContent(value, false),
    ]));
  }
  for (const field of fields) if (field in result) {
    result[field] = suppressToolContent(result[field], ["toolResponse", "tool_response", "metadata"].includes(field));
  }
  return JSON.stringify(result) === JSON.stringify(node) ? node : result;
}
