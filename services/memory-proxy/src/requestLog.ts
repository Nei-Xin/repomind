/**
 * Request debug log — logs every intercepted LLM API request body via structured log system.
 * Only active when log.level === "debug".
 */

import type { ProxyConfig } from "./types.js";
import { log } from "./report/log.js";

/** Write the raw LLM request body as a debug log entry. Only writes if level=debug. */
export function writeRequestLog(config: ProxyConfig, body: Record<string, unknown>): void {
  if (config.log.level !== "debug") return;
  const model = typeof body.model === "string" ? body.model : "unknown";
  const msgCount = Array.isArray(body.messages) ? body.messages.length : 0;
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  log.debug("request.body", { model, msgCount, hasTools, stream: body.stream === true });
}
