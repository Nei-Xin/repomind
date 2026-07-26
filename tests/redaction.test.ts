import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryMemoryCore } from "../src/core.js";
import { initializeRepository } from "../src/repository.js";
import { redactSecrets } from "../src/security/redaction.js";
import { createTestRepository, git } from "./helpers.js";

describe("redactSecrets", () => {
  it("redacts common token shapes with typed markers", () => {
    const input = [
      "aws AKIAIOSFODNN7EXAMPLE",
      `github ${"ghp_"}${"a".repeat(36)}`,
      `openai sk-${"b".repeat(24)}`,
      "Authorization: Bearer abcdef1234567890abcdef",
      "API_KEY=supersecretvalue123",
    ].join("\n");
    const result = redactSecrets(input);
    expect(result.redactions).toBe(5);
    expect(result.content).not.toContain("supersecretvalue123");
    expect(result.content).toContain("[REDACTED:aws-access-key-id]");
    expect(result.content).toContain("[REDACTED:github-token]");
    expect(result.content).toContain("[REDACTED:api-key]");
    expect(result.content).toContain("Bearer [REDACTED:bearer-token]");
    expect(result.content).toContain("API_KEY=[REDACTED:credential]");
  });

  it("redacts private key blocks and JWTs", () => {
    const input = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA0Zx",
      "-----END RSA PRIVATE KEY-----",
      `token: eyJ${"h".repeat(10)}.eyJ${"p".repeat(10)}.${"s".repeat(12)}`,
    ].join("\n");
    const result = redactSecrets(input);
    expect(result.content).toContain("[REDACTED:private-key]");
    expect(result.content).not.toContain("MIIEow");
    expect(result.content).toContain("[REDACTED:jwt]");
  });

  it("leaves benign content untouched", () => {
    const input = [
      "idempotency_key: demo-1",
      "tokenizer: splits camelCase identifiers",
      "npm test -- sqlite-loader.test.ts reported 12 passing tests",
      "The token budget stays under 1800.",
    ].join("\n");
    expect(redactSecrets(input)).toEqual({ content: input, redactions: 0 });
  });
});

