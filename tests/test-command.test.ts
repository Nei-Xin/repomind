import { describe, expect, it } from "vitest";
import { isTestInvocation, isVerifyingTestCommand, verifyingTestCommand } from "../src/activity/test-command.js";

describe("test command recognition", () => {
  it.each([
    "npm test",
    "npm run test",
    "pnpm test -- invoice",
    "npx vitest run",
    "pytest -q",
    "go test ./...",
    "cargo test",
    "node --test",
    "node --test storage.test.mjs",
    "/opt/homebrew/bin/node --test x.mjs",
    "node --experimental-strip-types --test a.ts",
    "node --test-reporter=spec --test a.mjs",
    "node --test-only a.mjs",
  ])("recognizes %s", (command) => {
    expect(isTestInvocation(command)).toBe(true);
    expect(isVerifyingTestCommand(command)).toBe(true);
  });

  it.each([
    "node app.js",
    "node --testfoo a.mjs",
    "nodemon --test",
    "ls tests/",
    "cat storage.test.mjs",
    "git log --oneline",
  ])("does not treat %s as a test", (command) => {
    expect(isVerifyingTestCommand(command)).toBe(false);
  });

  it.each([
    ["cd app && npm test", true],
    ["npm run build && npm test", true],
    ["ls; npm test", true],
    ["npm test 2>&1", true],
    ["npm test &> test.log", true],
    ["npm test > out.txt 2>&1", true],
    ["echo 'a | b; c' && npm test", true],
    ["echo \"x || y\" && node --test", true],
    ["npm test && echo done", true],
    ["node --test storage.test.mjs 2>&1 | tail -30", false],
    ["npm test | tee test.log", false],
    ["npm test |& tail", false],
    ["npm test; echo done", false],
    ["npm test || true", false],
    ["npm test && echo ok || echo failed", false],
    ["npm test &", false],
    ["npm test\necho done", false],
    ["npm test | tail -5 && npm test", true],
  ])("attributes the exit status of %j to the test: %s", (command, expected) => {
    expect(isVerifyingTestCommand(command)).toBe(expected);
  });

  it("ignores operators inside quotes when locating the test", () => {
    expect(isVerifyingTestCommand("npm test -- --grep 'a | b'")).toBe(true);
    expect(isVerifyingTestCommand("npm test -- --grep \"a; b\"")).toBe(true);
    expect(isVerifyingTestCommand("echo 'npm test'")).toBe(false);
  });

  it.each([
    ["node --test storage.test.mjs", "node --test storage.test.mjs"],
    ["ls src && cat storage.test.mjs && node --test storage.test.mjs", "node --test storage.test.mjs"],
    ["cd app && npm test", "cd app && npm test"],
    ["ls && cd app && npm test", "cd app && npm test"],
    ["cd app && ls && npm test", "npm test"],
    ["export NODE_ENV=test && npm test", "export NODE_ENV=test && npm test"],
    ["CI=1 && npm test", "CI=1 && npm test"],
    ["source .venv/bin/activate && pytest -q", "source .venv/bin/activate && pytest -q"],
    ["nvm use 22 && npm test", "nvm use 22 && npm test"],
    ["npm run build && npm test", "npm test"],
    ["npm test && echo done", "npm test"],
    ["echo start; cd app && npm test", "cd app && npm test"],
    ["npm test 2>&1", "npm test 2>&1"],
    ["npm test | tail", null],
    ["git status", null],
  ])("extracts the verifying test from %j", (command, expected) => {
    expect(verifyingTestCommand(command)).toBe(expected);
  });
});
