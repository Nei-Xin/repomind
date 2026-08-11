#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

const AUDIT_KIND = "repomind-cross-session-result-audit";
const AUDIT_VERSION = 1;
const SUMMARY_VERSION = 4;
const ARMS = ["isolated", "shared"];
const LAYERS = ["l1", "l2", "l3"];
const REQUIRED_DATABASE_TABLES = [
  "repositories",
  "sessions",
  "evidence",
  "memories",
  "host_runs",
  "module_narratives",
  "repository_profiles",
  "skill_candidates",
];
const RESUME_SAFE_TOOLS = new Set([
  "apply_patch",
  "edit",
  "glob",
  "grep",
  "list",
  "read",
  "todowrite",
  "write",
]);
const TRANSIENT_PATTERNS = [
  ["tls-certificate", [
    /\bunknown certificate verification error\b/iu,
    /\bcertificate (?:verification|verify) (?:error|failed|failure)\b/iu,
    /\bunable to verify (?:the )?(?:first |leaf )?certificate\b/iu,
    /\bself[- ]signed certificate\b/iu,
    /\b(?:cert_has_expired|unable_to_verify_leaf_signature|err_tls_cert_altname_invalid)\b/iu,
    /\b(?:tls|ssl)\b.{0,80}\b(?:handshake|certificate)\b.{0,40}\b(?:error|failed|failure)\b/iu,
  ]],
  ["connection-reset", [/\b(?:econnreset|connection reset(?: by peer)?|socket hang up)\b/iu]],
  ["network-timeout", [
    /\b(?:etimedout|esockettimedout|deadline exceeded)\b/iu,
    /\b(?:request|connect(?:ion)?|network|upstream|gateway)\s+(?:timed?\s*out|timeout)\b/iu,
  ]],
  ["http-429", [
    /\b(?:http(?:\/[0-9.]+)?\s+|status(?:[_ -]*code)?\s*[:=]?\s*)429\b/iu,
    /\b(?:too many requests|rate limit(?:ed| exceeded)?)\b/iu,
  ]],
  ["http-5xx", [
    /\b(?:http(?:\/[0-9.]+)?\s+(?:status(?:[_ -]*code)?\s*)?|status(?:[_ -]*code)?\s*[:=]?\s*)5\d\d\b/iu,
    /\b(?:internal server error|bad gateway|service unavailable|gateway timeout)\b/iu,
  ]],
  ["upstream-http2-stream", [
    /\bupstream_http2_stream_error\b/iu,
    /\bupstream HTTP\/2 stream failed\b/iu,
  ]],
];
const SNAPSHOT_ALGORITHM = "repomind-source-snapshot-v1";

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function integerValue(value) {
  return Number.isInteger(value) ? value : null;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/u, ""));
}

