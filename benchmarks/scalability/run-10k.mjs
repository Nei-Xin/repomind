import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  DeterministicEmbeddingProvider,
  RepositoryMemoryCore,
  initializeRepository,
} from "../../dist/index.js";

const FORMAL_MEMORY_COUNT = 10_000;
const TARGETS = {
  ftsSearchP95Ms: 150,
  hybridSearchP95Ms: 500,
  inspectP95Ms: 100,
  sessionStartP95Ms: 1_000,
  cliColdStartP95Ms: 1_000,
};

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

async function measureAsync(repetitions, operation) {
  const samples = [];
  for (let index = 0; index < repetitions; index++) {
    const started = performance.now();
    await operation(index);
    samples.push(performance.now() - started);
  }
  return latency(samples);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cloneAt(source, destination, commit) {
  execFileSync("git", ["clone", "--quiet", "--no-local", source, destination], { windowsHide: true });
  execFileSync("git", ["checkout", "--quiet", "--detach", commit], { cwd: destination, windowsHide: true });
  const actual = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: destination,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  if (actual !== commit) throw new Error(`Clone resolved ${actual}, expected ${commit}`);
}

function trackedFiles(repository) {
  return execFileSync("git", ["ls-files"], { cwd: repository, encoding: "utf8", windowsHide: true })
    .split(/\r?\n/u)
    .map((file) => file.trim())
    .filter((file) => file && !file.startsWith(".repomind/") && existsSync(join(repository, file)))
    .slice(0, 32);
}

function memorySpec(index, files) {
  const types = [
    "architecture", "convention", "decision", "command", "failure",
    "solution", "dependency", "location", "requirement", "risk",
  ];
  const topics = [
    "SQLite migration rollback", "MCP lifecycle", "hybrid retrieval", "evidence audit",
    "repository portability", "Windows verification", "module narrative", "profile freshness",
  ];
  const modules = ["src/storage", "src/mcp", "src/search", "src/eval", "src/portability"];
  const padded = String(index).padStart(5, "0");
  const repositoryScoped = index % 4 === 0;
  const topic = topics[index % topics.length];
  return {
    type: types[index % types.length],
    title: `Scale memory ${padded}: ${topic}`,
    content: `scaleid${padded} records the reviewed ${topic} behavior for deterministic shard ${index % 97}. `
      + `The repository must preserve Evidence, scope, status, and retrieval isolation at 10,000 L1 records.`,
    confidence: 0.8 + (index % 20) / 100,
    ...(repositoryScoped ? {} : { scopeType: "module", scopeValue: modules[index % modules.length] }),
    tags: ["scale-10k", `topic-${index % topics.length}`, index % 11 === 0 ? "中文检索" : "english"],
    relatedFiles: [files[index % files.length]],
  };
}

function memoryCounts(core) {
  const db = core.context.database.raw;
  const repositoryId = core.context.marker.projectId;
  const scalar = (sql, ...params) => Number(db.prepare(sql).get(...params).count);
  return {
    memories: scalar("SELECT count(*) AS count FROM memories WHERE repository_id=?", repositoryId),
    activeMemories: scalar("SELECT count(*) AS count FROM memories WHERE repository_id=? AND status='active'", repositoryId),
    evidence: scalar("SELECT count(*) AS count FROM evidence WHERE repository_id=?", repositoryId),
    evidenceBackedMemories: scalar(`
      SELECT count(DISTINCT m.id) AS count FROM memories m
      JOIN memory_evidence me ON me.memory_id=m.id WHERE m.repository_id=?
    `, repositoryId),
    memoryEvidenceLinks: scalar(`
      SELECT count(*) AS count FROM memory_evidence me
      JOIN memories m ON m.id=me.memory_id WHERE m.repository_id=?
    `, repositoryId),
    fileLinks: scalar(`
      SELECT count(*) AS count FROM memory_files mf
      JOIN memories m ON m.id=mf.memory_id WHERE m.repository_id=?
    `, repositoryId),
    auditEntries: scalar(`
      SELECT count(*) AS count FROM memory_audit_log ma
      JOIN memories m ON m.id=ma.memory_id WHERE m.repository_id=?
    `, repositoryId),
    ftsRows: scalar("SELECT count(*) AS count FROM memory_fts WHERE repository_id=?", repositoryId),
    embeddings: scalar("SELECT count(*) AS count FROM memory_embeddings WHERE repository_id=?", repositoryId),
    memoryTypes: scalar("SELECT count(DISTINCT type) AS count FROM memories WHERE repository_id=?", repositoryId),
    scopeTypes: scalar("SELECT count(DISTINCT scope_type) AS count FROM memories WHERE repository_id=?", repositoryId),
  };
}

function databaseSizes(path) {
  const size = (candidate) => existsSync(candidate) ? statSync(candidate).size : 0;
  return {
    databaseBytes: size(path),
    walBytes: size(`${path}-wal`),
    shmBytes: size(`${path}-shm`),
    totalBytes: size(path) + size(`${path}-wal`) + size(`${path}-shm`),
  };
}

function memorySnapshot() {
  const value = process.memoryUsage();
  return { rssBytes: value.rss, heapUsedBytes: value.heapUsed, externalBytes: value.external };
}

function maxMemory(samples) {
  return {
    rssBytes: Math.max(...samples.map((sample) => sample.rssBytes)),
    heapUsedBytes: Math.max(...samples.map((sample) => sample.heapUsedBytes)),
    externalBytes: Math.max(...samples.map((sample) => sample.externalBytes)),
  };
}

const source = resolve(required("--repo"));
const workspace = resolve(required("--workspace"));
const repetitions = Number(argument("--repeat", "50"));
const mode = process.argv.includes("--smoke") ? "smoke" : "formal";
if (mode === "formal" && process.argv.includes("--count")) {
  throw new Error("--count is available only with --smoke; formal acceptance always uses 10,000 L1 records");
}
const memoryCount = mode === "smoke" ? Number(argument("--count", "100")) : FORMAL_MEMORY_COUNT;
if (!Number.isInteger(memoryCount) || (mode === "smoke" && (memoryCount < 100 || memoryCount > 1_000))) {
  throw new Error("smoke --count must be from 100 to 1,000");
}
if (!Number.isInteger(repetitions) || repetitions < 20 || repetitions > 200) {
  throw new Error("--repeat must be from 20 to 200");
}
if (!existsSync(join(source, ".git"))) throw new Error(`Not a Git repository: ${source}`);
if (existsSync(workspace)) throw new Error(`Workspace must not already exist: ${workspace}`);

const requestedCommit = argument("--commit", "HEAD");
const targetCommit = execFileSync("git", ["rev-parse", requestedCommit], {
  cwd: source,
  encoding: "utf8",
  windowsHide: true,
}).trim();
const repoMindCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: source,
  encoding: "utf8",
  windowsHide: true,
}).trim();
const repoMindDirty = Boolean(execFileSync("git", ["status", "--porcelain"], {
  cwd: source,
  encoding: "utf8",
  windowsHide: true,
}).trim());

