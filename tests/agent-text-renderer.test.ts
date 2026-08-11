import { describe, expect, it } from "vitest";
import { createAgentTextRenderer } from "../src/cli/agent-text-renderer.js";

describe("Agent CLI text renderer", () => {
  it("renders Claude assistant text without duplicating terminal result JSON", () => {
    const output: string[] = [];
    const renderer = createAgentTextRenderer("claude", (text) => output.push(text));
    const assistant = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Implemented the change." },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } },
          { type: "text", text: "Tests pass." },
        ],
      },
    });
    const terminal = JSON.stringify({ type: "result", result: "Implemented the change.\nTests pass." });

    renderer.feed(assistant.slice(0, 20));
    renderer.feed(`${assistant.slice(20)}\n${terminal}`);
    renderer.finish();

    expect(output).toEqual(["Implemented the change.\nTests pass."]);
    expect(renderer.lastText()).toBe("Implemented the change.\nTests pass.");
  });

  it("preserves OpenCode text rendering and handles split JSONL chunks", () => {
    const output: string[] = [];
    const renderer = createAgentTextRenderer("opencode", (text) => output.push(text));
    const event = JSON.stringify({ type: "text", part: { text: "OpenCode summary" } });
    renderer.feed(event.slice(0, 8));
    renderer.feed(`${event.slice(8)}\n`);

    expect(output).toEqual(["OpenCode summary"]);
    expect(renderer.lastText()).toBe("OpenCode summary");
  });
});
