import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "repomind-cross-session-fixtures-"));
const suite = join(root, "suite");
const reproducibleSuite = join(root, "suite-reproducible");
const overrideSuite = join(root, "suite-model-overrides");

const defaultModels = {
  opencode: "cliproxyapi/gpt-5.6-luna",
  claude: "gpt-5.6-luna",
};
const overrideModels = {
  opencode: "test-provider/opencode-model",
  claude: "test-provider/claude-model",
};
const crossAgentSpecifications = {
  "xagent-claude-to-opencode-endpoint": {
    contractId: "corr-stale-endpoint",
    runners: ["claude", "opencode"],
  },
  "xagent-opencode-to-claude-parser": {
    contractId: "corr-error-contract",
    runners: ["opencode", "claude"],
  },
};
const expectedEfficiencyAcceptance = {
  maxMeanDurationRegressionPercent: 10,
  maxMeanTotalPromptTokenRegressionPercent: 10,
  minTotalPromptTokenPairedWinRate: 0.6,
  minAgentDurationPairedWinRate: 0.6,
  minComparablePairCoverageRate: 1,
};
const efficiencyAcceptanceFields = Object.keys(expectedEfficiencyAcceptance);
const efficiencyRecoveryEvidence = {
  "eff-dependency-boundary": ["config/cache-key-vectors.json", "package.json"],
  "eff-delivery-failure": ["src/delivery-worker.js", "test/delivery-worker.contract.node.js"],
  "eff-gateway-history": ["config/nimbus-runtime.json", "src/gateway-telemetry.js"],
};
const directEfficiencyPromptFragments = {
  "eff-dependency-boundary": ["node:crypto", "createhash", "sha256", "utf8", "digest(\"hex\")"],
  "eff-delivery-failure": ["before awaiting", "remove the claim", "invoke send only once", "return false to a concurrent"],
  "eff-gateway-history": [
    "bounded-exponential-v2",
    "x-gateway-retry-policy",
    "x-gateway-retry-limit",
    "x-gateway-retry-attempt",
    "x-request-id",
    "0 through 4",
  ],
};
const producerPromptRequirements = [
  "coordination-only",
  "separate follow-up",
  "do not modify application code, package files, or tests in this task",
  "Run the current tests as-is; if they fail, report the failure rather than fixing it.",
  "leave every other tracked file unchanged",
];

