import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { RepositoryMemoryCore } from "./core.js";
import type { MemoryType } from "./domain/types.js";
import { RepoMindError } from "./errors.js";
import { inspectGit, locateGitRoot } from "./git/git-inspector.js";
import { redactSecrets } from "./security/redaction.js";

const MAX_SOURCE_BYTES = 128 * 1024;
const MAX_CONTENT_CHARS = 4_000;

const sourceKindSchema = z.enum(["readme", "adr", "contributing", "git-history"]);
const candidateSchema = z.object({
  id: z.string().regex(/^btc_[a-f0-9]{24}$/u),
  type: z.enum(["architecture", "convention", "decision", "command", "failure", "solution", "dependency", "location", "requirement", "risk"]),
  title: z.string().min(1),
  content: z.string().min(1),
  confidence: z.number().min(0).max(1),
  tags: z.array(z.string()),
  relatedFiles: z.array(z.string()),
  source: z.object({ kind: sourceKindSchema, reference: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
}).strict();

export const bootstrapBundleSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  repository: z.object({
    projectId: z.string().uuid(),
    root: z.string().min(1),
    head: z.string().nullable(),
  }).strict(),
  candidates: z.array(candidateSchema),
}).strict();

export type BootstrapBundle = z.infer<typeof bootstrapBundleSchema>;
export type BootstrapCandidate = BootstrapBundle["candidates"][number];

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function markdownTitle(text: string, fallback: string): string {
  const heading = text.split(/\r?\n/u).map((line) => line.trim()).find((line) => /^#\s+\S/u.test(line));
  return redactSecrets((heading?.replace(/^#\s+/u, "") ?? fallback).trim()).content.slice(0, 160);
}

function markdownContent(text: string): string {
  const withoutFrontmatter = text.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/u, "");
  const withoutCode = withoutFrontmatter.replace(/```[\s\S]*?```/gu, "[code example omitted]");
  const normalized = withoutCode
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(/^\s*[-*+]\s+/gmu, "- ")
    .replace(/\r\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return redactSecrets(normalized.slice(0, MAX_CONTENT_CHARS)).content;
}

function candidate(input: {
  type: MemoryType;
  title: string;
  content: string;
  confidence: number;
  sourceKind: BootstrapCandidate["source"]["kind"];
  reference: string;
  sourceHash: string;
  relatedFiles?: string[];
}): BootstrapCandidate {
  const fingerprint = hash(`${input.sourceKind}\0${input.reference}\0${input.content}`);
  return {
    id: `btc_${fingerprint.slice(0, 24)}`,
    type: input.type,
    title: input.title,
    content: input.content,
    confidence: input.confidence,
    tags: ["bootstrap", input.sourceKind],
    relatedFiles: input.relatedFiles ?? [],
    source: { kind: input.sourceKind, reference: input.reference, sha256: input.sourceHash },
  };
}

function markdownCandidate(root: string, path: string, kind: "readme" | "adr" | "contributing"): BootstrapCandidate | null {
  const bytes = readFileSync(path);
  if (bytes.length > MAX_SOURCE_BYTES) return null;
  const text = bytes.toString("utf8").replace(/^\uFEFF/u, "");
  const content = markdownContent(text);
  if (content.length < 40) return null;
  const reference = relative(root, path).replaceAll("\\", "/");
  if (redactSecrets(reference).redactions > 0) return null;
  const type: MemoryType = kind === "adr" ? "decision" : kind === "contributing" ? "convention" : "architecture";
  const fallback = kind === "adr" ? basename(path, ".md") : kind === "contributing" ? "Repository contribution conventions" : "Repository overview";
  return candidate({
    type,
    title: markdownTitle(text, fallback),
    content,
    confidence: kind === "adr" ? 0.8 : kind === "contributing" ? 0.7 : 0.55,
    sourceKind: kind,
    reference,
    sourceHash: hash(bytes),
    relatedFiles: [reference],
  });
}

function rootMarkdown(root: string, pattern: RegExp): string | null {
  const entry = readdirSync(root, { withFileTypes: true })
    .find((item) => item.isFile() && pattern.test(item.name));
  return entry ? join(root, entry.name) : null;
}

function adrFiles(root: string): string[] {
  const directory = join(root, "docs", "adr");
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md") && entry.name.toLowerCase() !== "readme.md")
    .map((entry) => join(directory, entry.name))
    .sort()
    .slice(0, 50);
}

function gitHistoryCandidate(root: string, head: string | null): BootstrapCandidate | null {
  if (!head) return null;
  let history: string;
  try {
    history = execFileSync("git", ["log", "-n", "20", "--pretty=format:%h%x09%s"], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    }).trim();
  } catch (error) {
    throw new RepoMindError("GIT_INSPECTION_FAILED", "Unable to read recent Git history for bootstrap", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!history) return null;
  const content = redactSecrets(`Recent repository changes:\n${history.split(/\r?\n/u).map((line) => `- ${line}`).join("\n")}`).content;
  return candidate({
    type: "solution",
    title: "Recent repository change history",
    content,
    confidence: 0.4,
    sourceKind: "git-history",
    reference: "git log -n 20",
    sourceHash: hash(head),
  });
}

export function generateBootstrapBundle(repositoryPath: string): BootstrapBundle {
  const root = resolve(locateGitRoot(repositoryPath));
  const core = new RepositoryMemoryCore(root);
  try {
    const snapshot = inspectGit(root);
    const candidates: BootstrapCandidate[] = [];
    const readme = rootMarkdown(root, /^readme\.md$/iu);
    const contributing = rootMarkdown(root, /^contributing\.md$/iu);
    if (readme) {
      const value = markdownCandidate(root, readme, "readme");
      if (value) candidates.push(value);
    }
    if (contributing) {
      const value = markdownCandidate(root, contributing, "contributing");
      if (value) candidates.push(value);
    }
    for (const path of adrFiles(root)) {
      const value = markdownCandidate(root, path, "adr");
      if (value) candidates.push(value);
    }
    const history = gitHistoryCandidate(root, snapshot.head);
    if (history) candidates.push(history);
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      repository: { projectId: core.context.marker.projectId, root: redactSecrets(root).content, head: snapshot.head },
      candidates,
    };
  } finally {
    core.close();
  }
}

export function parseBootstrapBundle(value: unknown, source = "bootstrap bundle"): BootstrapBundle {
  const parsed = bootstrapBundleSchema.safeParse(value);
  if (!parsed.success) {
    throw new RepoMindError("INVALID_INPUT", `Invalid ${source}`, {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  const ids = parsed.data.candidates.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) throw new RepoMindError("INVALID_INPUT", `${source} contains duplicate candidate ids`);
  const mismatched = parsed.data.candidates.filter((entry) =>
    entry.id !== `btc_${hash(`${entry.source.kind}\0${entry.source.reference}\0${entry.content}`).slice(0, 24)}`,
  ).map((entry) => entry.id);
  if (mismatched.length) {
    throw new RepoMindError("INVALID_INPUT", `${source} contains candidates whose deterministic ids do not match their content: ${mismatched.join(", ")}`);
  }
  return parsed.data;
}

export function loadBootstrapBundle(path: string): BootstrapBundle {
  try {
    return parseBootstrapBundle(JSON.parse(readFileSync(resolve(path), "utf8").replace(/^\uFEFF/u, "")), path);
  } catch (error) {
    if (error instanceof RepoMindError) throw error;
    throw new RepoMindError("INVALID_INPUT", `Unable to read bootstrap bundle ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function writeBootstrapBundle(bundle: BootstrapBundle, path: string): string {
  const absolute = resolve(path);
  writeFileSync(absolute, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return absolute;
}

function verifyCandidateSource(root: string, entry: BootstrapCandidate, currentHead: string | null): void {
  if (entry.source.kind === "git-history") {
    if (!currentHead || hash(currentHead) !== entry.source.sha256) {
      throw new RepoMindError("INVALID_INPUT", `Bootstrap candidate ${entry.id} Git history is stale; generate a new bundle`);
    }
    return;
  }
  const path = resolve(root, entry.source.reference);
  const relativePath = relative(root, path);
  if (isAbsolute(entry.source.reference) || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new RepoMindError("INVALID_INPUT", `Bootstrap candidate ${entry.id} source is outside the repository`);
  }
  if (!existsSync(path) || hash(readFileSync(path)) !== entry.source.sha256) {
    throw new RepoMindError("INVALID_INPUT", `Bootstrap candidate ${entry.id} source changed; generate a new bundle`);
  }
}

export function applyBootstrapBundle(
  repositoryPath: string,
  bundleValue: unknown,
  selectedIds?: string[],
): {
  projectId: string;
  candidates: number;
  selected: number;
  stored: number;
  reactivated: number;
  skipped: number;
  conflicts: number;
  memories: Array<{ candidateId: string; memoryId: string; stored: boolean; reactivated: boolean; conflicts: string[] }>;
} {
  const bundle = parseBootstrapBundle(bundleValue);
  const root = resolve(locateGitRoot(repositoryPath));
  const core = new RepositoryMemoryCore(root);
  try {
    if (core.context.marker.projectId !== bundle.repository.projectId) {
      throw new RepoMindError("INVALID_INPUT", "Bootstrap bundle belongs to a different repository project id");
    }
    const selectedSet = selectedIds === undefined ? null : new Set(selectedIds);
    const selected = selectedSet
      ? bundle.candidates.filter((entry) => selectedSet.has(entry.id))
      : bundle.candidates;
    const unknown = (selectedIds ?? []).filter((id) => !bundle.candidates.some((entry) => entry.id === id));
    if (unknown.length) throw new RepoMindError("INVALID_INPUT", `Unknown bootstrap candidate ids: ${unknown.join(", ")}`);
    const snapshot = inspectGit(root);
    for (const entry of selected) verifyCandidateSource(root, entry, snapshot.head);
    const memories = selected.map((entry) => {
      const result = core.record({
        type: entry.type,
        title: entry.title,
        content: entry.content,
        confidence: entry.confidence,
        tags: entry.tags,
        ...(entry.relatedFiles.length ? { relatedFiles: entry.relatedFiles } : {}),
      });
      return { candidateId: entry.id, memoryId: result.id, stored: result.stored, reactivated: result.reactivated, conflicts: result.conflicts };
    });
    return {
      projectId: core.context.marker.projectId,
      candidates: bundle.candidates.length,
      selected: selected.length,
      stored: memories.filter((entry) => entry.stored).length,
      reactivated: memories.filter((entry) => entry.reactivated).length,
      skipped: memories.filter((entry) => !entry.stored).length,
      conflicts: memories.reduce((sum, entry) => sum + entry.conflicts.length, 0),
      memories,
    };
  } finally {
    core.close();
  }
}
