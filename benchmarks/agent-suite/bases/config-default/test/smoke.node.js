import test from "node:test";
import assert from "node:assert/strict";
import { requestTimeout } from "../src/config.js";

test("requestTimeout respects an explicit override", () => {
  assert.equal(requestTimeout({ REQUEST_TIMEOUT_MS: "1200" }), 1200);
});
