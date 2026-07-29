import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { cpus, freemem, platform, release, tmpdir, totalmem } from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  RepositoryMemoryCore,
  backupManifestPath,
  backupRepository,
  exportRepository,
  importRepository,
  initializeRepository,
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

function flag(name) {
  return process.argv.includes(name);
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

function temporaryPlaintextDirectories() {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith("repomind-encrypted-backup-") || name.startsWith("repomind-encrypted-restore-"))
    .sort();
}

function mutateBase64(value) {
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}

function rejected(operation, pattern) {
  try {
    operation();
    return false;
  } catch (error) {
    return pattern.test(error instanceof Error ? error.message : String(error));
  }
}

const source = resolve(required("--repo"));
const workspace = resolve(required("--workspace"));
const repetitions = Number(argument("--repeat", "5"));
if (!Number.isInteger(repetitions) || repetitions < 5 || repetitions > 30) throw new Error("--repeat must be from 5 to 30");
if (!existsSync(join(source, ".git"))) throw new Error(`Not a Git repository: ${source}`);
if (existsSync(workspace)) throw new Error(`Workspace must not already exist: ${workspace}`);
const passphrase = process.env.REPOMIND_ARCHIVE_PASSPHRASE;
if (!passphrase) throw new Error("REPOMIND_ARCHIVE_PASSPHRASE must be set for this acceptance run");

const implementationCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: source, encoding: "utf8", windowsHide: true,
}).trim();
const implementationDirty = execFileSync("git", ["status", "--porcelain"], {
  cwd: source, encoding: "utf8", windowsHide: true,
}).trim().length > 0;
const requireClean = flag("--require-clean");
const requestedCommit = argument("--commit", implementationCommit);
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
process.env.REPOMIND_DATA_DIR = data;

const sourceContext = initializeRepository(sourceRepository);
sourceContext.database.close();
const targetContext = initializeRepository(targetRepository, true);
targetContext.database.close();
const sourceProjectId = sourceContext.marker.projectId;
const targetProjectId = targetContext.marker.projectId;
const temporaryBefore = temporaryPlaintextDirectories();

let sourceCore = new RepositoryMemoryCore(sourceRepository, { embeddingProvider: null });
const seeded = [];
for (let index = 0; index < 40; index++) {
  const sourceFile = index % 2 === 0 ? "src/portability/repository-data.ts" : "docs/data-portability.md";
  seeded.push(sourceCore.record({
    type: index % 3 === 0 ? "decision" : "convention",
    title: `Encrypted portability fixture ${String(index).padStart(2, "0")}`,
    content: `Evidence-backed portability fixture ${index} verifies authenticated local archive recovery.`,
    scopeType: "module",
    scopeValue: index % 2 === 0 ? "src/portability" : "docs",
    confidence: 0.95,
    relatedFiles: [sourceFile],
  }));
}
sourceCore.rebuildModuleNarratives();
sourceCore.rebuildRepositoryProfile({ minConfidence: 0.8 });

const plainExport = join(artifacts, "baseline-export.json");
const encryptedExport = join(artifacts, "baseline-export.enc.json");
const plainBackup = join(artifacts, "baseline-backup.db");
const encryptedBackup = join(artifacts, "baseline-backup.db.enc");
const plainExportResult = exportRepository(sourceCore.context, plainExport);
const encryptedExportResult = exportRepository(sourceCore.context, encryptedExport, { passphrase });
const plainBackupResult = backupRepository(sourceCore.context, plainBackup);
const encryptedBackupResult = backupRepository(sourceCore.context, encryptedBackup, { passphrase });
const encryptedBundle = loadRepositoryExport(encryptedExport, { passphrase });
const timings = {};
timings.plainExport = measure(repetitions, (index) => {
  exportRepository(sourceCore.context, join(artifacts, `plain-export-${index}.json`));
});
timings.encryptedExport = measure(repetitions, (index) => {
  exportRepository(sourceCore.context, join(artifacts, `encrypted-export-${index}.json`), { passphrase });
});
timings.plainBackup = measure(repetitions, (index) => {
  backupRepository(sourceCore.context, join(artifacts, `plain-backup-${index}.db`));
});
timings.encryptedBackup = measure(repetitions, (index) => {
  backupRepository(sourceCore.context, join(artifacts, `encrypted-backup-${index}.db.enc`), { passphrase });
});
sourceCore.close();

