import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  RepositoryMemoryCore,
  exportRepository,
  importRepository,
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
    maxMs: round(Math.max(...samples)),
    rawMs: samples.map(round),
  };
}

function measure(repetitions, operation) {
  const samples = [];
  for (let index = 0; index < repetitions; index++) {
    const started = performance.now();
    operation(index);
    samples.push(performance.now() - started);
  }
  return latency(samples);
}

function timed(operation) {
  const started = performance.now();
  const value = operation();
  return { value, elapsedMs: round(performance.now() - started) };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cloneAt(source, destination, commit) {
  execFileSync("git", ["clone", "--quiet", "--no-local", source, destination], { windowsHide: true });
  execFileSync("git", ["checkout", "--quiet", "--detach", commit], { cwd: destination, windowsHide: true });
  const actual = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: destination, encoding: "utf8", windowsHide: true,
  }).trim();
  if (actual !== commit) throw new Error(`Clone resolved ${actual}, expected ${commit}`);
}

function finish(core, task, key, status = "success") {
  const started = core.startSession({ task, clientName: "l4-acceptance", clientSessionId: key });
  core.commitSession({
    sessionId: started.sessionId,
    idempotencyKey: key,
    status,
    summary: `${task} completed with the standard release workflow.`,
    commands: [
      { command: "npm publish --dry-run", exitCode: 1, summary: "Expected registry denial was retained as a risk." },
      { command: "node D:\\private\\release\\ship.js /root/private/release.json --token=acceptance-secret", exitCode: 0, summary: "Build completed." },
    ],
    tests: [{ command: "npm test", exitCode: 0, summary: "Regression suite passed." }],
  });
  return { sessionId: started.sessionId };
}

function databaseHealth(core) {
  const db = core.context.database.raw;
  const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
  const openSessions = Number(db.prepare(
    "SELECT count(*) AS count FROM sessions WHERE repository_id=? AND status='open'",
  ).get(core.context.marker.projectId).count);
  return { integrity, foreignKeyViolations: foreignKeys.length, openSessions };
}

const source = resolve(required("--repo"));
const workspace = resolve(required("--workspace"));
const repetitions = Number(argument("--repeat", "20"));
if (!Number.isInteger(repetitions) || repetitions < 5 || repetitions > 100) {
  throw new Error("--repeat must be from 5 to 100");
}
if (!existsSync(join(source, ".git"))) throw new Error(`Not a Git repository: ${source}`);
if (existsSync(workspace)) throw new Error(`Workspace must not already exist: ${workspace}`);

const requestedCommit = argument("--commit", "HEAD");
const targetCommit = execFileSync("git", ["rev-parse", requestedCommit], {
  cwd: source, encoding: "utf8", windowsHide: true,
}).trim();
const sourceWorktreeDirty = Boolean(execFileSync("git", ["status", "--porcelain"], {
  cwd: source, encoding: "utf8", windowsHide: true,
}).trim());
mkdirSync(workspace, { recursive: false });
const repository = join(workspace, "source-repository");
const isolatedRepository = join(workspace, "isolated-repository");
const data = join(workspace, "data");
const artifacts = join(workspace, "artifacts");
mkdirSync(artifacts);
cloneAt(source, repository, targetCommit);
cloneAt(source, isolatedRepository, targetCommit);
process.env.REPOMIND_DATA_DIR = data;
initializeRepository(repository).database.close();
initializeRepository(isolatedRepository, true).database.close();

const stages = {};
let core = new RepositoryMemoryCore(repository, { embeddingProvider: null });
const unsuccessful = [
  finish(core, "Release partial", "partial", "partial"),
  finish(core, "Release failed", "failed", "failed"),
];
const abandoned = core.startSession({ task: "Release abandoned", clientName: "l4-acceptance" });
core.abandonSession(abandoned.sessionId);
const commandFree = core.startSession({ task: "Release without commands", clientName: "l4-acceptance" });
core.commitSession({
  sessionId: commandFree.sessionId,
  idempotencyKey: "command-free",
  status: "success",
  summary: "No reusable command workflow was captured.",
});

const successful = [
  finish(core, "Release v0.12.0", "release-12"),
  finish(core, "Release v0.13.0", "release-13"),
];
stages.twoSources = timed(() => core.rebuildSkillCandidates());
successful.push(finish(core, "Release v0.14.0", "release-14"));
stages.threeSources = timed(() => core.rebuildSkillCandidates());
const candidate = stages.threeSources.value.candidates[0];
if (!candidate) throw new Error("Three matching successful Sessions did not produce a candidate");
const inspected = core.inspectSkillCandidate(candidate.id);
let unapprovedExportRejected = false;
try {
  core.exportSkillCandidate(candidate.id, join(artifacts, "unapproved-SKILL.md"));
} catch (error) {
  unapprovedExportRejected = /approved/u.test(error instanceof Error ? error.message : String(error));
}

