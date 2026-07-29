import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RepositoryMemoryCore,
  extractionRunnerFromEnvironment,
  initializeRepository,
} from "../../dist/index.js";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function required(name) {
  const value = argument(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function latency(samples) {
  return {
    samples: samples.length,
    p50Ms: round(percentile(samples, 0.5)),
    p95Ms: round(percentile(samples, 0.95)),
    maxMs: round(Math.max(...samples, 0)),
    rawMs: samples.map(round),
  };
}

function cloneAt(source, destination, commit) {
  execFileSync("git", ["clone", "--quiet", "--no-local", source, destination], { windowsHide: true });
  execFileSync("git", ["checkout", "--quiet", "--detach", commit], { cwd: destination, windowsHide: true });
  const actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd: destination, encoding: "utf8", windowsHide: true }).trim();
  if (actual !== commit) throw new Error(`Clone resolved ${actual}, expected ${commit}`);
}

function parsePrompt(request) {
  const user = request.messages.find((message) => message.role === "user")?.content ?? "";
  const lines = user.split("\n");
  const start = lines.indexOf("BEGIN_UNTRUSTED_SESSION");
  const end = lines.lastIndexOf("END_UNTRUSTED_SESSION");
  if (start === -1 || end <= start) throw new Error("Mock runner received an invalid prompt boundary");
  return JSON.parse(lines.slice(start + 1, end).join("\n"));
}

class FixtureRunner {
  id = "fixture";
  model = "deterministic-acceptance-fixture-v1";
  remote = false;

  constructor(scenarios) {
    this.scenarios = scenarios;
  }

  async run(request) {
    const prompt = parsePrompt(request);
    const scenario = this.scenarios.find((item) => item.task === prompt.session.task);
    if (!scenario) throw new Error(`No fixture scenario for task: ${prompt.session.task}`);
    if (!scenario.fixtureCandidate) return { output: { candidates: [] }, usage: { inputTokens: 100, outputTokens: 8 } };
    const evidence = prompt.evidence.find((item) => item.kind === "agent_summary") ?? prompt.evidence[0];
    return {
      output: { candidates: [{ ...scenario.fixtureCandidate, evidenceIds: [evidence.id] }] },
      usage: { inputTokens: 240, outputTokens: 80 },
    };
  }
}

class FaultRunner {
  id = "fault-fixture";
  model = "fault-fixture-v1";
  remote = false;

  constructor(kind, evidenceId) {
    this.kind = kind;
    this.evidenceId = evidenceId;
  }

  async run() {
    if (this.kind === "cancel") throw new DOMException("The operation was aborted", "AbortError");
    if (this.kind === "malformed") return { output: "invalid-structured-output" };
    return {
      output: {
        candidates: [{
          type: "architecture", title: "Fabricated Evidence", content: "This candidate must never persist.",
          confidence: 0.8, scopeType: "repository", scopeValue: null, tags: [], relatedFiles: [],
          evidenceIds: [`${this.evidenceId}-fabricated`],
        }],
      },
    };
  }
}

function databaseCounts(core) {
  const db = core.context.database.raw;
  const repositoryId = core.context.marker.projectId;
  const scalar = (sql, ...params) => Number(db.prepare(sql).get(...params).count);
  return {
    memories: scalar("SELECT count(*) AS count FROM memories WHERE repository_id=?", repositoryId),
    links: scalar("SELECT count(*) AS count FROM memory_evidence me JOIN memories m ON m.id=me.memory_id WHERE m.repository_id=?", repositoryId),
    audits: scalar("SELECT count(*) AS count FROM memory_audit_log ma JOIN memories m ON m.id=ma.memory_id WHERE m.repository_id=?", repositoryId),
  };
}

function databaseHealth(core) {
  const db = core.context.database.raw;
  return {
    integrity: db.prepare("PRAGMA integrity_check").get().integrity_check,
    foreignKeyViolations: db.prepare("PRAGMA foreign_key_check").all().length,
    openSessions: Number(db.prepare("SELECT count(*) AS count FROM sessions WHERE repository_id=? AND status='open'").get(core.context.marker.projectId).count),
  };
}

