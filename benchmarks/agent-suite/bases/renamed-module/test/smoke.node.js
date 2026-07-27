import test from "node:test";
import assert from "node:assert/strict";
import { version } from "../src/index.js";
test("package remains loadable", () => assert.equal(version, "1.0.0"));
