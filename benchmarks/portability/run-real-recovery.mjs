import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  RepositoryMemoryCore,
  backupManifestPath,
  backupRepository,
  exportRepository,
  importRepository,
  initializeRepository,
  loadBackupManifest,
  loadRepositoryExport,
  restoreRepository,
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

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function latency(samples) {
  const round = (value) => Math.round(value * 1_000) / 1_000;
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cloneAt(source, destination, commit) {
  execFileSync("git", ["clone", "--quiet", "--no-local", source, destination], { windowsHide: true });
  execFileSync("git", ["checkout", "--quiet", "--detach", commit], { cwd: destination, windowsHide: true });
  const actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd: destination, encoding: "utf8", windowsHide: true }).trim();
  if (actual !== commit) throw new Error(`Clone resolved ${actual}, expected ${commit}`);
}

function expectedIds(bundle, table) {
  return bundle.tables[table].map((row) => row.id).filter(Boolean).sort();
}

const source = resolve(required("--repo"));
const workspace = resolve(required("--workspace"));
const repetitions = Number(argument("--repeat", "10"));
if (!Number.isInteger(repetitions) || repetitions < 5 || repetitions > 100) throw new Error("--repeat must be from 5 to 100");
if (!existsSync(join(source, ".git"))) throw new Error(`Not a Git repository: ${source}`);
if (existsSync(workspace)) throw new Error(`Workspace must not already exist: ${workspace}`);

const requestedCommit = argument("--commit", "HEAD");
const targetCommit = execFileSync("git", ["rev-parse", requestedCommit], {
  cwd: source, encoding: "utf8", windowsHide: true,
}).trim();
mkdirSync(workspace, { recursive: false });
const sourceRepository = join(workspace, "source-repository");
const targetRepository = join(workspace, "logical-import-target");
const data = join(workspace, "data");
const artifacts = join(workspace, "artifacts");
mkdirSync(artifacts);
cloneAt(source, sourceRepository, targetCommit);
cloneAt(source, targetRepository, targetCommit);

const manifestPath = resolve("benchmarks/layered-memory/repomind-l2-manifest.json");
const manifestRaw = readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(manifestRaw);
for (const memory of manifest.memories) {
  for (const file of memory.relatedFiles) {
    if (!existsSync(join(sourceRepository, file))) throw new Error(`Manifest file does not exist at ${targetCommit}: ${file}`);
  }
}

process.env.REPOMIND_DATA_DIR = data;
const sourceContext = initializeRepository(sourceRepository);
sourceContext.database.close();
const targetContext = initializeRepository(targetRepository, true);
targetContext.database.close();

let sourceCore = new RepositoryMemoryCore(sourceRepository, { embeddingProvider: null });
const moduleMemories = manifest.memories.map((memory) => sourceCore.record(memory));
const repositoryMemories = [
  sourceCore.record({
    type: "decision",
    title: "Repository portability boundary",
    content: "Use logical export for a different Project ID and physical backup for exact same-project recovery.",
    confidence: 0.98,
    relatedFiles: ["src/portability/repository-data.ts", "docs/data-portability.md"],
  }),
  sourceCore.record({
    type: "command",
    title: "Release verification",
    content: "Run typecheck, build, tests, coverage, and real acceptance before release.",
    confidence: 0.98,
    relatedFiles: ["package.json", ".github/workflows/ci.yml"],
  }),
];
sourceCore.rebuildModuleNarratives({ maxChars: manifest.budgetChars });
sourceCore.rebuildRepositoryProfile({ maxChars: 6_000, minConfidence: 0.8 });

const baselineExport = join(artifacts, "repository-export.json");
const exportResult = exportRepository(sourceCore.context, baselineExport);
const exportBundle = loadRepositoryExport(baselineExport);
const timings = {};
timings.logicalExport = measure(repetitions, (index) => {
  exportRepository(sourceCore.context, join(artifacts, `measured-export-${index}.json`));
});

const baselineBackup = join(artifacts, "repository-backup.db");
const backupResult = backupRepository(sourceCore.context, baselineBackup);
const backupManifest = loadBackupManifest(baselineBackup);
timings.physicalBackup = measure(repetitions, (index) => {
  backupRepository(sourceCore.context, join(artifacts, `measured-backup-${index}.db`));
});
sourceCore.close();

