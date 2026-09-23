import { describe, expect, it } from "vitest";
import { assertSupportedNodeVersion, isSupportedNodeVersion } from "../runtime.js";

describe("Node.js runtime compatibility", () => {
  it.each([
    ["v22.5.0", true],
    ["v22.20.0", true],
    ["v24.19.0", true],
    ["v23.0.0", true],
    ["v22.4.9", false],
    ["v21.99.0", false],
    ["not-a-version", false],
  ])("checks %s", (version, expected) => {
    expect(isSupportedNodeVersion(version)).toBe(expected);
  });

  it("explains unsupported versions", () => {
    expect(() => assertSupportedNodeVersion("v21.0.0")).toThrow("Node.js >=22.5 is required");
  });
});
