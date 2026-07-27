import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repository = process.argv[2];
const api = await import(`${pathToFileURL(resolve(repository, "src/config.js")).href}?verify=${Date.now()}`);
assert.equal(api.requestTimeout({}), 5_000);
assert.equal(api.requestTimeout({ REQUEST_TIMEOUT_MS: "2500" }), 2_500);
