import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repository = process.argv[2];
const api = await import(`${pathToFileURL(resolve(repository, "src/client.js")).href}?verify=${Date.now()}`);
assert.equal(api.jobsEndpoint(), "/v2/tasks");
