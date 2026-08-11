#!/usr/bin/env node
import { globSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import { RepositoryMemoryCore } from "../core.js";
import type { HostRunStatus, MemoryReviewKind, MemoryReviewQueue, MemoryType, SkillCandidateStatus } from "../domain/types.js";
import { RepoMindError } from "../errors.js";
import { locateGitRoot } from "../git/git-inspector.js";
import { initializeRepository } from "../repository.js";
import { runMcpServer } from "../mcp/server.js";
import { VERSION } from "../version.js";
import { loadDataset } from "../eval/dataset.js";
import { evaluateDataset } from "../eval/runner.js";
import { runScenarioSuite } from "../eval/scenarios.js";
import { loadFixture } from "../eval/comparison/fixture.js";
import { renderMarkdown } from "../eval/comparison/report.js";
import { lintFixtures, runComparison } from "../eval/comparison/runner.js";
import type { ArmKey } from "../eval/comparison/types.js";
import { hashAgentManifest, loadAgentManifest } from "../eval/agent/manifest.js";
import { runAgentEvaluation } from "../eval/agent/runner.js";
import { aggregateAgentReports, writeAgentAggregateReport } from "../eval/agent/aggregate.js";
import { profileAgentReport, writeAgentProfileReport } from "../eval/agent/profile.js";
import { hashCrossSessionManifest, loadCrossSessionManifest } from "../eval/agent/cross-session-manifest.js";
import { runCrossSessionEvaluation } from "../eval/agent/cross-session-runner.js";
import { runAgentHost } from "../integrations/agent-host/run.js";
import {
  createAgentHostAdapter,
  isRegisteredAgentHostId,
  REGISTERED_AGENT_HOST_IDS,
  type RegisteredAgentHostId,
} from "../integrations/agent-host/registry.js";
import { validateHostContextBudget } from "../integrations/opencode/context.js";
import { redactSecrets } from "../security/redaction.js";
import { createAgentTextRenderer } from "./agent-text-renderer.js";
import { readCommitInput } from "./commit-input.js";
import { readReviewInput } from "./review-input.js";
import { stringifyCliJson } from "./json.js";
import { applyBootstrapBundle, generateBootstrapBundle, loadBootstrapBundle, writeBootstrapBundle } from "../bootstrap.js";
import { backupRepository, exportRepository, importRepository, restoreRepository } from "../portability/repository-data.js";

const MEMORY_TYPES = ["architecture", "convention", "decision", "command", "failure", "solution", "dependency", "location", "requirement", "risk"] as const;

const HELP = `RepoMind ${VERSION}

Usage:
  repomind --version
  repomind init [--repo <path>] [--new-id]
  repomind status [--repo <path>] [--json]
  repomind review [--kind all|stale|conflict|other] [--limit <1-200>] [--repo <path>] [--json]
  repomind review-apply --input <decisions.json|-> [--repo <path>] [--json]
  repomind review-history [--limit <1-200>] [--repo <path>] [--json]
  repomind module-rebuild [--module <path[,path...]>] [--budget <500-20000>] [--repo <path>] [--json]
  repomind modules [--repo <path>] [--json]
  repomind module-inspect <l2-id> [--repo <path>] [--json]
  repomind profile-rebuild [--budget <1000-30000>] [--min-confidence <0.5-1>] [--repo <path>] [--json]
  repomind profile [--repo <path>] [--json]
  repomind profile-inspect [--repo <path>] [--json]
  repomind skill-rebuild [--min-sessions <3-20>] [--repo <path>] [--json]
  repomind skills [--status pending|approved|rejected] [--repo <path>] [--json]
  repomind skill-inspect <l4-id> [--repo <path>] [--json]
  repomind skill-review <l4-id> --action approve|reject --reason <text> [--repo <path>] [--json]
  repomind skill-export <l4-id> --output <new-SKILL.md> [--repo <path>] [--json]
  repomind doctor [--repo <path>] [--json]
  repomind start --task <text> [--no-profile] [--repo <path>] [--json]
  repomind commit --input <result.json|-> [--repo <path>] [--json]
  repomind commit --session <id> --key <key> --summary <text> [--status success|partial|failed] [--repo <path>] [--json]
  repomind extract --session <completed-session-id> [--repo <path>] [--json]
  repomind search <query> [--repo <path>] [--limit <n>] [--json]
  repomind inspect <memory-id> [--repo <path>] [--json]
  repomind record --type <type> --title <text> --content <text> [--scope-type repository|module|path] [--scope-value <path>] [--related-files <csv>] [--repo <path>] [--json]
  repomind memory-validate <memory-id> --reason <text> [--repo <path>] [--json]
  repomind memory-correct <memory-id> --reason <text> --title <text> --content <text> [--type <type>] [--repo <path>] [--json]
  repomind memory-invalidate <memory-id> --reason <text> [--repo <path>] [--json]
  repomind forget <memory-id> --reason <text> [--scope memory|memory-and-evidence] --yes [--repo <path>] [--json]
  repomind reindex [--repo <path>] [--json]
  repomind vector-reindex [--repo <path>] [--json]
  repomind export --output <new-export.json> [--encrypt] [--passphrase-env <name>] [--allow-sensitive] [--repo <path>] [--json]
  repomind import --input <export.json> [--passphrase-env <name>] [--dry-run | --yes] [--allow-sensitive] [--repo <path>] [--json]
  repomind backup --output <new-backup.db.enc> [--encrypt] [--passphrase-env <name>] [--repo <path>] [--json]
  repomind restore --input <backup.db|backup.db.enc> [--passphrase-env <name>] [--dry-run | --yes] [--allow-unreadable] [--repo <path>] [--json]
  repomind sessions [--repo <path>] [--json]
  repomind session-abandon <session-id> [--repo <path>]
  repomind runs [--repo <path>] [--status running|committed|partial|failed|abandoned] [--limit <1-200>] [--json]
  repomind run-inspect <run-id> [--repo <path>] [--json]
  repomind bootstrap [--repo <path>] [--output <new-candidates.json>] [--json]
  repomind bootstrap-apply --input <candidates.json> [--candidate <id[,id...]>] --yes [--repo <path>] [--json]
  repomind run --task <text> [--repo <path>] [--runner opencode|claude] [--runner-executable <path>] [--model <id>] [--max-memories <0-20>] [--context-budget <1000-24000>] [--timeout <ms>] [--output <dir>] [--json]
  repomind eval (--dataset <path> | --scenarios | --compare | --agent | --agent-cross-session | --agent-summary | --agent-profile) [--limit <n>] [--json]
  repomind eval --compare [--fixtures <glob>] [--arms <csv>] [--budgets <csv>] [--repeat <1-100>] [--lint] [--strict] [--markdown]
  repomind eval --agent --manifest <path> [--runner opencode] [--model <id>] [--lifecycle agent-managed|host-managed] [--repeat <1-100>] [--output <dir>] [--strict] [--require-acceptance] [--json]
  repomind eval --agent-cross-session --manifest <path> [--runner opencode|claude] [--runner-executable <path>] [--model <id>] [--repeat <1-100>] [--max-memories <0-20>] [--context-budget <1000-24000>] [--timeout <ms>] [--output <dir>] [--strict] [--require-acceptance] [--json]
  repomind eval --agent-summary --reports <glob> [--output <dir>] [--strict] [--json]
  repomind eval --agent-profile --report <summary.json> [--raw <dir>] [--output <dir>] [--strict] [--json]
  repomind mcp
`;

function parseCliArgs() {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      strict: true,
      options: {
    repo: { type: "string" },
    json: { type: "boolean", default: false },
    "new-id": { type: "boolean", default: false },
    task: { type: "string" },
    session: { type: "string" },
    key: { type: "string" },
    summary: { type: "string" },
    status: { type: "string" },
    kind: { type: "string" },
    module: { type: "string" },
    budget: { type: "string" },
    "min-confidence": { type: "string" },
    "min-sessions": { type: "string" },
    action: { type: "string" },
    "no-profile": { type: "boolean", default: false },
    limit: { type: "string" },
    type: { type: "string" },
    title: { type: "string" },
    content: { type: "string" },
    "scope-type": { type: "string" },
    "scope-value": { type: "string" },
    "related-files": { type: "string" },
    candidate: { type: "string" },
    reason: { type: "string" },
    input: { type: "string" },
    scope: { type: "string" },
    yes: { type: "boolean", default: false },
    "allow-sensitive": { type: "boolean", default: false },
    "allow-unreadable": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    encrypt: { type: "boolean", default: false },
    "passphrase-env": { type: "string" },
    dataset: { type: "string" },
    scenarios: { type: "boolean", default: false },
    compare: { type: "boolean", default: false },
    agent: { type: "boolean", default: false },
    "agent-cross-session": { type: "boolean", default: false },
    "agent-summary": { type: "boolean", default: false },
    "agent-profile": { type: "boolean", default: false },
    reports: { type: "string" },
    report: { type: "string" },
    raw: { type: "string" },
    manifest: { type: "string" },
    runner: { type: "string" },
    "runner-executable": { type: "string" },
    model: { type: "string" },
    "max-memories": { type: "string" },
    "context-budget": { type: "string" },
    lifecycle: { type: "string" },
    output: { type: "string" },
    timeout: { type: "string" },
    fixtures: { type: "string" },
    arms: { type: "string" },
    budgets: { type: "string" },
    repeat: { type: "string" },
    "alpha-sweep": { type: "boolean", default: true },
    lint: { type: "boolean", default: false },
    strict: { type: "boolean", default: false },
    "require-acceptance": { type: "boolean", default: false },
    markdown: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`INVALID_INPUT: ${message}\nRun 'repomind --help' to see supported commands and options.`);
    process.exit(1);
  }
}