let targetCore = new RepositoryMemoryCore(targetRepository, { embeddingProvider: null });
const sentinel = targetCore.record({
  type: "risk", title: "Target sentinel", content: "Authentication failures must preserve this target-only record.",
});
const targetCountBeforeRejections = targetCore.status().memories;
const wrongLogicalKeyRejected = rejected(
  () => importRepository(targetCore.context, encryptedExport, { passphrase: `${passphrase}-wrong` }),
  /authentication/u,
);
const logicalEnvelope = JSON.parse(readFileSync(encryptedExport, "utf8"));
const logicalTampering = [
  ["ciphertext", (archive) => { archive.ciphertext = mutateBase64(archive.ciphertext); }, /authentication/u],
  ["tag", (archive) => { archive.cipher.tag = mutateBase64(archive.cipher.tag); }, /authentication/u],
  ["aad", (archive) => { archive.createdAt += 1; }, /authentication/u],
  ["purpose", (archive) => { archive.purpose = "sqlite-backup"; }, /purpose/u],
];
const logicalTamperResults = logicalTampering.map(([name, mutate, pattern]) => {
  const archive = structuredClone(logicalEnvelope);
  mutate(archive);
  const path = join(artifacts, `tampered-logical-${name}.json`);
  writeFileSync(path, `${JSON.stringify(archive, null, 2)}\n`, "utf8");
  return { name, rejected: rejected(() => importRepository(targetCore.context, path, { passphrase }), pattern) };
});
const targetUnchangedAfterRejections = targetCore.status().memories === targetCountBeforeRejections
  && targetCore.inspect(sentinel.id).title === "Target sentinel";
timings.plainImportDryRun = measure(repetitions, () => {
  importRepository(targetCore.context, plainExport, { dryRun: true });
});
timings.encryptedImportDryRun = measure(repetitions, () => {
  importRepository(targetCore.context, encryptedExport, { passphrase, dryRun: true });
});
timings.plainImportConfirmed = measure(repetitions, () => {
  importRepository(targetCore.context, plainExport);
});
timings.encryptedImportConfirmed = measure(repetitions, () => {
  importRepository(targetCore.context, encryptedExport, { passphrase });
});
const importedStatus = targetCore.status();
const importedIds = targetCore.context.database.raw
  .prepare("SELECT id FROM memories WHERE repository_id=? ORDER BY id")
  .all(targetProjectId).map((row) => row.id);
targetCore.close();

sourceCore = new RepositoryMemoryCore(sourceRepository, { embeddingProvider: null });
const postBackup = sourceCore.record({
  type: "risk", title: "Post-backup mutation", content: "A successful encrypted restore removes this later write.",
});
sourceCore.close();
const sourceCountBeforeRejections = new RepositoryMemoryCore(sourceRepository, { embeddingProvider: null });
const expectedSourceCount = sourceCountBeforeRejections.status().memories;
sourceCountBeforeRejections.close();
const wrongPhysicalKeyRejected = rejected(
  () => restoreRepository(sourceRepository, encryptedBackup, { passphrase: `${passphrase}-wrong`, dryRun: true }),
  /authentication/u,
);
const physicalEnvelope = JSON.parse(readFileSync(encryptedBackup, "utf8"));
physicalEnvelope.ciphertext = mutateBase64(physicalEnvelope.ciphertext);
const tamperedPhysical = join(artifacts, "tampered-physical.db.enc");
writeFileSync(tamperedPhysical, `${JSON.stringify(physicalEnvelope, null, 2)}\n`, "utf8");
const physicalTamperingRejected = rejected(
  () => restoreRepository(sourceRepository, tamperedPhysical, { passphrase, dryRun: true }),
  /authentication/u,
);
let sourceAfterRejections = new RepositoryMemoryCore(sourceRepository, { embeddingProvider: null });
const sourceUnchangedAfterRejections = sourceAfterRejections.status().memories === expectedSourceCount
  && sourceAfterRejections.inspect(postBackup.id).title === "Post-backup mutation";