let targetCore = new RepositoryMemoryCore(targetRepository, { embeddingProvider: null });
const replaced = targetCore.record({
  type: "risk", title: "Target-only record", content: "Confirmed replacement must remove this record.",
});
timings.logicalImportDryRun = measure(repetitions, () => {
  importRepository(targetCore.context, baselineExport, { dryRun: true });
});
timings.logicalImportConfirmed = measure(repetitions, () => {
  importRepository(targetCore.context, baselineExport);
});
const importedStatus = targetCore.status();
const importedSearch = targetCore.search("different Project ID physical backup", 10);
const importedProfile = targetCore.inspectRepositoryProfile();
const importedMemoryIds = targetCore.context.database.raw
  .prepare("SELECT id FROM memories WHERE repository_id=? ORDER BY id")
  .all(targetCore.context.marker.projectId).map((row) => row.id);
let replacementRemoved = false;
try {
  targetCore.inspect(replaced.id);
} catch {
  replacementRemoved = true;
}
targetCore.close();

sourceCore = new RepositoryMemoryCore(sourceRepository, { embeddingProvider: null });
const postBackup = sourceCore.record({
  type: "risk", title: "Post-backup mutation", content: "A successful physical restore removes this later write.",
});
sourceCore.close();
timings.physicalRestoreDryRun = measure(repetitions, () => {
  restoreRepository(sourceRepository, baselineBackup, { dryRun: true });
});
const restoreResults = [];
timings.physicalRestoreConfirmed = measure(repetitions, () => {
  restoreResults.push(restoreRepository(sourceRepository, baselineBackup));
});

sourceCore = new RepositoryMemoryCore(sourceRepository, { embeddingProvider: null });
let postBackupRemoved = false;
try {
  sourceCore.inspect(postBackup.id);
} catch {
  postBackupRemoved = true;
}
const restoredStatus = sourceCore.status();
sourceCore.close();

const corruptedBackup = join(artifacts, "corrupted-backup.db");
cpSync(baselineBackup, corruptedBackup);
cpSync(backupManifestPath(baselineBackup), backupManifestPath(corruptedBackup));
const corruptedManifest = JSON.parse(readFileSync(backupManifestPath(corruptedBackup), "utf8"));
corruptedManifest.databaseFile = basename(corruptedBackup);
writeFileSync(backupManifestPath(corruptedBackup), `${JSON.stringify(corruptedManifest, null, 2)}\n`, "utf8");
appendFileSync(corruptedBackup, "corrupted", "utf8");
let corruptionRejected = false;
try {
  restoreRepository(sourceRepository, corruptedBackup, { dryRun: true });
} catch (error) {
  corruptionRejected = /checksum|size/u.test(error instanceof Error ? error.message : String(error));
}

const livePath = join(data, "repositories", sourceContext.marker.projectId, "repomind.db");
writeFileSync(livePath, "not a sqlite database", "utf8");
let unreadableRejectedWithoutApproval = false;
try {
  restoreRepository(sourceRepository, baselineBackup);
} catch (error) {
  unreadableRejectedWithoutApproval = /allow-unreadable/u.test(error instanceof Error ? error.message : String(error));
}
const unreadableRestore = restoreRepository(sourceRepository, baselineBackup, { allowUnreadable: true });
const finalCore = new RepositoryMemoryCore(sourceRepository, { embeddingProvider: null });
const finalStatus = finalCore.status();
finalCore.close();