function normalizedPath(path) {
  return resolve(path).replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function pathInside(parent, child, allowSame = false) {
  const difference = relative(resolve(parent), resolve(child));
  if (!difference) return allowSame;
  return !difference.startsWith("..") && !isAbsolute(difference);
}

function existingRealPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function safeExistingPath(parent, candidate, allowSame = false) {
  if (!pathInside(parent, candidate, allowSame)) return false;
  const realParent = existingRealPath(parent);
  const realCandidate = existingRealPath(candidate);
  return realParent !== null
    && realCandidate !== null
    && pathInside(realParent, realCandidate, allowSame);
}

function uniqueStrings(value) {
  return Array.isArray(value)
    && value.every((entry) => typeof entry === "string")
    && new Set(value).size === value.length;
}

function sortedStrings(value) {
  return [...value].sort((left, right) => left.localeCompare(right));
}

function setEqual(left, right) {
  return left.length === right.length
    && sortedStrings(left).every((value, index) => value === sortedStrings(right)[index]);
}

function runKey(run) {
  return `${run.sequenceId}/${run.arm}/${run.iteration}/${run.stageId}`;
}

function expectedRunName(sequenceId, arm, iteration, stageIndex, stageId) {
  return `${sequenceId}-${arm}-${iteration}-s${stageIndex + 1}-${stageId}`;
}

function walkFiles(root) {
  const files = [];
  if (!existsSync(root)) return files;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files;
}

function fileTreeSnapshot(root) {
  const files = walkFiles(root).map((path) => {
    const bytes = readFileSync(path);
    return {
      path: relative(root, path).replaceAll("\\", "/"),
      size: bytes.length,
      sha256: sha256(bytes),
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  return {
    root: resolve(root),
    fileCount: files.length,
    sha256: sha256(JSON.stringify(files)),
    files,
  };
}

function nativeLinkEntries(root) {
  const links = [];
  if (!existsSync(root)) return links;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const currentStat = lstatSync(current);
    if (currentStat.isSymbolicLink()) {
      links.push({ path: current, target: readlinkSync(current), kind: "symbolic-link" });
      continue;
    }
    if (!currentStat.isDirectory()) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        links.push({ path, target: readlinkSync(path), kind: "symbolic-link" });
      } else if (entry.isDirectory()) {
        pending.push(path);
      }
    }
  }
  return links;
}

function windowsReparseEntries(root) {
  if (process.platform !== "win32" || !existsSync(root)) return [];
  const script = [
    "$ErrorActionPreference='Stop'",
    "$root=$env:REPOMIND_AUDIT_REPARSE_ROOT",
    "$items=@(Get-Item -Force -LiteralPath $root)",
    "$items+=@(Get-ChildItem -Force -Recurse -LiteralPath $root)",
    "$items | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 } | ForEach-Object { $_.FullName }",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
    env: { ...process.env, REPOMIND_AUDIT_REPARSE_ROOT: resolve(root) },
  });
  if (result.status !== 0 || result.error) {
    return [{
      path: resolve(root),
      target: null,
      kind: "reparse-inspection-failed",
      error: result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`,
    }];
  }
  return lines(result.stdout ?? "").map((path) => ({ path, target: null, kind: "reparse-point" }));
}

export function findPathLinks(roots) {
  const findings = [];
  const seen = new Set();
  const minimalRoots = [...new Set(roots.filter(existsSync).map((root) => resolve(root)))]
    .filter((root, index, values) => !values.some((other, otherIndex) =>
      otherIndex !== index && pathInside(other, root, false)));
  for (const root of minimalRoots) {
    for (const finding of [...nativeLinkEntries(root), ...windowsReparseEntries(root)]) {
      const key = `${normalizedPath(finding.path)}\0${finding.kind}`;
      if (!seen.has(key)) findings.push(finding);
      seen.add(key);
    }
  }
  return findings;
}

function auditNoLinks(state, roots) {
  const findings = findPathLinks(roots);
  check(state, findings.length === 0, "paths", "symlink-reparse",
    "suite and result evidence must not contain symbolic links, junctions, or other reparse points", findings);
  return findings;
}

function git(repository, args) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().startsWith("GIT_")) delete environment[key];
  }
  Object.assign(environment, {
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  });
  const result = spawnSync("git", ["--no-replace-objects", "-C", repository, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    env: environment,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message ?? null,
  };
}

function parseNul(value) {
  return value.split("\0").filter((entry) => entry.length > 0);
}

function gitTree(repository, commit) {
  const result = git(repository, ["ls-tree", "-r", "-z", "--full-tree", commit]);
  if (!commandPassed(result)) {
    return { result, entries: null };
  }
  const entries = new Map();
  for (const record of parseNul(result.stdout)) {
    const separator = record.indexOf("\t");
    if (separator < 0) return { result, entries: null };
    const metadata = record.slice(0, separator).split(/\s+/u);
    const path = record.slice(separator + 1);
    if (metadata.length !== 3 || entries.has(path)) return { result, entries: null };
    entries.set(path, { mode: metadata[0], type: metadata[1], object: metadata[2] });
  }
  return { result, entries };
}

function changedTreePaths(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => !isDeepStrictEqual(before.get(path), after.get(path)))
    .sort((left, right) => left.localeCompare(right));
}

function sourceRepositoryRoot() {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const result = git(scriptDirectory, ["rev-parse", "--show-toplevel"]);
  if (!commandPassed(result) || !result.stdout.trim()) {
    throw new Error(`Unable to locate RepoMind source root: ${result.stderr.trim() || result.error || result.status}`);
  }
  return resolve(result.stdout.trim());
}

export function computeSourceSnapshot(root = sourceRepositoryRoot()) {
  const listed = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  const staged = git(root, ["ls-files", "--stage", "-z"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  for (const [name, result] of Object.entries({ listed, staged, head, status })) {
    if (!commandPassed(result)) throw new Error(`Unable to compute source snapshot (${name}): ${result.stderr.trim()}`);
  }
  const modes = new Map();
  for (const record of parseNul(staged.stdout)) {
    const separator = record.indexOf("\t");
    if (separator < 0) continue;
    const [mode] = record.slice(0, separator).split(/\s+/u);
    modes.set(record.slice(separator + 1), mode);
  }
  const files = sortedStrings([...new Set(parseNul(listed.stdout))]).map((path) => {
    const absolute = resolve(root, path);
    if (!pathInside(root, absolute)) throw new Error(`Source snapshot path escaped repository: ${path}`);
    if (!existsSync(absolute)) return { path, mode: modes.get(path) ?? "missing", kind: "missing" };
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolute);
      return { path, mode: modes.get(path) ?? "120000", kind: "symbolic-link", target, sha256: sha256(target) };
    }
    if (!stat.isFile()) throw new Error(`Unsupported source snapshot entry: ${path}`);
    const bytes = readFileSync(absolute);
    return { path, mode: modes.get(path) ?? "100644", kind: "file", size: bytes.length, sha256: sha256(bytes) };
  });
  const payload = {
    algorithm: SNAPSHOT_ALGORITHM,
    head: head.stdout.trim(),
    files,
  };
  return {
    algorithm: SNAPSHOT_ALGORITHM,
    root,
    head: payload.head,
    dirty: status.stdout.trim().length > 0,
    fileCount: files.length,
    sha256: sha256(JSON.stringify(payload)),
  };
}

function commandPassed(result) {
  return result.status === 0 && result.signal === null && result.error === null;
}

function lines(value) {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function recursiveStrings(value, key = "", depth = 0) {
  if (depth > 12) return [];
  if (typeof value === "string") return [{ key, value }];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => recursiveStrings(item, `${key}[${index}]`, depth + 1));
  }
  const object = objectValue(value);
  if (!object) return [];
  return Object.entries(object).flatMap(([childKey, child]) =>
    recursiveStrings(child, key ? `${key}.${childKey}` : childKey, depth + 1));
}

function normalizedText(value) {
  return value.replaceAll("\\", "/").toLowerCase();
}

function textContainsPath(text, target) {
  const haystack = normalizedText(text);
  const needle = normalizedPath(target);
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    const before = index === 0 ? "" : haystack[index - 1];
    const after = haystack[index + needle.length] ?? "";
    const beforeBoundary = !before || /[\s"'`=(:,;]/u.test(before);
    const afterBoundary = !after || /[\s"'`),:;\\/]/u.test(after);
    if (beforeBoundary && afterBoundary) return true;
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

function textContainsRelativePath(text, from, target) {
  const relativeTarget = relative(from, target).replaceAll("\\", "/");
  if (!relativeTarget || relativeTarget === ".") return false;
  const normalized = normalizedText(text);
  const needle = normalizedText(relativeTarget);
  return normalized.includes(needle)
    || normalized.includes(needle.replace(/^\.\//u, ""));
}

function toolAccessKind(name) {
  const normalized = name.toLowerCase();
  if (["write", "edit", "apply_patch", "applypatch", "patch"].some((token) =>
    normalized === token || normalized.endsWith(`__${token}`))) return "write";
  if (["bash", "shell", "powershell", "cmd", "read", "glob", "grep", "search", "find", "list", "ls"]
    .some((token) => normalized === token || normalized.includes(token))) return "read";
  return null;
}

function metadataExitCode(metadata) {
  const sources = [metadata, objectValue(metadata?.result)].filter(Boolean);
  for (const source of sources) {
    for (const field of ["exit", "exitCode", "exit_code", "code"]) {
      if (Number.isInteger(source[field])) return source[field];
    }
  }
  return null;
}

function contentExitCode(value) {
  const text = recursiveStrings(value).map((entry) => entry.value).join("\n");
  const match = /\bexit(?:ed)?(?:\s+with)?(?:\s+code)?\s*[:=]?\s*(-?\d+)\b/iu.exec(text);
  return match?.[1] === undefined ? null : Number.parseInt(match[1], 10);
}

function claudeResultStatus(result) {
  if (!result || result.invalidErrorFlag) return { known: false, exitCode: 1 };
  const explicitMetadata = metadataExitCode(result.metadata);
  const errorSignaled = result.isError === true || result.metadata.interrupted === true;
  if (errorSignaled) {
    const explicitFailure = explicitMetadata ?? contentExitCode(result.output);
    if (explicitFailure === 0) return { known: false, exitCode: 1 };
    return { known: true, exitCode: explicitFailure ?? 1 };
  }
  if (result.isError === false && explicitMetadata !== null && explicitMetadata !== 0) {
    return { known: false, exitCode: 1 };
  }
  if (explicitMetadata !== null) return { known: true, exitCode: explicitMetadata };
  return { known: true, exitCode: 0 };
}

function parseAgentToolEvents(jsonl, runner) {
  const events = [];
  let malformedLines = 0;
  for (const [index, line] of jsonl.replace(/^\uFEFF/u, "").split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (objectValue(value)) events.push({ line: index + 1, value });
      else malformedLines += 1;
    } catch {
      malformedLines += 1;
    }
  }

  if (runner === "claude") {
    const uses = [];
    const results = new Map();
    for (const event of events) {
      const value = event.value;
      const message = objectValue(value.message);
      if (value.type === "assistant" && Array.isArray(message?.content)) {
        for (const block of message.content) {
          const tool = objectValue(block);
          if (tool?.type !== "tool_use" || typeof tool.name !== "string") continue;
          uses.push({
            line: event.line,
            id: stringValue(tool.id),
            tool: tool.name,
            input: objectValue(tool.input) ?? {},
          });
        }
      }
      if (value.type !== "user" || !Array.isArray(message?.content)) continue;
      const blocks = message.content.map(objectValue).filter((block) => block?.type === "tool_result");
      const sharedMetadata = blocks.length === 1 ? objectValue(value.tool_use_result) ?? {} : {};
      for (const block of blocks) {
        const id = stringValue(block.tool_use_id);
        if (!id) continue;
        const result = {
          isError: typeof block.is_error === "boolean" ? block.is_error : null,
          invalidErrorFlag: block.is_error !== undefined && typeof block.is_error !== "boolean",
          output: block.content,
          metadata: sharedMetadata,
        };
        results.set(id, [...(results.get(id) ?? []), result]);
      }
    }
    const usesById = new Map();
    for (const use of uses) {
      if (use.id) usesById.set(use.id, [...(usesById.get(use.id) ?? []), use]);
    }
    return {
      events,
      parsedEvents: events.length,
      malformedLines,
      tools: uses.map((use) => {
        const uniquelyIdentified = use.id !== null && usesById.get(use.id)?.length === 1;
        const matches = uniquelyIdentified ? results.get(use.id) ?? [] : [];
        const result = matches.length === 1 ? matches[0] : null;
        const status = claudeResultStatus(result);
        const failed = uniquelyIdentified && result !== null && (result.isError === true
          || result.metadata.interrupted === true
          || (status.known && status.exitCode !== 0));
        const succeeded = uniquelyIdentified && result !== null && !failed;
        return {
          line: use.line,
          id: use.id,
          tool: use.tool,
          input: use.input,
          output: result ? [result.output, result.metadata] : [],
          succeeded,
          resultKnown: result !== null,
          failed,
          exitCode: status.exitCode,
          exitCodeKnown: status.known,
        };
      }),
    };
  }

  return {
    events,
    parsedEvents: events.length,
    malformedLines,
    tools: events.flatMap((event) => {
      const value = event.value;
      const part = objectValue(value.part);
      const state = objectValue(part?.state);
      if (value.type !== "tool_use" || typeof part?.tool !== "string" || !state) return [];
      const metadata = objectValue(state.metadata) ?? {};
      const exitCode = metadataExitCode(metadata);
      return [{
        line: event.line,
        tool: part.tool,
        input: objectValue(state.input) ?? {},
        output: [state.output, metadata],
        succeeded: state.status === "completed" && (exitCode === null || exitCode === 0),
        resultKnown: true,
        failed: state.status !== "completed" || (exitCode !== null && exitCode !== 0),
        exitCode,
      }];
    }),
  };
}

function numberValue(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function memoriesIn(value, depth = 0) {
  if (depth > 4) return 0;
  if (typeof value === "string") {
    try { return memoriesIn(JSON.parse(value), depth + 1); } catch { return 0; }
  }
  if (Array.isArray(value)) return Math.max(0, ...value.map((item) => memoriesIn(item, depth + 1)));
  const object = objectValue(value);
  if (!object) return 0;
  if (Array.isArray(object.memories)) return object.memories.length;
  return Math.max(0, ...Object.values(object).map((item) => memoriesIn(item, depth + 1)));
}

function recomputeAgentMetrics(parsed, runner) {
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  const toolCalls = new Map();
  const reads = new Map();
  let turns = 0;
  let failedTools = 0;
  let failedCommands = 0;
  let failedFileReads = 0;
  let retrievedMemories = 0;
  if (runner === "claude") {
    const terminal = [...parsed.events].reverse().find((entry) => entry.value.type === "result")?.value;
    const usage = objectValue(terminal?.usage) ?? {};
    turns = Math.floor(numberValue(terminal?.num_turns));
    tokens.input = numberValue(usage.input_tokens);
    tokens.output = numberValue(usage.output_tokens);
    tokens.reasoning = numberValue(usage.reasoning_tokens);
    tokens.cacheRead = numberValue(usage.cache_read_input_tokens);
    tokens.cacheWrite = numberValue(usage.cache_creation_input_tokens);
    for (const tool of parsed.tools) {
      toolCalls.set(tool.tool, (toolCalls.get(tool.tool) ?? 0) + 1);
      if (tool.failed) failedTools += 1;
      const normalized = tool.tool.toLowerCase();
      if ((normalized === "bash" || normalized === "powershell") && tool.exitCode !== 0) failedCommands += 1;
      if (normalized === "read") {
        const path = stringValue(tool.input.file_path) ?? stringValue(tool.input.filePath);
        if (tool.succeeded && path) {
          const key = path.toLowerCase();
          reads.set(key, (reads.get(key) ?? 0) + 1);
        } else {
          failedFileReads += 1;
        }
      }
      if (normalized.startsWith("mcp__repomind__repo_session_start")) {
        retrievedMemories = Math.max(retrievedMemories, memoriesIn(tool.output));
      }
    }
  } else {
    for (const event of parsed.events) {
      const value = event.value;
      const part = objectValue(value.part);
      if (value.type === "step_finish" && objectValue(part?.tokens)) {
        turns += 1;
        const eventTokens = part.tokens;
        const cache = objectValue(eventTokens.cache) ?? {};
        tokens.input += numberValue(eventTokens.input);
        tokens.output += numberValue(eventTokens.output);
        tokens.reasoning += numberValue(eventTokens.reasoning);
        tokens.cacheRead += numberValue(cache.read);
        tokens.cacheWrite += numberValue(cache.write);
      }
      if (value.type !== "tool_use" || typeof part?.tool !== "string") continue;
      const state = objectValue(part.state) ?? {};
      const metadata = objectValue(state.metadata) ?? {};
      const input = objectValue(state.input) ?? {};
      const tool = part.tool;
      toolCalls.set(tool, (toolCalls.get(tool) ?? 0) + 1);
      if (state.status !== "completed") failedTools += 1;
      if ((tool === "bash" || tool === "shell") && Number(metadata.exit ?? 0) !== 0) failedCommands += 1;
      if (tool === "read" && typeof input.filePath === "string") {
        if (state.status === "completed") {
          const key = input.filePath.toLowerCase();
          reads.set(key, (reads.get(key) ?? 0) + 1);
        } else {
          failedFileReads += 1;
        }
      }
      if (tool === "repomind_repo_session_start" && typeof state.output === "string") {
        retrievedMemories = Math.max(retrievedMemories, memoriesIn(state.output));
      }
    }
  }
  return {
    turns,
    tokens,
    toolCalls: Object.fromEntries([...toolCalls].sort(([left], [right]) => left.localeCompare(right))),
    failedTools,
    failedCommands,
    fileReads: [...reads.values()].reduce((sum, count) => sum + count, 0),
    failedFileReads,
    repeatedFileReads: [...reads.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0),
    repoMindCalls: [...toolCalls].filter(([name]) => name.toLowerCase().startsWith(runner === "claude" ? "mcp__repomind__" : "repomind_"))
      .reduce((sum, [, count]) => sum + count, 0),
    retrievedMemories,
  };
}

function recomputeLegacyReadMetrics(parsed) {
  const reads = new Map();
  for (const tool of parsed.tools) {
    if (tool.tool.toLowerCase() !== "read") continue;
    const path = stringValue(tool.input.filePath) ?? stringValue(tool.input.file_path);
    if (!path) continue;
    const key = path.toLowerCase();
    reads.set(key, (reads.get(key) ?? 0) + 1);
  }
  return {
    fileReads: [...reads.values()].reduce((sum, count) => sum + count, 0),
    repeatedFileReads: [...reads.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0),
  };
}

function outputHasContent(value) {
  return recursiveStrings(value).some((entry) => entry.value.trim().length > 0);
}

function recomputeAgentTerminal(parsed, runner) {
  if (runner === "claude") {
    const terminalResults = parsed.events.filter((entry) => entry.value.type === "result");
    const explicitErrors = parsed.events.filter((entry) => {
      const event = entry.value;
      return event.type === "error"
        || (event.type === "assistant" && (event.is_api_error_message === true || typeof event.error === "string"))
        || (event.type === "result" && (event.is_error === true
          || (typeof event.terminal_reason === "string" && event.terminal_reason !== "completed")
          || (event.api_error_status !== null && event.api_error_status !== undefined)));
    }).length;
    const terminal = terminalResults.at(-1);
    const clean = terminalResults.length === 1
      && parsed.events.at(-1) === terminal
      && terminal?.value.is_error === false
      && terminal.value.terminal_reason === "completed";
    return explicitErrors > 0 ? "explicit-error" : clean ? "clean-stop" : "incomplete";
  }
  const explicitErrors = parsed.events.filter((entry) => entry.value.type === "error").length;
  const last = parsed.events.at(-1)?.value;
  return explicitErrors > 0
    ? "explicit-error"
    : last?.type === "step_finish" && objectValue(last.part)?.reason === "stop"
      ? "clean-stop"
      : "incomplete";
}

export function auditAgentEventLeakage(input) {
  const parsed = parseAgentToolEvents(input.jsonl, input.runner);
  const findings = [];
  const auditedTools = parsed.tools.filter((tool) => {
    const access = toolAccessKind(tool.tool);
    return access === "write"
      || (access === "read" && (tool.succeeded || (!tool.succeeded && outputHasContent(tool.output))));
  });
  const pathKeys = /(^|\.)(file_?path|path|directory|cwd|root|pattern)$/iu;
  const targets = input.forbiddenTargets ?? [
    ...(input.hiddenTargets ?? []).map((path) => ({ kind: "hidden-verifier", path })),
    ...(input.siblingRepositories ?? []).map((path) => ({ kind: "sibling-repository", path })),
    ...(input.siblingDataDirectories ?? []).map((path) => ({ kind: "sibling-data", path })),
  ];

  for (const tool of auditedTools) {
    const values = [
      ...recursiveStrings(tool.input).map((entry) => ({ ...entry, source: "input" })),
      ...recursiveStrings(tool.output).map((entry) => ({ ...entry, source: "output" })),
    ];
    for (const target of targets) {
      let matched = false;
      let source = null;
      for (const entry of values) {
        if (textContainsPath(entry.value, target.path)
          || textContainsRelativePath(entry.value, input.repository, target.path)) {
          matched = true;
          source = `${entry.source}.${entry.key}`;
          break;
        }
        if (entry.source === "input" && pathKeys.test(entry.key)) {
          const candidate = isAbsolute(entry.value)
            ? resolve(entry.value)
            : resolve(input.repository, entry.value);
          if (samePath(candidate, target.path) || pathInside(target.path, candidate, true)) {
            matched = true;
            source = `${entry.source}.${entry.key}`;
            break;
          }
        }
      }
      if (matched) {
        findings.push({
          kind: target.kind,
          eventLine: tool.line,
          tool: tool.tool,
          access: toolAccessKind(tool.tool),
          succeeded: tool.succeeded,
          source,
          target: target.path,
        });
      }
    }
  }

  const deduplicated = [];
  const seen = new Set();
  for (const finding of findings) {
    const key = JSON.stringify(finding);
    if (!seen.has(key)) deduplicated.push(finding);
    seen.add(key);
  }
  return {
    parsedEvents: parsed.parsedEvents,
    malformedLines: parsed.malformedLines,
    successfulReadTools: auditedTools.filter((tool) => toolAccessKind(tool.tool) === "read" && tool.succeeded).length,
    auditedTools: auditedTools.length,
    commandCount: parsed.tools.filter((tool) => {
      const normalized = tool.tool.toLowerCase();
      return ["bash", "shell", "powershell"].includes(normalized)
        && typeof tool.input.command === "string" && tool.input.command.trim().length > 0;
    }).length,
    terminal: recomputeAgentTerminal(parsed, input.runner),
    metrics: recomputeAgentMetrics(parsed, input.runner),
    legacyReadMetrics: recomputeLegacyReadMetrics(parsed),
    findings: deduplicated,
  };
}

function aggregateEventMetrics(values) {
  const aggregate = {
    turns: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    toolCalls: {},
    failedTools: 0,
    failedCommands: 0,
    fileReads: 0,
    failedFileReads: 0,
    repeatedFileReads: 0,
    repoMindCalls: 0,
    retrievedMemories: 0,
  };
  for (const value of values) {
    aggregate.turns += numberValue(value.turns);
    for (const token of Object.keys(aggregate.tokens)) aggregate.tokens[token] += numberValue(value.tokens?.[token]);
    for (const [tool, count] of Object.entries(objectValue(value.toolCalls) ?? {})) {
      aggregate.toolCalls[tool] = (aggregate.toolCalls[tool] ?? 0) + numberValue(count);
    }
    for (const field of [
      "failedTools",
      "failedCommands",
      "fileReads",
      "failedFileReads",
      "repeatedFileReads",
      "repoMindCalls",
      "retrievedMemories",
    ]) aggregate[field] += numberValue(value[field]);
  }
  aggregate.toolCalls = Object.fromEntries(
    Object.entries(aggregate.toolCalls).sort(([left], [right]) => left.localeCompare(right)),
  );
  return aggregate;
}

function metricsComparable(actual, expected, legacyReadMetrics = null) {
  const normalizedActual = { ...actual };
  const normalizedExpected = { ...expected };
  if (!("failedFileReads" in normalizedExpected)) {
    if (legacyReadMetrics) {
      normalizedActual.fileReads = legacyReadMetrics.fileReads;
      normalizedActual.repeatedFileReads = legacyReadMetrics.repeatedFileReads;
    }
    delete normalizedActual.failedFileReads;
  }
  if (!("failedFileReads" in normalizedActual)) delete normalizedExpected.failedFileReads;
  return isDeepStrictEqual(normalizedActual, normalizedExpected);
}

function snapshotsEqual(left, right) {
  return left?.branch === right?.branch
    && left?.head === right?.head
    && left?.dirty === right?.dirty
    && left?.status === right?.status;
}

function transientSignals(text) {
  return TRANSIENT_PATTERNS.filter(([, patterns]) => patterns.some((pattern) => pattern.test(text)))
    .map(([signal]) => signal);
}

function openCodeResumeTokenAvailable(jsonl) {
  const ids = new Set();
  for (const line of jsonl.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (typeof event.sessionID === "string" && event.sessionID.trim()) ids.add(event.sessionID.trim());
    } catch { /* malformed event lines are audited separately */ }
  }
  return ids.size === 1;
}

function recomputeRetryAssessment(
  attempt,
  stdout,
  stderr,
  runner,
  recomputedEvents = attempt.events,
  recomputedCommandCount = null,
  recomputedTerminal = null,
) {
  const processResult = objectValue(attempt.process) ?? {};
  const outcome = objectValue(attempt.outcome) ?? {};
  const events = objectValue(recomputedEvents) ?? {};
  const toolCalls = objectValue(events.toolCalls) ?? {};
  const executionMode = attempt.executionMode === "resume" ? "resume" : "fresh";
  const abnormalExitOrTerminal = processResult.exitCode === null
    || processResult.exitCode !== 0
    || processResult.error !== null
    || (recomputedTerminal ?? outcome.trace?.terminal) !== "clean-stop";
  const zeroInputOutputTokens = numberValue(events.tokens?.input) === 0
    && numberValue(events.tokens?.output) === 0;
  const commandCount = recomputedCommandCount ?? (Array.isArray(outcome.commands) ? outcome.commands.length : 0);
  const zeroAgentActivity = Object.values(toolCalls).reduce((sum, count) => sum + numberValue(count), 0) === 0
    && commandCount === 0
    && numberValue(events.repoMindCalls) === 0;
  const repositoryUnchanged = snapshotsEqual(attempt.git?.before, attempt.git?.after);
  const interruptFree = processResult.timedOut === false
    && processResult.aborted === false
    && processResult.signal === null;
  const matchedSignals = transientSignals([stdout, stderr].join("\n"));
  const transientFailureMatched = matchedSignals.length > 0;
  const upstreamStreamFailure = matchedSignals.includes("upstream-http2-stream");
  const resumeSupported = runner === "opencode";
  const resumeTokenAvailable = runner === "opencode" && openCodeResumeTokenAvailable(stdout);
  const noCommandActivity = commandCount === 0;
  const noRepoMindActivity = numberValue(events.repoMindCalls) === 0;
  const resumeSafeTools = Object.entries(toolCalls)
    .filter(([, count]) => numberValue(count) > 0)
    .every(([tool]) => RESUME_SAFE_TOOLS.has(tool.toLowerCase()));
  const conditions = {
    abnormalExitOrTerminal,
    zeroInputOutputTokens,
    zeroAgentActivity,
    repositoryUnchanged,
    interruptFree,
    transientFailureMatched,
    upstreamStreamFailure,
    resumeSupported,
    resumeTokenAvailable,
    noCommandActivity,
    noRepoMindActivity,
    resumeSafeTools,
  };
  const freshConditions = {
    abnormalExitOrTerminal,
    zeroInputOutputTokens,
    zeroAgentActivity,
    repositoryUnchanged,
    interruptFree,
    transientFailureMatched,
  };
  const freshLabels = {
    abnormalExitOrTerminal: "agent-exit-and-terminal-were-normal",
    zeroInputOutputTokens: "agent-produced-input-or-output-tokens",
    zeroAgentActivity: "agent-observed-tools-commands-or-repomind-calls",
    repositoryUnchanged: "repository-changed-during-attempt",
    interruptFree: "attempt-was-aborted-signaled-or-host-timed-out",
    transientFailureMatched: "no-explicit-transient-infrastructure-signal",
  };
  const freshBlockers = Object.keys(freshConditions).filter((condition) => !freshConditions[condition])
    .map((condition) => freshLabels[condition]);
  const resumeConditions = {
    abnormalExitOrTerminal,
    interruptFree,
    upstreamStreamFailure,
    resumeSupported,
    resumeTokenAvailable,
    noCommandActivity,
    noRepoMindActivity,
    resumeSafeTools,
  };
  const resumeLabels = {
    abnormalExitOrTerminal: "agent-exit-and-terminal-were-normal",
    interruptFree: "attempt-was-aborted-signaled-or-host-timed-out",
    upstreamStreamFailure: "failure-is-not-upstream-http2-stream",
    resumeSupported: "adapter-does-not-support-session-resume",
    resumeTokenAvailable: "missing-provider-session-token",
    noCommandActivity: "agent-observed-shell-or-command-activity",
    noRepoMindActivity: "agent-observed-repomind-activity",
    resumeSafeTools: "agent-observed-nonlocal-or-unsupported-tools",
  };
  const resumeBlockers = Object.keys(resumeConditions).filter((condition) => !resumeConditions[condition])
    .map((condition) => resumeLabels[condition]);
  const freshEligible = freshBlockers.length === 0;
  const resumeEligible = resumeBlockers.length === 0;
  const mode = executionMode === "resume"
    ? resumeEligible ? "resume" : "none"
    : freshEligible ? "fresh" : resumeEligible ? "resume" : "none";
  return {
    eligible: mode !== "none",
    mode,
    matchedSignals,
    conditions,
    blockers: mode === "none"
      ? (executionMode === "resume" || upstreamStreamFailure ? resumeBlockers : freshBlockers)
      : [],
  };
}

function closeNumber(left, right, tolerance = 0.01) {
  return typeof left === "number" && typeof right === "number" && Math.abs(left - right) <= tolerance;
}

function closeNullableNumber(left, right, tolerance = 0.01) {
  return (left === null && right === null) || closeNumber(left, right, tolerance);
}

function addFailure(state, group, id, message, details = undefined) {
  state.failures.push({
    group,
    id,
    message,
    ...(details === undefined ? {} : { details }),
  });
}

function check(state, condition, group, id, message, details = undefined) {
  if (!condition) addFailure(state, group, id, message, details);
  return condition;
}

function validateManifest(state, suiteRoot, summary) {
  const candidates = readdirSync(suiteRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^manifest(?:\..+)?\.json$/u.test(entry.name))
    .map((entry) => {
      const path = join(suiteRoot, entry.name);
      const bytes = readFileSync(path);
      let value = null;
      let parseError = null;
      try {
        value = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
      }
      return { path, sha256: sha256(bytes), value, parseError };
    });
  const claimedHash = stringValue(summary.provenance?.manifestSha256);
  check(state, claimedHash !== null && /^[a-f0-9]{64}$/u.test(claimedHash), "manifest", "claimed-hash",
    "summary provenance must contain a lowercase SHA-256 manifest hash");
  const hashMatches = claimedHash ? candidates.filter((candidate) => candidate.sha256 === claimedHash) : [];
  check(state, hashMatches.length === 1, "manifest", "hash-match",
    "exactly one suite manifest must match summary.provenance.manifestSha256", {
      claimedHash,
      matches: hashMatches.map((candidate) => candidate.path),
      candidates: candidates.map((candidate) => ({ path: candidate.path, sha256: candidate.sha256 })),
    });
  let selected = hashMatches[0] ?? candidates.find((candidate) => candidate.value?.name === summary.name) ?? null;
  if (!selected) return null;
  check(state, selected.parseError === null && objectValue(selected.value) !== null,
    "manifest", "parse", "matched manifest must contain a JSON object", selected.parseError);
  const manifest = objectValue(selected.value);
  if (!manifest) return null;
  check(state, manifest.version === 1, "manifest", "version", "cross-session manifest version must be 1", manifest.version);
  check(state, manifest.name === summary.name, "manifest", "name", "manifest and summary names must match", {
    manifest: manifest.name,
    summary: summary.name,
  });
  check(state, Array.isArray(manifest.sequences) && manifest.sequences.length > 0,
    "manifest", "sequences", "manifest must contain at least one sequence");
  for (const [index, sequenceValue] of (manifest.sequences ?? []).entries()) {
    const sequence = objectValue(sequenceValue);
    if (!sequence) continue;
    check(state, typeof sequence.baseRepository === "string"
      && samePath(sequence.baseRepository, join(suiteRoot, "repository"))
      && safeExistingPath(suiteRoot, sequence.baseRepository),
    "manifest", `sequence:${index}:base-repository`,
    "every sequence baseRepository must resolve to the suite repository", sequence.baseRepository);
    check(state, typeof sequence.baseCommit === "string" && /^[a-f0-9]{40,64}$/u.test(sequence.baseCommit),
      "manifest", `sequence:${index}:base-commit`, "sequence baseCommit must be a lowercase Git object id", sequence.baseCommit);
  }
  return { ...selected, manifest };
}

function buildExpectedRuns(state, manifest, repeat) {
  const expected = new Map();
  const sequenceIds = new Set();
  for (const sequenceValue of manifest.sequences ?? []) {
    const sequence = objectValue(sequenceValue);
    if (!sequence) {
      addFailure(state, "manifest", "sequence-shape", "every manifest sequence must be an object");
      continue;
    }
    const sequenceId = stringValue(sequence.id);
    if (!sequenceId || !/^[a-z0-9][a-z0-9._-]*$/u.test(sequenceId)) {
      addFailure(state, "manifest", "sequence-id", "manifest sequence id is invalid", sequence.id);
      continue;
    }
    if (sequenceIds.has(sequenceId)) addFailure(state, "manifest", "sequence-id", "manifest sequence id is duplicated", sequenceId);
    sequenceIds.add(sequenceId);
    if (!Array.isArray(sequence.stages) || sequence.stages.length < 2) {
      addFailure(state, "manifest", `${sequenceId}:stages`, "cross-session sequence must contain at least two stages");
      continue;
    }
    const stageIds = new Set();
    for (const [stageIndex, stageValue] of sequence.stages.entries()) {
      const stage = objectValue(stageValue);
      const stageId = stringValue(stage?.id);
      if (!stage || !stageId) {
        addFailure(state, "manifest", `${sequenceId}:stage:${stageIndex}`, "manifest stage is invalid");
        continue;
      }
      if (stageIds.has(stageId)) addFailure(state, "manifest", `${sequenceId}:${stageId}`, "manifest stage id is duplicated");
      stageIds.add(stageId);
      check(state, Array.isArray(stage.publicChecks) && stage.publicChecks.length > 0,
        "manifest", `${sequenceId}:${stageId}:public`, "stage must define public checks");
      check(state, Array.isArray(stage.hiddenChecks) && stage.hiddenChecks.length > 0,
        "manifest", `${sequenceId}:${stageId}:hidden`, "stage must define hidden checks");
      if (stage.allowedChanges !== undefined) {
        check(state, uniqueStrings(stage.allowedChanges)
          && stage.allowedChanges.every((path) => !isAbsolute(path) && !path.replaceAll("\\", "/").split("/").includes("..")),
        "manifest", `${sequenceId}:${stageId}:allowlist`, "allowedChanges must contain unique repository-relative paths");
      }
      for (let iteration = 1; iteration <= repeat; iteration += 1) {
        for (const arm of ARMS) {
          const key = `${sequenceId}\0${arm}\0${iteration}\0${stageId}`;
          expected.set(key, { sequence, sequenceId, stage, stageId, stageIndex, iteration, arm });
        }
      }
    }
  }
  return expected;
}

function resolvedCheck(checkValue, repository) {
  const value = objectValue(checkValue) ?? {};
  return {
    command: typeof value.command === "string" ? value.command.replaceAll("{repo}", repository) : value.command,
    args: Array.isArray(value.args)
      ? value.args.map((argument) => typeof argument === "string" ? argument.replaceAll("{repo}", repository) : argument)
      : [],
  };
}

function validateCheckResults(state, run, expected) {
  const label = runKey(run);
  const publicChecks = Array.isArray(run.publicChecks) ? run.publicChecks : [];
  const hiddenChecks = Array.isArray(run.hiddenChecks) ? run.hiddenChecks : [];
  const hasAllowlist = Array.isArray(expected.stage.allowedChanges);
  const persistedPublic = hasAllowlist ? publicChecks.slice(1) : publicChecks;
  if (hasAllowlist) {
    const scope = objectValue(publicChecks[0]);
    check(state, scope?.command === "repomind:allowed-changes" && scope.passed === true,
      "allowlist", `${label}:scope-check`, "runtime allowedChanges check must exist and pass");
  }
  const expectedPublic = expected.stage.publicChecks ?? [];
  const expectedHidden = expected.stage.hiddenChecks ?? [];
  check(state, persistedPublic.length === expectedPublic.length, "artifacts", `${label}:public-count`,
    "public check result count must match the manifest", { expected: expectedPublic.length, actual: persistedPublic.length });
  check(state, hiddenChecks.length === expectedHidden.length, "artifacts", `${label}:hidden-count`,
    "hidden check result count must match the manifest", { expected: expectedHidden.length, actual: hiddenChecks.length });
  for (const [index, resultValue] of persistedPublic.entries()) {
    const result = objectValue(resultValue);
    const manifestCheck = resolvedCheck(expectedPublic[index], run.repository);
    check(state, result?.command === manifestCheck.command && isDeepStrictEqual(result?.args, manifestCheck.args),
      "artifacts", `${label}:public:${index}`, "public check command must match the manifest");
  }
  for (const [index, resultValue] of hiddenChecks.entries()) {
    const result = objectValue(resultValue);
    const manifestCheck = resolvedCheck(expectedHidden[index], run.repository);
    check(state, result?.command === manifestCheck.command && isDeepStrictEqual(result?.args, manifestCheck.args),
      "artifacts", `${label}:hidden:${index}`, "hidden check command must match the manifest");
  }
  for (const [index, resultValue] of [...publicChecks, ...hiddenChecks].entries()) {
    const result = objectValue(resultValue);
    check(state, result !== null
      && typeof result.passed === "boolean"
      && result.passed === (result.exitCode === 0 && result.signal === null),
    "artifacts", `${label}:check-result:${index}`, "check passed telemetry must agree with exitCode and signal");
  }
}

function validateContextLayer(state, run, layerName) {
  const label = runKey(run);
  const layer = objectValue(run.context?.[layerName]);
  if (!layer) {
    addFailure(state, "context", `${label}:${layerName}`, "context layer telemetry is missing");
    return [];
  }
  const hasDeduplicationTelemetry = ["deduplicated", "deduplicatedIds", "deduplicatedChars", "candidateChars"]
    .some((field) => Object.hasOwn(layer, field));
  const numericFields = ["provided", "eligible", "injected", "truncated", "omitted", "allocatedChars", "sourceChars", "sectionChars"];
  if (hasDeduplicationTelemetry) numericFields.push("deduplicated", "deduplicatedChars", "candidateChars");
  for (const field of numericFields) {
    check(state, Number.isInteger(layer[field]) && layer[field] >= 0,
      "context", `${label}:${layerName}:${field}`, "context layer counters must be non-negative integers", layer[field]);
  }
  for (const [counter, idsField] of [["provided", "providedIds"], ["eligible", "eligibleIds"], ["injected", "injectedIds"]]) {
    check(state, uniqueStrings(layer[idsField]) && layer[counter] === layer[idsField].length,
      "context", `${label}:${layerName}:${idsField}`, `${idsField} must be unique and agree with ${counter}`);
  }
  if (uniqueStrings(layer.providedIds) && uniqueStrings(layer.eligibleIds) && uniqueStrings(layer.injectedIds)) {
    check(state, layer.eligibleIds.every((id) => layer.providedIds.includes(id)),
      "context", `${label}:${layerName}:eligible-subset`, "eligible ids must be a subset of provided ids");
    check(state, layer.injectedIds.every((id) => layer.eligibleIds.includes(id)),
      "context", `${label}:${layerName}:injected-subset`, "injected ids must be a subset of eligible ids");
  }
  if (hasDeduplicationTelemetry) {
    check(state, uniqueStrings(layer.deduplicatedIds) && layer.deduplicated === layer.deduplicatedIds.length,
      "context", `${label}:${layerName}:deduplicatedIds`, "deduplicatedIds must be unique and agree with deduplicated");
    if (uniqueStrings(layer.eligibleIds) && uniqueStrings(layer.injectedIds) && uniqueStrings(layer.deduplicatedIds)) {
      check(state, layer.deduplicatedIds.every((id) => layer.eligibleIds.includes(id)),
        "context", `${label}:${layerName}:deduplicated-subset`, "deduplicated ids must be a subset of eligible ids");
      check(state, layer.deduplicatedIds.every((id) => !layer.injectedIds.includes(id)),
        "context", `${label}:${layerName}:deduplicated-disjoint`, "deduplicated and injected ids must be disjoint");
    }
    check(state, layer.injected + layer.omitted + layer.deduplicated === layer.eligible,
      "context", `${label}:${layerName}:budget`, "eligible must equal injected + omitted + deduplicated");
    check(state, layer.candidateChars + layer.deduplicatedChars === layer.sourceChars,
      "context", `${label}:${layerName}:candidate-chars`, "candidateChars + deduplicatedChars must equal sourceChars");
  } else {
    check(state, layer.injected <= layer.eligible && layer.omitted === layer.eligible - layer.injected,
      "context", `${label}:${layerName}:budget`, "legacy injected/omitted context counters are inconsistent");
  }
  check(state, layer.truncated <= layer.injected && layer.sectionChars <= layer.allocatedChars,
    "context", `${label}:${layerName}:rendered`, "truncated/section context counters exceed represented records or allocation");
  return Array.isArray(layer.injectedIds) ? layer.injectedIds : [];
}

function checksPassed(checks) {
  return Array.isArray(checks) && checks.length > 0 && checks.every((entry) => entry?.passed === true);
}

function validateRunIntegrityClaims(state, run) {
  const label = runKey(run);
  check(state, run.agent?.exitCode === 0
    && run.agent?.signal === null
    && run.agent?.timedOut === false
    && run.agent?.aborted === false
    && run.agent?.error === null,
  "runtime", `${label}:clean-exit`, "Agent must independently report a clean process exit", run.agent);
  check(state, run.agent?.retryExhausted === false,
    "runtime", `${label}:retry-exhausted`, "Agent infrastructure retry budget must not be exhausted");
  check(state, run.lifecycle?.commitSucceeded === true,
    "runtime", `${label}:commit`, "RepoMind Session commit must complete");
  check(state, run.events?.repoMindCalls === 0,
    "runtime", `${label}:repomind-calls`, "Host-managed Agent must not call RepoMind MCP", run.events?.repoMindCalls);
  if (Object.hasOwn(run.events ?? {}, "failedFileReads")) {
    check(state, Number.isInteger(run.events.failedFileReads) && run.events.failedFileReads >= 0,
      "events", `${label}:failed-file-reads`, "failedFileReads must be a non-negative integer");
  }
  const checks = [...(Array.isArray(run.publicChecks) ? run.publicChecks : []), ...(Array.isArray(run.hiddenChecks) ? run.hiddenChecks : [])];
  const expectedVerification = checks.some((entry) => entry?.exitCode !== null && entry?.exitCode !== 0)
    ? false
    : checks.some((entry) => entry?.exitCode === null) ? null : true;
  const verification = run.quality?.authoritativeVerification;
  check(state, verification?.authority === "benchmark-manifest"
    && verification?.checks === checks.length
    && verification?.passed === expectedVerification
    && verification?.snapshotStable === true,
  "runtime", `${label}:authoritative-verification`, "authoritative verification telemetry is inconsistent", {
    expected: { authority: "benchmark-manifest", checks: checks.length, passed: expectedVerification, snapshotStable: true },
    actual: verification,
  });
  check(state, run.quality?.maintenanceEligible === (run.quality?.status === "success"),
    "runtime", `${label}:maintenance-eligibility`, "maintenanceEligible must exactly follow successful quality status");
  const expectedLifecycleStatus = run.quality?.status === "success" ? "committed" : run.quality?.status;
  check(state, run.lifecycle?.status === expectedLifecycleStatus,
    "runtime", `${label}:quality-lifecycle`, "lifecycle status must match Host quality assessment", {
      quality: run.quality?.status,
      lifecycle: run.lifecycle?.status,
    });
  if (run.lifecycle?.status === "committed") {
    check(state, objectValue(run.maintenance) !== null
      && !["partial", "failed"].includes(run.maintenance.status)
      && typeof run.lifecycle.maintenanceMs === "number",
    "runtime", `${label}:maintenance`, "committed Session must contain successful derived maintenance telemetry", run.maintenance);
  } else {
    check(state, run.maintenance === null && run.lifecycle?.maintenanceMs === null,
      "runtime", `${label}:maintenance`, "non-committed Session must not run derived maintenance");
  }
  check(state, run.memoryState?.openSessions === 0 && run.memoryState?.runningHostRuns === 0,
    "runtime", `${label}:open-resources`, "every stage snapshot must report zero open Sessions and running Host runs", run.memoryState);
  const expectedHostMs = numberValue(run.lifecycle?.startMs)
    + numberValue(run.lifecycle?.agentMs)
    + numberValue(run.lifecycle?.commitMs)
    + numberValue(run.lifecycle?.maintenanceMs);
  check(state, closeNumber(run.lifecycle?.hostLifecycleMs, expectedHostMs, 0.02),
    "runtime", `${label}:host-duration`, "Host lifecycle duration must equal its component durations", {
      expected: expectedHostMs,
      actual: run.lifecycle?.hostLifecycleMs,
    });
}

function validateRunMatrix(state, summary, manifest, resultsDirectory) {
  const repeat = integerValue(summary.repeat);
  check(state, repeat !== null && repeat >= 1 && repeat <= 100,
    "summary", "repeat", "summary repeat must be an integer between 1 and 100", summary.repeat);
  if (repeat === null || repeat < 1) return { runs: [], expected: new Map(), counts: null };
  const expected = buildExpectedRuns(state, manifest, repeat);
  const runs = Array.isArray(summary.runs) ? summary.runs.filter((run) => objectValue(run)) : [];
  check(state, Array.isArray(summary.runs), "summary", "runs", "summary.runs must be an array");
  check(state, runs.length === expected.size, "counts", "stage-runs",
    "actual stage run count must match repeat x arms x manifest stages", { expected: expected.size, actual: runs.length });
  const actualKeys = new Set();
  let processAttempts = 0;
  let retries = 0;
  let retriedStageRuns = 0;
  let exhaustedStageRuns = 0;
  const runnerSet = new Set();
  const modelSet = new Set();
  const validRuns = [];

  for (const run of runs) {
    const key = `${run.sequenceId}\0${run.arm}\0${run.iteration}\0${run.stageId}`;
    const label = runKey(run);
    if (actualKeys.has(key)) addFailure(state, "counts", `${label}:duplicate`, "stage run key is duplicated");
    actualKeys.add(key);
    const expectedRun = expected.get(key);
    if (!expectedRun) {
      addFailure(state, "counts", `${label}:unexpected`, "stage run is not present in the manifest/repeat matrix");
      continue;
    }
    check(state, run.stageIndex === expectedRun.stageIndex, "counts", `${label}:stage-index`,
      "stageIndex must match manifest order", { expected: expectedRun.stageIndex, actual: run.stageIndex });
    if (expectedRun.stage.runner !== undefined) {
      check(state, run.runner === expectedRun.stage.runner, "counts", `${label}:runner`,
        "run runner must match the stage override");
    }
    if (expectedRun.stage.model !== undefined) {
      check(state, run.model === expectedRun.stage.model, "counts", `${label}:model`,
        "run model must match the stage override");
    }
    check(state, Number.isInteger(run.maxMemories) && run.maxMemories >= 0 && run.maxMemories <= 20,
      "context", `${label}:max-memories`, "run maxMemories must be an integer from 0 through 20", run.maxMemories);
    if (expectedRun.stage.maxMemories !== undefined) {
      check(state, run.maxMemories === expectedRun.stage.maxMemories,
        "context", `${label}:stage-max-memories`, "run maxMemories must match the manifest stage override", {
          expected: expectedRun.stage.maxMemories,
          actual: run.maxMemories,
        });
    }
    runnerSet.add(run.runner);
    modelSet.add(run.model);
    for (const field of ["requestedCommit", "baseCommit", "checkpointCommit", "checkpointTree"]) {
      check(state, typeof run[field] === "string" && /^[a-f0-9]{40,64}$/u.test(run[field]),
        "git", `${label}:${field}`, `${field} must be a lowercase Git object id`, run[field]);
    }
    check(state, run.previousCheckpointCommit === null
      || (typeof run.previousCheckpointCommit === "string" && /^[a-f0-9]{40,64}$/u.test(run.previousCheckpointCommit)),
    "git", `${label}:previousCheckpointCommit`, "previousCheckpointCommit must be null or a lowercase Git object id",
    run.previousCheckpointCommit);

    const name = expectedRunName(run.sequenceId, run.arm, run.iteration, run.stageIndex, run.stageId);
    const expectedRepository = join(resultsDirectory, "runs", name);
    const expectedArtifactDirectory = join(resultsDirectory, "artifacts", name);
    const expectedDataDirectory = run.arm === "shared"
      ? join(resultsDirectory, "data", `${run.sequenceId}-${run.iteration}-shared`)
      : join(resultsDirectory, "data", `${run.sequenceId}-${run.iteration}-isolated-s${run.stageIndex + 1}`);
    check(state, typeof run.repository === "string" && samePath(run.repository, expectedRepository),
      "paths", `${label}:repository`, "run repository path must equal its deterministic results/runs path", {
        expected: expectedRepository,
        actual: run.repository,
      });
    check(state, typeof run.dataDirectory === "string" && samePath(run.dataDirectory, expectedDataDirectory),
      "paths", `${label}:data`, "run dataDirectory must equal its deterministic results/data path", {
        expected: expectedDataDirectory,
        actual: run.dataDirectory,
      });
    const artifacts = objectValue(run.artifacts);
    for (const [field, filename] of [["events", "events.jsonl"], ["stderr", "stderr.log"], ["report", "run.json"]]) {
      const expectedPath = join(expectedArtifactDirectory, filename);
      check(state, typeof artifacts?.[field] === "string" && samePath(artifacts[field], expectedPath),
        "paths", `${label}:artifact:${field}`, `artifact ${field} must use its deterministic path`);
    }
    check(state, safeExistingPath(join(resultsDirectory, "runs"), expectedRepository),
      "paths", `${label}:repository-containment`, "repository must exist and resolve within results/runs");
    check(state, safeExistingPath(join(resultsDirectory, "data"), expectedDataDirectory),
      "paths", `${label}:data-containment`, "data directory must exist and resolve within results/data");
    check(state, safeExistingPath(join(resultsDirectory, "artifacts"), expectedArtifactDirectory),
      "paths", `${label}:artifact-containment`, "artifact directory must exist and resolve within results/artifacts");

    check(state, run.initialWorktreeClean === true, "allowlist", `${label}:initial-clean`,
      "summary must report a clean initial worktree");
    const changedFiles = Array.isArray(run.changedFiles) ? run.changedFiles : [];
    const unexpectedChanges = Array.isArray(run.unexpectedChanges) ? run.unexpectedChanges : [];
    check(state, uniqueStrings(run.changedFiles), "allowlist", `${label}:changed-files`,
      "changedFiles must be a unique string array");
    check(state, uniqueStrings(run.unexpectedChanges) && unexpectedChanges.length === 0,
      "allowlist", `${label}:unexpected`, "unexpectedChanges must be an empty unique string array", unexpectedChanges);
    if (Array.isArray(expectedRun.stage.allowedChanges)) {
      check(state, changedFiles.every((path) => expectedRun.stage.allowedChanges.includes(path)),
        "allowlist", `${label}:subset`, "changedFiles must remain within manifest allowedChanges", {
          changedFiles,
          allowedChanges: expectedRun.stage.allowedChanges,
        });
    }
    validateCheckResults(state, run, expectedRun);
    validateRunIntegrityClaims(state, run);

    const attempts = integerValue(run.agent?.attempts);
    const runRetries = integerValue(run.agent?.infrastructureRetries);
    check(state, attempts !== null && attempts >= 1, "counts", `${label}:attempts`,
      "agent attempts must be a positive integer", run.agent?.attempts);
    check(state, runRetries !== null && runRetries >= 0 && attempts !== null && runRetries === attempts - 1,
      "counts", `${label}:retries`, "infrastructureRetries must equal attempts - 1", {
        attempts,
        retries: runRetries,
      });
    if (attempts !== null) processAttempts += attempts;
    if (runRetries !== null) {
      retries += runRetries;
      if (runRetries > 0) retriedStageRuns += 1;
    }
    if (run.agent?.retryExhausted === true) exhaustedStageRuns += 1;

    for (const layer of LAYERS) validateContextLayer(state, run, layer);
    const injectedTotal = LAYERS.reduce((sum, layer) => sum + Number(run.context?.[layer]?.injected ?? 0), 0);
    if (run.arm === "isolated") {
      check(state, injectedTotal === 0, "context", `${label}:isolated`,
        "isolated stages must not receive L1-L3 records from another session", injectedTotal);
    } else if (run.stageIndex === 0) {
      check(state, injectedTotal === 0, "context", `${label}:shared-producer`,
        "the first shared stage must begin without L1-L3 records", injectedTotal);
    } else {
      check(state, injectedTotal > 0, "context", `${label}:shared-transfer`,
        "shared transfer stages must receive at least one L1-L3 record so the treatment was delivered", injectedTotal);
    }
    if (expectedRun.stage.maxMemories === 0) {
      check(state, Number(run.context?.l1?.injected ?? 0) === 0,
        "context", `${label}:derived-only-l1`, "a maxMemories=0 stage must inject zero L1 records");
      if (run.arm === "shared") {
        check(state, Number(run.context?.l2?.injected ?? 0) > 0,
          "context", `${label}:derived-only-l2`, "a shared maxMemories=0 stage must inject L2");
        check(state, Number(run.context?.l3?.injected ?? 0) > 0,
          "context", `${label}:derived-only-l3`, "a shared maxMemories=0 stage must inject L3");
      }
    }
    check(state, Number.isInteger(run.context?.budgetChars) && run.context.budgetChars > 0
      && Number.isInteger(run.context?.contextChars) && run.context.contextChars >= 0
      && run.context.contextChars <= run.context.budgetChars
      && run.context.unusedChars === run.context.budgetChars - run.context.contextChars,
    "context", `${label}:budget`, "context budget totals are inconsistent");
    const l1Provided = run.context?.l1?.providedIds ?? [];
    const l2Provided = run.context?.l2?.providedIds ?? [];
    const l3Provided = run.context?.l3?.providedIds ?? [];
    check(state, setEqual(run.lifecycle?.retrievedMemoryIds ?? [], l1Provided),
      "context", `${label}:l1-retrieval`, "lifecycle L1 retrieval ids must match context provided ids");
    check(state, setEqual(run.lifecycle?.retrievedModuleNarrativeIds ?? [], l2Provided),
      "context", `${label}:l2-retrieval`, "lifecycle L2 retrieval ids must match context provided ids");
    const expectedProfileIds = run.lifecycle?.repositoryProfileId ? [run.lifecycle.repositoryProfileId] : [];
    check(state, setEqual(expectedProfileIds, l3Provided),
      "context", `${label}:l3-retrieval`, "lifecycle L3 profile id must match context provided ids");
    validRuns.push({ run, expected: expectedRun, name, repository: expectedRepository, dataDirectory: expectedDataDirectory, artifactDirectory: expectedArtifactDirectory });
  }
  for (const [key, expectedRun] of expected) {
    if (!actualKeys.has(key)) {
      addFailure(state, "counts", `${expectedRun.sequenceId}/${expectedRun.arm}/${expectedRun.iteration}/${expectedRun.stageId}:missing`,
        "expected stage run is missing");
    }
  }

  const aggregate = { stageRuns: runs.length, processAttempts, retries, retriedStageRuns, exhaustedStageRuns };
  check(state, isDeepStrictEqual(summary.infrastructure, aggregate), "counts", "infrastructure",
    "summary infrastructure totals must equal the stage-level attempt telemetry", {
      expected: aggregate,
      actual: summary.infrastructure,
    });
  const expectedRunner = runnerSet.size === 1 ? [...runnerSet][0] : "mixed";
  const expectedModel = modelSet.size === 1 ? [...modelSet][0] : "mixed";
  check(state, summary.runner === expectedRunner, "summary", "runner", "summary runner aggregation is inconsistent", {
    expected: expectedRunner,
    actual: summary.runner,
  });
  check(state, summary.model === expectedModel, "summary", "model", "summary model aggregation is inconsistent", {
    expected: expectedModel,
    actual: summary.model,
  });
  return { runs: validRuns, expected, counts: aggregate };
}

function reportedGitPath(repository, value) {
  const trimmed = value.trim();
  return trimmed ? resolve(repository, trimmed) : null;
}

function evidenceFileLines(path) {
  return existsSync(path) && statSync(path).isFile() ? lines(readFileSync(path, "utf8")) : [];
}

function treeSource(entry, allEntries) {
  if (entry.run.stageIndex === 0) {
    return {
      repository: entry.expected.sequence.baseRepository,
      commit: entry.expected.sequence.baseCommit,
      kind: "manifest-base",
    };
  }
  const previous = allEntries.find((candidate) => candidate.run.sequenceId === entry.run.sequenceId
    && candidate.run.arm === entry.run.arm
    && candidate.run.iteration === entry.run.iteration
    && candidate.run.stageIndex === entry.run.stageIndex - 1);
  return previous ? {
    repository: previous.repository,
    commit: previous.run.checkpointCommit,
    kind: "previous-stage-checkpoint",
  } : null;
}

function auditRepository(state, entry, allEntries) {
  const { run, repository } = entry;
  const label = runKey(run);
  const expectedGitDirectory = join(repository, ".git");
  const report = {
    run: label,
    path: repository,
    passed: false,
    head: null,
    refs: [],
    remotes: [],
    parentCount: null,
    unreachableObjects: null,
    reflogEntries: null,
    clean: null,
    gitDirectory: null,
    gitCommonDirectory: null,
    shallow: null,
    alternates: [],
    promisorFiles: [],
    source: null,
    changedFiles: null,
  };
  if (!existsSync(expectedGitDirectory) || !statSync(expectedGitDirectory).isDirectory()) {
    addFailure(state, "git", `${label}:git-directory`, "stage repository must contain its own .git directory");
    return report;
  }
  const inside = git(repository, ["rev-parse", "--is-inside-work-tree"]);
  const absoluteGitDirectory = git(repository, ["rev-parse", "--absolute-git-dir"]);
  const commonGitDirectory = git(repository, ["rev-parse", "--git-common-dir"]);
  const head = git(repository, ["rev-parse", "HEAD"]);
  const tree = git(repository, ["rev-parse", "HEAD^{tree}"]);
  const parents = git(repository, ["rev-list", "--parents", "-n", "1", "HEAD"]);
  const refs = git(repository, ["for-each-ref", "--format=%(refname)"]);
  const snapshotRef = git(repository, ["rev-parse", "refs/heads/repomind-stage-snapshot"]);
  const symbolic = git(repository, ["symbolic-ref", "-q", "HEAD"]);
  const remotes = git(repository, ["remote"]);
  const unreachable = git(repository, ["fsck", "--unreachable", "--no-reflogs"]);
  const reflog = git(repository, ["reflog", "show", "--all", "--format=%H"]);
  const status = git(repository, ["status", "--porcelain"]);
  const shallow = git(repository, ["rev-parse", "--is-shallow-repository"]);
  const partialClone = git(repository, ["config", "--local", "--get-regexp", "^(extensions\\.partialClone|remote\\..*\\.promisor)$"]);
  const commands = {
    inside,
    absoluteGitDirectory,
    commonGitDirectory,
    head,
    tree,
    parents,
    refs,
    snapshotRef,
    symbolic,
    remotes,
    unreachable,
    reflog,
    status,
    shallow,
  };
  for (const [name, result] of Object.entries(commands)) {
    const expectedStatus = name === "symbolic" ? result.status === 1 && result.error === null : commandPassed(result);
    check(state, expectedStatus, "git", `${label}:${name}`, `git ${name} inspection failed`, {
      status: result.status,
      signal: result.signal,
      stderr: result.stderr.trim(),
      error: result.error,
    });
  }
  const refNames = lines(refs.stdout);
  const remoteNames = lines(remotes.stdout);
  const parentTokens = parents.stdout.trim().split(/\s+/u).filter(Boolean);
  const unreachableLines = lines(`${unreachable.stdout}\n${unreachable.stderr}`)
    .filter((line) => /^(unreachable|dangling)\s/u.test(line));
  const reflogLines = lines(reflog.stdout);
  const resolvedHead = head.stdout.trim();
  const resolvedGitDirectory = reportedGitPath(repository, absoluteGitDirectory.stdout);
  const resolvedCommonDirectory = reportedGitPath(repository, commonGitDirectory.stdout);
  const alternateFiles = [
    join(expectedGitDirectory, "objects", "info", "alternates"),
    join(expectedGitDirectory, "objects", "info", "http-alternates"),
  ];
  const alternateEntries = alternateFiles.flatMap((path) => evidenceFileLines(path).map((value) => ({ path, value })));
  const promisorFiles = walkFiles(join(expectedGitDirectory, "objects"))
    .filter((path) => path.toLowerCase().endsWith(".promisor"));
  const source = treeSource(entry, allEntries);
  const validObjectId = (value) => typeof value === "string" && /^[a-f0-9]{40,64}$/u.test(value);
  const beforeTree = source && validObjectId(source.commit)
    ? gitTree(source.repository, source.commit) : { result: null, entries: null };
  const afterTree = validObjectId(run.checkpointCommit)
    ? gitTree(repository, run.checkpointCommit) : { result: null, entries: null };
  const changedFiles = beforeTree.entries && afterTree.entries
    ? changedTreePaths(beforeTree.entries, afterTree.entries)
    : null;
  const unsafeTreeEntries = afterTree.entries ? [...afterTree.entries]
    .filter(([, value]) => value.mode === "120000" || value.mode === "160000")
    .map(([path, value]) => ({ path, ...value })) : [];
  report.head = resolvedHead || null;
  report.refs = refNames;
  report.remotes = remoteNames;
  report.parentCount = Math.max(0, parentTokens.length - 1);
  report.unreachableObjects = unreachableLines.length;
  report.reflogEntries = reflogLines.length;
  report.clean = status.stdout.trim().length === 0;
  report.gitDirectory = resolvedGitDirectory;
  report.gitCommonDirectory = resolvedCommonDirectory;
  report.shallow = shallow.stdout.trim() === "true";
  report.alternates = alternateEntries;
  report.promisorFiles = promisorFiles;
  report.source = source;
  report.changedFiles = changedFiles;
  check(state, inside.stdout.trim() === "true", "git", `${label}:inside`, "path must be a Git worktree");
  check(state, resolvedGitDirectory !== null && samePath(resolvedGitDirectory, expectedGitDirectory),
    "git", `${label}:absolute-git-dir`, "Git object storage must be the repository's own .git directory", {
      expected: expectedGitDirectory,
      actual: resolvedGitDirectory,
    });
  check(state, resolvedCommonDirectory !== null && samePath(resolvedCommonDirectory, expectedGitDirectory),
    "git", `${label}:common-dir`, "Git common directory must not be shared with another repository", {
      expected: expectedGitDirectory,
      actual: resolvedCommonDirectory,
    });
  check(state, resolvedHead === run.checkpointCommit, "git", `${label}:checkpoint-head`,
    "HEAD must equal summary checkpointCommit", { head: resolvedHead, checkpointCommit: run.checkpointCommit });
  check(state, tree.stdout.trim() === run.checkpointTree, "git", `${label}:checkpoint-tree`,
    "HEAD tree must equal summary checkpointTree");
  check(state, parentTokens.length === 1 && parentTokens[0] === resolvedHead,
    "git", `${label}:parentless`, "checkpoint HEAD must be a parentless commit", parents.stdout.trim());
  check(state, refNames.length === 1 && refNames[0] === "refs/heads/repomind-stage-snapshot",
    "git", `${label}:refs`, "repository must contain only the stage snapshot ref", refNames);
  check(state, snapshotRef.stdout.trim() === resolvedHead, "git", `${label}:snapshot-ref`,
    "stage snapshot ref must point to HEAD");
  check(state, symbolic.status === 1, "git", `${label}:detached`, "HEAD must remain detached");
  check(state, remoteNames.length === 0, "git", `${label}:remotes`, "repository must contain zero remotes", remoteNames);
  check(state, unreachableLines.length === 0, "git", `${label}:unreachable`,
    "repository must contain zero unreachable/dangling objects", unreachableLines);
  check(state, reflogLines.length === 0, "git", `${label}:reflog`, "repository must contain zero reflog entries", reflogLines);
  check(state, status.stdout.trim().length === 0, "git", `${label}:clean`, "checkpointed repository must be clean", status.stdout);
  check(state, shallow.stdout.trim() === "false" && !existsSync(join(expectedGitDirectory, "shallow")),
    "git", `${label}:shallow`, "repository must not be shallow", shallow.stdout.trim());
  check(state, partialClone.status === 1 && partialClone.error === null && !partialClone.stdout.trim(),
    "git", `${label}:partial-clone`, "repository must not declare partial-clone or promisor configuration", {
      status: partialClone.status,
      stdout: partialClone.stdout.trim(),
      stderr: partialClone.stderr.trim(),
      error: partialClone.error,
    });
  check(state, alternateEntries.length === 0, "git", `${label}:alternates`,
    "Git alternate and HTTP alternate object stores must be empty", alternateEntries);
  check(state, promisorFiles.length === 0, "git", `${label}:promisor-files`,
    "Git object storage must contain no .promisor files", promisorFiles);
  check(state, source !== null, "git", `${label}:tree-source`, "a prior immutable tree source must exist for every stage");
  if (source) {
    check(state, source.commit === run.baseCommit, "git", `${label}:tree-base-commit`,
      "tree comparison source commit must equal summary baseCommit", { source: source.commit, summary: run.baseCommit });
    check(state, beforeTree.entries !== null, "git", `${label}:tree-before`,
      "unable to read the source tree used by this stage", beforeTree.result);
  }
  check(state, afterTree.entries !== null, "git", `${label}:tree-after`,
    "unable to read the immutable checkpoint tree", afterTree.result);
  check(state, unsafeTreeEntries.length === 0, "git", `${label}:tree-links`,
    "checkpoint tree must not contain symbolic links or gitlinks", unsafeTreeEntries);
  if (changedFiles) {
    check(state, setEqual(changedFiles, Array.isArray(run.changedFiles) ? run.changedFiles : []),
      "allowlist", `${label}:tree-changes`, "summary changedFiles must equal the independently compared Git trees", {
        source,
        computed: changedFiles,
        summary: run.changedFiles,
      });
    const allowedChanges = Array.isArray(entry.expected.stage.allowedChanges)
      ? entry.expected.stage.allowedChanges : null;
    const unexpectedChanges = allowedChanges
      ? changedFiles.filter((path) => !allowedChanges.includes(path))
      : [];
    check(state, setEqual(unexpectedChanges, Array.isArray(run.unexpectedChanges) ? run.unexpectedChanges : []),
      "allowlist", `${label}:tree-unexpected`,
      "summary unexpectedChanges must equal the tree-derived allowlist violations", {
        computed: unexpectedChanges,
        summary: run.unexpectedChanges,
      });
  }
  report.passed = !state.failures.some((failure) => failure.group === "git" && failure.id.startsWith(`${label}:`));
  return report;
}

function validTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function snapshotTelemetryValid(snapshot) {
  return objectValue(snapshot) !== null
    && (snapshot.branch === null || typeof snapshot.branch === "string")
    && (snapshot.head === null || typeof snapshot.head === "string")
    && typeof snapshot.dirty === "boolean"
    && typeof snapshot.status === "string"
    && snapshot.dirty === (snapshot.status.trim().length > 0);
}

function retryAssessmentComparable(actual, expected, strict) {
  const stored = objectValue(expected);
  if (!stored) return false;
  for (const field of ["eligible", "matchedSignals", "blockers"]) {
    if (!isDeepStrictEqual(actual[field], stored[field])) return false;
  }
  if (strict || Object.hasOwn(stored, "mode")) {
    if (actual.mode !== stored.mode) return false;
  }
  const storedConditions = objectValue(stored.conditions);
  if (!storedConditions) return false;
  if (strict) return isDeepStrictEqual(actual.conditions, storedConditions);
  return Object.entries(storedConditions).every(([key, value]) => actual.conditions[key] === value);
}

function validateStoredRun(state, entry, allEntries, suiteRoot, resultsDirectory) {
  const { run, expected, repository, artifactDirectory } = entry;
  const label = runKey(run);
  const reportPath = join(artifactDirectory, "run.json");
  const eventsPath = join(artifactDirectory, "events.jsonl");
  const stderrPath = join(artifactDirectory, "stderr.log");
  const expectedTopLevelArtifacts = { report: reportPath, events: eventsPath, stderr: stderrPath };
  for (const [kind, path] of Object.entries(expectedTopLevelArtifacts)) {
    check(state, existsSync(path) && statSync(path).isFile(), "artifacts", `${label}:${kind}`,
      `${kind} artifact must exist as a file`, path);
  }
  if (!existsSync(reportPath) || !statSync(reportPath).isFile()) return null;
  let stored;
  try {
    stored = readJson(reportPath);
  } catch (error) {
    addFailure(state, "artifacts", `${label}:run-json`, "run.json is not valid JSON",
      error instanceof Error ? error.message : String(error));
    return null;
  }

  check(state, stored.version === 3, "artifacts", `${label}:run-version`, "Host run artifact version must be 3", stored.version);
  check(state, samePath(stored.repository ?? "", repository), "artifacts", `${label}:run-repository`,
    "Host run artifact repository must match the stage repository");
  check(state, samePath(stored.outputDirectory ?? "", artifactDirectory), "artifacts", `${label}:run-output`,
    "Host run outputDirectory must match its deterministic artifact directory");
  for (const [field, path] of Object.entries(expectedTopLevelArtifacts)) {
    check(state, typeof stored.artifacts?.[field] === "string" && samePath(stored.artifacts[field], path),
      "artifacts", `${label}:stored-artifact:${field}`, `Host run ${field} path must be deterministic`, stored.artifacts?.[field]);
  }
  check(state, stored.runner === run.runner && stored.model === run.model,
    "artifacts", `${label}:run-agent`, "Host run artifact runner/model must match summary");
  check(state, stored.task === expected.stage.prompt, "artifacts", `${label}:task`, "Host run task must match manifest prompt");
  check(state, stored.runId === stored.session?.id && stored.session?.id === run.lifecycle?.sessionId
    && stored.session?.status === run.lifecycle?.status,
  "artifacts", `${label}:session`, "Host run/session identity and status must match summary");
  check(state, validTimestamp(stored.startedAt) && validTimestamp(stored.endedAt)
    && Date.parse(stored.endedAt) >= Date.parse(stored.startedAt),
  "runtime", `${label}:timestamps`, "Host run timestamps must be valid and ordered");
  check(state, isDeepStrictEqual(stored.context, run.context), "artifacts", `${label}:context`,
    "Host run context telemetry must match summary");
  check(state, isDeepStrictEqual(stored.quality, run.quality), "artifacts", `${label}:quality`,
    "Host run quality telemetry must match summary");
  check(state, isDeepStrictEqual(stored.maintenance ?? null, run.maintenance ?? null),
    "artifacts", `${label}:maintenance`, "Host run maintenance telemetry must match summary");

  const attempts = Array.isArray(stored.attempts) ? stored.attempts : [];
  const maxAttempts = integerValue(stored.retry?.maxAttempts);
  const retryDelayMs = numberValue(stored.retry?.delayMs);
  check(state, maxAttempts !== null && maxAttempts >= 1 && attempts.length <= maxAttempts,
    "runtime", `${label}:max-attempts`, "Host retry maxAttempts must cover all stored attempts", stored.retry);
  check(state, typeof stored.retry?.delayMs === "number" && Number.isFinite(stored.retry.delayMs)
    && stored.retry.delayMs >= 0,
  "runtime", `${label}:retry-delay`, "Host retry delay must be a non-negative finite number", stored.retry?.delayMs);
  check(state, attempts.length > 0 && attempts.length === run.agent?.attempts,
    "artifacts", `${label}:attempt-count`, "Host run attempt artifact count must match summary", {
      expected: run.agent?.attempts,
      actual: attempts.length,
    });
  const strictAttemptSchema = attempts.length > 0 && attempts.every((attempt) =>
    Object.hasOwn(objectValue(attempt) ?? {}, "executionMode")
    && Object.hasOwn(objectValue(attempt?.retry) ?? {}, "mode"));
  const forbiddenTargets = [
    { kind: "hidden-verifier", path: join(suiteRoot, "hidden") },
    { kind: "suite-source-repository", path: join(suiteRoot, "repository") },
    { kind: "result-data", path: join(resultsDirectory, "data") },
    ...allEntries.filter((other) => other !== entry)
      .map((other) => ({ kind: "sibling-repository", path: other.repository })),
    ...allEntries.filter((other) => other !== entry)
      .map((other) => ({ kind: "sibling-artifact", path: other.artifactDirectory })),
  ].map((target) => ({ ...target, path: resolve(target.path) }));
  const uniqueTargets = [...new Map(forbiddenTargets.map((target) =>
    [`${target.kind}\0${normalizedPath(target.path)}`, target])).values()];
  const attemptReports = [];
  const recomputedMetrics = [];
  const recomputedLegacyReads = [];
  const assessments = [];
  let previousAfter = null;
  let expectedExecutionMode = "fresh";

  for (const [index, attemptValue] of attempts.entries()) {
    const attempt = objectValue(attemptValue) ?? {};
    const attemptNumber = index + 1;
    const attemptLabel = `${label}:attempt:${attemptNumber}`;
    check(state, attempt.attempt === attemptNumber, "artifacts", attemptLabel,
      "attempt numbers must be consecutive", attempt.attempt);
    if (strictAttemptSchema || Object.hasOwn(attempt, "executionMode")) {
      check(state, attempt.executionMode === expectedExecutionMode, "runtime", `${attemptLabel}:execution-mode`,
        "attempt executionMode must follow the independently recomputed retry chain", {
          expected: expectedExecutionMode,
          actual: attempt.executionMode,
        });
    }
    check(state, validTimestamp(attempt.startedAt) && validTimestamp(attempt.endedAt)
      && Date.parse(attempt.endedAt) >= Date.parse(attempt.startedAt),
    "runtime", `${attemptLabel}:timestamps`, "attempt timestamps must be valid and ordered");

    const attemptDirectory = join(artifactDirectory, "attempts", `attempt-${String(attemptNumber).padStart(2, "0")}`);
    const expectedAttemptPaths = {
      stdout: join(attemptDirectory, "stdout.log"),
      stderr: join(attemptDirectory, "stderr.log"),
    };
    const artifactTexts = { stdout: "", stderr: "" };
    for (const [field, expectedPath] of Object.entries(expectedAttemptPaths)) {
      const path = attempt.artifacts?.[field];
      const valid = typeof path === "string"
        && samePath(path, expectedPath)
        && safeExistingPath(join(artifactDirectory, "attempts"), path)
        && statSync(path).isFile();
      check(state, valid, "artifacts", `${attemptLabel}:${field}`,
        "attempt artifact must use its deterministic path within the attempts directory", { expected: expectedPath, actual: path });
      if (valid) artifactTexts[field] = readFileSync(path, "utf8");
    }

    const eventAudit = auditAgentEventLeakage({
      jsonl: artifactTexts.stdout,
      runner: run.runner,
      repository,
      forbiddenTargets: uniqueTargets,
    });
    check(state, eventAudit.parsedEvents > 0, "events", `${attemptLabel}:parsed`,
      "every Agent attempt must contain structured JSON events", eventAudit.parsedEvents);
    check(state, eventAudit.malformedLines === 0, "events", `${attemptLabel}:malformed`,
      "every Agent attempt JSONL file must contain zero malformed lines", eventAudit.malformedLines);
    check(state, eventAudit.parsedEvents === attempt.outcome?.trace?.parsedEvents
      && eventAudit.malformedLines === attempt.outcome?.trace?.malformedLines
      && eventAudit.terminal === attempt.outcome?.trace?.terminal,
    "events", `${attemptLabel}:trace`, "attempt event counts must match its outcome trace", {
      computed: {
        parsedEvents: eventAudit.parsedEvents,
        malformedLines: eventAudit.malformedLines,
        terminal: eventAudit.terminal,
      },
      stored: attempt.outcome?.trace,
    });
    check(state, metricsComparable(eventAudit.metrics, objectValue(attempt.events) ?? {}, eventAudit.legacyReadMetrics),
      "events", `${attemptLabel}:metrics`, "attempt Agent metrics must equal metrics recomputed from raw events", {
        computed: eventAudit.metrics,
        stored: attempt.events,
      });
    check(state, eventAudit.findings.length === 0, "leakage", `${attemptLabel}:forbidden-access`,
      "Agent tools must not access hidden, source, data, sibling repository, or sibling artifact state", eventAudit.findings);
    recomputedMetrics.push(eventAudit.metrics);
    recomputedLegacyReads.push(eventAudit.legacyReadMetrics);

    const before = attempt.git?.before;
    const after = attempt.git?.after;
    check(state, snapshotTelemetryValid(before) && snapshotTelemetryValid(after),
      "allowlist", `${attemptLabel}:git-shape`, "attempt Git snapshots must contain consistent dirty/status telemetry", attempt.git);
    check(state, attempt.git?.unchanged === snapshotsEqual(before, after),
      "allowlist", `${attemptLabel}:git-unchanged`, "attempt git.unchanged must equal its before/after snapshots", attempt.git);
    if (previousAfter) {
      check(state, snapshotsEqual(previousAfter, before), "allowlist", `${attemptLabel}:git-chain`,
        "each retry must start from the exact repository snapshot left by the previous attempt", {
          previousAfter,
          currentBefore: before,
        });
    }
    previousAfter = after;

    const assessment = recomputeRetryAssessment(
      attempt,
      artifactTexts.stdout,
      artifactTexts.stderr,
      run.runner,
      eventAudit.metrics,
      eventAudit.commandCount,
      eventAudit.terminal,
    );
    const retryLimit = maxAttempts ?? attempts.length;
    const scheduled = assessment.eligible && attemptNumber < retryLimit;
    const expectedDelay = scheduled ? retryDelayMs : null;
    check(state, retryAssessmentComparable(assessment, attempt.retry, strictAttemptSchema),
      "runtime", `${attemptLabel}:retry-assessment`, "stored retry assessment must match an independent recomputation", {
        computed: assessment,
        stored: attempt.retry,
        strict: strictAttemptSchema,
      });
    check(state, attempt.retry?.scheduled === scheduled && attempt.retry?.delayMs === expectedDelay,
      "runtime", `${attemptLabel}:retry-schedule`, "attempt retry scheduling and delay must match eligibility and budget", {
        computed: { scheduled, delayMs: expectedDelay },
        stored: attempt.retry,
      });
    assessments.push({ assessment, scheduled, delayMs: expectedDelay });
    expectedExecutionMode = scheduled ? assessment.mode : null;

    check(state, typeof attempt.process?.durationMs === "number" && Number.isFinite(attempt.process.durationMs)
      && attempt.process.durationMs >= 0,
    "runtime", `${attemptLabel}:duration`, "attempt process duration must be a non-negative finite number", attempt.process?.durationMs);
    check(state, attempt.process?.stdoutTruncated === false && attempt.process?.stderrTruncated === false,
      "events", `${attemptLabel}:complete-logs`, "formal evidence requires complete, non-truncated attempt logs", attempt.process);
    attemptReports.push({
      attempt: attemptNumber,
      executionMode: Object.hasOwn(attempt, "executionMode") ? attempt.executionMode : "legacy-fresh",
      stdout: expectedAttemptPaths.stdout,
      stderr: expectedAttemptPaths.stderr,
      parsedEvents: eventAudit.parsedEvents,
      malformedLines: eventAudit.malformedLines,
      successfulReadTools: eventAudit.successfulReadTools,
      auditedTools: eventAudit.auditedTools,
      metrics: eventAudit.metrics,
      legacyReadMetrics: eventAudit.legacyReadMetrics,
      retry: { ...assessment, scheduled, delayMs: expectedDelay },
      findings: eventAudit.findings,
    });
  }

  const firstAttempt = attempts[0];
  check(state, firstAttempt?.git?.before?.dirty === false
    && firstAttempt?.git?.before?.status === ""
    && firstAttempt?.git?.before?.head === run.baseCommit,
  "allowlist", `${label}:artifact-initial-clean`, "first Agent attempt must independently record a clean baseCommit checkout", {
    baseCommit: run.baseCommit,
    gitBefore: firstAttempt?.git?.before,
  });

  const aggregateMetrics = aggregateEventMetrics(recomputedMetrics);
  const aggregateLegacyReads = recomputedLegacyReads.reduce((aggregate, value) => ({
    fileReads: aggregate.fileReads + value.fileReads,
    repeatedFileReads: aggregate.repeatedFileReads + value.repeatedFileReads,
  }), { fileReads: 0, repeatedFileReads: 0 });
  check(state, metricsComparable(aggregateMetrics, objectValue(stored.agent?.events) ?? {}, aggregateLegacyReads),
    "events", `${label}:aggregate-stored`, "Host aggregate Agent metrics must equal all raw attempt logs", {
      computed: aggregateMetrics,
      stored: stored.agent?.events,
    });
  check(state, metricsComparable(aggregateMetrics, objectValue(run.events) ?? {}, aggregateLegacyReads),
    "events", `${label}:aggregate-summary`, "summary Agent metrics must equal all raw attempt logs", {
      computed: aggregateMetrics,
      summary: run.events,
    });
  check(state, metricsComparable(objectValue(stored.agent?.events) ?? {}, objectValue(run.events) ?? {}),
    "artifacts", `${label}:events-summary`, "Host run Agent event metrics must match summary");

  const finalAttempt = attempts.at(-1);
  const finalAttemptReport = attemptReports.at(-1);
  const finalProcess = objectValue(finalAttempt?.process) ?? {};
  const processFields = ["exitCode", "signal", "timedOut", "aborted", "error", "stdoutTruncated", "stderrTruncated"];
  for (const field of processFields) {
    check(state, stored.agent?.[field] === finalProcess[field] && run.agent?.[field] === finalProcess[field],
      "runtime", `${label}:final-process:${field}`, "Host and summary process telemetry must equal the final attempt", {
        attempt: finalProcess[field],
        host: stored.agent?.[field],
        summary: run.agent?.[field],
      });
  }
  check(state, finalProcess.exitCode === 0 && finalProcess.signal === null
    && finalProcess.timedOut === false && finalProcess.aborted === false && finalProcess.error === null,
  "runtime", `${label}:stored-clean-exit`, "final stored attempt must independently show a clean Agent exit", finalProcess);
  const aggregateDuration = attempts.reduce((sum, attempt, index) =>
    sum + numberValue(attempt?.process?.durationMs) + numberValue(assessments[index]?.delayMs), 0);
  check(state, closeNumber(stored.agent?.durationMs, aggregateDuration, 0.02)
    && closeNumber(run.lifecycle?.agentMs, aggregateDuration, 0.02),
  "runtime", `${label}:agent-duration`, "Host and summary Agent duration must equal attempt durations plus retry delays", {
    computed: aggregateDuration,
    host: stored.agent?.durationMs,
    summary: run.lifecycle?.agentMs,
  });

  const computedRetries = assessments.filter((value) => value.scheduled).length;
  const computedExhausted = attempts.length > 0 && maxAttempts !== null
    && attempts.length === maxAttempts && assessments.at(-1)?.assessment.eligible === true;
  check(state, stored.retry?.attempts === attempts.length
    && stored.retry?.retries === computedRetries
    && stored.retry?.exhausted === computedExhausted,
  "runtime", `${label}:retry-aggregate`, "Host retry totals must equal the independently audited attempt chain", {
    computed: { attempts: attempts.length, retries: computedRetries, exhausted: computedExhausted },
    stored: stored.retry,
  });
  check(state, run.agent?.attempts === attempts.length
    && run.agent?.infrastructureRetries === computedRetries
    && run.agent?.retryExhausted === computedExhausted,
  "runtime", `${label}:retry-summary`, "summary retry totals must equal the independently audited attempt chain", {
    computed: { attempts: attempts.length, retries: computedRetries, exhausted: computedExhausted },
    summary: run.agent,
  });

  if (finalAttempt) {
    check(state, isDeepStrictEqual(stored.quality?.trace, finalAttempt.outcome?.trace),
      "runtime", `${label}:quality-trace`, "Host quality trace must equal the final Agent attempt outcome trace", {
        quality: stored.quality?.trace,
        attempt: finalAttempt.outcome?.trace,
      });
    check(state, stored.summary === finalAttempt.outcome?.summary,
      "runtime", `${label}:summary-text`, "Host summary must equal the final Agent attempt summary");
  }
  const computedSucceeded = finalProcess.exitCode === 0 && stored.commit?.status === "committed";
  check(state, stored.succeeded === computedSucceeded, "runtime", `${label}:succeeded`,
    "Host succeeded must be derived from clean Agent exit and committed Session", {
      computed: computedSucceeded,
      stored: stored.succeeded,
    });
  check(state, stored.commit?.sessionId === stored.session?.id
    && stored.commit?.status === stored.session?.status
    && run.lifecycle?.commitSucceeded === (objectValue(stored.commit) !== null),
  "runtime", `${label}:stored-commit`, "Host commit result must agree with Session identity/status and summary", {
    commit: stored.commit,
    session: stored.session,
    summary: run.lifecycle,
  });
  const storedMemoryIds = Array.isArray(stored.session?.retrievedMemoryIds) ? stored.session.retrievedMemoryIds : [];
  const storedNarrativeIds = Array.isArray(stored.session?.retrievedModuleNarrativeIds)
    ? stored.session.retrievedModuleNarrativeIds : [];
  const summaryMemoryIds = Array.isArray(run.lifecycle?.retrievedMemoryIds) ? run.lifecycle.retrievedMemoryIds : [];
  const summaryNarrativeIds = Array.isArray(run.lifecycle?.retrievedModuleNarrativeIds)
    ? run.lifecycle.retrievedModuleNarrativeIds : [];
  check(state, Array.isArray(stored.session?.retrievedMemoryIds)
    && Array.isArray(stored.session?.retrievedModuleNarrativeIds)
    && stored.session?.retrievedMemories === storedMemoryIds.length
    && stored.session?.retrievedModuleNarratives === storedNarrativeIds.length
    && setEqual(storedMemoryIds, summaryMemoryIds)
    && setEqual(storedNarrativeIds, summaryNarrativeIds)
    && stored.session?.repositoryProfileId === run.lifecycle?.repositoryProfileId,
  "artifacts", `${label}:retrieval`, "Host retrieval telemetry must be internally consistent and match summary", stored.session);
  check(state, closeNumber(stored.session?.startMs, run.lifecycle?.startMs)
    && closeNullableNumber(stored.session?.commitMs, run.lifecycle?.commitMs)
    && closeNullableNumber(stored.session?.maintenanceMs, run.lifecycle?.maintenanceMs),
  "runtime", `${label}:lifecycle-durations`, "Host Session phase durations must match summary lifecycle", {
    host: stored.session,
    summary: run.lifecycle,
  });

  const topLevelEvents = existsSync(eventsPath) && statSync(eventsPath).isFile() ? readFileSync(eventsPath, "utf8") : null;
  const topLevelStderr = existsSync(stderrPath) && statSync(stderrPath).isFile() ? readFileSync(stderrPath, "utf8") : null;
  const finalAttemptDirectory = join(artifactDirectory, "attempts", `attempt-${String(attempts.length).padStart(2, "0")}`);
  const finalStdoutPath = join(finalAttemptDirectory, "stdout.log");
  const finalStderrPath = join(finalAttemptDirectory, "stderr.log");
  const finalStdout = existsSync(finalStdoutPath) && statSync(finalStdoutPath).isFile()
    ? readFileSync(finalStdoutPath, "utf8") : null;
  const finalStderr = existsSync(finalStderrPath) && statSync(finalStderrPath).isFile()
    ? readFileSync(finalStderrPath, "utf8") : null;
  check(state, topLevelEvents !== null && topLevelEvents === finalStdout,
    "artifacts", `${label}:final-events-copy`, "events.jsonl must be an exact copy of the final attempt stdout log");
  check(state, topLevelStderr !== null && topLevelStderr === finalStderr,
    "artifacts", `${label}:final-stderr-copy`, "stderr.log must be an exact copy of the final attempt stderr log");
  check(state, finalAttemptReport?.parsedEvents === run.quality?.trace?.parsedEvents
    && finalAttemptReport?.malformedLines === run.quality?.trace?.malformedLines,
  "events", `${label}:summary-trace`, "summary quality trace must match the final raw Agent attempt", {
    computed: finalAttemptReport,
    summary: run.quality?.trace,
  });

  const findings = attemptReports.flatMap((attempt) =>
    attempt.findings.map((finding) => ({ attempt: attempt.attempt, ...finding })));
  return {
    run: label,
    path: eventsPath,
    parsedEvents: attemptReports.reduce((sum, attempt) => sum + attempt.parsedEvents, 0),
    malformedLines: attemptReports.reduce((sum, attempt) => sum + attempt.malformedLines, 0),
    successfulReadTools: attemptReports.reduce((sum, attempt) => sum + attempt.successfulReadTools, 0),
    auditedTools: attemptReports.reduce((sum, attempt) => sum + attempt.auditedTools, 0),
    metrics: aggregateMetrics,
    findings,
    attempts: attemptReports,
  };
}

function databaseCount(database, table, where = "", parameters = []) {
  return Number(database.prepare(`SELECT count(*) AS count FROM ${table}${where}`).get(...parameters).count);
}

function auditDatabase(state, dataDirectory, entries, projectId) {
  const label = relative(dirname(dataDirectory), dataDirectory) || basename(dataDirectory);
  const path = join(dataDirectory, "repositories", projectId, "repomind.db");
  const report = {
    dataDirectory,
    path,
    projectId,
    stages: entries.map((entry) => runKey(entry.run)),
    passed: false,
    integrityCheck: null,
    foreignKeyViolations: null,
    counts: null,
  };
  if (!existsSync(path) || !statSync(path).isFile()) {
    addFailure(state, "database", `${label}:missing`, "expected RepoMind database is missing", path);
    return report;
  }
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const integrityRows = database.prepare("PRAGMA integrity_check").all();
    const foreignKeyRows = database.prepare("PRAGMA foreign_key_check").all();
    report.integrityCheck = integrityRows;
    report.foreignKeyViolations = foreignKeyRows.length;
    check(state, integrityRows.length === 1 && integrityRows[0]?.integrity_check === "ok",
      "database", `${label}:integrity`, "SQLite PRAGMA integrity_check must return exactly ok", integrityRows);
    check(state, foreignKeyRows.length === 0, "database", `${label}:foreign-keys`,
      "SQLite PRAGMA foreign_key_check must return no rows", foreignKeyRows);
    const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name);
    check(state, REQUIRED_DATABASE_TABLES.every((table) => tables.includes(table)),
      "database", `${label}:tables`, "RepoMind database is missing required tables", {
        required: REQUIRED_DATABASE_TABLES,
        actual: tables,
      });
    const repositoryIds = database.prepare("SELECT id FROM repositories ORDER BY id").all().map((row) => row.id);
    check(state, repositoryIds.length === 1 && repositoryIds[0] === projectId,
      "database", `${label}:project`, "database must contain exactly the stage episode projectId", repositoryIds);
    const counts = {
      sessions: databaseCount(database, "sessions"),
      evidence: databaseCount(database, "evidence"),
      memories: databaseCount(database, "memories"),
      moduleNarratives: databaseCount(database, "module_narratives"),
      repositoryProfiles: databaseCount(database, "repository_profiles"),
      skillCandidates: databaseCount(database, "skill_candidates"),
      hostRuns: databaseCount(database, "host_runs"),
      openSessions: databaseCount(database, "sessions", " WHERE status='open'"),
      runningHostRuns: databaseCount(database, "host_runs", " WHERE status='running'"),
    };
    report.counts = counts;
    check(state, counts.openSessions === 0, "database", `${label}:open-sessions`,
      "database must contain zero open sessions", counts.openSessions);
    check(state, counts.runningHostRuns === 0, "database", `${label}:running-hosts`,
      "database must contain zero running Host runs", counts.runningHostRuns);
    check(state, counts.sessions === entries.length && counts.hostRuns === entries.length,
      "database", `${label}:lifecycle-count`, "database must contain exactly one Session and Host run per stage using it", {
        stages: entries.length,
        sessions: counts.sessions,
        hostRuns: counts.hostRuns,
      });
    for (const entry of entries) {
      const run = entry.run;
      const runLabel = runKey(run);
      const session = database.prepare("SELECT status, started_at FROM sessions WHERE id=? AND repository_id=?")
        .get(run.lifecycle.sessionId, projectId);
      const host = database.prepare("SELECT status FROM host_runs WHERE session_id=? AND repository_id=?")
        .get(run.lifecycle.sessionId, projectId);
      check(state, session?.status === run.lifecycle.status, "database", `${runLabel}:session`,
        "database Session status must match summary lifecycle", { database: session?.status, summary: run.lifecycle.status });
      check(state, host?.status === run.lifecycle.status, "database", `${runLabel}:host`,
        "database Host run status must match summary lifecycle", { database: host?.status, summary: run.lifecycle.status });
      const injectedByLayer = {
        l1: run.context?.l1?.injectedIds ?? [],
        l2: run.context?.l2?.injectedIds ?? [],
        l3: run.context?.l3?.injectedIds ?? [],
      };
      for (const [layer, table] of [["l1", "memories"], ["l2", "module_narratives"], ["l3", "repository_profiles"]]) {
        for (const id of injectedByLayer[layer]) {
          const record = database.prepare(`SELECT created_at FROM ${table} WHERE id=? AND repository_id=?`).get(id, projectId);
          check(state, record !== undefined, "database", `${runLabel}:${layer}:${id}`,
            `injected ${layer.toUpperCase()} record must exist in the shared database`);
          check(state, record !== undefined && session !== undefined && record.created_at < session.started_at,
            "database", `${runLabel}:${layer}:${id}:prior`, `injected ${layer.toUpperCase()} record must predate the consuming Session`, {
              recordCreatedAt: record?.created_at,
              sessionStartedAt: session?.started_at,
            });
        }
      }
    }
    const lastEntry = [...entries].sort((left, right) => right.run.stageIndex - left.run.stageIndex)[0];
    const reportedState = lastEntry?.run.memoryState;
    const comparableCounts = {
      sessions: counts.sessions,
      evidence: counts.evidence,
      memories: counts.memories,
      moduleNarratives: counts.moduleNarratives,
      repositoryProfiles: counts.repositoryProfiles,
      skillCandidates: counts.skillCandidates,
      openSessions: counts.openSessions,
      runningHostRuns: counts.runningHostRuns,
    };
    check(state, isDeepStrictEqual(reportedState, comparableCounts), "database", `${label}:memory-state`,
      "final stage memoryState must match the read-only database counts", {
        summary: reportedState,
        database: comparableCounts,
      });
  } catch (error) {
    addFailure(state, "database", `${label}:query`, "unable to audit RepoMind database in read-only mode",
      error instanceof Error ? error.message : String(error));
  } finally {
    database?.close();
  }
  report.passed = !state.failures.some((failure) => failure.group === "database"
    && (failure.id.startsWith(`${label}:`) || report.stages.some((stage) => failure.id.startsWith(`${stage}:`))));
  return report;
}

function validateEpisodes(state, entries, summary) {
  const groups = new Map();
  for (const entry of entries) {
    const key = `${entry.run.sequenceId}\0${entry.run.iteration}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  for (const episode of groups.values()) {
    const first = episode[0].run;
    const label = `${first.sequenceId}/${first.iteration}`;
    const projectIds = [...new Set(episode.map((entry) => entry.run.projectId))];
    check(state, projectIds.length === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(projectIds[0] ?? ""),
      "database", `${label}:project-id`, "episode must use one valid UUIDv4 projectId across both arms", projectIds);
    const producers = episode.filter((entry) => entry.run.stageIndex === 0);
    check(state, producers.length === 2 && producers[0].run.checkpointTree === producers[1].run.checkpointTree,
      "git", `${label}:producer-tree`, "isolated/shared producer checkpoint trees must match");
    for (const arm of ARMS) {
      const chain = episode.filter((entry) => entry.run.arm === arm)
        .sort((left, right) => left.run.stageIndex - right.run.stageIndex);
      for (let index = 1; index < chain.length; index += 1) {
        const previous = chain[index - 1].run;
        const current = chain[index].run;
        check(state, current.previousCheckpointCommit === previous.checkpointCommit
          && current.baseCommit === previous.checkpointCommit,
        "git", `${label}:${arm}:${current.stageId}:chain`, "stage checkpoint chain is broken");
      }
      const directories = new Set(chain.map((entry) => normalizedPath(entry.dataDirectory)));
      check(state, arm === "shared" ? directories.size === 1 : directories.size === chain.length,
        "database", `${label}:${arm}:isolation`, arm === "shared"
          ? "shared stages must reuse one database directory"
          : "isolated stages must use distinct database directories");
    }
  }
  const baseCommits = objectValue(summary.provenance?.sequenceBaseCommits) ?? {};
  for (const entry of entries.filter((value) => value.run.stageIndex === 0)) {
    check(state, baseCommits[entry.run.sequenceId] === entry.run.baseCommit,
      "summary", `${runKey(entry.run)}:base-provenance`, "sequence base commit provenance must match producer baseCommit");
    check(state, entry.run.requestedCommit === entry.run.baseCommit,
      "git", `${runKey(entry.run)}:requested`, "producer requestedCommit must equal checked-out baseCommit");
  }
}

function validateAcceptance(state, manifest, summary) {
  const acceptance = objectValue(summary.acceptance);
  if (!acceptance) {
    addFailure(state, "summary", "acceptance", "summary.acceptance must be an object");
    return null;
  }
  const configured = objectValue(manifest.acceptance);
  if (!configured) {
    check(state, acceptance.status === "not-configured"
      && acceptance.criteria === null
      && Array.isArray(acceptance.checks)
      && acceptance.checks.length === 0,
    "summary", "acceptance-shape", "unconfigured acceptance must be reported as not-configured with no checks");
  } else {
    check(state, isDeepStrictEqual(acceptance.criteria, configured), "summary", "acceptance-criteria",
      "summary acceptance criteria must exactly match the manifest");
    const checks = Array.isArray(acceptance.checks) ? acceptance.checks : [];
    check(state, checks.length > 0 && checks.every((entry) => objectValue(entry)
      && typeof entry.id === "string" && typeof entry.passed === "boolean"),
    "summary", "acceptance-checks", "configured acceptance must contain structured checks");
    check(state, new Set(checks.map((entry) => entry.id)).size === checks.length,
      "summary", "acceptance-check-ids", "acceptance check ids must be unique");
    const expectedStatus = checks.every((entry) => entry.passed) ? "passed" : "failed";
    check(state, acceptance.status === expectedStatus, "summary", "acceptance-status",
      "acceptance status must agree with its reported checks", { expected: expectedStatus, actual: acceptance.status });
    const integrityCheck = checks.find((entry) => entry.id === "integrity");
    check(state, integrityCheck?.passed === summary.integrity?.passed,
      "summary", "acceptance-integrity", "acceptance integrity check must mirror summary.integrity");
  }
  return {
    status: acceptance.status,
    criteria: acceptance.criteria,
    checks: acceptance.checks,
    source: "summary.json",
    note: "Effect thresholds are not re-evaluated by the integrity auditor.",
  };
}

function validateExpectations(state, summary, matrix, options) {
  const summaryRuns = Array.isArray(summary.runs) ? summary.runs : [];
  const expectations = {
    runner: options.expectedRunner ?? null,
    model: options.expectedModel ?? null,
    contextBudget: options.expectedContextBudget ?? null,
    repeat: options.expectedRepeat ?? null,
    stageRuns: options.expectedStageRuns ?? null,
    repoMindCommit: options.expectedRepoMindCommit ?? null,
    sourceSnapshotSha256: options.sourceSnapshotSha256 ?? null,
  };
  check(state, typeof expectations.runner === "string" && expectations.runner.trim().length > 0,
    "expectations", "runner-required", "expected runner must be explicitly supplied");
  check(state, typeof expectations.model === "string" && expectations.model.trim().length > 0,
    "expectations", "model-required", "expected model must be explicitly supplied");
  for (const field of ["contextBudget", "repeat", "stageRuns"]) {
    check(state, Number.isSafeInteger(expectations[field]) && expectations[field] > 0,
      "expectations", `${field}-required`, `${field} must be an explicitly supplied positive integer`, expectations[field]);
  }
  check(state, typeof expectations.repoMindCommit === "string" && /^[a-f0-9]{40,64}$/u.test(expectations.repoMindCommit),
    "expectations", "repomind-commit-required", "expected RepoMind commit must be an explicit lowercase Git object id",
    expectations.repoMindCommit);
  check(state, typeof expectations.sourceSnapshotSha256 === "string"
    && /^[a-f0-9]{64}$/u.test(expectations.sourceSnapshotSha256),
  "expectations", "source-snapshot-required", "source snapshot must be an explicit lowercase SHA-256",
  expectations.sourceSnapshotSha256);
  const runnerMatches = expectations.runner === "mixed"
    ? summary.runner === "mixed" && new Set(summaryRuns.map((run) => run.runner)).size > 1
    : summary.runner === expectations.runner && summaryRuns.every((run) => run.runner === expectations.runner);
  check(state, runnerMatches,
  "expectations", "runner", "summary and every stage must use the expected runner", {
    expected: expectations.runner,
    summary: summary.runner,
    stages: [...new Set(summaryRuns.map((run) => run.runner))],
  });
  const modelMatches = expectations.model === "mixed"
    ? summary.model === "mixed" && new Set(summaryRuns.map((run) => run.model)).size > 1
    : summary.model === expectations.model && summaryRuns.every((run) => run.model === expectations.model);
  check(state, modelMatches,
  "expectations", "model", "summary and every stage must use the expected model", {
    expected: expectations.model,
    summary: summary.model,
    stages: [...new Set(summaryRuns.map((run) => run.model))],
  });
  check(state, summary.repeat === expectations.repeat, "expectations", "repeat",
    "summary repeat must equal the formally expected repeat", { expected: expectations.repeat, actual: summary.repeat });
  check(state, matrix.expected.size === expectations.stageRuns
    && matrix.counts?.stageRuns === expectations.stageRuns
    && summary.infrastructure?.stageRuns === expectations.stageRuns,
  "expectations", "stage-runs", "manifest matrix, summary runs, and infrastructure must equal expected stage runs", {
    expected: expectations.stageRuns,
    matrix: matrix.expected.size,
    runs: matrix.counts?.stageRuns,
    infrastructure: summary.infrastructure?.stageRuns,
  });
  const budgets = [...new Set(summaryRuns.map((run) => run.context?.budgetChars))];
  check(state, budgets.length === 1 && budgets[0] === expectations.contextBudget,
    "expectations", "context-budget", "every stage must use the expected Host context budget", {
      expected: expectations.contextBudget,
      actual: budgets,
    });
  check(state, summary.provenance?.repoMindCommit === expectations.repoMindCommit,
    "expectations", "repomind-commit", "summary provenance must equal the expected RepoMind commit", {
      expected: expectations.repoMindCommit,
      actual: summary.provenance?.repoMindCommit,
    });
  return expectations;
}

function validateSourceProvenance(state, summary, expectations) {
  let snapshot = null;
  try {
    snapshot = computeSourceSnapshot();
  } catch (error) {
    addFailure(state, "source", "snapshot", "unable to compute the current RepoMind source snapshot",
      error instanceof Error ? error.message : String(error));
    return null;
  }
  check(state, snapshot.sha256 === expectations.sourceSnapshotSha256,
    "source", "snapshot-sha256", "current RepoMind source snapshot must equal --source-snapshot-sha256", {
      expected: expectations.sourceSnapshotSha256,
      actual: snapshot.sha256,
    });
  check(state, snapshot.head === expectations.repoMindCommit
    && snapshot.head === summary.provenance?.repoMindCommit,
  "source", "head", "current RepoMind HEAD must equal expected and reported experiment provenance", {
    current: snapshot.head,
    expected: expectations.repoMindCommit,
    reported: summary.provenance?.repoMindCommit,
  });
  check(state, typeof summary.provenance?.repoMindDirty === "boolean"
    && snapshot.dirty === summary.provenance.repoMindDirty,
  "source", "dirty", "current RepoMind dirty state must equal experiment provenance", {
    current: snapshot.dirty,
    reported: summary.provenance?.repoMindDirty,
  });
  if (summary.provenance?.repoMindDirty === true) {
    check(state, /^[a-f0-9]{64}$/u.test(expectations.sourceSnapshotSha256 ?? ""),
      "source", "dirty-snapshot-pin", "dirty experiment provenance requires an explicit current source snapshot pin");
  }
  return snapshot;
}

function finalizeSourceSnapshot(state, before) {
  if (!before) return null;
  let after = null;
  try {
    after = computeSourceSnapshot(before.root);
  } catch (error) {
    addFailure(state, "source", "snapshot-after", "unable to recompute RepoMind source after the audit",
      error instanceof Error ? error.message : String(error));
    return { before, after: null, unchanged: false };
  }
  const unchanged = before.sha256 === after.sha256
    && before.head === after.head
    && before.dirty === after.dirty;
  check(state, unchanged, "source", "snapshot-unchanged",
    "RepoMind source must remain unchanged throughout the audit", { before, after });
  return { before, after, unchanged };
}

function finalizeHiddenSnapshot(state, before, hiddenRoot) {
  if (!before || !existsSync(hiddenRoot) || !statSync(hiddenRoot).isDirectory()) return null;
  const after = fileTreeSnapshot(hiddenRoot);
  const unchanged = isDeepStrictEqual(before.files, after.files) && before.sha256 === after.sha256;
  check(state, unchanged, "source", "hidden-verifier-unchanged",
    "hidden verifier files must remain byte-for-byte unchanged throughout the audit", { before, after });
  return { before, after, unchanged };
}

function groupChecks(state) {
  const definitions = [
    ["summary", `Summary v${SUMMARY_VERSION} and reported integrity/acceptance`],
    ["manifest", "Manifest identity and SHA-256"],
    ["counts", "Repeat, stage, attempt, and retry counts"],
    ["paths", "Result path containment and deterministic layout"],
    ["allowlist", "Initial cleanliness and allowedChanges"],
    ["artifacts", "Host run artifacts and check provenance"],
    ["git", "Independent parentless Git checkpoints and object stores"],
    ["database", "SQLite count, integrity, FK, and lifecycle state"],
    ["context", "Shared/isolated L1-L3 treatment constraints"],
    ["events", "Per-attempt structured Agent event completeness and metrics"],
    ["leakage", "Agent reads/writes of forbidden experimental state"],
    ["runtime", "Clean exit, retry, commit, maintenance, and duration claims"],
    ["expectations", "Explicit formal runner/model/budget/repeat/stage pins"],
    ["source", "RepoMind source provenance and hidden verifier immutability"],
  ];
  return definitions.map(([id, description]) => ({
    id,
    description,
    passed: !state.failures.some((failure) => failure.group === id),
    failureCount: state.failures.filter((failure) => failure.group === id).length,
  }));
}

export function auditCrossSessionResults(options) {
  const generatedAt = new Date().toISOString();
  const suiteRoot = resolve(options.suite);
  const resultsDirectory = resolve(options.results);
  const state = { failures: [] };
  const hiddenRoot = join(suiteRoot, "hidden");
  let hiddenBefore = null;
  let pathLinkFindings = [];
  check(state, existsSync(suiteRoot) && statSync(suiteRoot).isDirectory(),
    "paths", "suite-root", "--suite must name an existing directory", suiteRoot);
  check(state, existsSync(resultsDirectory) && statSync(resultsDirectory).isDirectory(),
    "paths", "results-directory", "--results must name an existing directory", resultsDirectory);
  if (!existsSync(suiteRoot) || !existsSync(resultsDirectory)) {
    return {
      kind: AUDIT_KIND,
      version: AUDIT_VERSION,
      generatedAt,
      passed: false,
      suiteRoot,
      resultsDirectory,
      checks: groupChecks(state),
      failures: state.failures,
    };
  }
  check(state, existsSync(hiddenRoot) && statSync(hiddenRoot).isDirectory(),
    "source", "hidden-verifier-directory", "suite must contain a hidden verifier directory", hiddenRoot);
  if (existsSync(hiddenRoot) && statSync(hiddenRoot).isDirectory()) hiddenBefore = fileTreeSnapshot(hiddenRoot);
  pathLinkFindings = auditNoLinks(state, [suiteRoot, resultsDirectory]);
  const summaryPath = join(resultsDirectory, "summary.json");
  if (!check(state, existsSync(summaryPath) && statSync(summaryPath).isFile(),
    "summary", "file", "results directory must contain summary.json", summaryPath)) {
    const hiddenVerifiers = finalizeHiddenSnapshot(state, hiddenBefore, hiddenRoot);
    return {
      kind: AUDIT_KIND,
      version: AUDIT_VERSION,
      generatedAt,
      passed: false,
      suiteRoot,
      resultsDirectory,
      hiddenVerifiers,
      summary: { path: summaryPath },
      checks: groupChecks(state),
      failures: state.failures,
    };
  }
  const summaryBytes = readFileSync(summaryPath);
  let summary;
  try {
    summary = JSON.parse(summaryBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    addFailure(state, "summary", "parse", "summary.json is not valid JSON",
      error instanceof Error ? error.message : String(error));
    const hiddenVerifiers = finalizeHiddenSnapshot(state, hiddenBefore, hiddenRoot);
    return {
      kind: AUDIT_KIND,
      version: AUDIT_VERSION,
      generatedAt,
      passed: false,
      suiteRoot,
      resultsDirectory,
      hiddenVerifiers,
      summary: { path: summaryPath, sha256: sha256(summaryBytes) },
      checks: groupChecks(state),
      failures: state.failures,
    };
  }
  check(state, objectValue(summary) !== null && summary.version === SUMMARY_VERSION,
    "summary", "schema-version", `summary schema must be v${SUMMARY_VERSION}`, summary.version);
  check(state, typeof summary.generatedAt === "string" && !Number.isNaN(Date.parse(summary.generatedAt)),
    "summary", "generated-at", "summary generatedAt must be a valid timestamp", summary.generatedAt);
  check(state, typeof summary.outputDirectory === "string" && samePath(summary.outputDirectory, resultsDirectory),
    "paths", "summary-output", "summary outputDirectory must equal --results", {
      summary: summary.outputDirectory,
      results: resultsDirectory,
    });
  check(state, summary.integrity?.passed === true
    && Array.isArray(summary.integrity?.failures)
    && summary.integrity.failures.length === 0,
  "summary", "reported-integrity", "summary must report passed integrity with no failures", summary.integrity);

  const selectedManifest = validateManifest(state, suiteRoot, summary);
  if (!selectedManifest) {
    const hiddenVerifiers = finalizeHiddenSnapshot(state, hiddenBefore, hiddenRoot);
    return {
      kind: AUDIT_KIND,
      version: AUDIT_VERSION,
      generatedAt,
      passed: false,
      suiteRoot,
      resultsDirectory,
      hiddenVerifiers,
      summary: { path: summaryPath, sha256: sha256(summaryBytes), schemaVersion: summary.version },
      checks: groupChecks(state),
      failures: state.failures,
    };
  }
  const reportedAcceptance = validateAcceptance(state, selectedManifest.manifest, summary);
  const matrix = validateRunMatrix(state, summary, selectedManifest.manifest, resultsDirectory);
  const expectations = validateExpectations(state, summary, matrix, options);
  const sourceBefore = validateSourceProvenance(state, summary, expectations);
  validateEpisodes(state, matrix.runs, summary);

  const actualRunDirectories = existsSync(join(resultsDirectory, "runs"))
    ? readdirSync(join(resultsDirectory, "runs"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(resultsDirectory, "runs", entry.name))
    : [];
  const expectedRunDirectories = matrix.runs.map((entry) => entry.repository);
  check(state, setEqual(actualRunDirectories.map(normalizedPath), expectedRunDirectories.map(normalizedPath)),
    "paths", "run-directories", "results/runs directories must exactly match summary stage runs", {
      expected: expectedRunDirectories,
      actual: actualRunDirectories,
    });
  const actualArtifactDirectories = existsSync(join(resultsDirectory, "artifacts"))
    ? readdirSync(join(resultsDirectory, "artifacts"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(resultsDirectory, "artifacts", entry.name))
    : [];
  const expectedArtifactDirectories = matrix.runs.map((entry) => entry.artifactDirectory);
  check(state, setEqual(actualArtifactDirectories.map(normalizedPath), expectedArtifactDirectories.map(normalizedPath)),
    "paths", "artifact-directories", "results/artifacts directories must exactly match summary stage runs", {
      expected: expectedArtifactDirectories,
      actual: actualArtifactDirectories,
    });

  const repositories = matrix.runs.map((entry) => auditRepository(state, entry, matrix.runs));
  const eventAudits = matrix.runs.map((entry) =>
    validateStoredRun(state, entry, matrix.runs, suiteRoot, resultsDirectory)).filter(Boolean);

  const dataGroups = new Map();
  for (const entry of matrix.runs) {
    const key = normalizedPath(entry.dataDirectory);
    dataGroups.set(key, [...(dataGroups.get(key) ?? []), entry]);
  }
  const expectedDatabasePaths = [];
  const databases = [];
  for (const entries of dataGroups.values()) {
    const projectIds = [...new Set(entries.map((entry) => entry.run.projectId))];
    if (projectIds.length !== 1 || typeof projectIds[0] !== "string") continue;
    expectedDatabasePaths.push(join(entries[0].dataDirectory, "repositories", projectIds[0], "repomind.db"));
    databases.push(auditDatabase(state, entries[0].dataDirectory, entries, projectIds[0]));
  }
  const actualDatabasePaths = walkFiles(join(resultsDirectory, "data"))
    .filter((path) => basename(path).toLowerCase() === "repomind.db");
  check(state, actualDatabasePaths.length === dataGroups.size,
    "database", "database-count", "database count must equal unique shared/isolated data directories", {
      expected: dataGroups.size,
      actual: actualDatabasePaths.length,
    });
  check(state, setEqual(actualDatabasePaths.map(normalizedPath), expectedDatabasePaths.map(normalizedPath)),
    "database", "database-paths", "database files must exactly match dataDirectory/projectId layout", {
      expected: expectedDatabasePaths,
      actual: actualDatabasePaths,
    });

  const hiddenVerifiers = finalizeHiddenSnapshot(state, hiddenBefore, hiddenRoot);
  const source = finalizeSourceSnapshot(state, sourceBefore);
  const checks = groupChecks(state);
  const leakageFindings = eventAudits.flatMap((entry) => entry.findings.map((finding) => ({ run: entry.run, ...finding })));
  return {
    kind: AUDIT_KIND,
    version: AUDIT_VERSION,
    generatedAt,
    passed: state.failures.length === 0,
    suiteRoot,
    resultsDirectory,
    expectations,
    source,
    hiddenVerifiers,
    pathLinks: {
      passed: pathLinkFindings.length === 0,
      findings: pathLinkFindings,
    },
    summary: {
      path: summaryPath,
      sha256: sha256(summaryBytes),
      schemaVersion: summary.version,
      name: summary.name,
      repeat: summary.repeat,
      reportedIntegrity: summary.integrity,
      reportedAcceptance,
    },
    manifest: {
      path: selectedManifest.path,
      sha256: selectedManifest.sha256,
      matchesSummaryHash: selectedManifest.sha256 === summary.provenance?.manifestSha256,
    },
    counts: {
      expectedStageRuns: matrix.expected.size,
      actualStageRuns: matrix.counts?.stageRuns ?? null,
      processAttempts: matrix.counts?.processAttempts ?? null,
      retries: matrix.counts?.retries ?? null,
      retriedStageRuns: matrix.counts?.retriedStageRuns ?? null,
      exhaustedStageRuns: matrix.counts?.exhaustedStageRuns ?? null,
      repositories: repositories.length,
      databases: databases.length,
      eventLogs: eventAudits.length,
    },
    checks,
    repositories,
    databases,
    agentEventLeakage: {
      passed: leakageFindings.length === 0,
      successfulReadTools: eventAudits.reduce((sum, entry) => sum + entry.successfulReadTools, 0),
      auditedTools: eventAudits.reduce((sum, entry) => sum + entry.auditedTools, 0),
      malformedLines: eventAudits.reduce((sum, entry) => sum + entry.malformedLines, 0),
      findings: leakageFindings,
      scope: "All Agent attempt stdout events only; benchmark Host hidden-check commands in run.json are intentionally excluded.",
    },
    failures: state.failures,
  };
}

function usage() {
  return [
    "Usage:",
    "  node benchmarks/cross-session-agent-suite/audit-results.mjs --suite <suiteRoot> --results <resultsDir>",
    "    --expected-runner <runner> --expected-model <model> --expected-context-budget <chars>",
    "    --expected-repeat <count> --expected-stage-runs <count> --expected-repomind-commit <oid>",
    "    --source-snapshot-sha256 <sha256> [--output <audit.json>]",
    "",
    "Use --expected-runner mixed and --expected-model mixed for manifests with explicit per-stage agents.",
    "The JSON written to stdout is authoritative. Exit code 0 means all integrity checks passed;",
    "the experiment's effect acceptance status is reported from summary.json and is not re-evaluated.",
  ].join("\n");
}

function positiveIntegerOption(value, name) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    throw new Error(`${name} must be a positive base-10 integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} exceeds the safe integer range`);
  return parsed;
}

function requiredStringOption(value, name, pattern = null) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  if (pattern && !pattern.test(value)) throw new Error(`${name} has an invalid format`);
  return value;
}

function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        suite: { type: "string" },
        results: { type: "string" },
        output: { type: "string" },
        "expected-runner": { type: "string" },
        "expected-model": { type: "string" },
        "expected-context-budget": { type: "string" },
        "expected-repeat": { type: "string" },
        "expected-stage-runs": { type: "string" },
        "expected-repomind-commit": { type: "string" },
        "source-snapshot-sha256": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
    if (values.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    if (!values.suite || !values.results) throw new Error("--suite and --results are required");
    const report = auditCrossSessionResults({
      suite: values.suite,
      results: values.results,
      expectedRunner: requiredStringOption(values["expected-runner"], "--expected-runner"),
      expectedModel: requiredStringOption(values["expected-model"], "--expected-model"),
      expectedContextBudget: positiveIntegerOption(values["expected-context-budget"], "--expected-context-budget"),
      expectedRepeat: positiveIntegerOption(values["expected-repeat"], "--expected-repeat"),
      expectedStageRuns: positiveIntegerOption(values["expected-stage-runs"], "--expected-stage-runs"),
      expectedRepoMindCommit: requiredStringOption(
        values["expected-repomind-commit"],
        "--expected-repomind-commit",
        /^[a-f0-9]{40,64}$/u,
      ),
      sourceSnapshotSha256: requiredStringOption(
        values["source-snapshot-sha256"],
        "--source-snapshot-sha256",
        /^[a-f0-9]{64}$/u,
      ),
    });
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (values.output) {
      const output = resolve(values.output);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, serialized, "utf8");
    }
    process.stdout.write(serialized);
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    const report = {
      kind: AUDIT_KIND,
      version: AUDIT_VERSION,
      generatedAt: new Date().toISOString(),
      passed: false,
      fatalError: error instanceof Error ? error.message : String(error),
    };
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (values?.output) {
      const output = resolve(values.output);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, serialized, "utf8");
    }
    process.stdout.write(serialized);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) main();