const producerFiles = {
  "corr-release-command": "ops/pending/release-review.todo",
  "corr-stale-endpoint": "ops/pending/jobs-cutover.todo",
  "corr-error-contract": "ops/pending/parser-review.todo",
  "eff-dependency-boundary": "ops/dependency-boundary-review.txt",
  "eff-delivery-failure": "ops/delivery-dedup-incident.txt",
  "eff-gateway-history": "ops/nimbus-gateway-cutover.txt",
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

function requireFailure(result, description, expectedMessage) {
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  if (result.status === 0 || result.error || !output.includes(expectedMessage)) {
    throw new Error(`${description}: expected failure containing ${JSON.stringify(expectedMessage)}\n${output}`);
  }
}

function parseJsonOutput(result, description) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${description}: generator did not print JSON\n${result.stdout}`, { cause: error });
  }
}

function verifierContractId(sequence) {
  if (sequence.stages.length !== 2) throw new Error(`${sequence.id}: expected exactly two stages`);
  const contractIds = [];
  for (const [stageIndex, stage] of sequence.stages.entries()) {
    const expectedMode = stageIndex === 0 ? "producer" : "consumer";
    if (!Array.isArray(stage.hiddenChecks) || stage.hiddenChecks.length === 0) {
      throw new Error(`${sequence.id}/${stage.id}: expected at least one hidden check`);
    }
    for (const check of stage.hiddenChecks) {
      if (!Array.isArray(check.args) || check.args[1] !== expectedMode
        || typeof check.args[2] !== "string" || check.args[2].length === 0) {
        throw new Error(`${sequence.id}/${stage.id}: hidden verifier arguments do not identify ${expectedMode} contract`);
      }
      contractIds.push(check.args[2]);
    }
  }
  if (new Set(contractIds).size !== 1) {
    throw new Error(`${sequence.id}: stages do not use one shared hidden verifier contract`);
  }
  return contractIds[0];
}

function validateCrossAgentManifest(manifest, models, description) {
  if (manifest.version !== 1 || !Array.isArray(manifest.sequences) || manifest.sequences.length !== 2) {
    throw new Error(`${description}: cross-Agent manifest must contain exactly two version-1 sequences`);
  }
  const actualIds = manifest.sequences.map((sequence) => sequence.id).sort();
  const expectedIds = Object.keys(crossAgentSpecifications).sort();
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new Error(`${description}: unexpected cross-Agent sequence ids: ${actualIds.join(", ")}`);
  }
  for (const sequence of manifest.sequences) {
    const specification = crossAgentSpecifications[sequence.id];
    if (sequence.stages.length !== specification.runners.length) {
      throw new Error(`${description}/${sequence.id}: expected exactly two stages`);
    }
    for (const [stageIndex, stage] of sequence.stages.entries()) {
      const runner = specification.runners[stageIndex];
      if (!Object.hasOwn(stage, "runner") || !Object.hasOwn(stage, "model")) {
        throw new Error(`${description}/${sequence.id}/${stage.id}: runner and model must be explicit`);
      }
      if (stage.runner !== runner || stage.model !== models[runner]) {
        throw new Error(
          `${description}/${sequence.id}/${stage.id}: expected ${runner}/${models[runner]}, received ${stage.runner}/${stage.model}`,
        );
      }
    }
    const contractId = verifierContractId(sequence);
    if (contractId !== specification.contractId) {
      throw new Error(`${description}/${sequence.id}: expected verifier contract ${specification.contractId}, received ${contractId}`);
    }
  }
  const repeatFiveCalls = manifest.sequences.reduce(
    (count, sequence) => count + (sequence.stages.length * 2 * 5),
    0,
  );
  if (repeatFiveCalls !== 40) {
    throw new Error(`${description}: repeat-5 plan must make 40 Agent calls, received ${repeatFiveCalls}`);
  }
  return repeatFiveCalls;
}

function validateEfficiencyAcceptance(manifest) {
  for (const [field, expected] of Object.entries(expectedEfficiencyAcceptance)) {
    const actual = manifest.acceptance?.[field];
    if (actual !== expected) {
      throw new Error(`efficiency acceptance ${field} must be ${expected}, received ${actual}`);
    }
  }
}

function validateNoEfficiencyAcceptance(manifest, description) {
  for (const field of efficiencyAcceptanceFields) {
    if (Object.hasOwn(manifest.acceptance ?? {}, field)) {
      throw new Error(`${description} must not configure efficiency acceptance field ${field}`);
    }
  }
}

function validateEfficiencyRecoveryDesign(manifest, description, repositoryFiles) {
  for (const sequence of manifest.sequences) {
    const contractId = verifierContractId(sequence);
    const evidence = efficiencyRecoveryEvidence[contractId];
    const forbidden = directEfficiencyPromptFragments[contractId];
    if (!evidence || !forbidden) {
      throw new Error(`${description}/${sequence.id}: unknown efficiency recovery contract ${contractId}`);
    }
    const consumer = sequence.stages[1];
    const normalizedPrompt = consumer.prompt.toLowerCase();
    for (const fragment of forbidden) {
      if (normalizedPrompt.includes(fragment)) {
        throw new Error(`${description}/${sequence.id}: consumer prompt directly reveals ${JSON.stringify(fragment)}`);
      }
    }
    const mutable = new Set([
      ...(sequence.stages[0].allowedChanges ?? []),
      ...(consumer.allowedChanges ?? []),
    ]);
    for (const path of evidence) {
      if (mutable.has(path)) {
        throw new Error(`${description}/${sequence.id}: recovery evidence is mutable by a benchmark stage: ${path}`);
      }
      if (repositoryFiles && !repositoryFiles.has(path)) {
        throw new Error(`${description}/${sequence.id}: recovery evidence is missing from the current tree: ${path}`);
      }
    }
  }
}

async function loadFixtureModule(repository, path) {
  const url = pathToFileURL(resolve(repository, path));
  return import(`${url.href}?evidence=${Date.now()}-${Math.random()}`);
}

async function validateEfficiencyRecoverySemantics(repository) {
  const vectorPath = join(repository, "config", "cache-key-vectors.json");
  const vectorText = readFileSync(vectorPath, "utf8");
  const vectors = JSON.parse(vectorText).vectors;
  if (!Array.isArray(vectors) || vectors.length < 2 || !vectors.some((vector) => /[^\x00-\x7f]/u.test(vector.input))) {
    throw new Error("digest recovery evidence needs multiple vectors including non-ASCII input");
  }
  if (["sha256", "utf8", "node:crypto", "hex"].some((fact) => vectorText.toLowerCase().includes(fact))) {
    throw new Error("digest compatibility vectors directly name the implementation contract");
  }
  for (const vector of vectors) {
    if (!/^[0-9a-f]{64}$/u.test(vector.key)
      || vector.key !== createHash("sha256").update(vector.input, "utf8").digest("hex")) {
      throw new Error(`digest compatibility vector does not constrain the expected contract: ${vector.input}`);
    }
  }
  const pkg = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"));
  if (Object.keys(pkg.dependencies ?? {}).length !== 0) {
    throw new Error("digest dependency evidence must keep the fixture dependency-free");
  }

  const deliverySource = readFileSync(join(repository, "src", "delivery-worker.js"), "utf8");
  if ([".has(", ".add(", ".delete("].some((fragment) => deliverySource.includes(fragment))) {
    throw new Error("delivery caller evidence directly copies the ownership implementation");
  }
  const deliveryContractSource = readFileSync(
    join(repository, "test", "delivery-worker.contract.node.js"),
    "utf8",
  );
  if (!deliveryContractSource.includes("../src/delivery-worker.js")) {
    throw new Error("delivery caller-contract evidence must exercise delivery-worker.js");
  }
  const forbiddenDeliveryContractFragments = [
    "../src/delivery.js", "deliverOnce", "resetDeliveries",
    "new Set(", "new Map(", ".has(", ".add(", ".delete(",
  ];
  if (forbiddenDeliveryContractFragments.some((fragment) => deliveryContractSource.includes(fragment))) {
    throw new Error("delivery caller-contract evidence leaks the ownership implementation");
  }
  const delivery = await loadFixtureModule(repository, "src/delivery-worker.js");
  const retries = [];
  const duplicate = await delivery.runDeliveryJob(
    { id: "semantic-probe", attempt: 3 },
    async () => {},
    (retry) => retries.push(retry),
    async () => false,
  );
  if (JSON.stringify(duplicate) !== JSON.stringify({ id: "semantic-probe", outcome: "duplicate" })
    || retries.length !== 0) {
    throw new Error("delivery caller evidence does not establish the duplicate result contract");
  }
  let rejected = false;
  try {
    await delivery.runDeliveryJob(
      { id: "semantic-probe", attempt: 3 },
      async () => {},
      (retry) => retries.push(retry),
      async () => { throw new Error("temporary"); },
    );
  } catch {
    rejected = true;
  }
  if (!rejected || JSON.stringify(retries) !== JSON.stringify([{ id: "semantic-probe", attempt: 4 }])) {
    throw new Error("delivery caller evidence does not establish same-ID retry after rejection");
  }

  const gatewayConfigText = readFileSync(join(repository, "config", "nimbus-runtime.json"), "utf8");
  const gatewayTelemetryText = readFileSync(join(repository, "src", "gateway-telemetry.js"), "utf8");
  if (gatewayConfigText.includes("x-gateway-") || gatewayConfigText.includes("x-request-id")) {
    throw new Error("Nimbus runtime evidence directly includes the wire-header map");
  }
  if (gatewayTelemetryText.includes("bounded-exponential-v2") || gatewayTelemetryText.includes("maximumAttempt")) {
    throw new Error("Nimbus telemetry evidence directly includes the runtime retry policy");
  }
  const gatewayConfig = JSON.parse(gatewayConfigText);
  if (gatewayConfig.gateway !== "nimbus" || gatewayConfig.retry.mode !== "bounded-exponential-v2"
    || gatewayConfig.retry.minimumAttempt !== 0 || gatewayConfig.retry.maximumAttempt !== 4) {
    throw new Error("Nimbus runtime evidence does not establish the policy and attempt bounds");
  }
  const gateway = await loadFixtureModule(repository, "src/gateway-telemetry.js");
  const telemetry = gateway.gatewayRetryTelemetry({
    "x-gateway-retry-policy": gatewayConfig.retry.mode,
    "x-gateway-retry-limit": String(gatewayConfig.retry.maximumAttempt),
    "x-gateway-retry-attempt": "2",
    "x-request-id": "semantic-probe",
  });
  if (JSON.stringify(telemetry) !== JSON.stringify({
    policy: "bounded-exponential-v2",
    limit: 4,
    attempt: 2,
    requestId: "semantic-probe",
  })) {
    throw new Error("Nimbus telemetry evidence does not establish the wire-header contract");
  }
  try {
    gateway.gatewayRetryTelemetry({
      "x-gateway-retry-policy": gatewayConfig.retry.mode,
      "x-gateway-retry-limit": gatewayConfig.retry.maximumAttempt,
      "x-gateway-retry-attempt": 2,
      "x-request-id": "semantic-probe",
    });
    throw new Error("Nimbus telemetry evidence accepts non-string wire values");
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }

  return {
    "eff-dependency-boundary": [...efficiencyRecoveryEvidence["eff-dependency-boundary"]],
    "eff-delivery-failure": [...efficiencyRecoveryEvidence["eff-delivery-failure"]],
    "eff-gateway-history": [...efficiencyRecoveryEvidence["eff-gateway-history"]],
  };
}

function validateProducerBoundary(sequence, expectedBaseCommit, description) {
  const contractId = verifierContractId(sequence);
  const marker = producerFiles[contractId];
  if (!marker) throw new Error(`${description}/${sequence.id}: unknown producer contract ${contractId}`);
  const producer = sequence.stages[0];
  for (const requirement of producerPromptRequirements) {
    if (!producer.prompt.includes(requirement)) {
      throw new Error(`${description}/${sequence.id}: producer prompt is missing ${JSON.stringify(requirement)}`);
    }
  }
  if (!producer.prompt.includes(`Delete only ${marker}`)) {
    throw new Error(`${description}/${sequence.id}: producer prompt does not name its unique deletion ${marker}`);
  }
  if (JSON.stringify(producer.allowedChanges) !== JSON.stringify([marker])) {
    throw new Error(`${description}/${sequence.id}: producer allowlist must contain only ${marker}`);
  }
  for (const check of producer.hiddenChecks) {
    if (check.args.length !== 5 || check.args[3] !== "{repo}" || check.args[4] !== expectedBaseCommit) {
      throw new Error(`${description}/${sequence.id}: producer hidden check must receive repo and base commit`);
    }
  }
}

function validateCrossAgentPromptParity(correctness, crossAgent, description) {
  const correctnessByContract = new Map(correctness.sequences.map((sequence) => [
    verifierContractId(sequence),
    sequence.stages[0].prompt,
  ]));
  for (const sequence of crossAgent.sequences) {
    const contractId = verifierContractId(sequence);
    if (sequence.stages[0].prompt !== correctnessByContract.get(contractId)) {
      throw new Error(`${description}/${sequence.id}: producer prompt differs from correctness contract ${contractId}`);
    }
  }
}

function requireGeneratorFailure(generator, args, target, expectedMessage, description) {
  const result = run(process.execPath, [generator, target, ...args], process.cwd());
  requireFailure(result, description, expectedMessage);
  if (existsSync(target)) throw new Error(`${description}: generator created a directory after rejecting its arguments`);
}

function resolveCheck(check, repository) {
  return {
    command: check.command.replaceAll("{repo}", repository),
    args: check.args.map((argument) => argument.replaceAll("{repo}", repository)),
  };
}

function executeCheck(check, repository) {
  const resolved = resolveCheck(check, repository);
  return run(resolved.command, resolved.args, repository);
}

function repositoryFingerprint(repository) {
  const hash = createHash("sha256");
  for (const path of listFiles(repository).filter((entry) => entry !== ".git" && !entry.startsWith(".git/")).sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(join(repository, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function executeReadOnlyCheck(check, repository, description) {
  const before = repositoryFingerprint(repository);
  const result = executeCheck(check, repository);
  const after = repositoryFingerprint(repository);
  if (before !== after) throw new Error(`${description}: verifier modified the repository`);
  return result;
}

function outside(child, parent) {
  const path = relative(parent, child);
  return path.startsWith("..") && !isAbsolute(path);
}

function changedFiles(repository) {
  const status = run("git", ["status", "--porcelain"], repository);
  requireSuccess(status, `inspect changes in ${repository}`);
  return status.stdout.split(/\r?\n/u).filter(Boolean).map((line) => line.slice(3).trim()).sort();
}

function requireExactChanges(repository, expected, description) {
  const actual = changedFiles(repository);
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${description}: expected changes ${wanted.join(", ")}; received ${actual.join(", ")}`);
  }
}

function listFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? listFiles(join(directory, entry.name), relativePath)
      : [relativePath];
  });
}

function writePositiveConsumer(contractId, repository) {
  switch (contractId) {
    case "corr-release-command": {
      const path = join(repository, "package.json");
      const pkg = JSON.parse(readFileSync(path, "utf8"));
      pkg.scripts["verify:release"] = "node --test && node scripts/check-schema.mjs";
      writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
      return;
    }
    case "corr-stale-endpoint":
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
    case "corr-error-contract":
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
test("wraps malformed JSON", () => {
  assert.throws(() => parseConfig("{"), (error) =>
    error instanceof SyntaxError && error.code === "CONFIG_PARSE_FAILED" && error.cause instanceof SyntaxError);
});
`, "utf8");
      return;
    case "eff-dependency-boundary":
      writeFileSync(join(repository, "src", "digest.js"), `import { createHash } from "node:crypto";

export function stableDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}
`, "utf8");
      writeFileSync(join(repository, "test", "digest.test.js"), `import assert from "node:assert/strict";
import test from "node:test";
import { stableDigest } from "../src/digest.js";

test("returns a stable SHA-256 hexadecimal digest", () => {
  assert.equal(stableDigest("RepoMind"), "b0a049a2d28a387b41ab2dbd9044fc9b11d6d2b439746f3751a0b7970e5290fd");
});
`, "utf8");
      return;
    case "eff-delivery-failure":
      writeFileSync(join(repository, "src", "delivery.js"), `const delivered = new Set();
const inFlight = new Map();

export async function deliverOnce(id, send) {
  if (delivered.has(id)) return false;
  const existing = inFlight.get(id);
  if (existing) {
    await existing;
    return false;
  }
  const delivery = (async () => {
    await send(id);
    delivered.add(id);
  })();
  inFlight.set(id, delivery);
  try {
    await delivery;
    return true;
  } finally {
    if (inFlight.get(id) === delivery) inFlight.delete(id);
  }
}

export function resetDeliveries() {
  delivered.clear();
  inFlight.clear();
}
`, "utf8");
      writeFileSync(join(repository, "test", "delivery.test.js"), `import assert from "node:assert/strict";
import test from "node:test";
import { deliverOnce, resetDeliveries } from "../src/delivery.js";

test("deduplicates concurrent delivery", async () => {
  resetDeliveries();
  let sends = 0;
  const results = await Promise.all([
    deliverOnce("a", async () => { sends += 1; }),
    deliverOnce("a", async () => { sends += 1; }),
  ]);
  assert.deepEqual(results, [true, false]);
  assert.equal(sends, 1);
});
`, "utf8");
      return;
    case "eff-gateway-history":
      writeFileSync(join(repository, "src", "retry-policy.js"), `export function createRetryHeaders(attempt, requestId) {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > 4) {
    throw new RangeError("attempt must be an integer from 0 through 4");
  }
  return {
    "x-gateway-retry-policy": "bounded-exponential-v2",
    "x-gateway-retry-limit": "4",
    "x-gateway-retry-attempt": String(attempt),
    "x-request-id": requestId,
  };
}
`, "utf8");
      writeFileSync(join(repository, "src", "index.js"), `export { createRetryHeaders } from "./retry-policy.js";

