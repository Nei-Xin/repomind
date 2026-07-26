import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryMemoryCore } from "../src/core.js";
import { initializeRepository } from "../src/repository.js";
import { buildMatchExpression, cjkBigrams, lexicalTerms, searchTokens } from "../src/search/lexical.js";
import { createTestRepository } from "./helpers.js";

describe("lexical helpers", () => {
  it("expands ideographic runs into overlapping bigrams", () => {
    expect(cjkBigrams("单元测试")).toEqual(["单元", "元测", "测试"]);
    expect(cjkBigrams("如何运行 单元测试")).toEqual(["如何", "何运", "运行", "单元", "元测", "测试"]);
    expect(cjkBigrams("和")).toEqual(["和"]);
    expect(cjkBigrams("npm test")).toEqual([]);
  });

  it("keeps identifier splitting for latin text", () => {
    const tokens = searchTokens("parseCommitInput", "src/cli/commit-input.ts", ["snake_case"], []);
    expect(tokens).toContain("parse commit input");
    expect(tokens).toContain("src cli commit input ts");
    expect(tokens).toContain("snake case");
  });

  it("builds an OR expression and expands ideographic query words", () => {
    expect(buildMatchExpression("sqlite loader")).toBe('"sqlite" OR "loader"');
    expect(buildMatchExpression("单元测试")).toBe('"单元" OR "元测" OR "测试"');
    // A mixed word keeps its latin remainder alongside the bigrams.
    expect(buildMatchExpression("SQLite扩展")).toBe('"扩展" OR "SQLite"');
  });

  it("returns null when no usable term survives", () => {
    expect(buildMatchExpression("")).toBeNull();
    expect(buildMatchExpression('  "" () ')).toBeNull();
  });

  it("produces the same term vocabulary a lexical retriever would index", () => {
    expect(lexicalTerms("parseCommitInput 单元测试")).toEqual(
      expect.arrayContaining(["parsecommitinput", "parse", "commit", "input", "单元", "元测", "测试"]),
    );
  });
});

describe("ideographic search end to end", () => {
  let repository: string;
  let data: string;

  beforeEach(() => {
    repository = createTestRepository();
    data = mkdtempSync(join(tmpdir(), "repomind-data-"));
    process.env.REPOMIND_DATA_DIR = data;
    initializeRepository(repository).database.close();
  });

  afterEach(() => {
    rmSync(repository, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
    delete process.env.REPOMIND_DATA_DIR;
  });

  it("finds a Chinese memory by a Chinese substring query", () => {
    const core = new RepositoryMemoryCore(repository);
    const recorded = core.record({
      type: "command",
      title: "运行单元测试",
      content: "使用 npm test 运行全部单元测试，Windows 下需要先执行构建。",
    });

    // The substring a user would actually type; unicode61 alone cannot match it.
    expect(core.search("单元测试")[0]).toMatchObject({ id: recorded.id });
    expect(core.search("如何运行单元测试")[0]).toMatchObject({ id: recorded.id });
    expect(core.search("Windows 构建")[0]).toMatchObject({ id: recorded.id });
    core.close();
  });

  it("does not match an unrelated Chinese query", () => {
    const core = new RepositoryMemoryCore(repository);
    core.record({ type: "command", title: "运行单元测试", content: "使用 npm test 运行全部单元测试。" });
    expect(core.search("数据库迁移回滚")).toEqual([]);
    core.close();
  });

  it("reindex rebuilds the index for memories written before the tokenizer change", () => {
    const core = new RepositoryMemoryCore(repository);
    const recorded = core.record({ type: "convention", title: "架构约定", content: "所有外部调用必须经过统一适配器。" });

    // Two terms that appear in the memory but not contiguously, so only the FTS
    // path can match them; the substring fallback searches for the whole query.
    const query = "适配器 外部调用";
    expect(core.search(query)[0]).toMatchObject({ id: recorded.id });

    // Simulate a legacy index entry written without bigram expansion.
    const db = core.context.database.raw;
    db.prepare("UPDATE memory_fts SET search_tokens=? WHERE memory_id=?").run("架构约定 所有外部调用必须经过统一适配器。", recorded.id);
    expect(core.search(query)).toEqual([]);

    expect(core.reindex()).toEqual({ memories: 1 });
    expect(core.search(query)[0]).toMatchObject({ id: recorded.id });
    core.close();
  });
});
