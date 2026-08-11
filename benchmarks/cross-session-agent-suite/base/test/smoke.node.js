import assert from "node:assert/strict";
import test from "node:test";
import { jobsEndpoint } from "../src/client.js";
import { deliverOnce, resetDeliveries } from "../src/delivery.js";
import { stableDigest } from "../src/digest.js";
import { normalizeServiceName } from "../src/index.js";
import { parseConfig } from "../src/parse-config.js";

test("normalizes service names", () => {
  assert.equal(normalizeServiceName(" Billing_API "), "billing-api");
});

test("fixture APIs remain loadable before the benchmark tasks", async () => {
  assert.match(jobsEndpoint(), /^\/[a-z0-9/]+$/u);
  assert.deepEqual(parseConfig('{"enabled":true}'), { enabled: true });
  assert.equal(typeof stableDigest, "function");
  resetDeliveries();
  assert.equal(await deliverOnce("smoke", async () => {}), true);
});
