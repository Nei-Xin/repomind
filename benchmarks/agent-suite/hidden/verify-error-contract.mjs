import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repository = process.argv[2];
const api = await import(`${pathToFileURL(resolve(repository, "src/parse-config.js")).href}?verify=${Date.now()}`);
let caught;
try { api.parseConfig("{"); } catch (error) { caught = error; }
assert.ok(caught instanceof SyntaxError);
assert.equal(caught.code, "CONFIG_PARSE_FAILED");
assert.ok(caught.cause instanceof SyntaxError);
