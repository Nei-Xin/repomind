import { posix } from "node:path";
import type { MemoryType } from "../domain/types.js";

type StableMemoryType = Extract<MemoryType, "requirement" | "decision" | "architecture">;

export interface DeterministicExtractionInput {
  task: string;
  summary: string;
  changedFiles: string[];
}

export interface DeterministicMemoryCandidate {
  type: StableMemoryType;
  title: string;
  content: string;
  confidence: number;
  scopeType: "repository" | "module";
  scopeValue?: string;
  relatedFiles: string[];
}

const MAX_SENTENCE_CHARS = 400;
const MAX_CANDIDATES_PER_TYPE = 3;
const REQUIREMENT_SIGNAL = /(?:必须|不得|禁止|只能|需要保持|要求(?:使用|保持|提供|支持))|\b(?:must(?:\s+not)?|is required to|are required to|should remain)\b/iu;
const DECISION_SIGNAL = /(?:决定|采用|选择|统一使用|抛出(?:\s|`)*[A-Za-z]+Error|抛出.+异常)|\b(?:decided to|chosen|use\s+.+\s+instead of\s+|throws?\s+(?:an?\s+)?[A-Za-z]*Error)\b/iu;
const ARCHITECTURE_SIGNAL = /(?:负责|由.+(?:处理|负责)|唯一入口)|\b(?:owns|is responsible for|single entry point)\b/iu;
const COMPONENT_SIGNAL = /(?:模块|组件|服务|层|包)|\b(?:module|component|service|layer|package)\b|(?:^|\s|[`(])(?:src|lib|app|packages)\/[A-Za-z0-9_.\-/]+/iu;
const PATH_PATTERN = /(?:src|lib|app|packages)\/[A-Za-z0-9_.\-/]+/giu;

function normalizedFiles(files: string[]): string[] {
  return [...new Set(files.map((file) => file.trim().replaceAll("\\", "/").replace(/^\.\//u, "")).filter(Boolean))];
}

function withoutCodeBlocks(value: string): string {
  return value.replace(/```[\s\S]*?```/gu, "\n");
}

function sentences(value: string): string[] {
  return withoutCodeBlocks(value)
    .split(/(?<=[。！？；;])|(?<=[.!?])\s+|\r?\n/gu)
    .map((sentence) => sentence
      .replace(/^\s*(?:[-*+]\s+|\d+[.)、]\s*|#{1,6}\s+)/u, "")
      .trim())
    .filter((sentence) => sentence.length >= 4 && sentence.length <= MAX_SENTENCE_CHARS)
    .filter((sentence) => !/[?？]\s*$/u.test(sentence))
    .filter((sentence) => !/\bREPOMIND_[A-Z0-9_]+\b/iu.test(sentence));
}

function titleFor(type: StableMemoryType, content: string): string {
  const labels: Record<StableMemoryType, string> = {
    requirement: "Requirement",
    decision: "Technical decision",
    architecture: "Architecture boundary",
  };
  const compact = content.replace(/\s+/gu, " ").replace(/[。！？!?；;]+$/u, "").trim();
  const clipped = compact.length > 72 ? `${compact.slice(0, 69)}...` : compact;
  return `${labels[type]}: ${clipped}`;
}

function moduleFromPath(value: string): string {
  const normalized = value.replace(/[),.;:!?，。；：！？`'"\]]+$/gu, "").replace(/\/+$/u, "");
  return /\.[A-Za-z0-9]+$/u.test(posix.basename(normalized)) ? posix.dirname(normalized) : normalized;
}

function explicitModule(sentence: string): string | null {
  const path = sentence.match(PATH_PATTERN)?.[0];
  if (!path) return null;
  const modulePath = moduleFromPath(path);
  return modulePath === "." ? null : modulePath;
}

function uniqueChangedModule(files: string[]): string | null {
  const modules = [...new Set(files.map((file) => posix.dirname(file)).filter((modulePath) => modulePath !== "."))];
  return modules.length === 1 ? modules[0]! : null;
}

function candidate(
  type: StableMemoryType,
  content: string,
  files: string[],
  fallbackModule: string | null,
): DeterministicMemoryCandidate {
  const modulePath = explicitModule(content) ?? fallbackModule;
  const relatedFiles = modulePath
    ? files.filter((file) => file === modulePath || file.startsWith(`${modulePath}/`))
    : files;
  return {
    type,
    title: titleFor(type, content),
    content,
    confidence: type === "requirement" ? 0.9 : 0.85,
    scopeType: modulePath ? "module" : "repository",
    ...(modulePath ? { scopeValue: modulePath } : {}),
    relatedFiles,
  };
}

function matching(
  type: StableMemoryType,
  source: string,
  signal: RegExp,
  files: string[],
  fallbackModule: string | null,
  extra?: RegExp,
): DeterministicMemoryCandidate[] {
  const seen = new Set<string>();
  const result: DeterministicMemoryCandidate[] = [];
  for (const sentence of sentences(source)) {
    if (!signal.test(sentence) || (extra && !extra.test(sentence))) continue;
    const key = sentence.replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate(type, sentence, files, fallbackModule));
    if (result.length === MAX_CANDIDATES_PER_TYPE) break;
  }
  return result;
}

export function extractDeterministicMemories(input: DeterministicExtractionInput): DeterministicMemoryCandidate[] {
  const files = normalizedFiles(input.changedFiles);
  const changedModule = uniqueChangedModule(files);
  const taskModule = explicitModule(input.task) ?? changedModule;
  const summaryModule = explicitModule(input.summary) ?? changedModule;
  return [
    ...matching("requirement", input.task, REQUIREMENT_SIGNAL, files, taskModule),
    ...matching("decision", input.summary, DECISION_SIGNAL, files, summaryModule),
    ...matching("architecture", `${input.task}\n${input.summary}`, ARCHITECTURE_SIGNAL, files, taskModule, COMPONENT_SIGNAL),
  ];
}