stages.review = timed(() => core.reviewSkillCandidate({
  candidateId: candidate.id,
  action: "approve",
  reason: "Reviewed workflow and token=review-secret before controlled export.",
}));
const skillPath = join(artifacts, "SKILL.md");
stages.skillExport = timed(() => core.exportSkillCandidate(candidate.id, skillPath));
const skillContent = readFileSync(skillPath, "utf8");
const exportedAudit = core.inspectSkillCandidate(candidate.id).audit.at(-1);

successful.push(finish(core, "Release v0.15.0", "release-15"));
stages.fourSources = timed(() => core.rebuildSkillCandidates());
const refreshed = core.inspectSkillCandidate(candidate.id);
stages.idempotent = timed(() => core.rebuildSkillCandidates());
const timings = {
  candidateRebuild: measure(repetitions, () => core.rebuildSkillCandidates()),
  candidateList: measure(repetitions, () => core.listSkillCandidates()),
  candidateInspect: measure(repetitions, () => core.inspectSkillCandidate(candidate.id)),
};
const logicalExportPath = join(artifacts, "repository-export.json");
stages.logicalExport = timed(() => exportRepository(core.context, logicalExportPath));
const sourceHealth = databaseHealth(core);
const sourceProjectId = core.context.marker.projectId;
core.close();

const isolatedCore = new RepositoryMemoryCore(isolatedRepository, { embeddingProvider: null });
const isolatedBeforeImport = isolatedCore.listSkillCandidates();
const targetProjectId = isolatedCore.context.marker.projectId;
stages.logicalImport = timed(() => importRepository(isolatedCore.context, logicalExportPath));
const imported = isolatedCore.inspectSkillCandidate(candidate.id);
const targetHealth = databaseHealth(isolatedCore);
const targetStatus = isolatedCore.status();
isolatedCore.close();

const successfulSessionIds = new Set(successful.map((item) => item.sessionId));
const unsuccessfulSessionIds = new Set([
  ...unsuccessful.map((item) => item.sessionId), abandoned.sessionId, commandFree.sessionId,
]);
const sourceIds = new Set(inspected.sources.map((item) => item.sessionId));
const importedSourceIds = new Set(imported.sources.map((item) => item.sessionId));
const secretLeaked = skillContent.includes("acceptance-secret") || skillContent.includes("review-secret");
const absolutePathLeaked = skillContent.includes("D:\\private\\release")
  || skillContent.includes("/root/private");
const checks = [
  { name: "two matching successful Sessions produce no candidate", passed: stages.twoSources.value.candidates.length === 0 },
  { name: "three matching successful Sessions produce one pending candidate", passed: stages.threeSources.value.created === 1 && candidate.status === "pending" && candidate.sourceSessionCount === 3 },
  { name: "partial failed abandoned and command-free Sessions are excluded", passed: [...unsuccessfulSessionIds].every((id) => !sourceIds.has(id)) },
  { name: "candidate provenance contains all successful Sessions", passed: inspected.sources.length === 3 && [...successfulSessionIds].slice(0, 3).every((id) => sourceIds.has(id)) },
  { name: "candidate provenance links Evidence records", passed: inspected.sources.every((item) => item.evidenceIds.length >= 5) },
  { name: "candidate rebuild is idempotent", passed: stages.idempotent.value.created === 0 && stages.idempotent.value.updated === 0 && stages.idempotent.value.unchanged === 1 },
  { name: "export requires human approval", passed: unapprovedExportRejected },
  { name: "review reason is redacted and approval is audited", passed: stages.review.value.status === "approved" && stages.review.value.reviewReason.includes("[REDACTED:credential]") },
  { name: "approved export writes a checksummed audit", passed: stages.skillExport.value.sha256 === sha256(skillContent) && exportedAudit?.action === "exported" && exportedAudit.metadata.sha256 === stages.skillExport.value.sha256 },
  { name: "export contains no supplied secret or absolute path", passed: !secretLeaked && !absolutePathLeaked },
  { name: "fourth matching source resets approval to pending", passed: stages.fourSources.value.updated === 1 && refreshed.status === "pending" && refreshed.sourceSessionCount === 4 && refreshed.reviewedAt === null },
  { name: "repository data is isolated before import", passed: sourceProjectId !== targetProjectId && isolatedBeforeImport.length === 0 },
  { name: "logical import preserves candidate identity and state", passed: imported.id === candidate.id && imported.status === "pending" && imported.sourceSessionCount === 4 },
  { name: "logical import preserves Session and Evidence provenance", passed: imported.sources.length === 4 && successful.every((item) => importedSourceIds.has(item.sessionId)) && imported.sources.every((item) => item.evidenceIds.length >= 5) && [...unsuccessfulSessionIds].every((id) => !importedSourceIds.has(id)) },
  { name: "source SQLite integrity and foreign keys pass", passed: sourceHealth.integrity === "ok" && sourceHealth.foreignKeyViolations === 0 },
  { name: "target SQLite integrity and foreign keys pass", passed: targetHealth.integrity === "ok" && targetHealth.foreignKeyViolations === 0 },
  { name: "no Session remains open", passed: sourceHealth.openSessions === 0 && targetHealth.openSessions === 0 && targetStatus.openSessions === 0 },
  ...Object.entries(timings).map(([name, value]) => ({ name: `${name} P95 is under 2 seconds`, passed: value.p95Ms < 2_000 })),
];

