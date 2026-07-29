import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { cpus, platform, release } from "node:os";
import { basename, join, resolve } from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(name) {
  const value = argument(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error([
      `Command failed (${result.status}): ${executable} ${args.join(" ")}`,
      result.stdout?.trim(),
      result.stderr?.trim(),
    ].filter(Boolean).join("\n"));
  }
  return result.stdout.trim();
}

function npm(args, options = {}) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !existsSync(npmCli)) {
    throw new Error("npm_execpath is required; run this acceptance through npm run bench:package-smoke");
  }
  return run(process.execPath, [npmCli, ...args], options);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha1(path) {
  return createHash("sha1").update(readFileSync(path)).digest("hex");
}

function filesUnder(root, prefix = "") {
  const result = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(root, relative));
    else result.push(relative.replaceAll("\\", "/"));
  }
  return result;
}

function createRepository(path) {
  mkdirSync(path);
  run("git", ["init", "-b", "main"], { cwd: path });
  run("git", ["config", "user.email", "repomind-release@example.invalid"], { cwd: path });
  run("git", ["config", "user.name", "RepoMind Release Acceptance"], { cwd: path });
  writeFileSync(join(path, "README.md"), "# Packaged RepoMind acceptance\n", "utf8");
  run("git", ["add", "README.md"], { cwd: path });
  run("git", ["commit", "-m", "initial fixture"], { cwd: path });
}

function cli(entry, env, repository, ...args) {
  const stdout = run(process.execPath, [entry, ...args, "--repo", repository, "--json"], { env });
  return JSON.parse(stdout);
}

class JsonRpcClient {
  constructor(entry, env) {
    this.nextId = 1;
    this.buffer = "";
    this.pending = new Map();
    this.stderr = "";
    this.child = spawn(process.execPath, [entry, "mcp"], {
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.on("exit", (code) => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`MCP server exited with ${code}: ${this.stderr.trim()}`));
      }
      this.pending.clear();
    });
  }

  consume(chunk) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        const message = JSON.parse(line);
        const pending = this.pending.get(message.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
          else pending.resolve(message.result);
        }
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`Timed out waiting for MCP ${method}`));
      }, 20_000);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async tool(name, args) {
    const result = await this.request("tools/call", { name, arguments: args });
    if (result.isError) throw new Error(result.content?.[0]?.text ?? `${name} failed`);
    return JSON.parse(result.content[0].text);
  }

  close() {
    this.child.stdin.end();
    this.child.kill();
  }
}

const source = resolve(".");
const workspace = resolve(required("--workspace"));
if (existsSync(workspace)) throw new Error(`Workspace must not already exist: ${workspace}`);
mkdirSync(workspace, { recursive: false });
const artifacts = join(workspace, "artifacts");
const consumer = join(workspace, "consumer");
const repository = join(workspace, "repository");
const data = join(workspace, "data");
mkdirSync(artifacts);
mkdirSync(consumer);
mkdirSync(data);

const packed = JSON.parse(npm(["pack", "--json", "--pack-destination", artifacts], { cwd: source }));
if (!Array.isArray(packed) || packed.length !== 1) throw new Error("npm pack returned an unexpected result");
const packResult = packed[0];
const tarball = join(artifacts, packResult.filename);
writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true }, null, 2), "utf8");
npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", tarball], { cwd: consumer });

const installedRoot = join(consumer, "node_modules", "repomind");
const installedManifest = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
const entry = join(installedRoot, installedManifest.bin.repomind);
const binShim = join(consumer, "node_modules", ".bin", process.platform === "win32" ? "repomind.cmd" : "repomind");
const installedFiles = filesUnder(installedRoot);
const forbiddenFiles = installedFiles.filter((path) =>
  /(^|\/)(\.repomind|coverage|node_modules)(\/|$)|^tests?(\/|$)|\.db(?:-|\.|$)|(^|\/)\.env(?:\.|$)|opencode\.json$/iu.test(path));

