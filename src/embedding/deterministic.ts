import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "./provider.js";

function features(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const words = normalized.match(/[\p{L}\p{N}_./:-]+/gu) ?? [];
  const compact = normalized.replace(/\s+/gu, " ");
  const trigrams = compact.length < 3 ? [compact] : Array.from({ length: compact.length - 2 }, (_, index) => compact.slice(index, index + 3));
  return [...words, ...trigrams.filter(Boolean)];
}

export function deterministicEmbed(texts: string[], dimensions = 256): number[][] {
  return texts.map((text) => {
    const vector = new Float64Array(dimensions);
    for (const feature of features(text)) {
      const digest = createHash("sha256").update(feature).digest();
      const index = digest.readUInt32LE(0) % dimensions;
      vector[index] = (vector[index] ?? 0) + ((digest[4]! & 1) === 0 ? 1 : -1);
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return Array.from(vector, (value) => norm ? value / norm : 0);
  });
}

/** Offline feature hashing for tests, fallback experiments, and reproducible benchmarks. */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly id = "deterministic-feature-hash";
  readonly remote = false;

  constructor(readonly dimensions = 256, readonly model = `feature-hash-v1-${dimensions}`) {
    if (!Number.isInteger(dimensions) || dimensions < 8) throw new Error("Embedding dimensions must be an integer of at least 8");
  }

  async embed(texts: string[]): Promise<number[][]> {
    return deterministicEmbed(texts, this.dimensions);
  }
}
