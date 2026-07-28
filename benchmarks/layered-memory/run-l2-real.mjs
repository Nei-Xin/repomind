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
  const recorded = manifest.memories.map((memory) => core.record(memory));
  const first = core.rebuildModuleNarratives({ maxChars: manifest.budgetChars });
  const listed = core.listModuleNarratives();
  const inspected = listed.map((item) => core.inspectModuleNarrative(item.id));
  const repeat = core.rebuildModuleNarratives({ maxChars: manifest.budgetChars });

  core.record({
    type: "risk",
    title: "Migration rollback verification",
    content: "Storage migration changes must retain a rollback-safe upgrade test for every released schema.",
    scopeType: "module",
    scopeValue: "src/storage",
    confidence: 0.95,
    relatedFiles: ["src/storage/migrations.ts", "tests/migration.test.ts"],
  });
  const beforeTargeted = core.listModuleNarratives();
  const staleModules = beforeTargeted.filter((item) => !item.current).map((item) => item.modulePath);
  const targeted = core.rebuildModuleNarratives({ modules: ["src/storage"], maxChars: manifest.budgetChars });
  const finalNarratives = core.listModuleNarratives();

  for (let index = 0; index < 5; index++) {
    core.listModuleNarratives();
    core.searchModuleNarratives(manifest.queries[index % manifest.queries.length], 2);
    core.inspectModuleNarrative(finalNarratives[index % finalNarratives.length].id);
  }

  const timings = {
    fullRebuildUnchanged: measure(repetitions, () => core.rebuildModuleNarratives({ maxChars: manifest.budgetChars })),
    targetedRebuildUnchanged: measure(repetitions, () => core.rebuildModuleNarratives({ modules: ["src/storage"], maxChars: manifest.budgetChars })),
    list: measure(repetitions, () => core.listModuleNarratives()),
    search: measure(repetitions, (index) => core.searchModuleNarratives(manifest.queries[index % manifest.queries.length], 2)),
    inspect: measure(repetitions, (index) => core.inspectModuleNarrative(finalNarratives[index % finalNarratives.length].id)),
    sessionStart: measure(Math.min(repetitions, 30), (index) => {
      const started = core.startSession({ task: manifest.queries[index % manifest.queries.length] });
      core.abandonSession(started.sessionId);
    }),
  };

  const checks = [
    { name: "all manifest memories stored", passed: recorded.every((item) => item.stored) },
    { name: "multiple real modules generated", passed: first.created >= 6 && listed.length >= 6 },
    { name: "all narratives initially current", passed: listed.every((item) => item.current) },
    { name: "hard content budget", passed: listed.every((item) => item.content.length <= manifest.budgetChars) },
    { name: "L2 to L1 to Evidence provenance", passed: inspected.every((item) => item.sources.length > 0 && item.sources.every((source) => source.evidenceIds.length > 0)) },
    { name: "repeat rebuild unchanged", passed: repeat.unchanged === listed.length && repeat.created === 0 && repeat.updated === 0 },
    { name: "only changed module becomes stale", passed: staleModules.length === 1 && staleModules[0] === "src/storage" },
    { name: "targeted rebuild updates one module", passed: targeted.updated === 1 && targeted.created === 0 },
    { name: "final narratives current", passed: finalNarratives.every((item) => item.current) },
    { name: "L2 search returns relevant storage context", passed: core.searchModuleNarratives("SQLite migration transaction", 2).some((item) => item.modulePath === "src/storage") },
    { name: "L2 full rebuild p95 under 500ms", passed: timings.fullRebuildUnchanged.p95Ms < 500 },
    { name: "L2 search p95 under 100ms", passed: timings.search.p95Ms < 100 },
    { name: "L2 inspect p95 under 100ms", passed: timings.inspect.p95Ms < 100 },
    { name: "Session Start p95 under 1000ms", passed: timings.sessionStart.p95Ms < 1000 },
  ];
  const report = {
    schemaVersion: 1,
    kind: "repomind-real-repository-l2-acceptance",
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
      manifestMemories: manifest.memories.length,
      finalMemories: core.status().memories,
      narratives: finalNarratives.length,
      modules: finalNarratives.map((item) => item.modulePath),
      budgetChars: manifest.budgetChars,
      repetitions,
    },
    rebuild: { first, repeated: repeat, staleModules, targeted },
    timings,
    limitations: [
      "This is a fixed-commit acceptance on the real RepoMind repository, not an authored toy fixture.",
      "The seeded L1 facts are reviewed deterministic inputs; the run does not evaluate remote LLM extraction quality.",
      "The corpus is intentionally repository-sized and does not prove the final 10,000-L1 performance target.",
      "Single-machine wall-clock results must not be generalized to other hardware or operating systems.",
    ],
  };
  const jsonPath = join(workspace, "l2-real-report.json");
  const markdownPath = join(workspace, "l2-real-report.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const timingRows = Object.entries(timings).map(([name, value]) => `| ${name} | ${value.samples} | ${value.p50Ms} | ${value.p95Ms} | ${value.maxMs} |`).join("\n");
  const checkRows = checks.map((check) => `| ${check.name} | ${check.passed ? "passed" : "FAILED"} |`).join("\n");
  writeFileSync(markdownPath, `# RepoMind real-repository L2 acceptance\n\nIntegrity: **${report.integrity.passed ? "passed" : "FAILED"}**\n\nTarget: ${basename(source)} at \`${targetCommit}\`\n\nMemories: ${report.dataset.finalMemories}; narratives: ${report.dataset.narratives}; budget: ${manifest.budgetChars} characters.\n\n## Checks\n\n| Check | Result |\n| --- | --- |\n${checkRows}\n\n## Latency\n\n| Operation | Samples | P50 ms | P95 ms | Max ms |\n| --- | ---: | ---: | ---: | ---: |\n${timingRows}\n\n## Limitations\n\n${report.limitations.map((item) => `- ${item}`).join("\n")}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ passed: report.integrity.passed, jsonPath, markdownPath, targetCommit, timings }, null, 2)}\n`);
  if (!report.integrity.passed) process.exitCode = 1;
} finally {
  core.close();
}