sourceAfterRejections.close();
timings.plainRestoreDryRun = measure(repetitions, () => {
  restoreRepository(sourceRepository, plainBackup, { dryRun: true });
});
timings.encryptedRestoreDryRun = measure(repetitions, () => {
  restoreRepository(sourceRepository, encryptedBackup, { passphrase, dryRun: true });
});
timings.plainRestoreConfirmed = measure(repetitions, () => {
  restoreRepository(sourceRepository, plainBackup);
});
timings.encryptedRestoreConfirmed = measure(repetitions, () => {
  restoreRepository(sourceRepository, encryptedBackup, { passphrase });
});
sourceAfterRejections = new RepositoryMemoryCore(sourceRepository, { embeddingProvider: null });
let postBackupRemoved = false;
try {
  sourceAfterRejections.inspect(postBackup.id);
} catch {
  postBackupRemoved = true;
}
const restoredStatus = sourceAfterRejections.status();
sourceAfterRejections.close();

const plaintextMarker = "Encrypted portability fixture 00";
const encryptedFilesHidePlaintext = !readFileSync(encryptedExport, "utf8").includes(plaintextMarker)
  && !readFileSync(encryptedBackup, "utf8").includes(plaintextMarker);
const expectedIds = encryptedBundle.tables.memories.map((row) => row.id).sort();
const temporaryAfter = temporaryPlaintextDirectories();
const dataset = {
  memories: plainExportResult.counts.memories,
  moduleNarratives: plainExportResult.counts.module_narratives,
  repositoryProfiles: plainExportResult.counts.repository_profiles,
  repetitions,
  sizes: {
    plainExportBytes: statSync(plainExport).size,
    encryptedExportBytes: statSync(encryptedExport).size,
    plainBackupBytes: statSync(plainBackup).size,
    encryptedBackupBytes: statSync(encryptedBackup).size,
  },
};
const provenance = {
  sourceRepository: source,
  implementationCommit,
  implementationDirty,
  requireClean,
  sourceClone: sourceRepository,
  targetClone: targetRepository,
  targetCommit,
  sourceProjectId,
  targetProjectId,
  node: process.version,
  os: `${platform()} ${release()}`,
  cpu: cpus()[0]?.model ?? "unknown",
  cpuCount: cpus().length,
  totalMemoryBytes: totalmem(),
  freeMemoryBytesAtReport: freemem(),
};
const artifactsReport = {
  plainExport: { path: plainExport, sha256: sha256(readFileSync(plainExport)) },
  encryptedExport: { path: encryptedExport, sha256: sha256(readFileSync(encryptedExport)) },
  plainBackup: { path: plainBackup, sha256: plainBackupResult.sha256, manifestPath: plainBackupResult.manifestPath },
  encryptedBackup: { path: encryptedBackup, sha256: sha256(readFileSync(encryptedBackup)), manifestPath: encryptedBackupResult.manifestPath },
};
const reportPayloadExcludesPassphrase = !JSON.stringify({ provenance, dataset, timings, artifactsReport }).includes(passphrase);
const checks = [
  { name: "fixed commit real repository cloned", passed: targetCommit.length === 40 },
  { name: "implementation worktree satisfies clean-run policy", passed: !requireClean || !implementationDirty },
  { name: "logical and physical encrypted envelopes created", passed: encryptedExportResult.encrypted && encryptedBackupResult.encrypted },
  { name: "plaintext formats remain available", passed: !plainExportResult.encrypted && !plainBackupResult.encrypted },
  { name: "encrypted logical export reloads with complete L1-L3 data", passed: encryptedBundle.tables.memories.length === dataset.memories && encryptedBundle.tables.module_narratives.length === dataset.moduleNarratives && encryptedBundle.tables.repository_profiles.length === dataset.repositoryProfiles },
  { name: "encrypted artifacts hide known repository plaintext", passed: encryptedFilesHidePlaintext },
  { name: "wrong logical passphrase rejected", passed: wrongLogicalKeyRejected },
  { name: "logical ciphertext tag AAD and purpose tampering rejected", passed: logicalTamperResults.every((item) => item.rejected) },
  { name: "logical authentication failures perform zero target writes", passed: targetUnchangedAfterRejections },
  { name: "encrypted replace import preserves IDs and L1-L3 counts", passed: JSON.stringify(importedIds) === JSON.stringify(expectedIds) && importedStatus.moduleNarratives === dataset.moduleNarratives && importedStatus.repositoryProfiles === dataset.repositoryProfiles },
  { name: "wrong physical passphrase rejected", passed: wrongPhysicalKeyRejected },
  { name: "physical ciphertext tampering rejected", passed: physicalTamperingRejected },
  { name: "physical authentication failures perform zero live writes", passed: sourceUnchangedAfterRejections },
  { name: "encrypted physical restore removes post-backup mutation", passed: postBackupRemoved && restoredStatus.memories === dataset.memories },
  { name: "encrypted backup is a single file without sidecar manifest", passed: encryptedBackupResult.manifestPath === null && !existsSync(backupManifestPath(encryptedBackup)) },
  { name: "temporary plaintext directories are removed", passed: JSON.stringify(temporaryBefore) === JSON.stringify(temporaryAfter) },
  { name: "report payload excludes passphrase", passed: reportPayloadExcludesPassphrase },
  ...Object.entries(timings).map(([name, value]) => ({ name: `${name} p95 under 5 seconds`, passed: value.p95Ms < 5_000 })),
];
const report = {
  schemaVersion: 1,
  kind: "repomind-encrypted-portability-acceptance",
  generatedAt: new Date().toISOString(),
  integrity: { passed: checks.every((check) => check.passed), checks },
  provenance,
  configuration: {
    archiveFormat: 1,
    cipher: "aes-256-gcm",
    kdf: { name: "scrypt", N: 32768, r: 8, p: 1, keyLength: 32 },
    passphraseSource: "environment",
  },
  dataset,
  artifacts: artifactsReport,
  tamperProbes: { logical: logicalTamperResults, physicalCiphertext: physicalTamperingRejected },
  timings,
  overhead: {
    exportP50Ms: round(timings.encryptedExport.p50Ms - timings.plainExport.p50Ms),
    importDryRunP50Ms: round(timings.encryptedImportDryRun.p50Ms - timings.plainImportDryRun.p50Ms),
    backupP50Ms: round(timings.encryptedBackup.p50Ms - timings.plainBackup.p50Ms),
    restoreDryRunP50Ms: round(timings.encryptedRestoreDryRun.p50Ms - timings.plainRestoreDryRun.p50Ms),
  },
  limitations: [
    "This is a fixed-commit drill on a clone of the real RepoMind repository with deterministic seeded L1-L3 data.",
    "The passphrase is supplied only through the process environment and is deliberately absent from reports.",
    "Wall-clock results describe this machine and must not be generalized to other hardware or operating systems.",
    "Temporary plaintext SQLite is permitted only inside the operating-system temporary directory and is deleted before each operation returns.",
    "Logical merge import, scheduled backup, cloud storage, and key-management service integration remain outside this contract.",
  ],
};