createRepository(repository);
const env = {
  ...process.env,
  REPOMIND_DATA_DIR: data,
  REPOMIND_EMBEDDING_PROVIDER: "deterministic",
  REPOMIND_EMBEDDING_DIMENSIONS: "64",
  REPOMIND_ARCHIVE_PASSPHRASE: randomBytes(24).toString("base64"),
};
const initialized = cli(entry, env, repository, "init");
const recorded = cli(entry, env, repository, "record", "--type", "decision", "--title", "Packaged release boundary", "--content", "Install and run RepoMind from the npm tarball.");
const searched = cli(entry, env, repository, "search", "npm tarball");
const inspected = cli(entry, env, repository, "inspect", recorded.id);
const backupPath = join(artifacts, "repository.db");
const backup = cli(entry, env, repository, "backup", "--output", backupPath);
const mutation = cli(entry, env, repository, "record", "--type", "risk", "--title", "Post-backup mutation", "--content", "Restore must remove this record.");
const restorePreview = cli(entry, env, repository, "restore", "--input", backupPath, "--dry-run");
const restored = cli(entry, env, repository, "restore", "--input", backupPath, "--yes");
const originalAfterRestore = cli(entry, env, repository, "search", "npm tarball");
const mutationAfterRestore = cli(entry, env, repository, "search", "Post-backup mutation");
const encryptedExportPath = join(artifacts, "repository.enc.json");
const encryptedBackupPath = join(artifacts, "repository.db.enc");
const encryptedExport = cli(entry, env, repository, "export", "--output", encryptedExportPath, "--encrypt");
const encryptedBackup = cli(entry, env, repository, "backup", "--output", encryptedBackupPath, "--encrypt");
const postExportMutation = cli(entry, env, repository, "record", "--type", "risk", "--title", "Post-export mutation", "--content", "Encrypted import must remove this record.");
const encryptedImport = cli(entry, env, repository, "import", "--input", encryptedExportPath, "--yes");
const postEncryptedBackupMutation = cli(entry, env, repository, "record", "--type", "risk", "--title", "Post-encrypted-backup mutation", "--content", "Encrypted restore must remove this record.");
const encryptedRestore = cli(entry, env, repository, "restore", "--input", encryptedBackupPath, "--yes");
const postExportAfterImport = cli(entry, env, repository, "search", "Post-export mutation");
const postEncryptedBackupAfterRestore = cli(entry, env, repository, "search", "Post-encrypted-backup mutation");
const encryptedArtifactsHidePlaintext = !readFileSync(encryptedExportPath, "utf8").includes("Packaged release boundary")
  && !readFileSync(encryptedBackupPath, "utf8").includes("Packaged release boundary");
const encryptedOutputsHidePassphrase = !JSON.stringify({ encryptedExport, encryptedBackup, encryptedImport, encryptedRestore })
  .includes(env.REPOMIND_ARCHIVE_PASSPHRASE);

const mcp = new JsonRpcClient(entry, env);
let mcpResult;
try {
  await mcp.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "repomind-package-smoke", version: "1.0.0" },
  });
  mcp.notify("notifications/initialized");
  const tools = await mcp.request("tools/list", {});
  const started = await mcp.tool("repo_session_start", {
    repo_path: repository,
    task: "Verify the packaged release boundary",
    client_name: "package-smoke",
  });
  const found = await mcp.tool("repo_memory_search", {
    repo_path: repository,
    query: "npm tarball",
    limit: 5,
  });
  const memoryId = found.memories[0]?.id;
  if (!memoryId) throw new Error("MCP search returned no packaged release memory");
  const memory = await mcp.tool("repo_memory_inspect", { repo_path: repository, memory_id: memoryId });
  await mcp.tool("repo_session_abandon", { repo_path: repository, session_id: started.sessionId });
  mcpResult = { toolCount: tools.tools.length, sessionId: started.sessionId, searchCount: found.memories.length, memory };
} finally {
  mcp.close();
}

