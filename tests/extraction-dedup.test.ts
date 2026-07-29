import { describe, expect, it } from "vitest";
import { equivalentExtractionContent, extractionContentSimilarity } from "../src/extraction/dedup.js";

describe("remote extraction candidate equivalence", () => {
  const first = "Model-derived L1 confidence must be capped at 0.9 so remotely generated knowledge cannot claim manually verified certainty.";
  const wordingVariant = "Model-derived L1 confidence is capped at 0.9 so remotely generated knowledge never claims manually verified certainty.";

  it("accepts conservative wording drift for the same fact", () => {
    expect(extractionContentSimilarity(first, wordingVariant)).toBeGreaterThanOrEqual(0.8);
    expect(equivalentExtractionContent(first, wordingVariant)).toBe(true);
  });

  it("rejects changed numeric facts and opposite polarity", () => {
    expect(equivalentExtractionContent(first, wordingVariant.replace("0.9", "0.8"))).toBe(false);
    expect(equivalentExtractionContent(
      "Remote extraction is enabled by default.",
      "Remote extraction is not enabled by default.",
    )).toBe(false);
  });
});
