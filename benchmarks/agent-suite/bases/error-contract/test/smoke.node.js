import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/parse-config.js";

test("parseConfig parses valid JSON", () => {
  assert.deepEqual(parseConfig('{"enabled":true}'), { enabled: true });
});