const { values, positionals } = parseCliArgs();

function required(value: string | undefined, flag: string): string {
  if (!value) throw new RepoMindError("INVALID_INPUT", `${flag} is required`);
  return value;
}

const DEFAULT_ARCHIVE_PASSPHRASE_ENV = "REPOMIND_ARCHIVE_PASSPHRASE";

function archivePassphrase(requiredForEncryption: boolean): string | undefined {
  const variable = values["passphrase-env"] ?? DEFAULT_ARCHIVE_PASSPHRASE_ENV;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(variable)) {
    throw new RepoMindError("INVALID_INPUT", "--passphrase-env must be a valid environment variable name");
  }
  const passphrase = process.env[variable];
  if (values["passphrase-env"] !== undefined && !passphrase) {
    throw new RepoMindError("INVALID_INPUT", `Environment variable ${variable} is not set or is empty`);
  }
  if (requiredForEncryption && !passphrase) {
    throw new RepoMindError("INVALID_INPUT", `Set ${variable} to a passphrase before using --encrypt`);
  }
  return passphrase;
}

function archivePassphraseOption(requiredForEncryption: boolean): { passphrase?: string } {
  const passphrase = archivePassphrase(requiredForEncryption);
  return passphrase === undefined ? {} : { passphrase };
}

function assertEncryptionFlags(command: string): void {
  const createsArchive = command === "export" || command === "backup";
  const readsArchive = command === "import" || command === "restore";
  if (values.encrypt && !createsArchive) {
    throw new RepoMindError("INVALID_INPUT", "--encrypt is only valid with export or backup");
  }
  if (values["passphrase-env"] !== undefined && !createsArchive && !readsArchive) {
    throw new RepoMindError("INVALID_INPUT", "--passphrase-env is only valid with export, import, backup, or restore");
  }
  if (values["passphrase-env"] !== undefined && createsArchive && !values.encrypt) {
    throw new RepoMindError("INVALID_INPUT", "--passphrase-env requires --encrypt when creating an export or backup");
  }
}

