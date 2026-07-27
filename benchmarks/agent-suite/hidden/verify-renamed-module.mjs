import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const repository = process.argv[2];
const api = await import(`${pathToFileURL(resolve(repository, "src/index.js")).href}?verify=${Date.now()}`);
assert.equal(typeof api.serializeAuditRecord, "function");
assert.equal(api.serializeAuditRecord({ event: "login", actor: "ada" }), '{"event":"login","actor":"ada"}');
