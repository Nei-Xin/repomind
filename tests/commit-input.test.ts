import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCommitInput, readCommitInput } from "../src/cli/commit-input.js";
import { RepoMindError } from "../src/errors.js";

describe("CLI commit input", () => {
  it("accepts the complete session result model", () => {
    expect(parseCommitInput({
      sessionId: "ses_1",
      idempotencyKey: "turn-1",
      status: "success",
      summary: "Implemented migration validation.",
      decisions: ["Migrations run in transactions."],
      tests: [{ command: "npm test", exitCode: 0, summary: "8 tests passed" }],
      commands: [{ command: "npm run build", exitCode: 0, summary: "Build passed" }],
      remainingWork: [],
    })).toMatchObject({ sessionId: "ses_1", tests: [{ exitCode: 0 }] });
  });

  it("reports field paths for invalid input", () => {
    try {
      parseCommitInput({ sessionId: "ses_1", status: "done", summary: "invalid" });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RepoMindError);
      expect((error as RepoMindError).details).toMatchObject({
        issues: expect.arrayContaining([expect.objectContaining({ path: "idempotencyKey" })]),
      });
    }
  });

  it("reads UTF-8 JSON files with a PowerShell-style BOM", () => {
    const directory = mkdtempSync(join(tmpdir(), "repomind-commit-input-"));
    const path = join(directory, "result.json");
    try {
      writeFileSync(path, `\uFEFF${JSON.stringify({
        sessionId: "ses_1",
        idempotencyKey: "turn-1",
        status: "success",
        summary: "PowerShell JSON",
      })}`, "utf8");
      expect(readCommitInput(path)).toMatchObject({ sessionId: "ses_1", summary: "PowerShell JSON" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
