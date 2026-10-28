import { setTimeout } from "node:timers/promises";
import { afterEach } from "vitest";

// Git/SQLite fixtures do synchronous work. Let the worker receive Vitest's
// result acknowledgements between cases, including on slower Windows runners.
afterEach(async () => { await setTimeout(1); });
