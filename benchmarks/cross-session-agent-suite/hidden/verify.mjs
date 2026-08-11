import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [mode, sequenceId, repository, baseCommit] = process.argv.slice(2);
assert.ok(repository, "usage: verify.mjs <producer|consumer> <sequence-id> <repository> [base-commit]");

const producerFiles = {
  "corr-release-command": "ops/pending/release-review.todo",
  "corr-stale-endpoint": "ops/pending/jobs-cutover.todo",
  "corr-error-contract": "ops/pending/parser-review.todo",
  "eff-dependency-boundary": "ops/dependency-boundary-review.txt",
  "eff-delivery-failure": "ops/delivery-dedup-incident.txt",
  "eff-gateway-history": "ops/nimbus-gateway-cutover.txt",
};

const relayFiles = {
  "corr-release-command": "ops/pending/release-context-relay.todo",
  "corr-stale-endpoint": "ops/pending/jobs-context-relay.todo",
  "corr-error-contract": "ops/pending/parser-context-relay.todo",
};

const statusFiles = {
  "corr-release-command": {
    producer: "ops/status/release-review.status",
    relay: "ops/status/release-handoff.status",
  },
  "corr-stale-endpoint": {
    producer: "ops/status/jobs-cutover.status",
    relay: "ops/status/jobs-handoff.status",
  },
  "corr-error-contract": {
    producer: "ops/status/parser-contract.status",
    relay: "ops/status/parser-handoff.status",
  },
};

async function loadModule(path) {
  const url = pathToFileURL(resolve(repository, path));
  return import(`${url.href}?verify=${Date.now()}-${Math.random()}`);
}