export function normalizeServiceName(value) {
  return value.trim().toLowerCase().replaceAll("_", "-");
}
`, "utf8");
      writeFileSync(join(repository, "test", "retry-policy.test.js"), `import assert from "node:assert/strict";
import test from "node:test";
import { createRetryHeaders } from "../src/index.js";

test("creates retry headers", () => {
  assert.equal(createRetryHeaders(2, "request-2")["x-gateway-retry-attempt"], "2");
});
`, "utf8");
      return;
    default:
      throw new Error(`unknown positive consumer contract: ${contractId}`);
  }
}

function requireProducerLeakRejected(sequence, repository, commitLeak) {
  const contractId = verifierContractId(sequence);
  const producer = sequence.stages[0];
  const negativeRepository = join(root, `negative-${contractId}-${commitLeak ? "committed" : "worktree"}`);
  requireSuccess(
    run("git", ["clone", "--quiet", repository, negativeRepository], root),
    `${contractId} producer-leak clone`,
  );
  const marker = producerFiles[contractId];
  if (!marker) throw new Error(`${contractId}: unknown producer contract for negative test`);
  unlinkSync(join(negativeRepository, marker));
  writePositiveConsumer(contractId, negativeRepository);
  for (const check of producer.publicChecks) {
    requireSuccess(executeCheck(check, negativeRepository), `${contractId} producer-leak public check`);
  }
  if (commitLeak) {
    requireSuccess(run("git", ["add", "--all"], negativeRepository), `${contractId} committed leak staging`);
    requireSuccess(run("git", [
      "-c", "user.name=RepoMind", "-c", "user.email=benchmark@repomind.local",
      "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "premature consumer implementation",
    ], negativeRepository), `${contractId} committed leak commit`);
  }
  for (const check of producer.hiddenChecks) {
    const result = executeReadOnlyCheck(check, negativeRepository, `${contractId} producer-leak hidden check`);
    const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
    if (result.error || result.status === null) {
      throw new Error(`${contractId}: producer-leak hidden check could not execute\n${output}`);
    }
    if (result.status === 0 || !output.includes("producer must delete only its retirement file")) {
      throw new Error(`${contractId}: producer hidden check did not reject premature implementation\n${output}`);
    }
  }
  return { contractId, state: commitLeak ? "committed" : "uncommitted", result: "rejected" };
}

try {
  const generator = resolve(import.meta.dirname, "create.mjs");
  const templateManifests = Object.fromEntries([
    ["correctness", "manifest.correctness.template.json"],
    ["efficiency", "manifest.efficiency.template.json"],
    ["crossAgent", "manifest.cross-agent.template.json"],
  ].map(([name, file]) => [name, JSON.parse(readFileSync(resolve(import.meta.dirname, file), "utf8"))]));
  for (const [name, manifest] of Object.entries(templateManifests)) {
    for (const sequence of manifest.sequences) {
      validateProducerBoundary(sequence, "__BASE_COMMIT__", `${name} template`);
    }
  }
  validateEfficiencyRecoveryDesign(
    templateManifests.efficiency,
    "efficiency template",
  );
  validateNoEfficiencyAcceptance(templateManifests.correctness, "correctness template");
  validateNoEfficiencyAcceptance(templateManifests.crossAgent, "cross-Agent template");
  validateCrossAgentPromptParity(
    templateManifests.correctness,
    templateManifests.crossAgent,
    "template prompt parity",
  );

  const created = run(process.execPath, [generator, suite], process.cwd());
  requireSuccess(created, "fixture generation");
  const createdOutput = parseJsonOutput(created, "fixture generation");

  const refused = run(process.execPath, [generator, suite], process.cwd());
  if (refused.status === 0 || !`${refused.stderr}\n${refused.stdout}`.includes("Refusing to overwrite")) {
    throw new Error("generator did not refuse to overwrite an existing directory");
  }

  const recreated = run(process.execPath, [generator, reproducibleSuite], process.cwd());
  requireSuccess(recreated, "second fixture generation");

  const overridden = run(process.execPath, [
    generator,
    overrideSuite,
    "--opencode-model", overrideModels.opencode,
    "--claude-model", overrideModels.claude,
  ], process.cwd());
  requireSuccess(overridden, "model override fixture generation");
  const overriddenOutput = parseJsonOutput(overridden, "model override fixture generation");

  requireGeneratorFailure(
    generator,
    ["--unknown-option", "model"],
    join(root, "suite-invalid-unknown"),
    "Unknown option",
    "unknown generator option",
  );
  requireGeneratorFailure(
    generator,
    ["--opencode-model"],
    join(root, "suite-invalid-missing"),
    "requires a non-empty model id",
    "missing generator option value",
  );
  requireGeneratorFailure(
    generator,
    ["--claude-model", ""],
    join(root, "suite-invalid-empty"),
    "requires a non-empty model id",
    "empty generator option value",
  );

  const manifestPaths = {
    full: join(suite, "manifest.json"),
    correctness: join(suite, "manifest.correctness.json"),
    efficiency: join(suite, "manifest.efficiency.json"),
    crossAgent: join(suite, "manifest.cross-agent.json"),
  };
  const manifests = Object.fromEntries(Object.entries(manifestPaths).map(([name, path]) => [
    name,
    JSON.parse(readFileSync(path, "utf8")),
  ]));
  const secondFull = JSON.parse(readFileSync(join(reproducibleSuite, "manifest.json"), "utf8"));
  const secondCrossAgent = JSON.parse(readFileSync(join(reproducibleSuite, "manifest.cross-agent.json"), "utf8"));
  const overriddenCrossAgentPath = join(overrideSuite, "manifest.cross-agent.json");
  const overriddenCrossAgent = JSON.parse(readFileSync(overriddenCrossAgentPath, "utf8"));
  const allManifestText = Object.values(manifestPaths).map((path) => readFileSync(path, "utf8")).join("\n");
  if (/__[A-Z_]+__/u.test(allManifestText)) throw new Error("generated manifests contain an unresolved placeholder");
  if (/__[A-Z_]+__/u.test(readFileSync(overriddenCrossAgentPath, "utf8"))) {
    throw new Error("model override manifest contains an unresolved placeholder");
  }
  if (createdOutput.manifest !== manifestPaths.full
    || JSON.stringify(createdOutput.manifests) !== JSON.stringify(manifestPaths)
    || JSON.stringify(createdOutput.models) !== JSON.stringify(defaultModels)) {
    throw new Error("default generator output does not expose compatible manifest paths and model ids");
  }
  if (JSON.stringify(overriddenOutput.models) !== JSON.stringify(overrideModels)
    || overriddenOutput.manifests?.crossAgent !== overriddenCrossAgentPath) {
    throw new Error("model override generator output does not expose the requested model ids and manifest path");
  }
  if (manifests.full.version !== 1 || manifests.full.sequences.length !== 6) {
    throw new Error("full manifest must contain six version-1 sequences");
  }
  if (manifests.correctness.sequences.length !== 3 || manifests.efficiency.sequences.length !== 3) {
    throw new Error("correctness and efficiency manifests must contain three sequences each");
  }
  const crossAgentRepeatFiveCalls = validateCrossAgentManifest(
    manifests.crossAgent,
    defaultModels,
    "default generation",
  );
  validateCrossAgentManifest(overriddenCrossAgent, overrideModels, "model override generation");
  validateEfficiencyAcceptance(manifests.efficiency);
  validateNoEfficiencyAcceptance(manifests.correctness, "correctness generation");
  validateNoEfficiencyAcceptance(manifests.crossAgent, "cross-Agent generation");
  validateNoEfficiencyAcceptance(manifests.full, "full generation");
  const cohortIds = [...manifests.correctness.sequences, ...manifests.efficiency.sequences]
    .map((sequence) => sequence.id);
  const fullIds = manifests.full.sequences.map((sequence) => sequence.id);
  if (new Set(fullIds).size !== 6 || JSON.stringify(fullIds) !== JSON.stringify(cohortIds)) {
    throw new Error("full manifest does not exactly combine the two cohorts");
  }

  const repository = manifests.full.sequences[0].baseRepository;
  const baseCommit = manifests.full.sequences[0].baseCommit;
  if (!isAbsolute(repository)) throw new Error("baseRepository was not replaced with an absolute path");
  for (const [name, manifest] of Object.entries({
    correctness: manifests.correctness,
    efficiency: manifests.efficiency,
    crossAgent: manifests.crossAgent,
  })) {
    for (const sequence of manifest.sequences) {
      validateProducerBoundary(sequence, baseCommit, `${name} generation`);
    }
  }
  validateCrossAgentPromptParity(manifests.correctness, manifests.crossAgent, "generated prompt parity");
  const generatedSequences = Object.values(manifests).flatMap((manifest) => manifest.sequences);
  if (generatedSequences.some((sequence) => sequence.baseRepository !== repository
    || sequence.baseCommit !== baseCommit)) {
    throw new Error("generated sequences do not share the generated base repository and commit");
  }
  if (secondFull.sequences.some((sequence) => sequence.baseCommit !== baseCommit)) {
    throw new Error("base commit is not reproducible");
  }
  if (secondCrossAgent.sequences.some((sequence) => sequence.baseCommit !== baseCommit)) {
    throw new Error("cross-Agent base commit is not reproducible");
  }
  const head = run("git", ["rev-parse", "HEAD"], repository);
  requireSuccess(head, "base commit inspection");
  if (head.stdout.trim() !== baseCommit) throw new Error("base commit does not match manifest");
  if (changedFiles(repository).length) throw new Error("generated base worktree is dirty");

  const repositoryFiles = new Set(listFiles(repository)
    .filter((path) => path !== ".git" && !path.startsWith(".git/")));
  validateEfficiencyRecoveryDesign(
    manifests.efficiency,
    "efficiency generation",
    repositoryFiles,
  );
  const verifiedEfficiencyRecoveryEvidence = await validateEfficiencyRecoverySemantics(repository);

  const templateFiles = listFiles(resolve(import.meta.dirname, "base"));
  const vitestConflicts = templateFiles.filter((path) => /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path));
  if (vitestConflicts.length) {
    throw new Error(`base template contains tests that root Vitest can collect: ${vitestConflicts.join(", ")}`);
  }

  const baseText = listFiles(repository)
    .filter((path) => path !== ".git")
    .filter((path) => !path.startsWith(".git/"))
    .map((path) => readFileSync(join(repository, path), "utf8"))
    .join("\n");
  for (const fact of ["node --test && node scripts/check-schema.mjs", "/v2/tasks", "CONFIG_PARSE_FAILED"]) {
    if (baseText.includes(fact)) throw new Error(`correctness fact leaked into base repository: ${fact}`);
  }
  const consumerPrompts = [...manifests.correctness.sequences, ...manifests.crossAgent.sequences]
    .map((sequence) => sequence.stages[1].prompt)
    .join("\n");
  for (const fact of ["node --test && node scripts/check-schema.mjs", "/v2/tasks", "CONFIG_PARSE_FAILED"]) {
    if (consumerPrompts.includes(fact)) throw new Error(`correctness fact leaked into consumer prompt: ${fact}`);
  }

  const correctnessByContract = new Map(manifests.correctness.sequences.map((sequence) => [
    verifierContractId(sequence),
    sequence,
  ]));
  const staleEndpointSequence = correctnessByContract.get("corr-stale-endpoint");
  const errorContractSequence = correctnessByContract.get("corr-error-contract");
  if (!staleEndpointSequence || !errorContractSequence) {
    throw new Error("correctness manifest is missing a producer-isolation negative-test contract");
  }
  const producerIsolationNegatives = [
    requireProducerLeakRejected(staleEndpointSequence, repository, false),
    requireProducerLeakRejected(errorContractSequence, repository, true),
  ];

  const results = [];
  for (const sequence of [...manifests.full.sequences, ...manifests.crossAgent.sequences]) {
    const contractId = verifierContractId(sequence);
    const [producer, consumer] = sequence.stages;
    for (const stage of sequence.stages) {
      for (const check of stage.publicChecks) {
        requireSuccess(executeCheck(check, repository), `${sequence.id}/${stage.id} public baseline check`);
      }
      for (const check of stage.hiddenChecks) {
        const verifier = check.args[0];
        if (!isAbsolute(verifier)) throw new Error(`${sequence.id}/${stage.id}: hidden verifier is not absolute`);
        if (!outside(verifier, repository)) throw new Error(`${sequence.id}/${stage.id}: hidden verifier is inside Agent repository`);
        if (executeReadOnlyCheck(check, repository, `${sequence.id}/${stage.id}`).status === 0) {
          throw new Error(`${sequence.id}/${stage.id}: hidden check unexpectedly passes on base fixture`);
        }
      }
    }

    const positiveRepository = join(root, `positive-${sequence.id}`);
    requireSuccess(run("git", ["clone", "--quiet", repository, positiveRepository], root), `${sequence.id} positive clone`);
    const producerFile = producerFiles[contractId];
    if (!producerFile) throw new Error(`${sequence.id}: unknown producer contract ${contractId}`);
    unlinkSync(join(positiveRepository, producerFile));
    requireExactChanges(positiveRepository, producer.allowedChanges, `${sequence.id} producer allowlist`);
    for (const check of producer.publicChecks) {
      requireSuccess(executeCheck(check, positiveRepository), `${sequence.id} producer public positive check`);
    }
    for (const check of producer.hiddenChecks) {
      requireSuccess(
        executeReadOnlyCheck(check, positiveRepository, `${sequence.id} producer hidden positive check`),
        `${sequence.id} producer hidden positive check`,
      );
    }
    if (executeReadOnlyCheck(
      consumer.hiddenChecks[0],
      positiveRepository,
      `${sequence.id} consumer hidden pre-solution check`,
    ).status === 0) {
      throw new Error(`${sequence.id}: consumer hidden check passed before the consumer solution`);
    }
    requireSuccess(run("git", ["add", "--all"], positiveRepository), `${sequence.id} stage producer deletion`);
    requireSuccess(run("git", [
      "-c", "user.name=RepoMind", "-c", "user.email=benchmark@repomind.local",
      "commit", "--quiet", "-m", "known-positive producer",
    ], positiveRepository), `${sequence.id} commit producer deletion`);

    writePositiveConsumer(contractId, positiveRepository);
    requireExactChanges(positiveRepository, consumer.allowedChanges, `${sequence.id} consumer allowlist`);
    for (const check of consumer.publicChecks) {
      requireSuccess(executeCheck(check, positiveRepository), `${sequence.id} consumer public positive check`);
    }
    for (const check of consumer.hiddenChecks) {
      requireSuccess(
        executeReadOnlyCheck(check, positiveRepository, `${sequence.id} consumer hidden positive check`),
        `${sequence.id} consumer hidden positive check`,
      );
    }
    results.push({ sequenceId: sequence.id, contractId, producer: "passed", consumer: "passed" });
  }

  console.log(JSON.stringify({
    version: manifests.full.version,
    manifests: {
      full: { path: manifestPaths.full, sequences: manifests.full.sequences.length },
      correctness: { path: manifestPaths.correctness, sequences: manifests.correctness.sequences.length },
      efficiency: { path: manifestPaths.efficiency, sequences: manifests.efficiency.sequences.length },
      crossAgent: { path: manifestPaths.crossAgent, sequences: manifests.crossAgent.sequences.length },
    },
    repository: "clean-real-git-repository",
    baseCommit,
    sequences: results,
    correctnessFactIsolation: "base-and-consumer-prompts-verified",
    templateTestNaming: "root-vitest-safe",
    absolutePaths: "verified",
    externalHiddenVerifiers: "read-only-fail-baseline-pass-known-positive",
    exactAllowlists: "verified",
    producerTransitions: "single-file-deletion-with-unique-target-tree",
    overwriteProtection: "verified",
    reproducibleCommit: "verified",
    crossAgentDirections: "claude-to-opencode-and-opencode-to-claude-verified",
    crossAgentRepeatFiveCalls,
    generatorModelOptions: "defaults-overrides-and-invalid-values-verified",
    efficiencyAcceptance: expectedEfficiencyAcceptance,
    efficiencyGatesLimitedToEfficiencyManifest: "verified",
    efficiencyRecoveryEvidence: verifiedEfficiencyRecoveryEvidence,
    producerPromptBoundaries: "all-templates-and-generated-manifests-verified",
    crossAgentPromptParity: "verified-by-hidden-contract",
    producerIsolationNegatives,
  }, null, 2));
} finally {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}
