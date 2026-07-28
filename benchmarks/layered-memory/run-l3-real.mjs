import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { RepositoryMemoryCore } from "../../dist/index.js";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function required(name) {
  const value = argument(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function latency(samples) {
  const round = (value) => Math.round(value * 1000) / 1000;
  return {
    samples: samples.length,
    p50Ms: round(percentile(samples, 0.5)),
    p95Ms: round(percentile(samples, 0.95)),
    maxMs: round(Math.max(...samples)),
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const source = resolve(required("--repo"));
const workspace = resolve(required("--workspace"));
const repetitions = Number(argument("--repeat", "30"));
if (!Number.isInteger(repetitions) || repetitions < 5 || repetitions > 200) throw new Error("--repeat must be from 5 to 200");
if (!existsSync(join(source, ".git"))) throw new Error(`Not a Git repository: ${source}`);
if (existsSync(workspace)) throw new Error(`Workspace must not already exist: ${workspace}`);

mkdirSync(workspace, { recursive: false });
const repository = join(workspace, "repository");
const data = join(workspace, "data");
execFileSync("git", ["clone", "--quiet", "--no-local", source, repository], { windowsHide: true });
const targetCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8", windowsHide: true }).trim();
const targetStatus = execFileSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8", windowsHide: true }).trim();
if (targetStatus) throw new Error("Cloned target repository is not clean");

const manifestPath = resolve("benchmarks/layered-memory/repomind-l2-manifest.json");
const manifestRaw = readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(manifestRaw);
for (const memory of manifest.memories) {
  for (const file of memory.relatedFiles) {
    if (!existsSync(join(repository, file))) throw new Error(`Manifest file does not exist at ${targetCommit}: ${file}`);
  }
}

process.env.REPOMIND_DATA_DIR = data;
const core = new RepositoryMemoryCore(repository, { embeddingProvider: null });
try {
  const moduleMemories = manifest.memories.map((memory) => core.record(memory));
  const l2 = core.rebuildModuleNarratives({ maxChars: manifest.budgetChars });
  const repositoryMemories = [
    core.record({
      type: "dependency",
      title: "Supported Node runtime",
      content: "RepoMind requires Node.js 22.5.0 or newer and stores repository state in local SQLite.",
      confidence: 0.95,
      relatedFiles: ["package.json", "src/storage/database.ts"],
    }),
    core.record({
      type: "command",
      title: "Release verification",
      content: "Run npm run typecheck, npm run build, and npm test before release.",
      confidence: 0.98,
      relatedFiles: ["package.json", ".github/workflows/ci.yml"],
    }),
    core.record({
      type: "decision",
      title: "Evidence-backed local memory",
      content: "Durable conclusions remain repository-scoped, local-first, and traceable to captured Evidence.",
      confidence: 0.95,
      relatedFiles: ["README.md", "docs/architecture.md"],
    }),
  ];

  const first = core.rebuildRepositoryProfile({ maxChars: 6_000, minConfidence: 0.8 });
  const inspected = core.inspectRepositoryProfile();
  const repeated = core.rebuildRepositoryProfile({ maxChars: 6_000, minConfidence: 0.8 });

  core.record({
    type: "risk",
    title: "Speculative release risk",
    content: "A single unverified task suspects a release concern.",
    confidence: 0.4,
    relatedFiles: ["CHANGELOG.md"],
  });
  core.record({
    type: "risk",
    title: "Speculative storage risk",
    content: "A single unverified task suspects a storage concern.",
    scopeType: "module",
    scopeValue: "src/storage",
    confidence: 0.4,
    relatedFiles: ["src/storage/database.ts"],
  });
  core.rebuildModuleNarratives({ modules: ["src/storage"], maxChars: manifest.budgetChars });
  const afterLowConfidence = core.getRepositoryProfile();
  const lowConfidenceRebuild = core.rebuildRepositoryProfile({ maxChars: 6_000, minConfidence: 0.8 });

  core.record({
    type: "requirement",
    title: "Migration compatibility requirement",
    content: "Every released schema must upgrade to the current schema in automated tests.",
    confidence: 0.95,
    relatedFiles: ["src/storage/migrations.ts", "tests/migration.test.ts"],
  });
  const stale = core.getRepositoryProfile();
  const staleSession = core.startSession({ task: "Prepare a storage migration release" });
  const staleProfileInjected = staleSession.repositoryProfile !== undefined;
  core.abandonSession(staleSession.sessionId);
  const updated = core.rebuildRepositoryProfile({ maxChars: 6_000, minConfidence: 0.8 });
  const finalProfile = core.inspectRepositoryProfile();
  const currentSession = core.startSession({ task: "Prepare a storage migration release" });
  const currentProfileInjected = currentSession.repositoryProfile?.current === true;
  core.abandonSession(currentSession.sessionId);

  for (let index = 0; index < 5; index++) {
    core.getRepositoryProfile();
    core.inspectRepositoryProfile();
    core.rebuildRepositoryProfile({ maxChars: 6_000, minConfidence: 0.8 });
  }
  const timings = {
    rebuildUnchanged: measure(repetitions, () => core.rebuildRepositoryProfile({ maxChars: 6_000, minConfidence: 0.8 })),
    get: measure(repetitions, () => core.getRepositoryProfile()),
    inspect: measure(repetitions, () => core.inspectRepositoryProfile()),
    sessionStart: measure(Math.min(repetitions, 30), (index) => {
      const started = core.startSession({ task: manifest.queries[index % manifest.queries.length] });
      core.abandonSession(started.sessionId);
    }),
  };

  const checks = [
    { name: "all reviewed L1 inputs stored", passed: [...moduleMemories, ...repositoryMemories].every((item) => item.stored) },
    { name: "real L2 module boundaries generated", passed: l2.narratives.length >= 6 },
    { name: "bounded current L3 profile created", passed: first.created && first.profile.current && first.profile.content.length <= 6_000 },
    { name: "L3 has repository L1 and L2 sources", passed: inspected.memorySources.length === repositoryMemories.length && inspected.moduleSources.length >= 6 },
    { name: "complete L3 to L1 to Evidence provenance", passed: inspected.memorySources.every((item) => item.evidenceIds.length > 0) && inspected.moduleSources.every((item) => item.memoryIds.length > 0) },
    { name: "unchanged rebuild retains version", passed: repeated.unchanged && repeated.profile.version === 1 },
    { name: "low-confidence L1 and L2 changes do not stale L3", passed: afterLowConfidence?.current === true && lowConfidenceRebuild.unchanged },
    { name: "eligible source change makes L3 stale", passed: stale?.current === false },
    { name: "stale L3 is not injected", passed: !staleProfileInjected },
    { name: "rebuild increments L3 version", passed: updated.updated && updated.profile.version === 2 && finalProfile.versions.length === 2 },
    { name: "current L3 is injected", passed: currentProfileInjected },
    { name: "L3 rebuild p95 under 500ms", passed: timings.rebuildUnchanged.p95Ms < 500 },
    { name: "L3 get p95 under 100ms", passed: timings.get.p95Ms < 100 },
    { name: "L3 inspect p95 under 100ms", passed: timings.inspect.p95Ms < 100 },
    { name: "Session Start with L3 p95 under 1000ms", passed: timings.sessionStart.p95Ms < 1_000 },
  ];
  const report = {
    schemaVersion: 1,
    kind: "repomind-real-repository-l3-acceptance",
    generatedAt: new Date().toISOString(),
    integrity: { passed: checks.every((check) => check.passed), checks },
    provenance: {
      sourceRepository: source,
      targetRepository: repository,
      targetCommit,
      manifest: manifestPath,
      manifestSha256: sha256(manifestRaw),
      node: process.version,
      os: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model ?? "unknown",
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      freeMemoryBytesAtReport: freemem(),
    },
    dataset: {
      manifestModuleMemories: manifest.memories.length,
      repositoryMemories: repositoryMemories.length,
      finalMemories: core.status().memories,
      moduleNarratives: finalProfile.moduleSourceCount,
      profileMemorySources: finalProfile.memorySourceCount,
      profileVersion: finalProfile.version,
      profileBudgetChars: finalProfile.budgetChars,
      minConfidence: finalProfile.minConfidence,
      repetitions,
    },
    rebuild: { first, repeated, afterLowConfidence, lowConfidenceRebuild, stale, updated },
    timings,
    limitations: [
      "This is a fixed-commit acceptance on the real RepoMind repository, not an authored toy fixture.",
      "The seeded L1 facts are reviewed deterministic inputs; the run does not evaluate remote LLM extraction quality.",
      "The corpus is intentionally repository-sized and does not prove the final 10,000-L1 performance target.",
      "Single-machine wall-clock results must not be generalized to other hardware or operating systems.",
    ],
  };
  const jsonPath = join(workspace, "l3-real-report.json");
  const markdownPath = join(workspace, "l3-real-report.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const timingRows = Object.entries(timings).map(([name, value]) => `| ${name} | ${value.samples} | ${value.p50Ms} | ${value.p95Ms} | ${value.maxMs} |`).join("\n");
  const checkRows = checks.map((check) => `| ${check.name} | ${check.passed ? "passed" : "FAILED"} |`).join("\n");
  writeFileSync(markdownPath, `# RepoMind real-repository L3 acceptance\n\nIntegrity: **${report.integrity.passed ? "passed" : "FAILED"}**\n\nTarget: ${basename(source)} at \`${targetCommit}\`\n\nMemories: ${report.dataset.finalMemories}; module sources: ${report.dataset.moduleNarratives}; profile version: ${report.dataset.profileVersion}; budget: ${report.dataset.profileBudgetChars} characters.\n\n## Checks\n\n| Check | Result |\n| --- | --- |\n${checkRows}\n\n## Latency\n\n| Operation | Samples | P50 ms | P95 ms | Max ms |\n| --- | ---: | ---: | ---: | ---: |\n${timingRows}\n\n## Limitations\n\n${report.limitations.map((item) => `- ${item}`).join("\n")}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ passed: report.integrity.passed, jsonPath, markdownPath, targetCommit, timings }, null, 2)}\n`);
  if (!report.integrity.passed) process.exitCode = 1;
} finally {
  core.close();
}