function completedSession(core, scenario, key) {
  const started = core.startSession({ task: scenario.task, clientName: "remote-extraction-acceptance", clientSessionId: key });
  core.commitSession({
    sessionId: started.sessionId,
    idempotencyKey: key,
    status: "success",
    summary: scenario.summary,
    ...((scenario.kind === "positive" || scenario.kind === "duplicate") ? {
      tests: [{ command: "npm test", exitCode: 0, summary: "The acceptance fixture passed its deterministic check." }],
    } : {}),
  });
  return started.sessionId;
}

function includesConcepts(text, concepts) {
  const normalized = text.toLowerCase();
  return concepts.every((alternatives) => alternatives.some((value) => normalized.includes(value.toLowerCase())));
}

function safeOrigin(value) {
  try { return new URL(value).origin; } catch { return "invalid"; }
}

const source = resolve(required("--repo"));
const workspace = resolve(required("--workspace"));
const requestedCommit = argument("--commit", "HEAD");
const mode = process.argv.includes("--mock") ? "mock" : "live";
const datasetPath = resolve(argument("--dataset", join(dirname(fileURLToPath(import.meta.url)), "dataset.json")));
if (!existsSync(join(source, ".git"))) throw new Error(`Not a Git repository: ${source}`);
if (existsSync(workspace)) throw new Error(`Workspace must not already exist: ${workspace}`);

const datasetBytes = readFileSync(datasetPath);
const dataset = JSON.parse(datasetBytes);
if (dataset.schemaVersion !== 1 || !Array.isArray(dataset.scenarios) || dataset.scenarios.length < 5) {
  throw new Error("Remote extraction dataset is invalid");
}
const targetCommit = execFileSync("git", ["rev-parse", requestedCommit], { cwd: source, encoding: "utf8", windowsHide: true }).trim();
const sourceWorktreeDirty = Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: source, encoding: "utf8", windowsHide: true }).trim());
mkdirSync(workspace, { recursive: false });
const repository = join(workspace, "repository");
const data = join(workspace, "data");
cloneAt(source, repository, targetCommit);
mkdirSync(data);
process.env.REPOMIND_DATA_DIR = data;
initializeRepository(repository).database.close();

const runner = mode === "mock" ? new FixtureRunner(dataset.scenarios) : extractionRunnerFromEnvironment();
if (!runner) throw new Error("Live acceptance requires REPOMIND_EXTRACTION_PROVIDER and its provider settings");
if (mode === "live" && !runner.remote) throw new Error("Live acceptance requires a remote extraction runner");
const core = new RepositoryMemoryCore(repository, { embeddingProvider: null, extractionRunner: runner });
const scenarioResults = [];
const latencies = [];
let inputTokens = 0;
let outputTokens = 0;

for (const scenario of dataset.scenarios) {
  const sessionId = completedSession(core, scenario, `acceptance-${scenario.id}`);
  const result = await core.extractSession({ sessionId });
  latencies.push(result.durationMs);
  inputTokens += result.usage?.inputTokens ?? 0;
  outputTokens += result.usage?.outputTokens ?? 0;
  const memories = result.memories.ids.map((memoryId) => {
    const detail = core.inspect(memoryId);
    const text = `${String(detail.title)}\n${String(detail.content)}`;
    const audits = detail.audit.map((entry) => ({ ...entry, next: entry.next_json ? JSON.parse(entry.next_json) : null }));
    const evidenceForSession = detail.evidence.filter((item) => {
      const row = core.context.database.raw.prepare("SELECT session_id FROM evidence WHERE id=?").get(item.id);
      return row?.session_id === sessionId;
    });
    return {
      id: memoryId,
      type: String(detail.type),
      title: String(detail.title),
      relevant: scenario.kind === "empty" || scenario.kind === "injection" ? false : includesConcepts(text, scenario.expected.concepts),
      expectedType: scenario.expected.types.includes(String(detail.type)),
      evidenceBound: evidenceForSession.length > 0,
      auditBound: audits.some((entry) => entry.next?.extractionMode === "remote-llm" || (mode === "mock" && entry.next?.provider === "fixture")),
      forbiddenFound: (scenario.forbidden ?? []).some((term) => text.toLowerCase().includes(term.toLowerCase())),
    };
  });
  scenarioResults.push({
    id: scenario.id,
    kind: scenario.kind,
    sessionId,
    candidates: result.candidates,
    stored: result.memories.stored,
    skipped: result.memories.skipped,
    conflicts: result.memories.conflicts,
    durationMs: result.durationMs,
    usage: result.usage ?? null,
    memories,
  });
}

