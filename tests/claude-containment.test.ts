import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateClaudeContainment,
  pathWithinCheckout,
} from "../src/integrations/claude/containment-hook.js";

describe("Claude checkout containment", () => {
  let scratch: string | undefined;

  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  function fixture(): { root: string; outside: string } {
    scratch = mkdtempSync(join(tmpdir(), "repomind-claude-containment-"));
    const root = join(scratch, "checkout");
    const outside = join(scratch, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(root, "inside.txt"), "inside\n", "utf8");
    writeFileSync(join(outside, "canary.txt"), "secret\n", "utf8");
    return { root, outside };
  }

  const event = (tool_name: string, tool_input: Record<string, unknown>): unknown => ({
    hook_event_name: "PreToolUse",
    tool_name,
    tool_input,
  });

  it("allows existing and new paths inside the checkout", () => {
    const { root } = fixture();
    expect(pathWithinCheckout(root, "inside.txt")).toBe(true);
    expect(pathWithinCheckout(root, join(root, "new", "file.txt"))).toBe(true);
    expect(evaluateClaudeContainment(root, event("Read", { file_path: "inside.txt" })).allowed).toBe(true);
    expect(evaluateClaudeContainment(root, event("Write", { file_path: "new/file.txt" })).allowed).toBe(true);
  });

  it("denies absolute, traversal, and canonical link escapes", () => {
    const { root, outside } = fixture();
    expect(pathWithinCheckout(root, join(outside, "canary.txt"))).toBe(false);
    expect(pathWithinCheckout(root, "../outside/canary.txt")).toBe(false);
    expect(evaluateClaudeContainment(root, event("Glob", { path: outside })).allowed).toBe(false);
    expect(evaluateClaudeContainment(root, event("Read", { file_path: "../outside/canary.txt" })).allowed).toBe(false);
    try {
      symlinkSync(outside, join(root, "linked-outside"), "junction");
      expect(pathWithinCheckout(root, "linked-outside/canary.txt")).toBe(false);
    } catch {
      // Windows environments without link privileges still exercise lexical containment above.
    }
  });

  it("allows checkout-local shell commands and rejects escape mechanisms", () => {
    const { root, outside } = fixture();
    expect(evaluateClaudeContainment(root, event("Bash", { command: "node --test && git diff --check" })).allowed).toBe(true);
    expect(evaluateClaudeContainment(root, event("Bash", { command: `git -C \"${root}\" status --short` })).allowed).toBe(true);
    expect(evaluateClaudeContainment(root, event("Bash", { command: `type \"${join(outside, "canary.txt")}\"` })).allowed).toBe(false);
    expect(evaluateClaudeContainment(root, event("PowerShell", { command: "Get-Content ../outside/canary.txt" })).allowed).toBe(false);
    expect(evaluateClaudeContainment(root, event("Bash", { command: "node -e \"require('fs').readFileSync('outside')\"" })).allowed).toBe(false);
    expect(evaluateClaudeContainment(root, event("Bash", { command: "type %USERPROFILE%\\secret.txt" })).allowed).toBe(false);
  });

  it("fails closed for malformed hook events", () => {
    const { root } = fixture();
    expect(evaluateClaudeContainment(root, {})).toEqual({
      allowed: false,
      reason: "Unexpected Claude hook event.",
    });
    expect(evaluateClaudeContainment(root, event("Read", {})).allowed).toBe(false);
    expect(evaluateClaudeContainment(root, event("Glob", { pattern: "*.ts" })).allowed).toBe(true);
  });
});