const jsonPath = join(workspace, "encrypted-portability-report.json");
const markdownPath = join(workspace, "encrypted-portability-report.md");
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
const checkRows = checks.map((check) => `| ${check.name} | ${check.passed ? "passed" : "FAILED"} |`).join("\n");
const timingRows = Object.entries(timings).map(([name, value]) => `| ${name} | ${value.samples} | ${value.p50Ms} | ${value.p95Ms} | ${value.maxMs} |`).join("\n");
writeFileSync(markdownPath, `# RepoMind encrypted portability acceptance\n\nIntegrity: **${report.integrity.passed ? "passed" : "FAILED"}**\n\nTarget: ${basename(source)} at \`${targetCommit}\`\n\nDataset: ${dataset.memories} L1 memories, ${dataset.moduleNarratives} L2 narratives, and ${dataset.repositoryProfiles} L3 profile.\n\n## Checks\n\n| Check | Result |\n| --- | --- |\n${checkRows}\n\n## Latency\n\n| Operation | Samples | P50 ms | P95 ms | Max ms |\n| --- | ---: | ---: | ---: | ---: |\n${timingRows}\n\n## Limitations\n\n${report.limitations.map((item) => `- ${item}`).join("\n")}\n`, "utf8");
if (readFileSync(jsonPath, "utf8").includes(passphrase) || readFileSync(markdownPath, "utf8").includes(passphrase)) {
  throw new Error("Acceptance report contains the archive passphrase");
}
process.stdout.write(`${JSON.stringify({ passed: report.integrity.passed, jsonPath, markdownPath, targetCommit, timings, overhead: report.overhead }, null, 2)}\n`);
if (!report.integrity.passed) process.exitCode = 1;
