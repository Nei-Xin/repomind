import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeAgentEvents } from "../src/eval/agent/events.js";
import { parseAgentManifest } from "../src/eval/agent/manifest.js";
import { parseChangedFiles, runAgentEvaluation, type ProcessExecutor } from "../src/eval/agent/runner.js";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

describe("agent event analysis", () => {
  it("counts tokens, tools, reads, and RepoMind retrieval", () => {
    const metrics = analyzeAgentEvents([
      JSON.stringify({ type: "step_finish", part: { tokens: { input: 12, output: 3, reasoning: 2, cache: { read: 4, write: 1 } } } }),
      JSON.stringify({ type: "tool_use", part: { tool: "read", state: { status: "completed", input: { filePath: "README.md" } } } }),
      JSON.stringify({ type: "tool_use", part: { tool: "read", state: { status: "completed", input: { filePath: "README.md" } } } }),
      JSON.stringify({ type: "tool_use", part: { tool: "repomind_repo_session_start", state: { status: "completed", output: JSON.stringify({ memories: [{ id: "m1" }] }) } } }),
      "not json",
    ].join("\n"));
    expect(metrics).toMatchObject({ turns: 1, fileReads: 2, repeatedFileReads: 1, repoMindCalls: 1, retrievedMemories: 1 });
    expect(metrics.tokens).toEqual({ input: 12, output: 3, reasoning: 2, cacheRead: 4, cacheWrite: 1 });
  });
});

describe("Git porcelain parsing", () => {
  it("preserves the first character of unstaged paths", () => {
    expect(parseChangedFiles(" M src/index.js\n?? test/new.test.js\n")).toEqual(["src/index.js", "test/new.test.js"]);
  });
});

describe("agent manifest", () => {
  const task = {
    id: "task-one", baseRepository: ".", baseCommit: "HEAD", prompt: "Do it",
    publicChecks: [{ command: "node", args: ["--version"] }],
    hiddenChecks: [{ command: "node", args: ["--version"] }],
    memories: [{ type: "decision" as const, title: "Rule", content: "Use the rule." }],
  };

  it("applies defaults and rejects duplicate task ids", () => {
    expect(parseAgentManifest({ version: 1, name: "suite", tasks: [task] }).tasks[0]!.publicChecks[0]!.args).toEqual(["--version"]);
    expect(() => parseAgentManifest({ version: 1, name: "suite", tasks: [task, task] })).toThrow(/duplicate task ids/);
  });
});

describe("controlled agent evaluation", () => {
  it("runs isolated alternating arms and writes reports", () => {
    const root = mkdtempSync(join(tmpdir(), "repomind-agent-eval-"));
    const base = join(root, "base");
    const output = join(root, "output");
    try {
      spawnSync("git", ["init", "-q", base], { encoding: "utf8" });
      writeFileSync(join(base, "answer.txt"), "base\n", "utf8");
      git(base, ["add", "."]);
      git(base, ["-c", "user.name=RepoMind", "-c", "user.email=test@example.com", "commit", "-q", "-m", "base"]);
      const commit = git(base, ["rev-parse", "HEAD"]);
      const real: ProcessExecutor = (request) => spawnSync(request.command, request.args, {
        cwd: request.cwd, env: { ...process.env, ...request.env }, encoding: "utf8",
        timeout: request.timeoutMs, windowsHide: true, shell: false,
      });
      const execute: ProcessExecutor = (request) => {
        if (request.command === "fake-opencode") {
          const config = JSON.parse(readFileSync(join(request.cwd, "opencode.json"), "utf8")) as { mcp: Record<string, unknown> };
          const events = [{ type: "step_finish", part: { tokens: { input: 10, output: 2 } } }];
          if (config.mcp.repomind) events.push({
            type: "tool_use",
            part: { tool: "repomind_repo_session_start", state: { status: "completed", output: JSON.stringify({ memories: [{ id: "m1" }] }) } },
          } as never);
          return { status: 0, signal: null, stdout: events.map(JSON.stringify).join("\n"), stderr: "", error: undefined } as SpawnSyncReturns<string>;
        }
        return real(request);
      };
      const report = runAgentEvaluation({
        manifest: parseAgentManifest({
          version: 1, name: "fake suite", tasks: [{
            id: "smoke", baseRepository: base, baseCommit: commit, prompt: "Do it",
            publicChecks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
            hiddenChecks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
            memories: [{ type: "decision", title: "Hidden rule", content: "The historical answer." }],
            allowedChanges: [],
          }],
        }),
        model: "test/model", repeat: 2, outputDirectory: output,
        repoMindCli: join(process.cwd(), "dist", "cli", "index.js"),
        runnerExecutable: "fake-opencode", execute,
      });
      expect(report.runs.map((run) => `${run.arm}-${run.iteration}`)).toEqual([
        "no-memory-1", "repomind-1", "repomind-2", "no-memory-2",
      ]);
      expect(report.arms["no-memory"].repoMindCalls).toBe(0);
      expect(report.arms.repomind.repoMindCalls).toBe(2);
      expect(report.integrity).toEqual({ passed: true, failures: [] });
      expect(readFileSync(join(output, "summary.md"), "utf8")).toContain("fake suite");
      expect(JSON.parse(readFileSync(join(output, "summary.json"), "utf8"))).not.toHaveProperty("runs.0.rawLog");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
