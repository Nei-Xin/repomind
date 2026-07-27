import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repository = process.argv[2];
const api = await import(`${pathToFileURL(resolve(repository, "src/digest.js")).href}?verify=${Date.now()}`);
assert.equal(api.stableDigest("RepoMind"), createHash("sha256").update("RepoMind", "utf8").digest("hex"));
const pkg = JSON.parse(await readFile(resolve(repository, "package.json"), "utf8"));
assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
