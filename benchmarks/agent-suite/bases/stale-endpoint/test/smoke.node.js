import test from "node:test";
import assert from "node:assert/strict";
import { jobsEndpoint } from "../src/client.js";

test("jobsEndpoint returns an API path", () => {
  assert.match(jobsEndpoint(), /^\/[a-z0-9/]+$/u);
});
