import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const repository = process.argv[2];
const migration = await import(`${pathToFileURL(resolve(repository, "migrations/20260727-user-handle.js")).href}?verify=${Date.now()}`);
const statements = [];
await migration.down({ exec: async (sql) => statements.push(sql) });
assert.deepEqual(statements, [
  "DROP INDEX users_handle_uq",
  "ALTER TABLE users DROP COLUMN handle",
]);