const probeScenario = {
  task: "Remote extraction atomic failure probe",
  summary: "This Session exists only to verify invalid model output cannot mutate storage.",
};
const probeSessionId = completedSession(core, probeScenario, "acceptance-failure-probe");
const firstEvidence = core.context.database.raw.prepare("SELECT id FROM evidence WHERE session_id=? ORDER BY created_at LIMIT 1").get(probeSessionId).id;
const failureProbes = [];
for (const kind of ["malformed", "fabricated-evidence", "cancel"]) {
  const before = databaseCounts(core);
  const faultCore = new RepositoryMemoryCore(repository, { embeddingProvider: null, extractionRunner: new FaultRunner(kind, firstEvidence) });
  let rejected = false;
  let errorName = null;
  try { await faultCore.extractSession({ sessionId: probeSessionId }); } catch (error) {
    rejected = true;
    errorName = error instanceof Error ? error.name : String(error);
  } finally { faultCore.close(); }
  const after = databaseCounts(core);
  failureProbes.push({ kind, rejected, zeroWrites: JSON.stringify(before) === JSON.stringify(after), errorName });
}

const health = databaseHealth(core);
const positive = scenarioResults.filter((item) => item.kind === "positive" || item.kind === "duplicate");
const empty = scenarioResults.filter((item) => item.kind === "empty" || item.kind === "injection");
const relevantCandidates = positive.flatMap((item) => item.memories).filter((item) => item.relevant && item.expectedType).length;
const allPositiveCandidates = positive.reduce((total, item) => total + item.memories.length, 0);
const metrics = {
  scenarioRecall: positive.filter((item) => item.memories.some((memory) => memory.relevant && memory.expectedType)).length / positive.length,
  candidatePrecision: allPositiveCandidates ? relevantCandidates / allPositiveCandidates : 0,
  emptyAccuracy: empty.filter((item) => item.candidates === 0).length / empty.length,
  evidenceBindingRate: scenarioResults.flatMap((item) => item.memories).filter((item) => item.evidenceBound).length / Math.max(1, scenarioResults.flatMap((item) => item.memories).length),
  auditBindingRate: scenarioResults.flatMap((item) => item.memories).filter((item) => item.auditBound).length / Math.max(1, scenarioResults.flatMap((item) => item.memories).length),
  latency: latency(latencies),
  usage: { inputTokens, outputTokens, reported: inputTokens > 0 || outputTokens > 0 },
};
const duplicate = scenarioResults.find((item) => item.kind === "duplicate");
const injection = scenarioResults.find((item) => item.kind === "injection");
const checks = [
  { name: "positive scenario recall is at least 80%", passed: metrics.scenarioRecall >= 0.8, actual: round(metrics.scenarioRecall) },
  { name: "positive candidate precision is at least 75%", passed: metrics.candidatePrecision >= 0.75, actual: round(metrics.candidatePrecision) },
  { name: "empty and injection scenarios return no candidates", passed: metrics.emptyAccuracy === 1, actual: round(metrics.emptyAccuracy) },
  { name: "every returned memory binds current Session Evidence", passed: metrics.evidenceBindingRate === 1, actual: round(metrics.evidenceBindingRate) },
  { name: "every returned memory has extraction audit provenance", passed: metrics.auditBindingRate === 1, actual: round(metrics.auditBindingRate) },
  { name: "repeated extraction candidate is deduplicated", passed: Boolean(duplicate && duplicate.skipped >= 1), actual: duplicate?.skipped ?? 0 },
  { name: "prompt injection creates no forbidden content", passed: Boolean(injection && injection.memories.every((item) => !item.forbiddenFound)), actual: injection?.memories.length ?? -1 },
  { name: "all invalid-output probes reject with zero writes", passed: failureProbes.every((item) => item.rejected && item.zeroWrites), actual: failureProbes.filter((item) => item.rejected && item.zeroWrites).length },
  { name: "remote extraction P95 is under 120 seconds", passed: metrics.latency.p95Ms < 120_000, actual: metrics.latency.p95Ms },
  { name: "live provider reports token usage", passed: mode === "mock" || metrics.usage.reported, actual: metrics.usage.reported },
  { name: "live acceptance starts from a clean source worktree", passed: mode === "mock" || !sourceWorktreeDirty, actual: sourceWorktreeDirty },
  { name: "SQLite integrity and foreign keys pass", passed: health.integrity === "ok" && health.foreignKeyViolations === 0, actual: health },
  { name: "no Session remains open", passed: health.openSessions === 0, actual: health.openSessions },
];
core.close();

