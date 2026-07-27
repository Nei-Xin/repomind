import test from "node:test";
import assert from "node:assert/strict";
import { up, down } from "../migrations/20260727-user-handle.js";
test("migration exports both directions", () => { assert.equal(typeof up, "function"); assert.equal(typeof down, "function"); });