const sourceId = sourceContext.marker.projectId;
const targetId = targetContext.marker.projectId;
const checks = [
  { name: "fixed commit real repository cloned", passed: targetCommit.length === 40 },
  { name: "reviewed L1 L2 and L3 data seeded", passed: moduleMemories.length >= 6 && repositoryMemories.length === 2 && exportResult.counts.module_narratives >= 6 && exportResult.counts.repository_profiles === 1 },
  { name: "logical export checksum reloads", passed: exportBundle.checksum === exportResult.checksum },
  { name: "logical import uses a different Project ID", passed: sourceId !== targetId },
  { name: "logical replace removes target-only record", passed: replacementRemoved },
  { name: "logical import preserves memory IDs", passed: JSON.stringify(importedMemoryIds) === JSON.stringify(expectedIds(exportBundle, "memories")) },
  { name: "logical import preserves L1 L2 L3 counts", passed: importedStatus.memories === exportResult.counts.memories && importedStatus.moduleNarratives === exportResult.counts.module_narratives && importedStatus.repositoryProfiles === exportResult.counts.repository_profiles },
  { name: "logical import rebuilds FTS", passed: importedSearch.some((item) => item.title === "Repository portability boundary") },
  { name: "logical import preserves L3 provenance", passed: importedProfile.memorySources.length > 0 && importedProfile.moduleSources.length > 0 },
  { name: "logical import clears derived vectors", passed: importedStatus.embeddings === 0 },
  { name: "physical backup manifest validates", passed: backupManifest.sha256 === backupResult.sha256 && backupManifest.projectId === sourceId },
  { name: "physical restore removes post-backup mutation", passed: postBackupRemoved && restoredStatus.memories === exportResult.counts.memories },
  {
    name: "confirmed restores retain checksummed rollback snapshots",
    passed: restoreResults.length === repetitions && restoreResults.every((item) =>
      item.preRestoreBackup && existsSync(item.preRestoreBackup) && existsSync(backupManifestPath(item.preRestoreBackup))),
  },
  { name: "corrupted backup rejected", passed: corruptionRejected },
  { name: "unreadable live database requires approval", passed: unreadableRejectedWithoutApproval },
  { name: "approved unreadable recovery succeeds and retains artifact", passed: unreadableRestore.restored && unreadableRestore.previousDatabase === "unreadable" && Boolean(unreadableRestore.preRestoreBackup && existsSync(unreadableRestore.preRestoreBackup)) },
  { name: "final recovered database is readable", passed: finalStatus.memories === exportResult.counts.memories },
  ...Object.entries(timings).map(([name, value]) => ({ name: `${name} p95 under 2 seconds`, passed: value.p95Ms < 2_000 })),
];

const report = {
  schemaVersion: 1,
  kind: "repomind-real-repository-portability-acceptance",
  generatedAt: new Date().toISOString(),
  integrity: { passed: checks.every((check) => check.passed), checks },
  provenance: {
    sourceRepository: source,
    sourceClone: sourceRepository,
    targetClone: targetRepository,
    targetCommit,
    sourceProjectId: sourceId,
    targetProjectId: targetId,
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
    memories: exportResult.counts.memories,
    evidence: exportResult.counts.evidence,
    moduleNarratives: exportResult.counts.module_narratives,
    repositoryProfiles: exportResult.counts.repository_profiles,
    exportBytes: readFileSync(baselineExport).byteLength,
    backupBytes: backupResult.sizeBytes,
    repetitions,
  },
  artifacts: { baselineExport, baselineBackup, backupManifest: backupResult.manifestPath, unreadablePreRestore: unreadableRestore.preRestoreBackup },
  timings,
  limitations: [
    "This is a fixed-commit recovery drill on the real RepoMind repository, not an authored toy fixture.",
    "The seeded L1 facts are reviewed deterministic inputs; this run does not evaluate remote LLM extraction quality.",
    "The corpus is repository-sized and does not prove the final 10,000-L1 scale target.",
    "Single-machine wall-clock results must not be generalized to other hardware or operating systems.",
    "Logical merge, encrypted archives, and scheduled remote backups remain outside the v0.13 contract.",
  ],
};

const jsonPath = join(workspace, "portability-real-report.json");
const markdownPath = join(workspace, "portability-real-report.md");
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
const checkRows = checks.map((check) => `| ${check.name} | ${check.passed ? "passed" : "FAILED"} |`).join("\n");
const timingRows = Object.entries(timings).map(([name, value]) => `| ${name} | ${value.samples} | ${value.p50Ms} | ${value.p95Ms} | ${value.maxMs} |`).join("\n");
writeFileSync(markdownPath, `# RepoMind real-repository recovery acceptance\n\nIntegrity: **${report.integrity.passed ? "passed" : "FAILED"}**\n\nTarget: ${basename(source)} at \`${targetCommit}\`\n\nDataset: ${report.dataset.memories} L1 memories, ${report.dataset.evidence} Evidence records, ${report.dataset.moduleNarratives} L2 narratives, and ${report.dataset.repositoryProfiles} L3 profile.\n\n## Checks\n\n| Check | Result |\n| --- | --- |\n${checkRows}\n\n## Latency\n\n| Operation | Samples | P50 ms | P95 ms | Max ms |\n| --- | ---: | ---: | ---: | ---: |\n${timingRows}\n\n## Limitations\n\n${report.limitations.map((item) => `- ${item}`).join("\n")}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ passed: report.integrity.passed, jsonPath, markdownPath, targetCommit, timings }, null, 2)}\n`);
if (!report.integrity.passed) process.exitCode = 1;