const checks = [
  { name: "tarball checksum matches npm pack", passed: sha1(tarball) === packResult.shasum },
  { name: "installed package version matches packed version", passed: installedManifest.version === packResult.version },
  { name: "package bin entry and generated shim exist", passed: existsSync(entry) && existsSync(binShim) },
  { name: "package excludes databases local config tests and coverage", passed: forbiddenFiles.length === 0 },
  { name: "packaged CLI initializes a Git repository", passed: Boolean(initialized.projectId) },
  { name: "packaged CLI records searches and inspects Evidence", passed: searched.some((item) => item.id === recorded.id) && inspected.evidence.length > 0 && inspected.audit.length > 0 },
  { name: "packaged backup dry-run and confirmed restore succeed", passed: backup.sha256 && restorePreview.restored === false && restored.restored === true && existsSync(restored.preRestoreBackup) },
  { name: "restore preserves baseline and removes later mutation", passed: originalAfterRestore.some((item) => item.id === recorded.id) && !mutationAfterRestore.some((item) => item.id === mutation.id) },
  { name: "packaged encrypted export import backup and restore succeed", passed: encryptedExport.encrypted && encryptedBackup.encrypted && encryptedBackup.manifestPath === null && encryptedImport.imported && encryptedImport.encrypted && encryptedRestore.restored && encryptedRestore.encrypted },
  { name: "encrypted replacement loops remove later mutations", passed: !postExportAfterImport.some((item) => item.id === postExportMutation.id) && !postEncryptedBackupAfterRestore.some((item) => item.id === postEncryptedBackupMutation.id) },
  { name: "encrypted package artifacts and outputs hide plaintext credentials", passed: encryptedArtifactsHidePlaintext && encryptedOutputsHidePassphrase },
  { name: "packaged MCP exposes the complete tool surface", passed: mcpResult.toolCount === 24 },
  { name: "packaged MCP starts searches inspects and abandons", passed: mcpResult.sessionId.startsWith("ses_") && mcpResult.searchCount > 0 && mcpResult.memory.id === recorded.id },
  { name: "no Session remains open", passed: cli(entry, env, repository, "status").openSessions === 0 },
];

const report = {
  schemaVersion: 1,
  kind: "repomind-package-install-smoke",
  generatedAt: new Date().toISOString(),
  accepted: checks.every((check) => check.passed),
  checks,
  package: {
    name: packResult.name,
    version: packResult.version,
    filename: basename(tarball),
    sha256: sha256(tarball),
    files: packResult.entryCount,
    unpackedBytes: packResult.unpackedSize,
    forbiddenFiles,
  },
  lifecycle: {
    projectId: initialized.projectId,
    memoryId: recorded.id,
    backupSha256: backup.sha256,
    encryptedExportSha256: sha256(encryptedExportPath),
    encryptedBackupSha256: sha256(encryptedBackupPath),
    mcpTools: mcpResult.toolCount,
  },
  environment: {
    node: process.version,
    os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? "unknown",
  },
};

const reportPath = join(workspace, "package-smoke-report.json");
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (readFileSync(reportPath, "utf8").includes(env.REPOMIND_ARCHIVE_PASSPHRASE)) {
  throw new Error("Package smoke report contains the generated archive passphrase");
}
const markdown = [
  "# RepoMind packaged-install smoke report",
  "",
  `Result: **${report.accepted ? "accepted" : "rejected"}**`,
  "",
  `Package: \`${report.package.name}@${report.package.version}\``,
  `Tarball SHA-256: \`${report.package.sha256}\``,
  "",
  "| Check | Result |",
  "| --- | --- |",
  ...checks.map((check) => `| ${check.name} | ${check.passed ? "passed" : "failed"} |`),
  "",
].join("\n");
writeFileSync(join(workspace, "package-smoke-report.md"), markdown, "utf8");
console.log(JSON.stringify({ accepted: report.accepted, reportPath, checks: checks.length }));
if (!report.accepted) process.exitCode = 1;
