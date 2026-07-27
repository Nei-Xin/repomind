import test from "node:test";
import assert from "node:assert/strict";
import { schemaVersion } from "../src/schema.js";
test("schema is current", () => assert.equal(schemaVersion, 3));