describe("evidence and memory redaction", () => {
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

  it("redacts secrets in stored evidence and marks the redaction", () => {
    const core = new RepositoryMemoryCore(repository);
    core.startSession({ task: `Rotate the leaked key sk-${"a".repeat(24)} in CI` });
    const row = core.context.database.raw.prepare(
      "SELECT content, metadata_json FROM evidence WHERE kind='user_requirement'",
    ).get() as { content: string; metadata_json: string };
    expect(row.content).toBe("Rotate the leaked key [REDACTED:api-key] in CI");
    expect(JSON.parse(row.metadata_json)).toMatchObject({ redactions: 1 });
    core.close();
  });

  it("redacts memory content stored through record", () => {
    const core = new RepositoryMemoryCore(repository);
    const recorded = core.record({
      type: "command",
      title: "Deploy with the release token",
      content: "Run deploy with DEPLOY_TOKEN=abcdefgh12345 in the environment.",
    });
    expect(recorded.stored).toBe(true);
    const details = core.inspect(recorded.id);
    expect(details.content).toBe("Run deploy with DEPLOY_TOKEN=[REDACTED:credential] in the environment.");
    expect(String(details.content)).not.toContain("abcdefgh12345");
    core.close();
  });

  it("redacts secrets duplicated into evidence metadata, not only content", () => {
    const core = new RepositoryMemoryCore(repository);
    const session = core.startSession({ task: "Rotate credentials" });
    const token = `ghp_${"a".repeat(36)}`;
    core.commitSession({
      sessionId: session.sessionId,
      idempotencyKey: "metadata-1",
      status: "success",
      summary: "Rotated the deploy credentials",
      tests: [{ command: `GITHUB_TOKEN=${token} npm test`, exitCode: 0, summary: "passed" }],
      commands: [{ command: `curl -H "Authorization: Bearer ${"z".repeat(24)}" https://api.example.com`, exitCode: 0, summary: "ok" }],
      remainingWork: [`Revoke ${token}`],
    });
    const rows = core.context.database.raw.prepare("SELECT kind, content, metadata_json FROM evidence").all() as
      Array<{ kind: string; content: string; metadata_json: string }>;
    for (const row of rows) {
      expect(row.content, `content of ${row.kind}`).not.toContain(token);
      expect(row.metadata_json, `metadata of ${row.kind}`).not.toContain(token);
      expect(row.metadata_json, `metadata of ${row.kind}`).not.toContain("zzzzzzzzzzzzzzzzzzzzzzzz");
    }
    const testRow = rows.find((row) => row.kind === "test_result")!;
    expect(JSON.parse(testRow.metadata_json)).toMatchObject({ command: "GITHUB_TOKEN=[REDACTED:github-token] npm test" });

    // Inspect is the path that hands evidence back to an agent.
    const memory = core.search("Rotated deploy credentials")[0]!;
    expect(JSON.stringify(core.inspect(memory.id))).not.toContain(token);
    core.close();
  });

  it("redacts secrets in the session task and in memory tags and file paths", () => {
    const core = new RepositoryMemoryCore(repository);
    const token = `sk-${"b".repeat(24)}`;
    core.startSession({ task: `Remove the leaked ${token} from CI` });
    const sessionRow = core.context.database.raw.prepare("SELECT task FROM sessions").get() as { task: string };
    expect(sessionRow.task).toBe("Remove the leaked [REDACTED:api-key] from CI");

    const recorded = core.record({
      type: "convention",
      title: "Tagged convention",
      content: "Tags must not carry secrets.",
      tags: [`token:${token}`],
      relatedFiles: [`config/${token}.json`],
    });
    const memoryRow = core.context.database.raw.prepare("SELECT tags_json FROM memories WHERE id=?").get(recorded.id) as { tags_json: string };
    const ftsRow = core.context.database.raw.prepare("SELECT search_tokens FROM memory_fts WHERE memory_id=?").get(recorded.id) as { search_tokens: string };
    const fileRow = core.context.database.raw.prepare("SELECT file_path FROM memory_files WHERE memory_id=?").get(recorded.id) as { file_path: string };
    expect(memoryRow.tags_json).not.toContain(token);
    expect(ftsRow.search_tokens).not.toContain(token);
    expect(fileRow.file_path).not.toContain(token);
    expect(core.search(token.slice(3, 20))).toEqual([]);
    core.close();
  });

  it("redacts secrets in governance reasons and the forget tombstone", () => {
    const core = new RepositoryMemoryCore(repository);
    const token = `ghp_${"c".repeat(36)}`;
    const recorded = core.record({ type: "decision", title: "Token decision", content: "Tokens live in the vault." });
    core.invalidateMemory({ memoryId: recorded.id, reason: `Disproven while rotating ${token}` });
    const audit = core.context.database.raw.prepare("SELECT reason, next_json FROM memory_audit_log WHERE action='memory_invalidated'").get() as
      { reason: string; next_json: string };
    expect(audit.reason).not.toContain(token);
    expect(audit.next_json).not.toContain(token);

    core.forgetMemory({ memoryId: recorded.id, reason: `Contained ${token}` });
    const tombstone = core.context.database.raw.prepare("SELECT reason FROM forget_log").get() as { reason: string };
    expect(tombstone.reason).toBe("Contained [REDACTED:github-token]");
    core.close();
  });

  it("excludes sensitive files from captured diffs and records the exclusion", () => {
    const core = new RepositoryMemoryCore(repository);
    const session = core.startSession({ task: "Add application configuration" });
    writeFileSync(join(repository, ".env"), "SECRET=abcdef123456\n", "utf8");
    writeFileSync(join(repository, "app.txt"), "application\n", "utf8");
    git(repository, "add", ".");
    core.commitSession({
      sessionId: session.sessionId,
      idempotencyKey: "redaction-1",
      status: "success",
      summary: "Added application configuration",
    });
    const row = core.context.database.raw.prepare(
      "SELECT content, metadata_json FROM evidence WHERE kind='git_diff'",
    ).get() as { content: string; metadata_json: string };
    expect(row.content).toContain("app.txt");
    expect(row.content).not.toContain("SECRET=abcdef123456");
    expect(JSON.parse(row.metadata_json)).toMatchObject({ excludedFiles: [".env"] });
    core.close();
  });
});
