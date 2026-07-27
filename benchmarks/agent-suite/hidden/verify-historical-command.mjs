import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
const repository = process.argv[2];
const pkg = JSON.parse(await readFile(resolve(repository, "package.json"), "utf8"));
assert.equal(pkg.scripts["verify:release"], "node --test && node scripts/check-schema.mjs");