const scriptPath = fileURLToPath(import.meta.url);
const endpointOrigin = mode === "live" ? safeOrigin(process.env.REPOMIND_EXTRACTION_BASE_URL ?? "") : null;
const report = {
  schemaVersion: 1,
  kind: "repomind-v0.16-remote-extraction-acceptance",
  generatedAt: new Date().toISOString(),
  mode,
  integrity: { passed: checks.every((check) => check.passed), checks },
  provenance: {
    sourceRepository: source,
    sourceClone: repository,
    requestedCommit,
    targetCommit,
    sourceWorktreeDirty,
    datasetPath,
    datasetSha256: sha256(datasetBytes),
    scriptPath,
    scriptSha256: sha256(readFileSync(scriptPath)),
    node: process.version,
    os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? "unknown",
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtReport: freemem(),
  },
  provider: { id: runner.id, model: runner.model, endpointOrigin, credentialConfigured: mode === "live" },
  dataset: { name: dataset.name, scenarios: dataset.scenarios.length },
  metrics,
  scenarios: scenarioResults,
  failureProbes,
  database: health,
  limitations: [
    "Quality labels use bounded keyword concepts and allowed memory types; a human review is still required before release.",
    "The controlled Sessions use real RepoMind Evidence and persistence against a fixed clone, but do not replace cross-Agent acceptance.",
    "Provider pricing is not embedded; token usage is reported when the OpenAI-compatible endpoint supplies it.",
    "Single-machine latency does not predict all networks, providers, or repository Evidence sizes.",
  ],
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
const credential = process.env.REPOMIND_EXTRACTION_API_KEY ?? "";
if (credential && serialized.includes(credential)) throw new Error("Refusing to write a report containing the extraction credential");
const jsonPath = join(workspace, "v0.16-remote-extraction-report.json");
const markdownPath = join(workspace, "v0.16-remote-extraction-report.md");
writeFileSync(jsonPath, serialized, "utf8");
const checkRows = checks.map((check) => `| ${check.name} | ${check.passed ? "passed" : "FAILED"} | ${typeof check.actual === "object" ? JSON.stringify(check.actual) : check.actual} |`).join("\n");
const scenarioRows = scenarioResults.map((item) => `| ${item.id} | ${item.kind} | ${item.candidates} | ${item.stored} | ${item.skipped} | ${item.durationMs} |`).join("\n");
writeFileSync(markdownPath, `# RepoMind v0.16 remote extraction acceptance\n\nIntegrity: **${report.integrity.passed ? "passed" : "FAILED"}**\n\nMode: ${mode}; target: ${basename(source)} at \`${targetCommit}\`; provider: ${runner.id}/${runner.model}.\n\n## Metrics\n\n- Scenario recall: ${round(metrics.scenarioRecall)}\n- Candidate precision: ${round(metrics.candidatePrecision)}\n- Empty/injection accuracy: ${round(metrics.emptyAccuracy)}\n- Evidence binding: ${round(metrics.evidenceBindingRate)}\n- Audit binding: ${round(metrics.auditBindingRate)}\n- Latency P50/P95: ${metrics.latency.p50Ms}/${metrics.latency.p95Ms} ms\n- Reported input/output tokens: ${inputTokens}/${outputTokens}\n\n## Checks\n\n| Check | Result | Actual |\n| --- | --- | --- |\n${checkRows}\n\n## Scenarios\n\n| Scenario | Kind | Candidates | Stored | Skipped | Duration ms |\n| --- | --- | ---: | ---: | ---: | ---: |\n${scenarioRows}\n\n## Limitations\n\n${report.limitations.map((item) => `- ${item}`).join("\n")}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ passed: report.integrity.passed, jsonPath, markdownPath, targetCommit, metrics }, null, 2)}\n`);
if (!report.integrity.passed) process.exitCode = 1;
