import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const CLI = resolve("dist/cli/index.js");

function collectStdoutLines(child: ChildProcessWithoutNullStreams, expected: number, timeoutMs: number): Promise<string[]> {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffer = "";
    const lines: string[] = [];
    const timer = setTimeout(() => {
      rejectPromise(new Error(`Timed out waiting for ${expected} stdout lines; received ${lines.length}: ${JSON.stringify(lines)}`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) lines.push(line);
        if (lines.length >= expected) {
          clearTimeout(timer);
          resolvePromise(lines);
          return;
        }
        index = buffer.indexOf("\n");
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`MCP server exited early with code ${code}; stdout lines: ${JSON.stringify(lines)}`));
    });
  });
}

describe("MCP stdio protocol purity", () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  let scratch: string | undefined;

  afterEach(() => {
    child?.kill();
    child = undefined;
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  it("emits only JSON-RPC messages on stdout, including for tool errors", async () => {
    expect(existsSync(CLI), "dist/cli/index.js is missing; run npm run build before npm test").toBe(true);
    scratch = mkdtempSync(join(tmpdir(), "repomind-stdio-"));

    child = spawn(process.execPath, [CLI, "mcp"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pending = collectStdoutLines(child, 3, 15_000);

    const messages = [
      {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "purity-test", version: "1.0.0" } },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      {
        // Deliberately target a directory that is not a Git repository so the
        // error path is exercised; errors must flow through the protocol too.
        jsonrpc: "2.0", id: 3, method: "tools/call",
        params: { name: "repo_memory_search", arguments: { query: "anything", repo_path: scratch } },
      },
    ];
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);

    const lines = await pending;
    const parsed = lines.map((line) => {
      expect(() => JSON.parse(line), `stdout line is not JSON: ${line}`).not.toThrow();
      return JSON.parse(line) as { jsonrpc?: string; id?: number; result?: unknown };
    });
    for (const message of parsed) expect(message.jsonrpc).toBe("2.0");

    const toolList = parsed.find((message) => message.id === 2)?.result as { tools: Array<{ name: string }> };
    expect(toolList.tools).toHaveLength(23);

    const errorCall = parsed.find((message) => message.id === 3)?.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(errorCall.isError).toBe(true);
    expect(JSON.parse(errorCall.content[0]!.text)).toMatchObject({ code: expect.any(String) });
  });
});
