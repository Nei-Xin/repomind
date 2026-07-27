import test from "node:test";
import assert from "node:assert/strict";
import { stableDigest } from "../src/digest.js";

test("stableDigest remains exported", () => {
  assert.equal(typeof stableDigest, "function");
});
