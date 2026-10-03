import { describe, expect, it } from "vitest";
import {
  isBuildInvocation,
  isTestInvocation,
  isVerifyingTestCommand,
  verificationKey,
  verificationSteps,
  verifyingTestCommand,
} from "../src/activity/test-command.js";

describe("test command recognition", () => {
  it.each([
    "npm test",
    "npm run test",
    "npm --workspace a test",
    "pnpm --filter billing test",
    "node --import tsx --test a.ts",
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
    ["cd missing; npm test", false],
    ["cd app && ls; npm test", false],
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
    ["cd app && ls && npm test", "cd app && npm test"],
    ["export NODE_ENV=test && npm test", "export NODE_ENV=test && npm test"],
    ["CI=1 && npm test", "CI=1 && npm test"],
    ["source .venv/bin/activate && pytest -q", "source .venv/bin/activate && pytest -q"],
    ["nvm use 22 && npm test", "nvm use 22 && npm test"],
    ["npm run build && npm test", "npm test"],
    ["npm test && echo done", "npm test"],
    ["echo start; cd app && npm test", "cd app && npm test"],
    ["npm test 2>&1", "npm test"],
    ["cd app && npm test > out.log 2>&1", "cd app && npm test"],
    ["npm test | tail", null],
    ["git status", null],
  ])("extracts the verifying test from %j", (command, expected) => {
    expect(verifyingTestCommand(command)).toBe(expected);
  });

  it.each([
    "npm run build", "pnpm build", "yarn typecheck", "npm run lint", "npx tsc --noEmit", "tsc -p .",
    "cargo build", "cargo clippy", "go vet ./...", "make", "make all", "./gradlew build", "mvn package",
    "dotnet build", "eslint src", "ruff check .", "mypy src",
  ])("recognizes build step %s", (command) => {
    expect(isBuildInvocation(command)).toBe(true);
  });

  it.each(["npm install", "git status", "ls build", "cat Makefile", "echo make"])("does not treat %s as a build", (command) => {
    expect(isBuildInvocation(command)).toBe(false);
  });

  it.each([
    ["npm test", "npm test"],
    ["npm test 2>&1 | tail -30", "npm test"],
    ["cd app && npm test > out.log 2>&1", "cd app && npm test"],
    ["ls && node --test storage.test.mjs &> log.txt", "node --test storage.test.mjs"],
    ["npm run build && npm test", "npm test"],
    ["npm run build | tee build.log", "npm run build"],
    ["cat package.json", null],
    ["ls -la src", null],
  ])("keys verification steps (%j -> %j)", (command, key) => {
    expect(verificationKey(command)).toBe(key);
  });
});

describe("verification identity and shell semantics", () => {
  it.each(["ls test", "cat tests", "echo npm test", "grep test README.md", "node app.js --test"])("does not invent a test for %s", (command) => {
    expect(isTestInvocation(command)).toBe(false);
    expect(verificationSteps(command, 1)).toEqual([]);
  });

  it.each([
    ['npm test -- --testNamePattern="a > b"', 'npm test -- --testNamePattern="a > b"'],
    ['npm test -- --testNamePattern="a  b"', 'npm test -- --testNamePattern="a  b"'],
    ['node --test > "test log.txt"', 'node --test'],
    ['npm test -- --grep "(a|b)"', 'npm test -- --grep "(a|b)"'],
    ["npm test -- --grep 'a | b' 2>&1", "npm test -- --grep 'a | b'"],
  ])("preserves quoted arguments in %s", (command, expected) => {
    expect(verifyingTestCommand(command)).toBe(expected);
  });

  it.each(["npm test || true", "npm test | tail", "npm test; echo done", "npm test &", "false || npm test"])("does not use a masked status to verify %s", (command) => {
    expect(verificationSteps(command, 0)).toEqual([{ key: "npm test", passed: false, outcome: "unknown" }]);
  });

  it("tracks every verification step and preserves execution context", () => {
    expect(verificationSteps("npm run build && npm test", 1)).toEqual([
      { key: "npm run build", passed: false, outcome: "failed" }, { key: "npm test", passed: false, outcome: "failed" },
    ]);
    expect(verificationSteps("npm run build && npm test", 0).every((step) => step.passed)).toBe(true);
    expect(verificationKey("cd a && ls && npm test")).toBe("cd a && npm test");
    expect(verificationKey("cd b && npm test")).toBe("cd b && npm test");
    expect(verificationKey("cd . && npm test")).toBe("npm test");
    expect(verificationKey("NODE_ENV=production npm test")).not.toBe(verificationKey("NODE_ENV=test npm test"));
  });
});
