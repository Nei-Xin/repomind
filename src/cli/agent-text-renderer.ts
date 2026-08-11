import type { RegisteredAgentHostId } from "../integrations/agent-host/registry.js";
import { redactSecrets } from "../security/redaction.js";

export interface AgentTextRenderer {
  feed(chunk: string): void;
  finish(): void;
  lastText(): string;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function openCodeText(event: Record<string, unknown>): string {
  const part = objectValue(event.part);
  return event.type === "text" && typeof part.text === "string" ? part.text.trim() : "";
}

function claudeText(event: Record<string, unknown>): string {
  if (event.type !== "assistant") return "";
  const message = objectValue(event.message);
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((value) => objectValue(value))
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => (block.text as string).trim())
    .filter(Boolean)
    .join("\n");
}

export function createAgentTextRenderer(
  runner: RegisteredAgentHostId,
  write: (text: string) => void = (text) => console.log(text),
): AgentTextRenderer {
  let buffer = "";
  let rendered = "";
  const renderLine = (line: string): void => {
    if (!line.trim().startsWith("{")) return;
    try {
      const event = JSON.parse(line) as unknown;
      if (!event || typeof event !== "object" || Array.isArray(event)) return;
      const text = runner === "claude"
        ? claudeText(event as Record<string, unknown>)
        : openCodeText(event as Record<string, unknown>);
      if (!text) return;
      rendered = redactSecrets(text).content;
      write(rendered);
    } catch { /* malformed Agent output is retained in the artifact */ }
  };
  return {
    feed(chunk) {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        renderLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    },
    finish() {
      if (buffer) renderLine(buffer);
      buffer = "";
    },
    lastText: () => rendered,
  };
}
