import { readFileSync } from "node:fs";
import { parseGeminiInput, planGeminiHook } from "./state.js";

// Standalone entry avoids loading the Bridge/core dependency graph per stream chunk.
try {
  const input = parseGeminiInput(JSON.parse(readFileSync(0, "utf8")));
  if (input.hook_event_name === "BeforeModel" || input.hook_event_name === "AfterModel") planGeminiHook(input);
} catch {
  console.error("[RepoMind] Gemini model outcome could not be recorded; task completion may remain partial.");
}
console.log("{}");