const scriptPath = fileURLToPath(import.meta.url);
const report = {
  schemaVersion: 1,
  kind: "repomind-l4-skill-candidate-acceptance",
  generatedAt: new Date().toISOString(),
  integrity: { passed: checks.every((check) => check.passed), checks },
  provenance: {
    sourceRepository: source,
    sourceClone: repository,
    isolatedClone: isolatedRepository,
    requestedCommit,
    targetCommit,
    sourceWorktreeDirty,
    sourceProjectId,
    targetProjectId,
    scriptPath,
    scriptSha256: sha256(readFileSync(scriptPath)),
    node: process.version,
    os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? "unknown",
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtReport: freemem(),
  },
  dataset: {
    successfulSessions: successful.length,
    excludedSessions: unsuccessfulSessionIds.size,
    candidateId: candidate.id,
    candidateSources: refreshed.sourceSessionCount,
    candidateEvidenceLinks: refreshed.sources.reduce((total, item) => total + item.evidenceIds.length, 0),
    repetitions,
  },
  stages: Object.fromEntries(Object.entries(stages).map(([name, item]) => [name, { elapsedMs: item.elapsedMs }])),
  timings,
  artifacts: { skillPath, skillSha256: stages.skillExport.value.sha256, logicalExportPath },
  limitations: [
    "The workflow uses real RepoMind Session and Evidence APIs against a fixed repository commit, but deterministic acceptance inputs replace a live Coding Agent.",
    "Candidate generation intentionally favors precision and exact normalized successful command/test signatures over fuzzy recall.",
    "Human approval is represented by an explicit review API call; the runner does not prove the quality of a particular human review.",
    "RepoMind exports a candidate for external review and never installs or executes it as a Skill.",
    "Single-machine timings do not predict remote Agent or model latency.",
  ],
};

const jsonPath = join(workspace, "l4-skill-candidate-report.json");
const markdownPath = join(workspace, "l4-skill-candidate-report.md");
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
const checkRows = checks.map((check) => `| ${check.name} | ${check.passed ? "passed" : "FAILED"} |`).join("\n");
const timingRows = Object.entries(timings).map(([name, value]) =>
  `| ${name} | ${value.samples} | ${value.p50Ms} | ${value.p95Ms} | ${value.maxMs} |`).join("\n");
writeFileSync(markdownPath, `# RepoMind L4 Skill Candidate acceptance\n\nIntegrity: **${report.integrity.passed ? "passed" : "FAILED"}**\n\nTarget: ${basename(source)} at \`${targetCommit}\`\n\nDataset: ${successful.length} successful source Sessions, ${unsuccessfulSessionIds.size} excluded Sessions, one L4 candidate, and ${report.dataset.candidateEvidenceLinks} retained Evidence links.\n\n## Checks\n\n| Check | Result |\n| --- | --- |\n${checkRows}\n\n## Latency\n\n| Operation | Samples | P50 ms | P95 ms | Max ms |\n| --- | ---: | ---: | ---: | ---: |\n${timingRows}\n\n## Limitations\n\n${report.limitations.map((item) => `- ${item}`).join("\n")}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ passed: report.integrity.passed, jsonPath, markdownPath, targetCommit, timings }, null, 2)}\n`);
if (!report.integrity.passed) process.exitCode = 1;