function memoryType(value: string | undefined, flag: string): MemoryType {
  const candidate = required(value, flag);
  if (!MEMORY_TYPES.includes(candidate as MemoryType)) throw new RepoMindError("INVALID_INPUT", `Invalid ${flag} ${candidate}`);
  return candidate as MemoryType;
}

function output(value: unknown): void {
  if (values.json || typeof value !== "string") console.log(stringifyCliJson(value));
  else console.log(value);
}

function repositoryPath(): string {
  return values.repo ?? process.cwd();
}

function agentHostRunner(value: string | undefined): RegisteredAgentHostId {
  const runner = value ?? "opencode";
  if (!isRegisteredAgentHostId(runner)) throw new RepoMindError("INVALID_INPUT", `Unsupported --runner ${runner}`);
  return runner;
}

function reviewKind(value: string | undefined): MemoryReviewKind | "all" {
  const kind = value ?? "all";
  if (!("all stale conflict other".split(" ") as string[]).includes(kind)) {
    throw new RepoMindError("INVALID_INPUT", `Invalid --kind ${kind}`);
  }
  return kind as MemoryReviewKind | "all";
}

function renderReviewQueue(queue: MemoryReviewQueue): string {
  const lines = [
    `Memory review: ${queue.pending} pending (stale ${queue.counts.stale}, conflict ${queue.counts.conflict}, other ${queue.counts.other})`,
    `Showing ${queue.returned} for filter ${queue.filter}.`,
  ];
  for (const item of queue.items) {
    lines.push("", `[${item.kind}] ${item.title} (${item.id})`, `  ${item.warning}`);
    lines.push(`  Evidence: ${item.evidenceCount}; files: ${item.relatedFiles.map((file) => file.filePath).join(", ") || "none"}`);
    lines.push(`  Inspect: ${item.suggestedCommands.inspect}`);
    lines.push(`  Resolve: ${item.suggestedCommands.validate}`);
    lines.push(`           ${item.suggestedCommands.correct}`);
    lines.push(`           ${item.suggestedCommands.invalidate}`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const command = positionals[0];
  if (values.version) {
    console.log(VERSION);
    return;
  }
  if (!command || values.help) {
    console.log(HELP);
    return;
  }
  assertEncryptionFlags(command);
  if (command === "mcp") {
    await runMcpServer();
    return;
  }
  if (command === "init") {
    const context = initializeRepository(repositoryPath(), values["new-id"]);
    try {
      output({ projectId: context.marker.projectId, repositoryRoot: context.root, databasePath: context.database.path });
    } finally {
      context.database.close();
    }
    return;
  }
  if (command === "run") {
    const task = required(values.task, "--task");
    const runner = agentHostRunner(values.runner);
    const timeoutMs = values.timeout ? Number(values.timeout) : 600_000;
    const maxMemories = values["max-memories"] ? Number(values["max-memories"]) : 5;
    const contextBudgetChars = values["context-budget"] === undefined
      ? undefined
      : validateHostContextBudget(Number(values["context-budget"]));
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new RepoMindError("INVALID_INPUT", `Invalid --timeout ${values.timeout}`);
    if (!Number.isInteger(maxMemories) || maxMemories < 0 || maxMemories > 20) {
      throw new RepoMindError("INVALID_INPUT", `Invalid --max-memories ${values["max-memories"]}`);
    }
    const controller = new AbortController();
    let interruptedBy: NodeJS.Signals | null = null;
    const interrupt = (signal: NodeJS.Signals): void => {
      interruptedBy ??= signal;
      controller.abort(signal);
    };
    const onSigint = (): void => interrupt("SIGINT");
    const onSigterm = (): void => interrupt("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    const renderer = createAgentTextRenderer(runner);
    const adapter = createAgentHostAdapter(runner, {
      ...(values["runner-executable"] ? { executable: values["runner-executable"] } : {}),
    });
    try {
      const root = locateGitRoot(repositoryPath());
      const initialized = new RepositoryMemoryCore(root);
      initialized.close();
      const runnerVersion = await adapter.version(root);
      if (!runnerVersion) {
        throw new RepoMindError(
          "CAPABILITY_UNAVAILABLE",
          `${adapter.displayName} is not executable. Install it, add it to PATH, or pass --runner-executable <path>. Run 'repomind doctor --runner ${runner}' for details.`,
          { runner, executable: adapter.executable },
        );
      }
      const report = await runAgentHost({
        adapter,
        repository: repositoryPath(),
        task,
        ...(values.model ? { model: values.model } : {}),
        maxMemories,
        ...(contextBudgetChars === undefined ? {} : { contextBudgetChars }),
        timeoutMs,
        ...(values.output ? { outputDirectory: values.output } : {}),
        signal: controller.signal,
        ...(!values.json ? {
          onStatus: (message: string) => console.error(`[RepoMind] ${redactSecrets(message).content}`),
          onStdout: renderer.feed,
          onStderr: (chunk: string) => process.stderr.write(redactSecrets(chunk).content),
        } : {}),
      });
      renderer.finish();
      if (values.json) output(report);
      else {
        if (report.summary !== renderer.lastText()) console.log(report.summary);
        console.error(`[RepoMind] exit=${report.agent.exitCode ?? "none"} session=${report.session.status} retrieved=${report.session.retrievedMemories} context=${report.context.contextChars}/${report.context.budgetChars} maintenance=${report.maintenance?.status ?? "skipped"}`);
      }
      if (!report.succeeded) {
        process.exitCode = interruptedBy === "SIGINT" ? 130
          : interruptedBy === "SIGTERM" ? 143
            : report.agent.exitCode && report.agent.exitCode > 0 ? report.agent.exitCode : 1;
      }
    } finally {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    }
    return;
  }
  if (command === "eval") {
    const modes = [values.dataset ? "--dataset" : "", values.scenarios ? "--scenarios" : "", values.compare ? "--compare" : "", values.agent ? "--agent" : "", values["agent-cross-session"] ? "--agent-cross-session" : "", values["agent-summary"] ? "--agent-summary" : "", values["agent-profile"] ? "--agent-profile" : ""].filter(Boolean);
    if (modes.length > 1) throw new RepoMindError("INVALID_INPUT", `${modes.join(" and ")} cannot be combined`);
    if (values["agent-profile"]) {
      const report = profileAgentReport(required(values.report, "--report"), values.raw);
      writeAgentProfileReport(report, values.output ?? "agent-profile");
      output(report);
      if (values.strict && !report.integrity.passed) process.exitCode = 1;
      return;
    }
    if (values["agent-summary"]) {
      const paths = globSync(required(values.reports, "--reports")).sort();
      if (!paths.length) throw new RepoMindError("INVALID_INPUT", "No agent reports matched");
      const report = aggregateAgentReports(paths);
      writeAgentAggregateReport(report, values.output ?? "agent-summary");
      output(report);
      if (values.strict && !report.integrity.passed) process.exitCode = 1;
      return;
    }
    if (values["agent-cross-session"]) {
      const runner = agentHostRunner(values.runner);
      const repeat = values.repeat ? Number(values.repeat) : 3;
      const timeoutMs = values.timeout ? Number(values.timeout) : 600_000;
      const maxMemories = values["max-memories"] ? Number(values["max-memories"]) : 5;
      const contextBudgetChars = values["context-budget"] === undefined
        ? undefined
        : validateHostContextBudget(Number(values["context-budget"]));
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new RepoMindError("INVALID_INPUT", `Invalid --timeout ${values.timeout}`);
      if (!Number.isInteger(maxMemories) || maxMemories < 0 || maxMemories > 20) {
        throw new RepoMindError("INVALID_INPUT", `Invalid --max-memories ${values["max-memories"]}`);
      }
      const manifestPath = required(values.manifest, "--manifest");
      const report = await runCrossSessionEvaluation({
        manifest: loadCrossSessionManifest(manifestPath),
        manifestSha256: hashCrossSessionManifest(manifestPath),
        runner,
        model: values.model ?? (runner === "claude" ? "gpt-5.6-luna" : "cliproxyapi/gpt-5.6-luna"),
        repeat,
        outputDirectory: values.output ?? "cross-session-results",
        repoMindRoot: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."),
        ...(values["runner-executable"] ? { runnerExecutable: values["runner-executable"] } : {}),
        adapterFactory: (stageRunner, factoryOptions) => createAgentHostAdapter(stageRunner, {
          ...factoryOptions,
          ...(stageRunner === "claude" ? { trustedIsolatedCheckout: true } : {}),
        }),
        timeoutMs,
        maxMemories,
        ...(contextBudgetChars === undefined ? {} : { contextBudgetChars }),
      });
      output(report);
      if (values.strict && !report.integrity.passed) process.exitCode = 1;
      if (values["require-acceptance"] && report.acceptance.status !== "passed") process.exitCode = 1;
      return;
    }
    if (values.agent) {
      const runner = values.runner ?? "opencode";
      if (runner !== "opencode") throw new RepoMindError("INVALID_INPUT", `Unsupported --runner ${runner}`);
      const repeat = values.repeat ? Number(values.repeat) : 3;
      const timeoutMs = values.timeout ? Number(values.timeout) : 600_000;
      const lifecycleMode = values.lifecycle ?? "agent-managed";
      if (lifecycleMode !== "agent-managed" && lifecycleMode !== "host-managed") {
        throw new RepoMindError("INVALID_INPUT", `Unsupported --lifecycle ${lifecycleMode}`);
      }
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new RepoMindError("INVALID_INPUT", `Invalid --timeout ${values.timeout}`);
      const manifestPath = required(values.manifest, "--manifest");
      const report = await runAgentEvaluation({
        manifest: loadAgentManifest(manifestPath),
        manifestSha256: hashAgentManifest(manifestPath),
        model: values.model ?? "cliproxyapi/gpt-5.6-terra",
        repeat,
        outputDirectory: values.output ?? "agent-results",
        repoMindCli: fileURLToPath(import.meta.url),
        ...(values["runner-executable"] ? { runnerExecutable: values["runner-executable"] } : {}),
        lifecycleMode,
        timeoutMs,
      });
      output(report);
      if (values.strict && !report.integrity.passed) process.exitCode = 1;
      if (values["require-acceptance"] && report.acceptance.status !== "passed") process.exitCode = 1;
      return;
    }
    if (values.compare) {
      const paths = globSync(values.fixtures ?? "benchmarks/comparison/*.json").sort();
      if (!paths.length) throw new RepoMindError("INVALID_INPUT", "No comparison fixtures matched");
      const fixtures = paths.map((path) => loadFixture(path));
      if (values.lint) {
        output({ linted: lintFixtures(fixtures) });
        return;
      }
      const report = runComparison({
        fixtures,
        enforceAggregate: !values.fixtures,
        ...(values.arms ? { arms: values.arms.split(",").map((arm) => arm.trim()) as ArmKey[] } : {}),
        ...(values.budgets ? { budgets: values.budgets.split(",").map((budget) => (Number(budget) === 0 ? Number.POSITIVE_INFINITY : Number(budget))) } : {}),
        ...(values.repeat ? { repeat: Number(values.repeat) } : {}),
        ...(values["alpha-sweep"] === false ? { alphaSweep: false } : {}),
      });
      const failed = [...report.gates.tier1, ...report.gates.tier2, ...report.gates.tier3]
        .filter((gate) => !gate.passed && !gate.waived);
      if (values.markdown) console.log(renderMarkdown(report));
      else output(report);
      if (values.strict && failed.length) process.exitCode = 1;
      return;
    }
    if (values.scenarios) {
      output(runScenarioSuite());
      return;
    }
    const dataset = loadDataset(required(values.dataset, "--dataset"));
    const limit = values.limit ? Number(values.limit) : 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new RepoMindError("INVALID_INPUT", `Invalid --limit ${values.limit}`);
    output(evaluateDataset(dataset, limit));
    return;
  }
  if (command === "doctor") {
    if (values["runner-executable"] && !values.runner) {
      throw new RepoMindError("INVALID_INPUT", "--runner-executable requires --runner with doctor");
    }
    const selectedRunners = values.runner ? [agentHostRunner(values.runner)] : [...REGISTERED_AGENT_HOST_IDS];
    const checks: Record<string, unknown> = {
      node: process.version,
      sqlite: true,
      fts5: false,
      sqliteVec: false,
      git: false,
      initialized: false,
    };
    const memory = new DatabaseSync(":memory:", { allowExtension: true });
    try {
      memory.exec("CREATE VIRTUAL TABLE check_fts USING fts5(content)");
      checks.fts5 = true;
      try {
        sqliteVec.load(memory);
        checks.sqliteVec = true;
        checks.sqliteVecVersion = (memory.prepare("SELECT vec_version() AS version").get() as { version: string }).version;
      } catch (error) {
        checks.sqliteVecError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      memory.close();
    }
    try { checks.gitRoot = locateGitRoot(repositoryPath()); checks.git = true; } catch { /* reported below */ }
    try {
      const core = new RepositoryMemoryCore(repositoryPath());
      checks.initialized = true;
      checks.projectId = core.context.marker.projectId;
      checks.capabilities = (core.status() as { capabilities: unknown }).capabilities;
      core.close();
    } catch { /* an uninitialized repository is a valid diagnostic result */ }
    const probeRoot = typeof checks.gitRoot === "string" ? checks.gitRoot : repositoryPath();
    checks.agents = Object.fromEntries(await Promise.all(selectedRunners.map(async (runner) => {
      const adapter = createAgentHostAdapter(runner, {
        ...(values["runner-executable"] ? { executable: values["runner-executable"] } : {}),
      });
      const version = await adapter.version(probeRoot);
      return [runner, {
        displayName: adapter.displayName,
        executable: adapter.executable,
        available: version !== null,
        version,
        ...(version === null ? {
          nextStep: `Install ${adapter.displayName}, add it to PATH, or pass --runner-executable <path>.`,
        } : {}),
      }];
    })));
    checks.nextSteps = [
      ...(checks.git ? [] : ["Run this command inside a Git repository."]),
      ...(checks.git && !checks.initialized ? ["Run 'repomind init' in the repository."] : []),
    ];
    output(checks);
    return;
  }
  if (command === "bootstrap") {
    const bundle = generateBootstrapBundle(repositoryPath());
    if (values.output) {
      output({ path: writeBootstrapBundle(bundle, values.output), candidates: bundle.candidates.length, bundle });
    } else {
      output(bundle);
    }
    return;
  }
  if (command === "bootstrap-apply") {
    const bundle = loadBootstrapBundle(required(values.input, "--input"));
    const selectedIds = values.candidate === undefined
      ? undefined
      : values.candidate.split(",").map((id) => id.trim()).filter(Boolean);
    if (values.candidate !== undefined && !selectedIds?.length) {
      throw new RepoMindError("INVALID_INPUT", "--candidate must contain at least one candidate id");
    }
    const unknownIds = (selectedIds ?? []).filter((id) => !bundle.candidates.some((entry) => entry.id === id));
    if (unknownIds.length) throw new RepoMindError("INVALID_INPUT", `Unknown bootstrap candidate ids: ${unknownIds.join(", ")}`);
    if (!values.yes) {
      const selected = selectedIds?.length
        ? bundle.candidates.filter((entry) => selectedIds.includes(entry.id))
        : bundle.candidates;
      output({
        wouldApply: selected.map((entry) => ({ id: entry.id, type: entry.type, title: entry.title, source: entry.source })),
        hint: "Review the candidate bundle and re-run with --yes to store these memories.",
      });
      process.exitCode = 1;
      return;
    }
    output(applyBootstrapBundle(repositoryPath(), bundle, selectedIds));
    return;
  }
  if (command === "restore") {
    if (values.yes && values["dry-run"]) throw new RepoMindError("INVALID_INPUT", "--yes and --dry-run cannot be combined");
    const confirmed = values.yes;
    const result = restoreRepository(repositoryPath(), required(values.input, "--input"), {
      dryRun: !confirmed,
      allowUnreadable: values["allow-unreadable"],
      ...archivePassphraseOption(false),
    });
    output(confirmed || values["dry-run"] ? result : {
      ...result,
      hint: "This replaces the live database after retaining a pre-restore backup. Re-run with --yes to confirm.",
    });
    if (!confirmed && !values["dry-run"]) process.exitCode = 1;
    return;
  }

  const core = new RepositoryMemoryCore(repositoryPath());
  try {
    switch (command) {
      case "status": output(core.status()); break;
      case "review": {
        const queue = core.review({
          ...(values.limit ? { limit: Number(values.limit) } : {}),
          kind: reviewKind(values.kind),
        });
        output(values.json ? queue : renderReviewQueue(queue));
        break;
      }
      case "review-apply": output(core.applyReview(readReviewInput(required(values.input, "--input")))); break;
      case "review-history": output(core.reviewHistory(values.limit ? Number(values.limit) : undefined)); break;
      case "module-rebuild": output(core.rebuildModuleNarratives({
        ...(values.module ? { modules: values.module.split(",").map((item) => item.trim()).filter(Boolean) } : {}),
        ...(values.budget ? { maxChars: Number(values.budget) } : {}),
      })); break;
      case "modules": output(core.listModuleNarratives()); break;
      case "module-inspect": output(core.inspectModuleNarrative(required(positionals[1], "l2-id"))); break;
      case "profile-rebuild": output(core.rebuildRepositoryProfile({
        ...(values.budget ? { maxChars: Number(values.budget) } : {}),
        ...(values["min-confidence"] ? { minConfidence: Number(values["min-confidence"]) } : {}),
      })); break;
      case "profile": output(core.getRepositoryProfile()); break;
      case "profile-inspect": output(core.inspectRepositoryProfile()); break;
      case "skill-rebuild": output(core.rebuildSkillCandidates({
        ...(values["min-sessions"] ? { minSessions: Number(values["min-sessions"]) } : {}),
      })); break;
      case "skills": {
        const status = values.status as SkillCandidateStatus | undefined;
        if (status && !(["pending", "approved", "rejected"] as string[]).includes(status)) {
          throw new RepoMindError("INVALID_INPUT", `Invalid --status ${status}`);
        }
        output(core.listSkillCandidates(status));
        break;
      }
      case "skill-inspect": output(core.inspectSkillCandidate(required(positionals[1], "l4-id"))); break;
      case "skill-review": {
        const action = required(values.action, "--action");
        if (action !== "approve" && action !== "reject") throw new RepoMindError("INVALID_INPUT", `Invalid --action ${action}`);
        output(core.reviewSkillCandidate({
          candidateId: required(positionals[1], "l4-id"),
          action,
          reason: required(values.reason, "--reason"),
        }));
        break;
      }
      case "skill-export": output(core.exportSkillCandidate(
        required(positionals[1], "l4-id"),
        required(values.output, "--output"),
      )); break;
      case "export": output(exportRepository(core.context, required(values.output, "--output"), {
        allowSensitive: values["allow-sensitive"],
        ...(values.encrypt ? archivePassphraseOption(true) : {}),
      })); break;
      case "import": {
        if (values.yes && values["dry-run"]) throw new RepoMindError("INVALID_INPUT", "--yes and --dry-run cannot be combined");
        const confirmed = values.yes;
        const result = importRepository(core.context, required(values.input, "--input"), {
          allowSensitive: values["allow-sensitive"],
          dryRun: !confirmed,
          ...archivePassphraseOption(false),
        });
        output(confirmed || values["dry-run"] ? result : {
          ...result,
          hint: "This atomically replaces repository data and rebuilds derived indexes. Re-run with --yes to confirm.",
        });
        if (!confirmed && !values["dry-run"]) process.exitCode = 1;
        break;
      }
      case "backup": output(backupRepository(core.context, required(values.output, "--output"), {
        ...(values.encrypt ? archivePassphraseOption(true) : {}),
      })); break;
      case "start": output(await core.startSessionHybrid({
        task: required(values.task, "--task"),
        clientName: "cli",
        includeRepositoryProfile: !values["no-profile"],
      })); break;
      case "commit": {
        if (values.input) {
          if (values.session || values.key || values.summary || values.status) {
            throw new RepoMindError("INVALID_INPUT", "--input cannot be combined with --session, --key, --summary, or --status");
          }
          output(core.commitSession(readCommitInput(values.input)));
          break;
        }
        const status = values.status ?? "success";
        if (!(["success", "partial", "failed"] as const).includes(status as "success")) throw new RepoMindError("INVALID_INPUT", `Invalid --status ${status}`);
        output(core.commitSession({
          sessionId: required(values.session, "--session"),
          idempotencyKey: required(values.key, "--key"),
          status: status as "success" | "partial" | "failed",
          summary: required(values.summary, "--summary"),
        }));
        break;
      }
      case "extract": output(await core.extractSession({ sessionId: required(values.session, "--session") })); break;
      case "search": {
        const result = await core.searchHybrid(required(positionals[1], "query"), { limit: values.limit ? Number(values.limit) : 5 });
        output(result.memories);
        break;
      }
      case "inspect": output(core.inspect(required(positionals[1], "memory-id"))); break;
      case "record": {
        const scopeType = values["scope-type"] ?? "repository";
        if (!("repository module path".split(" ") as string[]).includes(scopeType)) {
          throw new RepoMindError("INVALID_INPUT", `Invalid --scope-type ${scopeType}`);
        }
        output(core.record({
          type: memoryType(values.type, "--type"),
          title: required(values.title, "--title"),
          content: required(values.content, "--content"),
          scopeType: scopeType as "repository" | "module" | "path",
          ...(values["scope-value"] ? { scopeValue: values["scope-value"] } : {}),
          ...(values["related-files"] ? { relatedFiles: values["related-files"].split(",").map((item) => item.trim()).filter(Boolean) } : {}),
        }));
        break;
      }
      case "memory-validate": output(core.validateMemory({
        memoryId: required(positionals[1], "memory-id"),
        reason: required(values.reason, "--reason"),
      })); break;
      case "memory-correct": output(core.correctMemory({
        memoryId: required(positionals[1], "memory-id"),
        reason: required(values.reason, "--reason"),
        title: required(values.title, "--title"),
        content: required(values.content, "--content"),
        ...(values.type ? { type: memoryType(values.type, "--type") } : {}),
      })); break;
      case "memory-invalidate": output(core.invalidateMemory({
        memoryId: required(positionals[1], "memory-id"),
        reason: required(values.reason, "--reason"),
      })); break;
      case "forget": {
        const memoryId = required(positionals[1], "memory-id");
        const scope = values.scope ?? "memory-and-evidence";
        if (!(["memory", "memory-and-evidence"] as const).includes(scope as "memory")) {
          throw new RepoMindError("INVALID_INPUT", `Invalid --scope ${scope}`);
        }
        const reason = required(values.reason, "--reason");
        if (!values.yes) {
          const details = core.inspect(memoryId);
          output({
            wouldDelete: {
              memoryId,
              type: details.type,
              title: details.title,
              scope,
              linkedEvidence: (details.evidence as unknown[]).length,
            },
            hint: "This permanently deletes the memory" +
              (scope === "memory-and-evidence" ? " and any evidence used only by it" : "") +
              ". Re-run with --yes to confirm.",
          });
          process.exitCode = 1;
          break;
        }
        output(core.forgetMemory({ memoryId, reason, scope: scope as "memory" | "memory-and-evidence" }));
        break;
      }
      case "reindex": output(core.reindex()); break;
      case "vector-reindex": output(await core.reindexVectors()); break;
      case "sessions": output(core.listSessions()); break;
      case "session-abandon": core.abandonSession(required(positionals[1], "session-id")); output("Session abandoned."); break;
      case "runs": output(core.listHostRuns({
        ...(values.limit ? { limit: Number(values.limit) } : {}),
        ...(values.status ? { status: values.status as HostRunStatus } : {}),
      })); break;
      case "run-inspect": output(core.inspectHostRun(required(positionals[1], "run-id"))); break;
      default: throw new RepoMindError("INVALID_INPUT", `Unknown command: ${command}`);
    }
  } finally {
    core.close();
  }
}

main().catch((error: unknown) => {
  const payload = error instanceof RepoMindError
    ? { code: error.code, message: error.message, details: error.details }
    : { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) };
  console.error(values.json ? stringifyCliJson(payload) : `${payload.code}: ${payload.message}`);
  process.exitCode = 1;
});
