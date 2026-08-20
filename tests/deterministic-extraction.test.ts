import { describe, expect, it } from "vitest";
import { extractDeterministicMemories } from "../src/extraction/deterministic.js";

describe("deterministic stable-memory extraction", () => {
  it("extracts explicit Chinese requirements, decisions, and architecture boundaries", () => {
    const candidates = extractDeterministicMemories({
      task: "存储写入必须保持事务性。请完成实现。",
      summary: "采用 SQLite 事务作为唯一写入边界，src/storage 模块负责持久化。",
      changedFiles: ["src/storage/index.ts", "src/storage/index.test.ts"],
    });

    expect(candidates.map((item) => item.type)).toEqual(["requirement", "decision", "architecture"]);
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "requirement", scopeType: "module", scopeValue: "src/storage" }),
      expect.objectContaining({
        type: "architecture",
        scopeType: "module",
        scopeValue: "src/storage",
        relatedFiles: ["src/storage/index.ts", "src/storage/index.test.ts"],
      }),
    ]));
  });

  it("extracts representative English signals", () => {
    const candidates = extractDeterministicMemories({
      task: "Storage writes must remain atomic.",
      summary: "We decided to use SQLite instead of flat files. The src/storage module owns persistence.",
      changedFiles: ["src/storage/database.ts"],
    });

    expect(candidates.map((item) => item.type)).toEqual(["requirement", "decision", "architecture"]);
  });

  it("does not promote ordinary task summaries, questions, code blocks, or benchmark markers", () => {
    const candidates = extractDeterministicMemories({
      task: "请按照要求进行修改。Can this function remain unchanged? REPOMIND_MEMORY_TEST_20260819",
      summary: [
        "Added subtract and all tests pass.",
        "```text",
        "The module must use a fake command.",
        "```",
        "Which module owns persistence?",
      ].join("\n"),
      changedFiles: ["src/math.ts", "tests/math.test.ts"],
    });

    expect(candidates).toEqual([]);
  });

  it("keeps repository scope when changed files span modules and no module is explicit", () => {
    const [requirement] = extractDeterministicMemories({
      task: "所有写入必须保持原子性。",
      summary: "Completed the requested changes.",
      changedFiles: ["src/storage/index.ts", "src/api/index.ts"],
    });

    expect(requirement).toMatchObject({ type: "requirement", scopeType: "repository" });
    expect(requirement).not.toHaveProperty("scopeValue");
  });

  it("prefers an explicit task module when source and test changes span directories", () => {
    const [requirement] = extractDeterministicMemories({
      task: "src/storage 模块的写入必须保持原子性。",
      summary: "Updated storage and its integration test.",
      changedFiles: ["src/storage/index.ts", "tests/storage.test.ts"],
    });

    expect(requirement).toMatchObject({
      type: "requirement",
      scopeType: "module",
      scopeValue: "src/storage",
      relatedFiles: ["src/storage/index.ts"],
    });
  });

  it("captures an implemented module responsibility and explicit error choices from a daily task", () => {
    const candidates = extractDeterministicMemories({
      task: "src/inventory 模块负责库存预留的输入校验和扣减边界。请补充测试并完成实现。",
      summary: [
        "非整数输入抛出 TypeError。",
        "负数和超额预留抛出 RangeError。",
        "npm test 全部通过。",
      ].join("\n"),
      changedFiles: ["src/inventory/index.js", "test/inventory.test.js"],
    });

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "architecture",
        scopeType: "module",
        scopeValue: "src/inventory",
        relatedFiles: ["src/inventory/index.js"],
      }),
      expect.objectContaining({ type: "decision", content: "非整数输入抛出 TypeError。" }),
      expect.objectContaining({ type: "decision", content: "负数和超额预留抛出 RangeError。" }),
    ]));
    expect(candidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "architecture", content: expect.stringContaining("请完成") }),
    ]));
  });

  it("extracts a changed validation decision and gives it a stable subject title", () => {
    const [decision] = extractDeterministicMemories({
      task: "更新窗口校验规则。",
      summary: "`windowMs` 现在允许正的有限数，包括小数。",
      changedFiles: ["src/rate-limit/index.js"],
    }).filter((item) => item.type === "decision");

    expect(decision).toMatchObject({
      title: "Technical decision: windowMs validation",
      content: "`windowMs` 现在允许正的有限数，包括小数。",
      scopeType: "module",
      scopeValue: "src/rate-limit",
    });
  });
});