mkdirSync(workspace, { recursive: false });
const repository = join(workspace, "repository");
const isolationRepository = join(workspace, "isolation-repository");
const data = join(workspace, "data");
cloneAt(source, repository, targetCommit);
cloneAt(source, isolationRepository, targetCommit);
mkdirSync(data);
process.env.REPOMIND_DATA_DIR = data;

const primaryContext = initializeRepository(repository);
primaryContext.database.close();
const isolationContext = initializeRepository(isolationRepository, true);
isolationContext.database.close();

const files = trackedFiles(repository);
if (!files.length) throw new Error("The fixed-commit repository has no tracked files for file-linked L1 data");

const provider = new DeterministicEmbeddingProvider(64, "scale-feature-hash-v1-64");
const core = new RepositoryMemoryCore(repository, { embeddingProvider: provider });
const memoryIds = [];
const memorySamples = [memorySnapshot()];
const seedStarted = performance.now();
for (let index = 0; index < memoryCount; index++) {
  const result = core.record(memorySpec(index, files));
  if (!result.stored) throw new Error(`Memory ${index} was unexpectedly deduplicated`);
  memoryIds.push(result.id);
  if ((index + 1) % 100 === 0) memorySamples.push(memorySnapshot());
}
const seedMs = performance.now() - seedStarted;
const countsAfterSeed = memoryCounts(core);

