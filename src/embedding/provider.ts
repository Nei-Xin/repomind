export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  readonly remote: boolean;
  embed(texts: string[]): Promise<number[][]>;
}

export function validateEmbeddings(provider: EmbeddingProvider, vectors: number[][], expected: number): void {
  if (vectors.length !== expected) throw new Error(`Embedding provider returned ${vectors.length} vectors for ${expected} inputs`);
  for (const vector of vectors) {
    if (vector.length !== provider.dimensions) {
      throw new Error(`Embedding provider ${provider.id} returned ${vector.length} dimensions; expected ${provider.dimensions}`);
    }
    if (vector.some((value) => !Number.isFinite(value))) throw new Error(`Embedding provider ${provider.id} returned a non-finite value`);
  }
}

export function serializeVector(vector: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(vector).buffer);
}