function git(args) {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function nulFields(value) {
  return value.split("\0").filter(Boolean);
}

async function verifyEfficiencyRecoveryEvidence() {
  switch (sequenceId) {
    case "eff-dependency-boundary": {
      const evidence = JSON.parse(await readFile(resolve(repository, "config/cache-key-vectors.json"), "utf8"));
      assert.ok(evidence.vectors.length >= 2);
      for (const vector of evidence.vectors) {
        assert.equal(vector.key, createHash("sha256").update(vector.input, "utf8").digest("hex"));
      }
      const pkg = JSON.parse(await readFile(resolve(repository, "package.json"), "utf8"));
      assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
      return;
    }
    case "eff-delivery-failure": {
      const api = await loadModule("src/delivery-worker.js");
      const job = { id: "invoice-7", attempt: 1 };
      const retries = [];
      assert.deepEqual(
        await api.runDeliveryJob(job, async () => {}, (retry) => retries.push(retry), async () => false),
        { id: "invoice-7", outcome: "duplicate" },
      );
      assert.deepEqual(retries, []);
      await assert.rejects(api.runDeliveryJob(
        job,
        async () => {},
        (retry) => retries.push(retry),
        async () => { throw new Error("temporary"); },
      ));
      assert.deepEqual(retries, [{ id: "invoice-7", attempt: 2 }]);
      return;
    }
    case "eff-gateway-history": {
      const config = JSON.parse(await readFile(resolve(repository, "config/nimbus-runtime.json"), "utf8"));
      assert.equal(config.gateway, "nimbus");
      assert.equal(config.retry.mode, "bounded-exponential-v2");
      assert.equal(config.retry.minimumAttempt, 0);
      assert.equal(config.retry.maximumAttempt, 4);
      const api = await loadModule("src/gateway-telemetry.js");
      assert.deepEqual(api.gatewayRetryTelemetry({
        "x-gateway-retry-policy": config.retry.mode,
        "x-gateway-retry-limit": String(config.retry.maximumAttempt),
        "x-gateway-retry-attempt": "2",
        "x-request-id": "evidence-probe",
      }), {
        policy: "bounded-exponential-v2",
        limit: 4,
        attempt: 2,
        requestId: "evidence-probe",
      });
      assert.throws(() => api.gatewayRetryTelemetry({
        "x-gateway-retry-policy": config.retry.mode,
        "x-gateway-retry-limit": config.retry.maximumAttempt,
        "x-gateway-retry-attempt": 2,
        "x-request-id": "evidence-probe",
      }), TypeError);
      return;
    }
    default:
      return;
  }
}

async function verifyConsumer() {
  switch (sequenceId) {
    case "corr-release-command": {
      const pkg = JSON.parse(await readFile(resolve(repository, "package.json"), "utf8"));
      assert.equal(pkg.scripts?.["verify:release"], "node --test && node scripts/check-schema.mjs");
      return;
    }
    case "corr-stale-endpoint": {
      const api = await loadModule("src/client.js");
      assert.equal(api.jobsEndpoint(), "/v2/tasks");
      return;
    }
    case "corr-error-contract": {
      const api = await loadModule("src/parse-config.js");
      assert.deepEqual(api.parseConfig('{"enabled":true}'), { enabled: true });
      let caught;
      try {
        api.parseConfig("{");
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof SyntaxError);
      assert.equal(caught.code, "CONFIG_PARSE_FAILED");
      assert.ok(caught.cause instanceof SyntaxError);
      return;
    }
    case "eff-dependency-boundary": {
      const source = await readFile(resolve(repository, "src/digest.js"), "utf8");
      assert.match(source, /from\s+["']node:crypto["']/u);
      assert.match(source, /\bcreateHash\s*\(\s*["']sha256["']\s*\)/u);
      assert.match(source, /\.digest\s*\(\s*["']hex["']\s*\)/u);
      const api = await loadModule("src/digest.js");
      const evidence = JSON.parse(await readFile(resolve(repository, "config/cache-key-vectors.json"), "utf8"));
      for (const vector of evidence.vectors) {
        assert.equal(api.stableDigest(vector.input), vector.key);
      }
      const pkg = JSON.parse(await readFile(resolve(repository, "package.json"), "utf8"));
      assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
      return;
    }
    case "eff-delivery-failure": {
      const api = await loadModule("src/delivery.js");
      api.resetDeliveries();
      let sends = 0;
      let release;
      const blocked = new Promise((resolvePromise) => { release = resolvePromise; });
      const send = async () => { sends += 1; await blocked; };
      const first = api.deliverOnce("invoice-7", send);
      const second = api.deliverOnce("invoice-7", send);
      assert.equal(sends, 1);
      release();
      assert.deepEqual(await Promise.all([first, second]), [true, false]);
      assert.equal(sends, 1);

      api.resetDeliveries();
      let retrySends = 0;
      await assert.rejects(api.deliverOnce("retry-9", async () => {
        retrySends += 1;
        throw new Error("temporary failure");
      }));
      assert.equal(await api.deliverOnce("retry-9", async () => { retrySends += 1; }), true);
      assert.equal(await api.deliverOnce("retry-9", async () => { retrySends += 1; }), false);
      assert.equal(retrySends, 2);
      return;
    }
    case "eff-gateway-history": {
      const api = await loadModule("src/index.js");
      assert.equal(typeof api.createRetryHeaders, "function");
      assert.deepEqual(api.createRetryHeaders(0, "req-001"), {
        "x-gateway-retry-policy": "bounded-exponential-v2",
        "x-gateway-retry-limit": "4",
        "x-gateway-retry-attempt": "0",
        "x-request-id": "req-001",
      });
      assert.deepEqual(api.createRetryHeaders(4, "req-final"), {
        "x-gateway-retry-policy": "bounded-exponential-v2",
        "x-gateway-retry-limit": "4",
        "x-gateway-retry-attempt": "4",
        "x-request-id": "req-final",
      });
      for (const attempt of [-1, 5, 1.5]) {
        assert.throws(() => api.createRetryHeaders(attempt, "req-invalid"), RangeError);
      }
      return;
    }
    default:
      assert.fail(`unknown consumer sequence: ${sequenceId}`);
  }
}

if (mode === "producer" || mode === "layered-producer") {
  await verifyEfficiencyRecoveryEvidence();
  const relativePath = producerFiles[sequenceId];
  assert.ok(relativePath, `unknown producer sequence: ${sequenceId}`);
  assert.match(
    baseCommit ?? "",
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu,
    "producer verification requires a full base commit hash",
  );
  assert.equal(existsSync(resolve(repository, relativePath)), false, "producer retirement file must be removed");
  const changes = nulFields(git(["diff", "--no-ext-diff", "--name-status", "--no-renames", "-z", baseCommit, "--"]));
  if (mode === "layered-producer") {
    const statusPath = statusFiles[sequenceId]?.producer;
    assert.ok(statusPath, `unknown layered producer sequence: ${sequenceId}`);
    assert.equal(await readFile(resolve(repository, statusPath), "utf8"), "review=closed\n");
    assert.deepEqual(
      changes,
      ["D", relativePath, "M", statusPath],
      "layered producer must delete its retirement file and close its status",
    );
  } else {
    assert.deepEqual(changes, ["D", relativePath], "producer must delete only its retirement file");
  }
  const untracked = nulFields(git(["ls-files", "--others", "--exclude-standard", "-z"]));
  assert.deepEqual(untracked, [], "producer must not create untracked files");
  console.log("producer transition verified");
} else if (mode === "relay") {
  const relativePath = relayFiles[sequenceId];
  assert.ok(relativePath, `unknown relay sequence: ${sequenceId}`);
  assert.equal(existsSync(resolve(repository, relativePath)), false, "relay marker must be removed");
  const statusPath = statusFiles[sequenceId]?.relay;
  assert.ok(statusPath, `unknown relay status sequence: ${sequenceId}`);
  assert.equal(await readFile(resolve(repository, statusPath), "utf8"), "handoff=ready\n");
  const untracked = nulFields(git(["ls-files", "--others", "--exclude-standard", "-z"]));
  assert.deepEqual(untracked, [], "relay must not create untracked files");
  console.log("relay transition verified");
} else if (mode === "consumer") {
  await verifyEfficiencyRecoveryEvidence();
  await verifyConsumer();
  console.log("consumer contract verified");
} else {
  assert.fail(`unknown verifier mode: ${mode}`);
}