const vectorStarted = performance.now();
const vectorIndex = await core.reindexVectors();
const vectorIndexMs = performance.now() - vectorStarted;
memorySamples.push(memorySnapshot());

const queryAt = (iteration) => {
  const index = (iteration * 499) % memoryCount;
  return { index, query: `scaleid${String(index).padStart(5, "0")}`, memoryId: memoryIds[index] };
};

core.search(queryAt(0).query, { limit: 1 });
core.inspect(queryAt(0).memoryId);
await core.searchHybrid(queryAt(0).query, { limit: 5 });
const warmSession = core.startSession({ task: queryAt(0).query, maxMemories: 5, includeRepositoryProfile: false });
core.abandonSession(warmSession.sessionId);

const ftsMisses = [];
const timings = {};
timings.ftsSearch = measure(repetitions, (iteration) => {
  const expected = queryAt(iteration);
  const results = core.search(expected.query, { limit: 1 });
  if (!results.some((result) => result.id === expected.memoryId)) ftsMisses.push(expected.index);
});
timings.ftsNoResult = measure(repetitions, (iteration) => {
  const results = core.search(`absent-scale-memory-${iteration}`, { limit: 5 });
  if (results.length) throw new Error("A no-result query returned an unrelated memory");
});
timings.inspect = measure(repetitions, (iteration) => {
  const expected = queryAt(iteration);
  const inspected = core.inspect(expected.memoryId);
  if (inspected.id !== expected.memoryId || inspected.evidence.length < 1) {
    throw new Error(`Inspect lost identity or Evidence for ${expected.memoryId}`);
  }
});

const expensiveRepetitions = Math.min(repetitions, 20);
const hybridMisses = [];
timings.hybridSearchCached = await measureAsync(expensiveRepetitions, async (iteration) => {
  const expected = queryAt(iteration);
  const result = await core.searchHybrid(expected.query, { limit: 5 });
  if (result.strategy !== "hybrid-fts5-vector" || !result.memories.some((memory) => memory.id === expected.memoryId)) {
    hybridMisses.push(expected.index);
  }
});
timings.sessionStart = measure(expensiveRepetitions, (iteration) => {
  const expected = queryAt(iteration);
  const started = core.startSession({
    task: `${expected.query} verify repository behavior`,
    maxMemories: 5,
    includeRepositoryProfile: false,
    clientName: "scale-acceptance",
  });
  if (!started.memories.some((memory) => memory.id === expected.memoryId)) {
    throw new Error(`Session Start did not recall ${expected.memoryId}`);
  }
  core.abandonSession(started.sessionId);
});
memorySamples.push(memorySnapshot());

const isolationCore = new RepositoryMemoryCore(isolationRepository, { embeddingProvider: null });
const sentinel = isolationCore.record({
  type: "solution",
  title: "Isolation sentinel",
  content: "isolationonlysentinel must never appear in the 10,000-L1 repository.",
});
const isolationOwnResult = isolationCore.search("isolationonlysentinel", { limit: 5 });
const primaryLeakResult = core.search("isolationonlysentinel", { limit: 5 });
const isolationLeakResult = isolationCore.search(queryAt(17).query, { limit: 5 });
isolationCore.close();

