import { describe, expect, it } from "vitest";
import { stringifyCliJson } from "../src/cli/json.js";

describe("CLI JSON serialization", () => {
  it("stays ASCII-safe and restores Chinese text after parsing", () => {
    const value = { title: "建立初始 Git 基线，并验证已提交 Diff 的采集。" };
    const serialized = stringifyCliJson(value);
    expect(serialized).toMatch(/^[\x00-\x7f]*$/);
    expect(JSON.parse(serialized)).toEqual(value);
  });
});
