import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "repomind-layered-consumption-fixtures-"));
const suite = join(root, "suite");

const contracts = {
  "layered-release-command": {
    contractId: "corr-release-command",
    producer: "ops/pending/release-review.todo",
    relay: "ops/pending/release-context-relay.todo",
    producerStatus: "ops/status/release-review.status",
    relayStatus: "ops/status/release-handoff.status",
  },
  "layered-stale-endpoint": {
    contractId: "corr-stale-endpoint",
    producer: "ops/pending/jobs-cutover.todo",
    relay: "ops/pending/jobs-context-relay.todo",
    producerStatus: "ops/status/jobs-cutover.status",
    relayStatus: "ops/status/jobs-handoff.status",
  },
  "layered-error-contract": {
    contractId: "corr-error-contract",
    producer: "ops/pending/parser-review.todo",
    relay: "ops/pending/parser-context-relay.todo",
    producerStatus: "ops/status/parser-contract.status",
    relayStatus: "ops/status/parser-handoff.status",
  },
};

function run(command, args, cwd) {
  return spawnSync(command === "node" ? process.execPath : command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
}

function requireSuccess(result, description) {
  if (result.status !== 0 || result.error) {
    throw new Error(`${description} failed\n${result.stderr || result.stdout || result.error?.message}`);
  }
}

function execute(check, repository) {
  return run(
    check.command.replaceAll("{repo}", repository),
    check.args.map((argument) => argument.replaceAll("{repo}", repository)),
    repository,
  );
}

function changedFiles(repository) {
  const result = run("git", ["status", "--porcelain"], repository);
  requireSuccess(result, `inspect ${repository}`);
  return result.stdout.split(/\r?\n/u).filter(Boolean).map((line) => line.slice(3).trim()).sort();
}

function requireChanges(repository, expected, description) {
  const actual = changedFiles(repository);
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${description}: expected ${wanted.join(", ")}; received ${actual.join(", ")}`);
  }
}

function commit(repository, message) {
  requireSuccess(run("git", ["add", "--all"], repository), `${message} add`);
  requireSuccess(run("git", [
    "-c", "user.name=RepoMind",
    "-c", "user.email=benchmark@repomind.local",
    "-c", "commit.gpgsign=false",
    "commit", "--quiet", "-m", message,
  ], repository), `${message} commit`);
}

function outside(child, parent) {
  const path = relative(parent, child);
  return path.startsWith("..") && !isAbsolute(path);
}

function writePositive(contractId, repository) {
  if (contractId === "corr-release-command") {
    const path = join(repository, "package.json");
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    pkg.scripts["verify:release"] = "node --test && node scripts/check-schema.mjs";
    writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
    return;
  }
  if (contractId === "corr-stale-endpoint") {
    writeFileSync(join(repository, "src", "client.js"), `export function jobsEndpoint() {
  return "/v2/tasks";
}
`, "utf8");
    writeFileSync(join(repository, "test", "jobs-endpoint.test.js"), `import assert from "node:assert/strict";
import test from "node:test";
import { jobsEndpoint } from "../src/client.js";

test("uses the production jobs route", () => assert.equal(jobsEndpoint(), "/v2/tasks"));
`, "utf8");
    return;
  }
  if (contractId === "corr-error-contract") {
    writeFileSync(join(repository, "src", "parse-config.js"), `export function parseConfig(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const failure = new SyntaxError("Configuration JSON could not be parsed", { cause: error });
    failure.code = "CONFIG_PARSE_FAILED";
    throw failure;
  }
}
`, "utf8");
    writeFileSync(join(repository, "test", "parse-config.test.js"), `import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../src/parse-config.js";

test("preserves valid parsing", () => assert.deepEqual(parseConfig('{"ok":true}'), { ok: true }));
test("wraps malformed JSON", () => assert.throws(() => parseConfig("{"), (error) =>
  error instanceof SyntaxError && error.code === "CONFIG_PARSE_FAILED" && error.cause instanceof SyntaxError));
`, "utf8");
    return;
  }
  throw new Error(`unknown contract ${contractId}`);
}

try {
  const generator = resolve(import.meta.dirname, "create.mjs");
  const generated = run(process.execPath, [generator, suite], process.cwd());
  requireSuccess(generated, "layered fixture generation");
  const output = JSON.parse(generated.stdout);
  const manifestPath = join(suite, "manifest.layered-consumption.json");
  if (output.layeredConsumptionManifest !== manifestPath) {
    throw new Error("generator did not expose the layered-consumption manifest path");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const smokeManifest = JSON.parse(readFileSync(output.layeredConsumptionSmokeManifest, "utf8"));
  if (smokeManifest.sequences.length !== 1
    || smokeManifest.sequences[0].id !== manifest.sequences[0].id) {
    throw new Error("layered smoke manifest must contain only the first formal sequence");
  }
  if (manifest.version !== 1 || manifest.sequences.length !== 3) {
    throw new Error("layered manifest must contain three version-1 sequences");
  }
  const requiredAcceptance = {
    minSharedDerivedRecallRate: 1,
    minSharedL2RecallRate: 1,
    minSharedL3RecallRate: 1,
    maxSharedDerivedStageL1RecallRate: 0,
    maxIsolatedDerivedRecallRate: 0,
  };
  for (const [key, value] of Object.entries(requiredAcceptance)) {
    if (manifest.acceptance?.[key] !== value) throw new Error(`missing strict layered acceptance gate ${key}`);
  }

  const repository = manifest.sequences[0].baseRepository;
  const results = [];
  for (const sequence of manifest.sequences) {
    const specification = contracts[sequence.id];
    if (!specification) throw new Error(`unexpected layered sequence ${sequence.id}`);
    if (sequence.baseRepository !== repository || sequence.stages.length !== 3) {
      throw new Error(`${sequence.id}: expected one common repository and exactly three stages`);
    }
    const [producer, relay, consumer] = sequence.stages;
    if (JSON.stringify(producer.allowedChanges) !== JSON.stringify([specification.producer, specification.producerStatus])) {
      throw new Error(`${sequence.id}: producer allowlist mismatch`);
    }
    if (JSON.stringify(relay.allowedChanges) !== JSON.stringify([specification.relay, specification.relayStatus])) {
      throw new Error(`${sequence.id}: relay allowlist mismatch`);
    }
    if (consumer.maxMemories !== 0) throw new Error(`${sequence.id}: derived consumer must disable L1 retrieval`);
    const modes = sequence.stages.map((stage) => stage.hiddenChecks[0]?.args?.[1]);
    if (JSON.stringify(modes) !== JSON.stringify(["layered-producer", "relay", "consumer"])) {
      throw new Error(`${sequence.id}: hidden verifier modes must be layered-producer/relay/consumer`);
    }
    for (const stage of sequence.stages) {
      for (const check of stage.publicChecks) requireSuccess(execute(check, repository), `${sequence.id}/${stage.id} public baseline`);
      for (const check of stage.hiddenChecks) {
        const verifier = check.args[0];
        if (!isAbsolute(verifier) || !outside(verifier, repository)) {
          throw new Error(`${sequence.id}/${stage.id}: hidden verifier must be absolute and external`);
        }
        if (execute(check, repository).status === 0) {
          throw new Error(`${sequence.id}/${stage.id}: hidden baseline unexpectedly passed`);
        }
      }
    }

    const positive = join(root, `positive-${sequence.id}`);
    requireSuccess(run("git", ["clone", "--quiet", repository, positive], root), `${sequence.id} clone`);
    unlinkSync(join(positive, specification.producer));
    writeFileSync(join(positive, specification.producerStatus), "review=closed\n", "utf8");
    requireChanges(positive, producer.allowedChanges, `${sequence.id} producer changes`);
    for (const check of producer.hiddenChecks) requireSuccess(execute(check, positive), `${sequence.id} producer positive`);
    commit(positive, "known-positive producer");

    unlinkSync(join(positive, specification.relay));
    writeFileSync(join(positive, specification.relayStatus), "handoff=ready\n", "utf8");
    requireChanges(positive, relay.allowedChanges, `${sequence.id} relay changes`);
    for (const check of relay.hiddenChecks) requireSuccess(execute(check, positive), `${sequence.id} relay positive`);
    commit(positive, "known-positive relay");

    if (execute(consumer.hiddenChecks[0], positive).status === 0) {
      throw new Error(`${sequence.id}: consumer passed before the hidden contract was implemented`);
    }
    writePositive(specification.contractId, positive);
    requireChanges(positive, consumer.allowedChanges, `${sequence.id} consumer changes`);
    for (const check of consumer.publicChecks) requireSuccess(execute(check, positive), `${sequence.id} consumer public positive`);
    for (const check of consumer.hiddenChecks) requireSuccess(execute(check, positive), `${sequence.id} consumer hidden positive`);
    results.push({ sequenceId: sequence.id, stages: 3, maxMemoriesAtConsumer: 0, knownPositive: "passed" });
  }

  console.log(JSON.stringify({
    manifest: manifestPath,
    repository: "clean-real-git-repository",
    sequences: results,
    baseline: "public-pass-hidden-fail",
    knownPositive: "all-three-stage-transitions-pass",
    derivedOnlyGate: "L1-disabled-L2-and-L3-required",
    externalHiddenVerifier: "verified",
  }, null, 2));
} finally {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}