const cliPath = resolve("dist/cli/index.js");
const cliEnvironment = { ...process.env, REPOMIND_DATA_DIR: data };
timings.cliColdStart = measure(expensiveRepetitions, () => {
  const stdout = execFileSync(process.execPath, [cliPath, "status", "--repo", repository, "--json"], {
    cwd: source,
    encoding: "utf8",
    env: cliEnvironment,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const status = JSON.parse(stdout);
  if (status.memories !== memoryCount) throw new Error(`CLI status reported ${status.memories} memories`);
});

const finalCounts = memoryCounts(core);
const integrityCheck = core.context.database.raw.prepare("PRAGMA integrity_check").get();
const foreignKeyFailures = core.context.database.raw.prepare("PRAGMA foreign_key_check").all();
core.context.database.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const database = databaseSizes(core.context.database.path);
const finalStatus = core.status();
memorySamples.push(memorySnapshot());

const checks = [
  { name: `exactly ${memoryCount.toLocaleString("en-US")} L1 memories stored`, passed: finalCounts.memories === memoryCount, measured: finalCounts.memories, target: memoryCount },
  { name: "every L1 is active", passed: finalCounts.activeMemories === memoryCount, measured: finalCounts.activeMemories, target: memoryCount },
  { name: "every L1 has Evidence", passed: finalCounts.evidenceBackedMemories === memoryCount, measured: finalCounts.evidenceBackedMemories, target: memoryCount },
  { name: "every L1 has a file link and audit entry", passed: finalCounts.fileLinks === memoryCount && finalCounts.auditEntries >= memoryCount, measured: `${finalCounts.fileLinks}/${finalCounts.auditEntries}`, target: `${memoryCount}/${memoryCount}` },
  { name: "FTS contains every L1", passed: finalCounts.ftsRows === memoryCount, measured: finalCounts.ftsRows, target: memoryCount },
  { name: "vector cache contains every L1", passed: finalCounts.embeddings === memoryCount && vectorIndex.total === memoryCount, measured: finalCounts.embeddings, target: memoryCount },
  { name: "all public memory types are represented", passed: finalCounts.memoryTypes === 10, measured: finalCounts.memoryTypes, target: 10 },
  { name: "repository and module scopes are represented", passed: finalCounts.scopeTypes === 2, measured: finalCounts.scopeTypes, target: 2 },
  { name: "FTS sampled recall is exact", passed: ftsMisses.length === 0, measured: ftsMisses.length, target: 0 },
  { name: "cached hybrid sampled recall is exact", passed: hybridMisses.length === 0, measured: hybridMisses.length, target: 0 },
  { name: "repository isolation has no cross-project recall", passed: isolationOwnResult.some((item) => item.id === sentinel.id) && primaryLeakResult.length === 0 && isolationLeakResult.length === 0, measured: `${primaryLeakResult.length}/${isolationLeakResult.length}`, target: "0/0" },
  { name: "SQLite integrity and foreign keys pass", passed: integrityCheck.integrity_check === "ok" && foreignKeyFailures.length === 0, measured: `${integrityCheck.integrity_check}/${foreignKeyFailures.length}`, target: "ok/0" },
  { name: "no open Sessions remain", passed: finalStatus.openSessions === 0, measured: finalStatus.openSessions, target: 0 },
  { name: "FTS P95 is below 150 ms", passed: timings.ftsSearch.p95Ms < TARGETS.ftsSearchP95Ms, measured: timings.ftsSearch.p95Ms, target: `<${TARGETS.ftsSearchP95Ms}` },
  { name: "FTS no-result P95 is below 150 ms", passed: timings.ftsNoResult.p95Ms < TARGETS.ftsSearchP95Ms, measured: timings.ftsNoResult.p95Ms, target: `<${TARGETS.ftsSearchP95Ms}` },
  { name: "cached hybrid P95 is below 500 ms", passed: timings.hybridSearchCached.p95Ms < TARGETS.hybridSearchP95Ms, measured: timings.hybridSearchCached.p95Ms, target: `<${TARGETS.hybridSearchP95Ms}` },
  { name: "Inspect P95 is below 100 ms", passed: timings.inspect.p95Ms < TARGETS.inspectP95Ms, measured: timings.inspect.p95Ms, target: `<${TARGETS.inspectP95Ms}` },
  { name: "Session Start P95 is below 1 second", passed: timings.sessionStart.p95Ms < TARGETS.sessionStartP95Ms, measured: timings.sessionStart.p95Ms, target: `<${TARGETS.sessionStartP95Ms}` },
  { name: "CLI cold start P95 is below 1 second", passed: timings.cliColdStart.p95Ms < TARGETS.cliColdStartP95Ms, measured: timings.cliColdStart.p95Ms, target: `<${TARGETS.cliColdStartP95Ms}` },
];

const scriptPath = new URL(import.meta.url);
const report = {
  schemaVersion: 1,
  kind: mode === "formal" ? "repomind-10k-l1-scale-acceptance" : "repomind-scale-runner-smoke",
  generatedAt: new Date().toISOString(),
  integrity: { passed: checks.every((check) => check.passed), checks },
  provenance: {
    repoMindCommit,
    repoMindWorktreeDirty: repoMindDirty,
    targetCommit,
    scriptSha256: sha256(readFileSync(scriptPath)),
    node: process.version,
    os: { platform: platform(), release: release(), arch: process.arch },
    cpu: { model: cpus()[0]?.model ?? "unknown", logicalCpus: cpus().length },
    memory: { totalBytes: totalmem(), freeBytesAfterRun: freemem() },
  },
  configuration: {
    mode,
    formalScaleTargetEvaluated: mode === "formal",
    memories: memoryCount,
    repetitions,
    expensiveRepetitions,
    embedding: { provider: provider.id, model: provider.model, dimensions: provider.dimensions, remote: provider.remote },
    targets: TARGETS,
    trackedFiles: files,
    generatorSha256: sha256(JSON.stringify({ memoryCount, files, version: 1 })),
  },
  dataset: {
    countsAfterSeed,
    finalCounts,
    seed: { totalMs: round(seedMs), memoriesPerSecond: round(memoryCount / (seedMs / 1_000)) },
    vectorIndex: { ...vectorIndex, totalMs: round(vectorIndexMs) },
    database,
    observedProcessMemoryHighWater: maxMemory(memorySamples),
  },
  timings,
  limitations: [
    "The 10,000 L1 records are deterministic synthetic scale data attached to a fixed real-repository checkout; they do not prove memory extraction quality.",
    "The offline deterministic embedding provider measures cached local hybrid retrieval and has no remote latency or cost.",
    "CLI cold start creates a new Node.js process for every sample, but operating-system file and database page caches remain warm.",
    "Single-machine wall-clock results must not be generalized to other hardware or operating systems.",
    "This runner measures repository memory operations, not downstream Coding Agent task-success improvement.",
  ],
};

const jsonPath = join(workspace, "scale-10k-report.json");
const markdownPath = join(workspace, "scale-10k-report.md");
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
const checkRows = checks.map((check) => `| ${check.name} | ${check.passed ? "passed" : "FAILED"} | ${check.measured} | ${check.target} |`).join("\n");
const timingRows = Object.entries(timings).map(([name, value]) => `| ${name} | ${value.samples} | ${value.p50Ms} | ${value.p95Ms} | ${value.maxMs} |`).join("\n");
writeFileSync(markdownPath, `# RepoMind 10,000-L1 scale acceptance\n\nIntegrity: **${report.integrity.passed ? "passed" : "FAILED"}**\n\nTarget: ${basename(source)} at \`${targetCommit}\`\n\n## Dataset\n\n- L1 memories: ${finalCounts.memories}\n- Evidence-backed L1: ${finalCounts.evidenceBackedMemories}\n- File links: ${finalCounts.fileLinks}\n- Cached embeddings: ${finalCounts.embeddings}\n- Seed throughput: ${report.dataset.seed.memoriesPerSecond} memories/second\n- Database plus WAL/SHM: ${database.totalBytes} bytes\n- Observed RSS high-water: ${report.dataset.observedProcessMemoryHighWater.rssBytes} bytes\n\n## Checks\n\n| Check | Result | Measured | Target |\n| --- | --- | ---: | --- |\n${checkRows}\n\n## Latency\n\n| Operation | Samples | P50 ms | P95 ms | Max ms |\n| --- | ---: | ---: | ---: | ---: |\n${timingRows}\n\n## Limitations\n\n${report.limitations.map((item) => `- ${item}`).join("\n")}\n`, "utf8");

core.close();
process.stdout.write(`${JSON.stringify({
  passed: report.integrity.passed,
  jsonPath,
  markdownPath,
  targetCommit,
  seed: report.dataset.seed,
  timings,
}, null, 2)}\n`);
if (!report.integrity.passed) process.exitCode = 1;
